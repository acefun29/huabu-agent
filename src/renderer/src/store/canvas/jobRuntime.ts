import type { MediaJobStatus } from '@shared/ipc'
import {
  DEFAULT_MEDIA_DURATION_S,
  DEFAULT_MEDIA_RATIO,
  MEDIA_REF_ROLES,
  MEDIA_ROLE_KIND,
  REF_ROLE_LABEL,
  deriveRefRole,
  inferMediaMode,
  nearestMediaRatio,
  normalizeMediaCaps
} from '@shared/media'
import type { MediaKind, MediaRefInput, MediaRefRole, MediaRatio, ResolvedRefCaps } from '@shared/media'
import { shortModelLabel } from '@shared/mediaResolve'
import { normalizePath } from '../../harness/assetCategories'
import {
  getGenerateReferences,
  validateGenerateReferences,
  withGenerateReferences,
  wouldCreateReferenceCycle
} from '../../lib/mediaReferenceGraph'
import type {
  AssetData,
  AssetGen,
  CanvasNode,
  GenerateInputSnapshot,
  GenerateReference,
  GenerateRefSnapshot,
  GenerateVersion
} from '../../types'
import type { CanvasState } from '../canvasStore'
import { BRIDGE_AVAILABLE, BRIDGE_UNAVAILABLE, MEDIA_LABEL, jobCardIndex, newNodeId, settingsBridgeRef, spawnOffset, zCounter } from './shared'
import type { StoreSet } from './chatRuntime'
import { createGenerationChain } from './generationChain'

/**
 * 生成任务域（T8 拆分）：生成不是卡片而是一种状态 —— 任务事件驱动卡片状态机，
 * 产物写成新版本挂在原卡片上，产物即素材。四条主链路：
 *
 * - job 事件 → 卡片状态机（patchGenByJob）：queued/running 更新进度；succeeded
 *   写新版本 + 解绑任务；failed/cancelled 保留卡片与可操作错误。同一 job 的
 *   终态/重复事件靠「path+createdAt」指纹只入一版（事件 replay 与对账可安全重叠）。
 * - Agent 工具发起的任务没有现成卡片 → spawnGenCardForJob 建卡承接；
 *   同一 jobId 只建一张（jobCardIndex 是同步事实源，在 shared.ts）。
 * - 画布（重）载入后对账（reconcileJobs）：卡片引用的任务若已终态/失效则收尾。
 * - 生成链（generationChain.ts）复用本文件的冻结提交桥：buildSubmitPlan /
 *   submitFrozen / waitJobTerminal / releaseCard，调度逻辑不碰 IPC 细节。
 *
 * 提交链（submitGeneration → buildSubmitPlan → submitFrozen）：提交前严格校验
 * （错误不发起 IPC），冻结提示词/参数/解析模型/参考角色与具体产物为
 * GenerateInputSnapshot（挂在 gen.pendingInputs，终态写进版本 inputs）；
 * 快速成功事件早于 IPC 返回时先按 jobId 缓冲、绑定后 replay。
 */

export interface JobRuntimeDeps {
  set: StoreSet
  get: () => CanvasState
  showToast: CanvasState['showToast']
  applyNodes: (fn: (prev: CanvasNode[]) => CanvasNode[]) => void
  mutateNodeData: (id: string, fn: (data: AssetData) => AssetData) => void
}

/** 一次提交的完整计划（冻结后的请求形态；链调度与单卡提交共用） */
export interface SubmitPlan {
  nodeId: string
  kind: MediaKind
  provider: string
  /** 命中模型的稳定 id（如 'dashscope/wan2.7-image'） */
  model: string
  prompt: string
  ratio?: MediaRatio
  durationSeconds?: number
  /** 落库目录（相对工作区根）；缺省 = 媒体产物目录 */
  outputDir?: string
  libraryName?: string
  /** 发给 IPC 的带角色参考（path 已按 pathRoot 还原为相对工作区根的完整路径） */
  refs: MediaRefInput[]
  /** 与请求同源的输入快照（终态写进 GenerateVersion.inputs，不随后续编辑漂移） */
  snapshot: GenerateInputSnapshot
}

export type SubmitResult =
  | { ok: true; jobId: string; /** IPC 返回前任务已终态（快速成功/失败），链调度可跳过等待 */ outcome?: JobTerminalOutcome }
  | { ok: false; error: string }

/** 一次任务等待的终态结论 */
export interface JobTerminalOutcome {
  state: MediaJobStatus['state']
  /** succeeded 时的真实产物版本（由任务事件捕获，非读卡片 activeVersion） */
  version: GenerateVersion | null
  error?: string
  /**
   * 结论来源：缺省/event = 任务真实终态；workspace/card-gone = 等待语境失效
   * （任务可能仍在跑，调用方应停止并取消已提交任务）；timeout = 等待超时（任务
   * 可能仍在跑，但卡片继续接收事件，不自动取消）。
   */
  origin?: 'event' | 'workspace' | 'card-gone' | 'timeout'
}

/** 暴露给生成链调度的提交桥（调度只认语义，不碰 IPC/事件缓冲细节） */
export interface JobRuntimeBridge {
  refCapsFor: (data: AssetData) => ResolvedRefCaps
  buildSubmitPlan: (node: CanvasNode, prompt: string) => { ok: true; plan: SubmitPlan } | { ok: false; error: string }
  submitFrozen: (plan: SubmitPlan, chainRunId?: string) => Promise<SubmitResult>
  waitJobTerminal: (jobId: string) => Promise<JobTerminalOutcome>
  /** 取消一个已提交任务（含 IPC 异常兜底；绝不 reject） */
  cancelJob: (jobId: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * 记录「提交在途即请求取消」的意图：该提交绑定 jobId 后立即取消。
   * 返回是否已记录（false = 该卡片没有在途提交）。
   */
  requestSubmitCancel: (nodeId: string) => boolean
  /** 链中止时把参与卡从 queued 拉回 failed 并释放 pending 上下文（卡片已删除则无操作） */
  releaseCard: (nodeId: string, error: string) => void
}

/** 任务事件丢失时的兜底探测节拍（单次 jobs() 对账，非轮询）；此后只依赖事件推送 */
const JOB_PROBE_DELAYS_MS = [3_000, 15_000, 60_000] as const
/** 等待任务终态的总上限（覆盖长视频生成）；超时按失败收尾，卡片仍接收后续事件 */
const JOB_WAIT_TIMEOUT_MS = 30 * 60 * 1000
/** 工作区切换观察节拍（等待期间低频检查，切换即唤醒等待方） */
const WORKSPACE_WATCH_MS = 2_000
/** 先到事件缓冲上限（只覆盖 IPC 在途的短暂窗口，正常远小于此） */
const PENDING_EVENT_BUFFER_MAX = 64
const PENDING_EVENT_MAX_AGE_MS = 60_000

const isTerminalState = (state: MediaJobStatus['state']): boolean =>
  state === 'succeeded' || state === 'failed' || state === 'cancelled'

export function createJobRuntime(deps: JobRuntimeDeps) {
  const { set, get, showToast, applyNodes, mutateNodeData } = deps

  /* ------------- 提交在途状态：先到事件缓冲 + 终态等待登记 ------------- */

  /** 有提交在 IPC 途中的卡片（事件先于 IPC 返回到达时按 jobId 缓冲，绑定后 replay） */
  const pendingSubmits = new Set<string>()
  /** 提交在途期间请求的取消（nodeId）；该提交绑定 jobId 后立即取消 */
  const cancelIntents = new Set<string>()
  /** jobId → 绑定前先到的事件（有序）；绑定/释放时消费 */
  const pendingEvents = new Map<string, MediaJobStatus[]>()
  /** jobId → 终态等待回调（生成链用；patchGenByJob 收尾时唤醒并清理） */
  const jobWaiters = new Map<string, Array<(job: MediaJobStatus, version: GenerateVersion | null) => void>>()

  /** 取消一个已提交任务（IPC 异常兜底，绝不 reject、绝不到处未处理 rejection） */
  const cancelJobSafe = async (jobId: string): Promise<{ ok: boolean; error?: string }> => {
    if (!BRIDGE_AVAILABLE) return { ok: false, error: BRIDGE_UNAVAILABLE }
    try {
      const result = await window.huabu.media.cancel(jobId)
      if (!result.ok) console.warn('[jobRuntime] 取消任务失败：', result.error)
      return result
    } catch (error) {
      console.warn('[jobRuntime] 取消任务异常：', error)
      return { ok: false, error: String(error) }
    }
  }

  const bufferPendingEvent = (job: MediaJobStatus) => {
    const list = pendingEvents.get(job.jobId) ?? []
    list.push(job)
    while (list.length > PENDING_EVENT_BUFFER_MAX) list.shift()
    pendingEvents.set(job.jobId, list)
    // 过期事件（提交早已结束仍未被认领）直接释放，防缓冲无界增长
    const now = Date.now()
    for (const [jobId, events] of pendingEvents) {
      const first = events[0]
      if (first && now - new Date(first.createdAt).getTime() > PENDING_EVENT_MAX_AGE_MS) {
        pendingEvents.delete(jobId)
        for (const stale of events) dispatchUnhandledJob(stale)
      }
    }
  }

  /** 无人认领的事件回归默认分发：Agent 来源建卡承接，画布来源静默丢弃（可被对账找回终态） */
  const dispatchUnhandledJob = (job: MediaJobStatus) => {
    if (job.sourceChatId && (job.state === 'queued' || job.state === 'running')) spawnGenCardForJob(job)
  }

  /**
   * 按 jobId 精确释放已知归属的缓冲（绑定落空时调用）。
   * 注意：提交 IPC 失败时**不能**全局清缓冲 —— 并发提交的事件按 jobId 混存在同一张表里，
   * 全局释放会把其它在途提交的先到事件误分发给默认通道（Agent 来源会重复建卡）。
   * 失败场景下本提交的 jobId 不可知，交由过期释放（PENDING_EVENT_MAX_AGE_MS）兜底。
   */
  const flushPendingJob = (jobId: string) => {
    const events = pendingEvents.get(jobId)
    if (!events) return
    pendingEvents.delete(jobId)
    for (const job of events) dispatchUnhandledJob(job)
  }

  /** 绑定后按序 replay 先到事件（此时 patchGenByJob 能按 gen.jobId 命中） */
  const replayPendingEvents = (jobId: string) => {
    const events = pendingEvents.get(jobId)
    if (!events) return
    pendingEvents.delete(jobId)
    for (const job of events) handleJobEvent(job)
  }

  const notifyJobWaiters = (job: MediaJobStatus, version: GenerateVersion | null) => {
    const waiters = jobWaiters.get(job.jobId)
    if (!waiters) return
    jobWaiters.delete(job.jobId)
    for (const waiter of waiters) {
      try {
        waiter(job, version)
      } catch (error) {
        console.error('[jobRuntime] 终态等待回调执行失败', error)
      }
    }
  }

  /* ------------- job 事件 → 卡片状态机 ------------- */

  const versionFromJob = (job: MediaJobStatus): GenerateVersion | null => {
    if (!job.artifact) return null
    // 落库目录（素材库映射）产物 = 工作区内普通文件；默认产物目录仍是 media 形态
    const storage = job.outputDir ? ('ws' as const) : ('media' as const)
    const path = job.outputDir
      ? normalizePath(`${job.outputDir.replace(/\/+$/, '')}/${job.artifact.relPath}`)
      : job.artifact.relPath
    return {
      id: crypto.randomUUID(),
      storage,
      path,
      // 只有 media 形态需要 pathRoot（它的 path 相对产物目录）；ws 形态的 path 已经是
      // 相对工作区根的完整路径，再带一个根就是双前缀陷阱
      ...(!job.outputDir && job.artifactDirRel ? { pathRoot: job.artifactDirRel } : {}),
      name: job.artifact.name,
      mime: job.artifact.mime,
      bytes: job.artifact.bytes,
      thumbnail: undefined,
      prompt: job.prompt,
      model: `${job.provider}:${job.model}`,
      // 产出该版本的真实任务 id：重复终态事件/对账按它去重
      jobId: job.jobId,
      createdAt: job.updatedAt
    }
  }

  /**
   * 事件应用与终态等待唤醒的唯一入口。返回 version 供链调度直接传递给下游
   * （真实捕获的 GenerateVersion，绝不事后读被切换的 activeVersion）。
   */
  const patchGenByJob = (job: MediaJobStatus): { handled: boolean; version: GenerateVersion | null } => {
    let handled = false
    let produced: GenerateVersion | null = null
    applyNodes((prev) =>
      prev.map((node) => {
        const data = node.data
        if (!data.gen || data.gen.jobId !== job.jobId) return node
        handled = true
        const gen = data.gen
        if (job.state === 'queued' || job.state === 'running') {
          return {
            ...node,
            data: {
              ...data,
              gen: {
                ...gen,
                status: job.state as AssetGen['status'],
                progress: job.progress,
                error: undefined,
                // 参考素材的处置留痕（哪条没进请求、为什么）；每次事件都按最新任务覆盖，
                // 新一轮提交没有 notes 时自然清空
                notes: job.notes
              }
            }
          }
        }
        if (job.state === 'succeeded') {
          const version = versionFromJob(job)
          if (!version) return node
          // 终态/重复事件只入一版：同 jobId（或同 path+createdAt 指纹）的产物已在版本列表里
          //（去重不限于最新一版 —— 迟到/乱序的旧任务终态事件同样只做幂等解绑）。重复事件也
          // 携带产物结论：把已有版本交给等待方（链调度/对账），二次对账不会误读成 null。
          const existing =
            gen.versions.find((v) => v.jobId === job.jobId) ??
            gen.versions.find((v) => v.path === version.path && v.createdAt === version.createdAt)
          if (existing) {
            produced = existing
            return {
              ...node,
              data: {
                ...data,
                gen: { ...gen, status: 'succeeded', progress: 1, jobId: undefined, pendingInputs: undefined }
              }
            }
          }
          produced = version
          // 输入快照绑定本次 job：不能拿生成完成时卡片上可能已被编辑的最新输入
          if (gen.pendingInputs) version.inputs = gen.pendingInputs
          return {
            ...node,
            data: {
              ...data,
              name: version.name,
              kind: job.kind,
              storage: version.storage,
              path: version.path,
              // 显式整体覆写：旧 media 卡新结果写 ws 时必须清掉残留 pathRoot（双前缀陷阱）
              pathRoot: version.pathRoot,
              mime: version.mime,
              bytes: version.bytes,
              // 产物落库后卡片归入对应素材库（提交时记下的落库目标）
              ...(job.outputDir && gen.params.libraryId ? { libraryId: gen.params.libraryId } : {}),
              gen: {
                ...gen,
                status: 'succeeded',
                progress: 1,
                error: undefined,
                notes: job.notes,
                // 终态即解绑任务：再次载入画布时对账不会重复入库同一产物；pending 上下文随之释放
                jobId: undefined,
                pendingInputs: undefined,
                // 比例标签对齐产物事实：图生图等场景可能不按请求比例出图，成功后按
                // 实际宽高反推（与工具结果回显同一 nearestMediaRatio），请求值不再冒充结果
                params: {
                  ...gen.params,
                  ...(job.artifact?.width && job.artifact?.height
                    ? {
                        ratio:
                          nearestMediaRatio(job.artifact.width, job.artifact.height) ??
                          gen.params.ratio
                      }
                    : {})
                },
                versions: [version, ...gen.versions],
                activeVersionId: version.id
              }
            }
          }
        }
        // failed / cancelled：卡片保留，错误可操作（可改提示词重试）；pending 上下文释放
        return {
          ...node,
          data: {
            ...data,
            gen: {
              ...gen,
              status: 'failed',
              error: job.error ?? (job.state === 'cancelled' ? '已取消' : '生成失败'),
              notes: job.notes,
              jobId: undefined,
              pendingInputs: undefined
            }
          }
        }
      })
    )
    if (handled) notifyJobWaiters(job, produced)
    return { handled, version: produced }
  }

  /** Agent 工具发起的任务：没有现成卡片 → 建一张生成卡片承接（落点按现有卡片错开） */
  const spawnGenCardForJob = (job: MediaJobStatus) => {
    // 同一 jobId 只建一张卡
    if (jobCardIndex.has(job.jobId)) return
    const id = newNodeId()
    jobCardIndex.set(job.jobId, id)
    zCounter.current += 1
    applyNodes((prev) => [
      ...prev,
      {
        id,
        type: 'asset',
        x: 140 + spawnOffset(prev),
        y: 120 + spawnOffset(prev) + 40,
        width: 320,
        height: 430,
        zIndex: zCounter.current,
        data: {
          name: `生成中 · ${job.model}`,
          kind: job.kind,
          fromChatId: job.sourceChatId,
          gen: {
            prompt: job.prompt,
            refs: [],
            // 任务协商后的真实参数优先（Agent 工具声明的 ratio/时长），
            // 手动路径没有 params 才回退设置默认值 —— 避免"Agent 说 1:1、卡片 16:9"的错位
            params: {
              ratio: job.params?.ratio ?? settingsBridgeRef.current?.mediaStatus?.defaultRatio ?? DEFAULT_MEDIA_RATIO,
              durationSeconds:
                job.params?.durationSeconds ??
                (job.kind === 'image'
                  ? undefined
                  : settingsBridgeRef.current?.mediaStatus?.defaultDuration ?? DEFAULT_MEDIA_DURATION_S),
              model: `${job.provider}:${job.model}`
            },
            status: job.state as AssetGen['status'],
            progress: job.progress,
            jobId: job.jobId,
            versions: []
          }
        } satisfies AssetData
      } satisfies CanvasNode
    ])
  }

  const handleJobEvent = (job: MediaJobStatus) => {
    const indexed = jobCardIndex.has(job.jobId)
    // 终态即解绑：卡片上的 jobId 由 patchGenByJob 清掉，同步索引在这里收尾
    if (isTerminalState(job.state)) jobCardIndex.delete(job.jobId)
    const { handled } = patchGenByJob(job)
    if (handled) {
      if (job.state === 'succeeded') showToast('生成完成，产物已写入工作目录')
      if (job.state === 'failed') showToast(`生成失败：${job.error ?? '未知原因'}`)
      return
    }
    // patch 没命中但索引命中（Agent 建卡与状态提交之间的瞬时差）：已有卡片承接，不缓冲不建卡
    if (indexed) return
    // 事件先于 IPC 返回（gen.jobId 还没绑定）：有提交在途就按 jobId 缓冲，绑定后 replay
    if (pendingSubmits.size > 0) {
      bufferPendingEvent(job)
      return
    }
    dispatchUnhandledJob(job)
  }

  /** 单任务对账：jobs() 里已终态但事件未到/丢失 → 就地收尾（去重保证不重复入库） */
  const reconcileSingleJob = async (jobId: string): Promise<JobTerminalOutcome | null> => {
    if (!BRIDGE_AVAILABLE) return null
    let result: Awaited<ReturnType<typeof window.huabu.media.jobs>>
    try {
      result = await window.huabu.media.jobs()
    } catch (error) {
      console.warn('[jobRuntime] 单任务对账异常：', error)
      return null
    }
    if (!result.ok) return null
    const job = result.value.find((j) => j.jobId === jobId)
    if (!job || !isTerminalState(job.state)) return null
    jobCardIndex.delete(jobId)
    const { version } = patchGenByJob(job)
    // patch 按 gen.jobId 匹配：若终态已被更早的事件应用（成功即解绑），二次 patch 不再
    // 命中任何卡 —— 按 jobId 从画布上找回已写入的真实产物版本，成功任务不得被读成 null
    //（否则生成链会把「上游已出图」误判为失败而中断）。
    const recovered =
      version ??
      (job.state === 'succeeded'
        ? (get().nodes.flatMap((n) => n.data.gen?.versions ?? []).find((v) => v.jobId === jobId) ?? null)
        : null)
    return {
      state: job.state,
      version: recovered,
      ...(job.error ? { error: job.error } : {})
    }
  }

  /**
   * 等一个任务到终态：事件驱动 + 有界兜底（3s/15s/60s 各一次 jobs() 对账、30min 总上限、
   * 工作区切换/参与卡被删除即唤醒）。超时不代表任务失败 —— 卡片仍持有 jobId 接收后续事件，
   * 只让等待方（生成链）按失败收尾、不再启动下游。语境失效型唤醒带 origin，供链调度
   * 区分「任务已终态」与「任务可能仍在跑、停止时须取消」。
   */
  const waitJobTerminal = (jobId: string): Promise<JobTerminalOutcome> =>
    new Promise((resolve) => {
      let settled = false
      const timers: ReturnType<typeof setTimeout>[] = []
      const finish = (outcome: JobTerminalOutcome) => {
        if (settled) return
        settled = true
        for (const timer of timers) clearTimeout(timer)
        resolve(outcome)
      }
      const waiters = jobWaiters.get(jobId) ?? []
      waiters.push((job, version) =>
        finish({ state: job.state, version, ...(job.error ? { error: job.error } : {}), origin: 'event' })
      )
      jobWaiters.set(jobId, waiters)
      const probe = async () => {
        if (settled || !BRIDGE_AVAILABLE) return
        let result: Awaited<ReturnType<typeof window.huabu.media.jobs>>
        try {
          result = await window.huabu.media.jobs()
        } catch {
          return // 对账失败不致命：等事件或下一次探测
        }
        if (!result.ok || settled) return
        const job = result.value.find((j) => j.jobId === jobId)
        if (job && isTerminalState(job.state)) {
          jobCardIndex.delete(jobId)
          // patch 会唤醒 waiter（notifyJobWaiters）→ finish
          patchGenByJob(job)
        }
      }
      for (const delay of JOB_PROBE_DELAYS_MS) {
        timers.push(setTimeout(() => void probe(), delay))
      }
      const workspacePath = get().workspace?.path
      timers.push(
        setInterval(() => {
          if (settled) return
          // 工作区切换 = 等待语境失效，唤醒调用方由其 guard 给出真实原因
          if (get().workspace?.path !== workspacePath) {
            finish({ state: 'failed', version: null, error: '工作区已切换', origin: 'workspace' })
            return
          }
          // 参与卡被删除（nodeOps 会同步清 jobCardIndex）：继续等待只会挂到超时，
          // 唤醒链调度停止并取消仍在跑的任务
          if (!jobCardIndex.has(jobId)) {
            finish({ state: 'failed', version: null, error: '任务卡片已被删除', origin: 'card-gone' })
          }
        }, WORKSPACE_WATCH_MS)
      )
      timers.push(
        setTimeout(() => {
          finish({
            state: 'failed',
            version: null,
            error: `等待任务事件超时（${Math.round(JOB_WAIT_TIMEOUT_MS / 60000)} 分钟）`,
            origin: 'timeout'
          })
        }, JOB_WAIT_TIMEOUT_MS)
      )
    })

  /** 画布（重）载入后对账：卡片引用的任务若已终态/失效则收尾 */
  const reconcileJobs = async () => {
    if (!BRIDGE_AVAILABLE) return
    let result: Awaited<ReturnType<typeof window.huabu.media.jobs>>
    try {
      result = await window.huabu.media.jobs()
    } catch (error) {
      console.warn('[jobRuntime] 任务对账异常：', error)
      return
    }
    if (!result.ok) return
    const byId = new Map(result.value.map((job) => [job.jobId, job]))
    for (const node of get().nodes) {
      const data = node.data
      const gen = data.gen
      const jobId = gen?.jobId
      if (!jobId || gen.status === 'idle') continue
      const job = byId.get(jobId)
      if (!job) {
        mutateNodeData(node.id, (d) => {
          if (!d.gen) return d
          return {
            ...d,
            gen: { ...d.gen, status: 'failed', error: '任务状态未知（可能来自其他工作区）' }
          }
        })
        continue
      }
      if (isTerminalState(job.state)) {
        jobCardIndex.delete(jobId)
        patchGenByJob(job)
      }
    }
  }

  /* ---------------- 生成：提交（并发上限/排队在主进程编排，卡片只认任务事件） ---------------- */

  /**
   * 卡片当前生效模型的参考配额（角色 + 总量）。判据与主进程闸门同源
   * （normalizeMediaCaps 从同一份能力声明派生），渲染端只做即时反馈，权威判定在提交时。
   */
  const refCapsFor = (data: AssetData): ResolvedRefCaps => {
    const kind = (data.kind as MediaKind) ?? 'image'
    const resolved = settingsBridgeRef.current?.resolveMediaModel(kind, data.gen?.params.model)
    const caps = resolved
      ? settingsBridgeRef.current?.mediaProviders
          ?.find((p) => p.id === resolved.provider)
          ?.models.find((m) => m.id === resolved.model)?.capabilities
      : undefined
    return normalizeMediaCaps(caps, kind)
  }

  /** 参考写入后清兼容残键：refs 里已不存在的 id 不许留在 refRoles */
  const pruneResidualRefKeys = (gen: AssetGen): AssetGen => {
    if (!gen.refRoles) return gen
    const keys = new Set(gen.refs)
    const entries = Object.entries(gen.refRoles).filter(([id]) => keys.has(id))
    if (entries.length === Object.keys(gen.refRoles).length) return gen
    return { ...gen, refRoles: Object.fromEntries(entries) }
  }

  /** 统一参考写入口：lib 负责同步 refs/refRoles（legacy 同步），这里只补残键清理 */
  const writeReferences = (gen: AssetGen, refs: GenerateReference[]): AssetGen =>
    pruneResidualRefKeys(withGenerateReferences(gen, refs))

  /** order 与数组下标对齐（增删/重排后统一重排） */
  const resequence = (refs: GenerateReference[]): GenerateReference[] =>
    refs.map((ref, index) => (ref.order === index ? ref : { ...ref, order: index }))

  const buildSubmitPlan = (
    node: CanvasNode,
    prompt: string
  ): { ok: true; plan: SubmitPlan } | { ok: false; error: string } => {
    const data = node.data
    const gen = data.gen
    if (!gen) return { ok: false, error: '该卡片不是可生成的媒体卡片' }
    const text = prompt.trim()
    if (!text) return { ok: false, error: '提示词为空' }
    const kind = (data.kind as MediaKind) ?? 'image'
    const resolved = settingsBridgeRef.current?.resolveMediaModel(kind, gen.params.model)
    if (!resolved) {
      return {
        ok: false,
        error: gen.params.model
          ? '卡片指定的模型已不可用（供应商或模型已变更），请在卡片参数里重新选择'
          : `未配置可用的${MEDIA_LABEL[kind]}生成模型，请到「设置 → 媒体生成」选择`
      }
    }
    const caps = refCapsFor(data)
    const nodes = get().nodes
    // 严格校验（缺失/路径/角色/数量/模式）：任何错误都不发起 IPC。
    // 尤其不允许"静默扔引用变 text-only"—— 挂了参考却提交不出参考必须是硬失败。
    const validation = validateGenerateReferences(node, nodes, caps)
    if (validation.errors.length > 0) {
      return { ok: false, error: `参考素材未通过校验：${validation.errors[0]}` }
    }
    // 冻结具体产物：提交时刻的 storage/path/pathRoot/mime/bytes 与源版本
    const nodesById = new Map(nodes.map((n) => [n.id, n]))
    const snapshots: GenerateRefSnapshot[] = []
    for (const ref of validation.references) {
      const source = nodesById.get(ref.sourceNodeId)
      if (!source) {
        return { ok: false, error: `参考素材源卡片已被删除（${REF_ROLE_LABEL[ref.role]}），请先移除这条参考` }
      }
      const sd = source.data
      if ((sd.storage !== 'media' && sd.storage !== 'ws') || !sd.path) {
        return { ok: false, error: `参考素材「${sd.name}」还没有可用产物，请先生成或导入` }
      }
      snapshots.push({
        referenceId: ref.id,
        sourceNodeId: ref.sourceNodeId,
        role: ref.role,
        sourceName: sd.name,
        ...(sd.gen?.activeVersionId ? { sourceVersionId: sd.gen.activeVersionId } : {}),
        storage: sd.storage,
        path: sd.path,
        ...(sd.pathRoot ? { pathRoot: sd.pathRoot } : {}),
        ...(sd.mime ? { mime: sd.mime } : {}),
        ...(sd.bytes != null ? { bytes: sd.bytes } : {})
      })
    }
    // 落库优先级链：卡片指定 > 类型默认 > 全局默认 > 公共库；命中素材库 → outputDir 落库
    const library = get().resolveOutputLibrary(kind, gen.params.libraryId)
    const snapshot: GenerateInputSnapshot = {
      prompt: text,
      params: { ...gen.params },
      provider: resolved.provider,
      model: resolved.model,
      refs: snapshots,
      createdAt: Date.now()
    }
    const resolveSnapshotPath = (ref: GenerateRefSnapshot): string =>
      ref.pathRoot ? `${ref.pathRoot.replace(/\/+$/, '')}/${ref.path}` : ref.path
    return {
      ok: true,
      plan: {
        nodeId: node.id,
        kind,
        provider: resolved.provider,
        model: resolved.model,
        prompt: text,
        ...(gen.params.ratio ? { ratio: gen.params.ratio } : {}),
        ...(gen.params.durationSeconds ? { durationSeconds: gen.params.durationSeconds } : {}),
        ...(library ? { outputDir: library.path, libraryName: library.name } : {}),
        refs: snapshots.map((ref) => ({ role: ref.role, path: resolveSnapshotPath(ref) })),
        snapshot
      }
    }
  }

  /**
   * 冻结计划提交：写 queued + pendingInputs → 注册在途 → IPC → 绑定 jobId →
   * replay 先到事件 → 单任务对账兜底。失败/绑定落空都会释放 pending 上下文。
   * IPC 在途期间请求的取消（cancelIntents）在绑定后立即执行，绝不留下无主付费任务。
   */
  const submitFrozen = async (plan: SubmitPlan, chainRunId?: string): Promise<SubmitResult> => {
    if (!BRIDGE_AVAILABLE) return { ok: false, error: BRIDGE_UNAVAILABLE }
    const { nodeId } = plan
    // 绑定前核对工作区身份：切换即回写落空，绝不把 jobId 绑到新工作区的画布上
    const workspacePath = get().workspace?.path ?? ''
    pendingSubmits.add(nodeId)
    try {
      mutateNodeData(nodeId, (d) => {
        if (!d.gen) return d
        return {
          ...d,
          gen: {
            ...d.gen,
            prompt: plan.prompt,
            status: 'queued',
            progress: 0,
            error: undefined,
            jobId: undefined,
            pendingInputs: plan.snapshot,
            chainRunId
          }
        }
      })
      let result: Awaited<ReturnType<typeof window.huabu.media.generate>>
      try {
        result = await window.huabu.media.generate({
          provider: plan.provider,
          model: plan.model,
          kind: plan.kind,
          prompt: plan.prompt,
          ...(plan.ratio ? { ratio: plan.ratio } : {}),
          ...(plan.durationSeconds ? { durationSeconds: plan.durationSeconds } : {}),
          nodeId,
          ...(plan.outputDir ? { outputDir: plan.outputDir } : {}),
          ...(plan.refs.length > 0 ? { refs: plan.refs } : {})
        })
      } catch (error) {
        result = { ok: false, code: 'unknown', error: `提交生成异常：${error instanceof Error ? error.message : String(error)}` }
      }
      if (!result.ok) {
        // 不清全局缓冲：并发提交的先到事件按 jobId 混存，全局释放会误伤其它在途任务；
        // 本提交的 jobId 不可知（大概率任务未创建），交由缓冲过期释放兜底
        cancelIntents.delete(nodeId)
        mutateNodeData(nodeId, (d) => {
          if (!d.gen) return d
          return { ...d, gen: { ...d.gen, status: 'failed', error: result.error, pendingInputs: undefined } }
        })
        return { ok: false, error: result.error }
      }
      const jobId = result.value.jobId
      // 绑定前确认卡片还在、工作区没切换：回写落空就取消刚启动的任务，绝不写到错卡
      if (!get().nodesById.get(nodeId)?.data.gen || (get().workspace?.path ?? '') !== workspacePath) {
        cancelIntents.delete(nodeId)
        flushPendingJob(jobId)
        void cancelJobSafe(jobId)
        return { ok: false, error: '卡片已不存在或工作区已切换，任务已在后台启动并尝试取消' }
      }
      mutateNodeData(nodeId, (d) => {
        if (!d.gen) return d
        return { ...d, gen: { ...d.gen, jobId } }
      })
      jobCardIndex.set(jobId, nodeId)
      // 先到事件按序 replay（含快速成功/失败），再对账兜底漏掉的事件
      replayPendingEvents(jobId)
      const outcome = await reconcileSingleJob(jobId)
      // IPC 在途期间的取消请求：绑定与对账完成后立即补取消。必须在绑定之后 —— 卡片要
      // 先持有 jobId，随后的 cancelled 事件才能正常收尾；也不能早于对账，否则对账会
      // 读到已取消态把绑定提前清掉。
      if (cancelIntents.delete(nodeId)) void cancelJobSafe(jobId)
      return { ok: true, jobId, ...(outcome ? { outcome } : {}) }
    } finally {
      pendingSubmits.delete(nodeId)
    }
  }

  const submitGeneration = async (nodeId: string, prompt: string) => {
    const node = get().nodesById.get(nodeId)
    const gen = node?.data.gen
    if (!node || !gen) return
    if (gen.status === 'queued' || gen.status === 'running') {
      showToast('该卡片正在生成中，等完成后再提交')
      return
    }
    // 与生成链互斥：链运行期链上卡片不允许单卡提交（配置已在链轮次冻结）
    const chainRun = get().chainRun
    if (chainRun?.status === 'running' && chainRun.nodeIds.includes(nodeId)) {
      showToast('该卡片正在生成链中执行，请先等链完成或取消')
      return
    }
    const plan = buildSubmitPlan(node, prompt)
    if (!plan.ok) {
      showToast(plan.error)
      return
    }
    const result = await submitFrozen(plan.plan)
    if (!result.ok) {
      showToast(`提交生成失败：${result.error}`)
      return
    }
    if (!result.outcome) {
      showToast(
        `已提交${MEDIA_LABEL[plan.plan.kind]}生成 → ${plan.plan.libraryName ?? '产物目录'} · ${plan.plan.provider} · ${shortModelLabel(plan.plan.provider, plan.plan.model)}`
      )
    }
  }

  /* ---------------- 生成：参考引用读写（统一走 lib，refs/refRoles/references 三方同步） ---------------- */

  const updateGenerate = (nodeId: string, patch: Partial<AssetGen>) => {
    // refs/refRoles 是既有脚本/UI 的 legacy 写入口：不能静默失效 ——
    // 权威 references 存在时 refRoles 补丁按 sourceNodeId 转换进 references（保首现身影射），
    // refs 全量替换则以 legacy 序列为新权威、清 references 懒重建（真实 caps）
    const touchesRefs = 'refs' in patch || 'refRoles' in patch
    if (!touchesRefs) {
      mutateNodeData(nodeId, (d) => (d.gen ? { ...d, gen: { ...d.gen, ...patch } } : d))
      return
    }
    const nodes = get().nodes
    const node = nodes.find((n) => n.id === nodeId)
    if (!node?.data.gen) return
    const prevGen = node.data.gen
    const prevReferences =
      Array.isArray(prevGen.references) && prevGen.references.length > 0 ? prevGen.references : null
    if (prevReferences && !('refs' in patch)) {
      const patchedRoles = patch.refRoles ?? {}
      let references = prevReferences
      for (const [sourceId, role] of Object.entries(patchedRoles)) {
        const index = references.findIndex((ref) => ref.sourceNodeId === sourceId)
        if (index >= 0) {
          references = references.map((ref, i) => (i === index ? { ...ref, role: role as MediaRefRole } : ref))
        }
      }
      mutateNodeData(nodeId, (d) => (d.gen ? { ...d, gen: writeReferences(d.gen, resequence(references)) } : d))
      return
    }
    const mergedGen: AssetGen = { ...prevGen, ...patch, references: undefined }
    const caps = refCapsFor({ ...node.data, gen: mergedGen })
    const references = getGenerateReferences({ ...node, data: { ...node.data, gen: mergedGen } }, nodes, caps)
    mutateNodeData(nodeId, (d) =>
      d.gen ? { ...d, gen: pruneResidualRefKeys({ ...mergedGen, references }) } : d
    )
  }

  const addGenerateRef = (nodeId: string, refId: string, role?: MediaRefRole) => {
    const nodes = get().nodes
    const node = nodes.find((n) => n.id === nodeId)
    const gen = node?.data.gen
    if (!node || !gen) return
    if (refId === nodeId) {
      showToast('不能把卡片自己加为自己的参考素材')
      return
    }
    const source = nodes.find((n) => n.id === refId)
    if (!source) {
      showToast('参考素材不存在（可能已被删除）')
      return
    }
    // 环禁止：参考方向是 source → node，若 node 已是 source 的（传递）上游则成环
    if (wouldCreateReferenceCycle(nodes, refId, nodeId)) {
      showToast('该连接会形成循环引用，已阻止')
      return
    }
    const caps = refCapsFor(node.data)
    const current = getGenerateReferences(node, nodes, caps)
    // 同 source+role 不重复；同 source 不同角色允许
    if (role) {
      if (current.some((ref) => ref.sourceNodeId === refId && ref.role === role)) {
        showToast('这条素材已经以该角色挂载了')
        return
      }
    } else if (current.some((ref) => ref.sourceNodeId === refId)) {
      showToast('这条素材已经在参考列表里（可在角色胶囊改角色）')
      return
    }
    const sourceKind = (source.data.kind as MediaKind) ?? 'image'
    const modelKind = (node.data.kind as MediaKind) ?? 'image'
    const resolvedRole = role ?? deriveRefRole(sourceKind, modelKind, current.length, caps.quota)
    if (!resolvedRole) {
      showToast('当前模型用不到这条参考素材（该模型没有这种媒体的参考输入）')
      return
    }
    // 组合可达性：加入（或替换单值角色）后的全体角色必须仍落在模型支持的用法内。
    // 显式角色不可达直接拦下；派生角色不可达时在同素材大类、有配额的角色里推荐合法方案，
    // 而不是把一个提交时必被校验拦死的结构挂上卡。
    const resultingRolesLegal = (candidate: MediaRefRole): boolean => {
      const roles = new Set(current.map((ref) => ref.role))
      const replacing = (caps.quota[candidate] ?? 0) === 1 && current.some((ref) => ref.role === candidate)
      if (!replacing) roles.add(candidate)
      if (roles.has('last_frame') && !roles.has('first_frame')) return false
      return inferMediaMode([...roles], modelKind, caps.modes) !== null
    }
    let chosenRole = resolvedRole
    if (!resultingRolesLegal(chosenRole)) {
      if (role) {
        showToast('调整后的参考组合不属于该模型支持的用法（首帧/首尾帧与参考类不能混用）')
        return
      }
      const alternative = MEDIA_REF_ROLES.find(
        (candidate) =>
          candidate !== chosenRole &&
          MEDIA_ROLE_KIND[candidate] === sourceKind &&
          (caps.quota[candidate] ?? 0) > 0 &&
          resultingRolesLegal(candidate)
      )
      if (!alternative) {
        showToast('当前模型的参考用法容纳不了这条素材的组合，请先调整已有参考的角色或数量')
        return
      }
      chosenRole = alternative
    }
    if (MEDIA_ROLE_KIND[chosenRole] !== sourceKind) {
      showToast(
        `${REF_ROLE_LABEL[chosenRole]}只能收${MEDIA_ROLE_KIND[chosenRole] === 'image' ? '图片' : MEDIA_ROLE_KIND[chosenRole] === 'video' ? '视频' : '音频'}素材，这条是${sourceKind === 'image' ? '图片' : sourceKind === 'video' ? '视频' : '音频'}`
      )
      return
    }
    const max = caps.quota[chosenRole] ?? 0
    if (max <= 0) {
      showToast(`当前模型不接受${REF_ROLE_LABEL[chosenRole]}参考`)
      return
    }
    const sameRole = current.filter((ref) => ref.role === chosenRole)
    if (sameRole.length >= max) {
      if (max === 1 && sameRole[0]) {
        // 首帧/尾帧等单值角色：新连接替换旧引用，旧引用完整保留（撤销可复原 role/order）
        const replaced = sameRole[0]
        const previous = current.map((ref) => ({ ...ref }))
        const replacedSource = nodes.find((n) => n.id === replaced.sourceNodeId)
        const nextRefs = resequence(
          current.map((ref) =>
            ref.id === replaced.id
              ? { id: newNodeId(), sourceNodeId: refId, role: chosenRole, order: ref.order }
              : ref
          )
        )
        mutateNodeData(nodeId, (d) => (d.gen ? { ...d, gen: writeReferences(d.gen, nextRefs) } : d))
        showToast(
          `已替换${REF_ROLE_LABEL[chosenRole]}参考：${replacedSource?.data.name ?? '原素材'} → ${source.data.name}`,
          {
            label: '撤销',
            onAction: () => {
              mutateNodeData(nodeId, (d) => (d.gen ? { ...d, gen: writeReferences(d.gen, previous) } : d))
            }
          }
        )
        return
      }
      showToast(`当前模型最多 ${max} 条${REF_ROLE_LABEL[chosenRole]}参考，先移除一条再添加`)
      return
    }
    if (caps.total > 0 && current.length >= caps.total) {
      showToast(`当前模型最多使用 ${caps.total} 条参考素材，先移除一条再添加`)
      return
    }
    const nextRefs = resequence([...current, { id: newNodeId(), sourceNodeId: refId, role: chosenRole, order: current.length }])
    mutateNodeData(nodeId, (d) => (d.gen ? { ...d, gen: writeReferences(d.gen, nextRefs) } : d))
    showToast('已加入参考（角色按当前模型派生，点卡片上的角色胶囊可改）')
  }

  const removeGenerateRef = (nodeId: string, refId: string) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node?.data.gen) return
    const caps = refCapsFor(node.data)
    const current = getGenerateReferences(node, get().nodes, caps)
    // referenceId 优先（同 source 多角色时不会误删全部）；兼容 legacy 按源节点 id 移除
    const byId = current.filter((ref) => ref.id === refId)
    const nextRefs = byId.length
      ? current.filter((ref) => ref.id !== refId)
      : current.filter((ref) => ref.sourceNodeId !== refId)
    if (nextRefs.length === current.length) return
    mutateNodeData(nodeId, (d) => (d.gen ? { ...d, gen: writeReferences(d.gen, resequence(nextRefs)) } : d))
  }

  const setGenerateRefRole = (nodeId: string, referenceId: string, role: MediaRefRole) => {
    const nodes = get().nodes
    const node = nodes.find((n) => n.id === nodeId)
    if (!node?.data.gen) return
    const caps = refCapsFor(node.data)
    const current = getGenerateReferences(node, nodes, caps)
    const target = current.find((ref) => ref.id === referenceId)
    if (!target) {
      showToast('参考条目不存在或已被移除')
      return
    }
    if (target.role === role) return
    const source = nodes.find((n) => n.id === target.sourceNodeId)
    if (!source) {
      showToast('参考源已缺失，请先移除这条参考再调整')
      return
    }
    const max = caps.quota[role] ?? 0
    if (max <= 0) {
      showToast(`当前模型不接受${REF_ROLE_LABEL[role]}参考`)
      return
    }
    const sourceKind = (source.data.kind as MediaKind) ?? 'image'
    if (MEDIA_ROLE_KIND[role] !== sourceKind) {
      showToast(`${REF_ROLE_LABEL[role]}只能收${MEDIA_ROLE_KIND[role] === 'image' ? '图片' : MEDIA_ROLE_KIND[role] === 'video' ? '视频' : '音频'}素材`)
      return
    }
    const others = current.filter((ref) => ref.id !== referenceId)
    const sameRoleCount = others.filter((ref) => ref.role === role).length
    if (sameRoleCount >= max) {
      showToast(`已有 ${sameRoleCount} 条${REF_ROLE_LABEL[role]}参考（该角色上限 ${max}），请先移除或改回`)
      return
    }
    // 改完的组合必须仍落在该模型支持的某个用法模式内（首帧/参考类互斥）
    const modelKind = (node.data.kind as MediaKind) ?? 'image'
    if (!inferMediaMode([...others.map((ref) => ref.role), role], modelKind, caps.modes)) {
      showToast('调整后的角色组合不属于该模型支持的用法（首帧/首尾帧与参考类不能混用）')
      return
    }
    const nextRefs = resequence(current.map((ref) => (ref.id === referenceId ? { ...ref, role } : ref)))
    mutateNodeData(nodeId, (d) => (d.gen ? { ...d, gen: writeReferences(d.gen, nextRefs) } : d))
    showToast(`已改为${REF_ROLE_LABEL[role]}`)
  }

  const moveGenerateRef = (nodeId: string, referenceId: string, direction: -1 | 1) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node?.data.gen) return
    const caps = refCapsFor(node.data)
    const current = getGenerateReferences(node, get().nodes, caps)
    let index = current.findIndex((ref) => ref.id === referenceId)
    // 兼容 legacy 调用传源节点 id
    if (index < 0) index = current.findIndex((ref) => ref.sourceNodeId === referenceId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return
    const next = [...current]
    ;[next[index], next[targetIndex]] = [next[targetIndex], next[index]]
    mutateNodeData(nodeId, (d) => (d.gen ? { ...d, gen: writeReferences(d.gen, resequence(next)) } : d))
  }

  /* ---------------- 生成：版本清理（running 防护） ---------------- */

  const isBusyGenerating = (nodeId: string): string | null => {
    const gen = get().nodesById.get(nodeId)?.data.gen
    if (gen && (gen.status === 'queued' || gen.status === 'running')) return '该卡片正在生成中'
    const chainRun = get().chainRun
    if (chainRun?.status === 'running' && chainRun.nodeIds.includes(nodeId)) return '该卡片正在生成链中执行'
    return null
  }

  const requestClearGenerateVersions = (nodeId: string) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node) return
    const data = node.data
    if (!data.gen) return
    const busy = isBusyGenerating(nodeId)
    if (busy) {
      showToast(`${busy}，暂不能清空版本`)
      return
    }
    set({
      confirm: {
        title: `清空「${data.name}」的全部版本？`,
        body: '版本记录清掉后找不回来（此操作不可逆）；各版本对应的文件仍留在工作目录。',
        confirmLabel: '清空结果',
        danger: true,
        onConfirm: () => clearGenerateVersions(nodeId)
      }
    })
  }

  const clearGenerateVersions = (nodeId: string) => {
    const busy = isBusyGenerating(nodeId)
    if (busy) {
      showToast(`${busy}，暂不能清空版本`)
      return
    }
    mutateNodeData(nodeId, (d) => {
      if (!d.gen) return d
      return {
        ...d,
        gen: { ...d.gen, versions: [], activeVersionId: undefined, status: 'idle', progress: 0, jobId: undefined, error: undefined }
      }
    })
    showToast('已清空结果（保留卡片）')
  }

  /* ---------------- 生成链调度（generationChain.ts） ---------------- */

  const bridge: JobRuntimeBridge = {
    refCapsFor,
    buildSubmitPlan,
    submitFrozen,
    waitJobTerminal,
    cancelJob: cancelJobSafe,
    requestSubmitCancel: (nodeId) => {
      // 只有提交真正在 IPC 途中才记意图（否则是误触，留着会误杀下一次提交）
      if (!pendingSubmits.has(nodeId)) return false
      cancelIntents.add(nodeId)
      return true
    },
    releaseCard: (nodeId, error) => {
      mutateNodeData(nodeId, (d) => {
        if (!d.gen) return d
        return {
          ...d,
          gen: {
            ...d.gen,
            status: 'failed',
            error,
            pendingInputs: undefined
          }
        }
      })
    }
  }

  const chain = createGenerationChain({
    set,
    get,
    showToast,
    mutateNodeData,
    bridge
  })

  return {
    handleJobEvent,
    reconcileJobs,
    submitGeneration,
    updateGenerate,
    addGenerateRef,
    removeGenerateRef,
    setGenerateRefRole,
    moveGenerateRef,
    clearGenerateVersions,
    requestClearGenerateVersions,
    runGenerationChain: chain.runGenerationChain,
    cancelGeneration: chain.cancelGeneration
  }
}
