import type { MediaJobStatus } from '@shared/ipc'
import { normalizeMediaCaps } from '@shared/media'
import type { MediaKind, MediaRefInput, MediaRatio, ResolvedRefCaps } from '@shared/media'
import { MEDIA_ROOT_REL } from '@shared/assets'
import { shortModelLabel } from '@shared/mediaResolve'
import { normalizePath } from '../../harness/assetCategories'
import { activeVersionOf, assignRefRoles, validateRefSet } from '../../lib/mediaReferenceGraph'
import type {
  AssetData,
  CanvasNode,
  GenerateInputSnapshot,
  GenerateParams,
  GenerateRefSnapshot,
  GenerateVersion
} from '../../types'
import type { CanvasState } from '../canvasStore'
import { BRIDGE_AVAILABLE, BRIDGE_UNAVAILABLE, MEDIA_LABEL, jobCardIndex, newNodeId, settingsBridgeRef, spawnOffset, zCounter } from './shared'
import type { StoreSet } from './chatRuntime'

/**
 * 生成任务域：生成是卡片的一种瞬时状态，产物即普通媒体卡 —— 任务事件驱动
 * data.pendingJob 的绑定/解除，成功时把产物写成新版本（含 inputs 定格）挂回卡片，
 * 引用链由生成事实自动派生（mediaReferenceGraph.getCardReferences），用户与
 * Agent 都不建链。四条主链路：
 *
 * - job 事件 → patchJobTerminal：queued/running 只进内存运行态（jobStates）；
 *   succeeded 写新版本 + inputs 并解绑；failed 保留 pendingJob（重试/重启对账要读）。
 *   同一 job 的终态/重复事件靠「jobId 或 path+createdAt」指纹只入一版。
 * - Agent 工具发起的任务没有现成卡片 → spawnCardForJob 建卡承接（贴着参考来源落位），
 *   终态时按 job.refs（主进程回执，含 absPath）反查来源卡补全 inputs —— Agent 生成
 *   也自动成链。
 * - 画布（重）载入后对账（reconcileJobs）：卡片 pendingJob 引用的任务若已终态/失效
 *   则收尾，在途则恢复运行态显示。
 * - 提交链（submitGeneration）：生成 Popover / 再次生成 / 失败重试共用 —— 提交前
 *   严格校验（错误不发起 IPC），冻结 GenerateInputSnapshot；快速成功事件早于 IPC
 *   返回时先按 jobId 缓冲、绑定后 replay。
 */

export interface JobRuntimeDeps {
  set: StoreSet
  get: () => CanvasState
  showToast: CanvasState['showToast']
  applyNodes: (fn: (prev: CanvasNode[]) => CanvasNode[]) => void
  mutateNodeData: (id: string, fn: (data: AssetData) => AssetData) => void
}

/** 卡片的生成运行态（内存，不落盘；渲染进度条/失败条/重试按钮） */
export interface JobCardRuntime {
  status: 'queued' | 'running' | 'failed' | 'succeeded'
  progress: number
  error?: string
  notes?: string[]
}

/** 一次直接生成请求（生成 Popover / 再次生成 / 失败重试共用入口） */
export interface GenerationRequest {
  kind: MediaKind
  prompt: string
  params: GenerateParams
  /** 参考来源卡（角色由系统按当前模型能力派生，用户不指定） */
  refs: string[]
  /** 就地加版本的目标卡（再次生成/重试）；缺省 = 生成新卡 */
  targetNodeId?: string
  /** 新卡落点（Popover 锚点；缺省 = 参考来源包围盒右侧，再缺省错开默认位） */
  at?: { x: number; y: number }
  fromChatId?: string
}

/** 一次提交的完整计划（冻结后的请求形态） */
interface SubmitPlan {
  nodeId: string
  kind: MediaKind
  provider: string
  model: string
  prompt: string
  ratio?: MediaRatio
  durationSeconds?: number
  outputDir?: string
  libraryName?: string
  /** 发给 IPC 的带角色参考（path 已按 pathRoot 还原为相对工作区根的完整路径） */
  refs: MediaRefInput[]
  /** 与请求同源的输入快照（终态写进 GenerateVersion.inputs，不随后续编辑漂移） */
  snapshot: GenerateInputSnapshot
}

/** 先到事件缓冲上限（只覆盖 IPC 在途的短暂窗口） */
const PENDING_EVENT_BUFFER_MAX = 64
const PENDING_EVENT_MAX_AGE_MS = 60_000

const isTerminalState = (state: MediaJobStatus['state']): boolean =>
  state === 'succeeded' || state === 'failed' || state === 'cancelled'

/** 卡片（或其历史版本）的工作区相对路径：media 形态 = pathRoot/path，ws 形态 = path */
const nodeRelPath = (ref: { storage?: string; path?: string; pathRoot?: string }): string | null => {
  if (!ref.path) return null
  return ref.storage === 'media' ? `${(ref.pathRoot ?? MEDIA_ROOT_REL).replace(/\/+$/, '')}/${ref.path}` : ref.path
}

/** path 反查索引：工作区相对路径 + 绝对路径（双键，各自带小写兜底） */
interface NodePathIndex {
  byRel: Map<string, CanvasNode>
  byRelLower: Map<string, CanvasNode>
  byAbs: Map<string, CanvasNode>
  byAbsLower: Map<string, CanvasNode>
}

export function createJobRuntime(deps: JobRuntimeDeps) {
  const { set, get, showToast, applyNodes, mutateNodeData } = deps

  /* ------------- 运行态（内存）：jobStates[nodeId] ------------- */

  const setJobState = (nodeId: string, state: JobCardRuntime | null) => {
    set((s) => {
      if (state === null) {
        if (!(nodeId in s.jobStates)) return s
        const next = { ...s.jobStates }
        delete next[nodeId]
        return { jobStates: next }
      }
      return { jobStates: { ...s.jobStates, [nodeId]: state } }
    })
  }

  /** 节点是否在途（提交/生成中） */
  const isNodeBusy = (nodeId: string): boolean => {
    const state = get().jobStates[nodeId]
    return state?.status === 'queued' || state?.status === 'running'
  }

  /* ------------- 提交在途状态：先到事件缓冲 ------------- */

  /** 有提交在 IPC 途中的卡片（事件先于 IPC 返回到达时按 jobId 缓冲，绑定后 replay） */
  const pendingSubmits = new Set<string>()
  /** jobId → 绑定前先到的事件（有序）；绑定/释放时消费 */
  const pendingEvents = new Map<string, MediaJobStatus[]>()

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
    if (job.sourceChatId && (job.state === 'queued' || job.state === 'running')) spawnCardForJob(job)
  }

  /**
   * 按 jobId 精确释放已知归属的缓冲（绑定落空时调用）。
   * 提交 IPC 失败时不能全局清缓冲 —— 并发提交的事件按 jobId 混存在同一张表里，
   * 全局释放会把其它在途提交的先到事件误分发给默认通道（Agent 来源会重复建卡）。
   * 失败场景下本提交的 jobId 不可知，交由过期释放（PENDING_EVENT_MAX_AGE_MS）兜底。
   */
  const flushPendingJob = (jobId: string) => {
    const events = pendingEvents.get(jobId)
    if (!events) return
    pendingEvents.delete(jobId)
    for (const job of events) dispatchUnhandledJob(job)
  }

  /** 绑定后按序 replay 先到事件（此时 patchJobTerminal 能按 pendingJob.jobId 命中） */
  const replayPendingEvents = (jobId: string) => {
    const events = pendingEvents.get(jobId)
    if (!events) return
    pendingEvents.delete(jobId)
    for (const job of events) handleJobEvent(job)
  }

  /* ------------- path 反查（Agent 生成自动成链） ------------- */

  const buildNodePathIndex = (): NodePathIndex => {
    const wsRoot = normalizePath(get().workspace?.path ?? '').replace(/\/+$/, '')
    const index: NodePathIndex = {
      byRel: new Map(),
      byRelLower: new Map(),
      byAbs: new Map(),
      byAbsLower: new Map()
    }
    for (const node of get().nodes) {
      const rel = nodeRelPath(node.data)
      if (!rel) continue
      const relNorm = normalizePath(rel)
      if (!index.byRel.has(relNorm)) index.byRel.set(relNorm, node)
      index.byRelLower.set(relNorm.toLowerCase(), node)
      if (wsRoot) {
        const abs = `${wsRoot}/${relNorm}`
        if (!index.byAbs.has(abs)) index.byAbs.set(abs, node)
        index.byAbsLower.set(abs.toLowerCase(), node)
      }
    }
    return index
  }

  const resolveRefNode = (
    ref: { path?: string; absPath?: string; url?: string },
    index: NodePathIndex
  ): CanvasNode | undefined => {
    if (ref.absPath) {
      const abs = normalizePath(ref.absPath)
      const hit = index.byAbs.get(abs) ?? index.byAbsLower.get(abs.toLowerCase())
      if (hit) return hit
    }
    if (ref.path) {
      const rel = normalizePath(ref.path)
      return index.byRel.get(rel) ?? index.byRelLower.get(rel.toLowerCase())
    }
    return undefined
  }

  /**
   * Agent 任务的输入定格重建：job.refs 回执（role + 定位路径）反查来源卡 →
   * GenerateRefSnapshot。查不到（画布外/临时上传文件）→ sourceNodeId 缺省，
   * 历史与文件落点保留、链条不画。
   */
  const buildInputsFromJob = (job: MediaJobStatus): GenerateInputSnapshot | undefined => {
    const index = buildNodePathIndex()
    const refs: GenerateRefSnapshot[] = []
    for (const ref of job.refs ?? []) {
      const label = ref.path ?? ref.url ?? '参考素材'
      const referenceId = `${job.jobId}:${ref.role}:${label}`
      const source = resolveRefNode(ref, index)
      if (source) {
        const sd = source.data
        const activeId = activeVersionOf(source)?.id
        refs.push({
          referenceId,
          sourceNodeId: source.id,
          role: ref.role,
          sourceName: sd.name,
          ...(activeId ? { sourceVersionId: activeId } : {}),
          storage: sd.storage ?? 'ws',
          path: sd.path ?? label,
          ...(sd.pathRoot ? { pathRoot: sd.pathRoot } : {}),
          ...(sd.mime ? { mime: sd.mime } : {}),
          ...(sd.bytes != null ? { bytes: sd.bytes } : {})
        })
      } else {
        refs.push({
          referenceId,
          role: ref.role,
          sourceName: label.split('/').pop() ?? label,
          storage: 'ws',
          path: ref.path ?? label
        })
      }
    }
    return {
      prompt: job.prompt,
      params: {
        ratio: job.params?.ratio,
        durationSeconds: job.params?.durationSeconds,
        model: `${job.provider}:${job.model}`
      },
      provider: job.provider,
      model: job.model,
      refs,
      createdAt: new Date(job.createdAt).getTime() || Date.now()
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
   * 事件应用的唯一入口。data.pendingJob.jobId 是绑定契约；queued/running 只更新
   * 内存运行态（不动节点数据，自动保存不被进度事件骚扰），终态才写卡片。
   */
  const patchJobTerminal = (job: MediaJobStatus): { handled: boolean; version: GenerateVersion | null } => {
    let handled = false
    let produced: GenerateVersion | null = null
    // holder 模式：闭包内的赋值不被控制流分析追踪，须经对象属性读回
    const runtimeRef: { current: { id: string; state: JobCardRuntime | null } | null } = { current: null }
    applyNodes((prev) =>
      prev.map((node) => {
        const pending = node.data.pendingJob
        if (!pending || pending.jobId !== job.jobId) return node
        handled = true
        if (job.state === 'queued' || job.state === 'running') {
          runtimeRef.current = { id: node.id, state: { status: job.state, progress: job.progress, notes: job.notes } }
          return node
        }
        if (job.state === 'succeeded') {
          const version = versionFromJob(job)
          if (!version) {
            runtimeRef.current = { id: node.id, state: { status: 'failed', progress: 0, error: '任务成功但没有产物', notes: job.notes } }
            return { ...node, data: { ...node.data, pendingJob: undefined } }
          }
          // 输入定格：画布提交的冻结快照优先；Agent 任务从 job.refs 回执反查重建
          const inputs = pending.inputs ?? buildInputsFromJob(job)
          if (inputs) version.inputs = inputs
          const versions = node.data.versions ?? []
          // 终态/重复事件只入一版：同 jobId（或同 path+createdAt 指纹）的产物已在版本列表里
          const existing =
            versions.find((v) => v.jobId === job.jobId) ??
            versions.find((v) => v.path === version.path && v.createdAt === version.createdAt)
          if (existing) {
            produced = existing
            runtimeRef.current = { id: node.id, state: null }
            return { ...node, data: { ...node.data, pendingJob: undefined } }
          }
          produced = version
          runtimeRef.current = { id: node.id, state: null }
          return {
            ...node,
            data: {
              ...node.data,
              name: version.name,
              kind: job.kind,
              storage: version.storage,
              path: version.path,
              // 显式整体覆写：旧 media 卡新结果写 ws 时必须清掉残留 pathRoot（双前缀陷阱）
              pathRoot: version.pathRoot,
              mime: version.mime,
              bytes: version.bytes,
              // 产物落库后卡片归入对应素材库（提交时记下的落库目标）
              ...(job.outputDir && inputs?.params.libraryId ? { libraryId: inputs.params.libraryId } : {}),
              pendingJob: undefined,
              versions: [version, ...versions],
              activeVersionId: version.id
            }
          }
        }
        // failed / cancelled：卡片保留 + pendingJob 保留（失败重试与重启对账都读它），
        // 失败态进内存运行态（卡面出重试/移除占位卡）
        runtimeRef.current = {
          id: node.id,
          state: {
            status: 'failed',
            progress: 0,
            error: job.error ?? (job.state === 'cancelled' ? '已取消' : '生成失败'),
            notes: job.notes
          }
        }
        return node
      })
    )
    if (runtimeRef.current) setJobState(runtimeRef.current.id, runtimeRef.current.state)
    return { handled, version: produced }
  }

  /** 新建一张产物卡（生成占位）：落点贴参考来源右侧，链条视觉上自然成形 */
  const spawnGenerationCard = (opts: {
    kind: MediaKind
    modelLabel: string
    at?: { x: number; y: number }
    sources?: readonly CanvasNode[]
    fromChatId?: string
  }): string => {
    const id = newNodeId()
    zCounter.current += 1
    const sources = opts.sources?.filter(Boolean) ?? []
    let x: number
    let y: number
    if (sources.length > 0) {
      const right = Math.max(...sources.map((n) => n.x + n.width))
      const top = Math.min(...sources.map((n) => n.y))
      const bottom = Math.max(...sources.map((n) => n.y + n.height))
      x = right + 90
      y = Math.max(40, (top + bottom) / 2 - 160)
    } else if (opts.at) {
      x = opts.at.x
      y = opts.at.y
    } else {
      const offset = spawnOffset(get().nodes)
      x = 140 + offset
      y = 120 + offset + 40
    }
    applyNodes((prev) => [
      ...prev,
      {
        id,
        type: 'asset',
        x,
        y,
        width: 280,
        height: 320,
        zIndex: zCounter.current,
        data: {
          name: `生成中 · ${opts.modelLabel}`,
          kind: opts.kind,
          ...(opts.fromChatId ? { fromChatId: opts.fromChatId } : {})
        } satisfies AssetData
      } satisfies CanvasNode
    ])
    return id
  }

  /** Agent 工具发起的任务：没有现成卡片 → 建一张媒体卡承接（同一 jobId 只建一张） */
  const spawnCardForJob = (job: MediaJobStatus) => {
    if (jobCardIndex.has(job.jobId)) return
    // 参考来源反查：新卡贴着参考卡落位，引用链一出现就在视觉上成立
    const index = buildNodePathIndex()
    const sources = (job.refs ?? [])
      .map((ref) => resolveRefNode(ref, index))
      .filter((n): n is CanvasNode => Boolean(n))
    const id = spawnGenerationCard({
      kind: job.kind,
      modelLabel: shortModelLabel(job.provider, job.model),
      sources,
      fromChatId: job.sourceChatId
    })
    jobCardIndex.set(job.jobId, id)
    mutateNodeData(id, (d) => ({ ...d, pendingJob: { jobId: job.jobId } }))
    setJobState(id, { status: job.state === 'running' ? 'running' : 'queued', progress: job.progress, notes: job.notes })
  }

  const handleJobEvent = (job: MediaJobStatus) => {
    const indexed = jobCardIndex.has(job.jobId)
    // 终态即解绑：索引收尾（卡上的 pendingJob 由 patchJobTerminal 处理）
    if (isTerminalState(job.state)) jobCardIndex.delete(job.jobId)
    const { handled } = patchJobTerminal(job)
    if (handled) {
      if (job.state === 'succeeded') showToast('生成完成，产物已写入工作目录')
      if (job.state === 'failed') showToast(`生成失败：${job.error ?? '未知原因'}`)
      return
    }
    // patch 没命中但索引命中（Agent 建卡与绑定之间的瞬时差）：已有卡片承接，不缓冲不建卡
    if (indexed) return
    // 事件先于 IPC 返回（pendingJob.jobId 还没绑定）：有提交在途就按 jobId 缓冲，绑定后 replay
    if (pendingSubmits.size > 0) {
      bufferPendingEvent(job)
      return
    }
    dispatchUnhandledJob(job)
  }

  /** 单任务对账：jobs() 里已终态但事件未到/丢失 → 就地收尾（去重保证不重复入库） */
  const probeJobOnce = async (jobId: string) => {
    if (!BRIDGE_AVAILABLE) return
    let result: Awaited<ReturnType<typeof window.huabu.media.jobs>>
    try {
      result = await window.huabu.media.jobs()
    } catch (error) {
      console.warn('[jobRuntime] 单任务对账异常：', error)
      return
    }
    if (!result.ok) return
    const job = result.value.find((j) => j.jobId === jobId)
    if (job && isTerminalState(job.state)) {
      jobCardIndex.delete(jobId)
      patchJobTerminal(job)
    }
  }

  /** 画布（重）载入后对账：pendingJob 引用的任务已终态/失效则收尾，在途则恢复运行态 */
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
      const jobId = node.data.pendingJob?.jobId
      if (!jobId) continue
      const job = byId.get(jobId)
      if (!job) {
        setJobState(node.id, { status: 'failed', progress: 0, error: '任务状态未知（可能来自其他工作区）' })
        continue
      }
      if (isTerminalState(job.state)) {
        jobCardIndex.delete(jobId)
        patchJobTerminal(job)
      } else if (job.state === 'queued' || job.state === 'running') {
        setJobState(node.id, { status: job.state, progress: job.progress, notes: job.notes })
      }
    }
  }

  /* ---------------- 生成：提交（并发上限/排队在主进程编排，卡片只认任务事件） ---------------- */

  /**
   * 指定模型的参考配额（角色 + 总量）。判据与主进程闸门同源（normalizeMediaCaps
   * 从同一份能力声明派生），渲染端只做即时反馈，权威判定在提交时。
   */
  const mediaCapsFor = (kind: MediaKind, modelId?: string): ResolvedRefCaps => {
    const resolved = settingsBridgeRef.current?.resolveMediaModel(kind, modelId)
    const caps = resolved
      ? settingsBridgeRef.current?.mediaProviders
          ?.find((p) => p.id === resolved.provider)
          ?.models.find((m) => m.id === resolved.model)?.capabilities
      : undefined
    return normalizeMediaCaps(caps, kind)
  }

  /** 冻结一条参考的产物落点（提交时刻的 storage/path/pathRoot 与源版本） */
  const snapshotRef = (
    ref: { id: string; sourceNodeId: string; role: GenerateRefSnapshot['role'] },
    nodesById: Map<string, CanvasNode>
  ): GenerateRefSnapshot | { error: string } => {
    const source = nodesById.get(ref.sourceNodeId)
    if (!source) {
      return { error: '参考素材源卡片已被删除，请先移除这条参考' }
    }
    const sd = source.data
    if ((sd.storage !== 'media' && sd.storage !== 'ws') || !sd.path) {
      return { error: `参考素材「${sd.name}」还没有可用产物，请先生成或导入` }
    }
    const activeId = activeVersionOf(source)?.id
    return {
      referenceId: ref.id,
      sourceNodeId: ref.sourceNodeId,
      role: ref.role,
      sourceName: sd.name,
      ...(activeId ? { sourceVersionId: activeId } : {}),
      storage: sd.storage,
      path: sd.path,
      ...(sd.pathRoot ? { pathRoot: sd.pathRoot } : {}),
      ...(sd.mime ? { mime: sd.mime } : {}),
      ...(sd.bytes != null ? { bytes: sd.bytes } : {})
    }
  }

  /**
   * 直接生成入口（生成 Popover / 再次生成 / 失败重试共用）：
   * 校验 → 冻结 inputs → 落目标卡（新建或就地）→ IPC 提交 → 绑定 pendingJob。
   * 返回 ok=false 时 Popover 保持打开（错误 toast 已发）；ok=true 附带目标卡 id。
   */
  const submitGeneration = async (request: GenerationRequest): Promise<{ ok: boolean; error?: string; nodeId?: string }> => {
    if (!BRIDGE_AVAILABLE) {
      showToast(BRIDGE_UNAVAILABLE)
      return { ok: false, error: BRIDGE_UNAVAILABLE }
    }
    const text = request.prompt.trim()
    if (!text) {
      showToast('提示词为空')
      return { ok: false, error: '提示词为空' }
    }
    const kind = request.kind
    const resolved = settingsBridgeRef.current?.resolveMediaModel(kind, request.params.model)
    if (!resolved) {
      // 媒体配置强制化：默认模型未显式选择/已失效 ⇒ 拦截并给「去设置」直达（openSettings 经 bridge 注入）
      const error = request.params.model
        ? '指定的模型已不可用（供应商或模型已变更），请重新选择'
        : `${MEDIA_LABEL[kind]}默认模型未选择：请在「设置 → 媒体生成」为${MEDIA_LABEL[kind]}选择默认模型后重试`
      showToast(error, { label: '去设置', onAction: () => settingsBridgeRef.current?.openSettings('media') })
      return { ok: false, error }
    }
    const nodes = get().nodes
    const nodesById = new Map(nodes.map((n) => [n.id, n]))
    // 参考角色由系统派生（用户只选卡，不指定角色）
    const sourceNodes = request.refs
      .map((id) => nodesById.get(id))
      .filter((n): n is CanvasNode => Boolean(n))
    const dedupedRefs = [...new Set(request.refs)]
    if (dedupedRefs.length !== request.refs.length) {
      showToast('参考素材里有重复的卡片，已自动去重')
    }
    const caps = mediaCapsFor(kind, request.params.model)
    const refs = assignRefRoles(request.targetNodeId ?? 'new', sourceNodes, kind, caps)
    // 严格校验（缺失/路径/角色/数量/模式）：任何错误都不发起 IPC。
    const validation = validateRefSet(kind, refs, nodes, caps)
    if (validation.errors.length > 0) {
      const error = `参考素材未通过校验：${validation.errors[0]}`
      showToast(error)
      return { ok: false, error }
    }
    const snapshots: GenerateRefSnapshot[] = []
    for (const ref of refs) {
      const snap = snapshotRef(ref, nodesById)
      if ('error' in snap) {
        showToast(snap.error)
        return { ok: false, error: snap.error }
      }
      snapshots.push(snap)
    }
    // 落库优先级链：卡片指定 > 类型默认 > 全局默认 > 公共库
    const library = get().resolveOutputLibrary(kind, request.params.libraryId)
    const snapshot: GenerateInputSnapshot = {
      prompt: text,
      params: { ...request.params },
      provider: resolved.provider,
      model: resolved.model,
      refs: snapshots,
      createdAt: Date.now()
    }
    // 目标卡：再次生成/重试就地；否则新建产物卡（贴参考来源落位）
    let targetId = request.targetNodeId
    if (targetId) {
      if (!get().nodesById.get(targetId)) {
        showToast('目标卡片不存在或已被删除')
        return { ok: false, error: '目标卡片不存在或已被删除' }
      }
      if (isNodeBusy(targetId)) {
        showToast('该卡片正在生成中，等完成后再提交')
        return { ok: false, error: '该卡片正在生成中' }
      }
    } else {
      targetId = spawnGenerationCard({
        kind,
        modelLabel: shortModelLabel(resolved.provider, resolved.model),
        at: request.at,
        sources: sourceNodes,
        fromChatId: request.fromChatId
      })
    }
    const plan: SubmitPlan = {
      nodeId: targetId,
      kind,
      provider: resolved.provider,
      model: resolved.model,
      prompt: text,
      ...(request.params.ratio ? { ratio: request.params.ratio } : {}),
      ...(request.params.durationSeconds ? { durationSeconds: request.params.durationSeconds } : {}),
      ...(library ? { outputDir: library.path, libraryName: library.name } : {}),
      refs: snapshots.map((ref) => ({
        role: ref.role,
        path: ref.pathRoot ? `${ref.pathRoot.replace(/\/+$/, '')}/${ref.path}` : ref.path
      })),
      snapshot
    }
    const result = await submitPlan(plan)
    if (!result.ok) {
      showToast(`提交生成失败：${result.error}`)
      return { ok: false, error: result.error }
    }
    showToast(
      `已提交${MEDIA_LABEL[kind]}生成 → ${library?.name ?? '产物目录'} · ${resolved.provider} · ${shortModelLabel(resolved.provider, resolved.model)}`
    )
    return { ok: true, nodeId: targetId }
  }

  /** 冻结计划提交：绑 pendingJob（jobId 先空占位）→ IPC → 回填 jobId → replay 先到事件 */
  const submitPlan = async (plan: SubmitPlan): Promise<{ ok: true } | { ok: false; error: string }> => {
    const { nodeId } = plan
    // 绑定前核对工作区身份：切换即回写落空，绝不把任务绑到新工作区的画布上
    const workspacePath = get().workspace?.path ?? ''
    pendingSubmits.add(nodeId)
    try {
      mutateNodeData(nodeId, (d) => ({ ...d, pendingJob: { jobId: '', inputs: plan.snapshot } }))
      setJobState(nodeId, { status: 'queued', progress: 0 })
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
        mutateNodeData(nodeId, (d) => ({ ...d, pendingJob: undefined }))
        setJobState(nodeId, { status: 'failed', progress: 0, error: result.error })
        return { ok: false, error: result.error }
      }
      const jobId = result.value.jobId
      // 绑定前确认卡片还在、工作区没切换：回写落空就取消刚启动的任务，绝不写到错卡
      if (!get().nodesById.get(nodeId) || (get().workspace?.path ?? '') !== workspacePath) {
        flushPendingJob(jobId)
        try {
          await window.huabu.media.cancel(jobId)
        } catch (error) {
          console.warn('[jobRuntime] 取消孤儿任务失败：', error)
        }
        return { ok: false, error: '卡片已不存在或工作区已切换，任务已在后台启动并尝试取消' }
      }
      mutateNodeData(nodeId, (d) => {
        if (!d.pendingJob) return d
        return { ...d, pendingJob: { ...d.pendingJob, jobId } }
      })
      jobCardIndex.set(jobId, nodeId)
      // 先到事件按序 replay（含快速成功/失败），再对账兜底漏掉的事件
      replayPendingEvents(jobId)
      void probeJobOnce(jobId)
      return { ok: true }
    } finally {
      pendingSubmits.delete(nodeId)
    }
  }

  /** 失败重试：按 pendingJob 里定格的输入快照重新提交（新任务、同目标卡） */
  const retryGeneration = async (nodeId: string) => {
    const node = get().nodesById.get(nodeId)
    const inputs = node?.data.pendingJob?.inputs
    if (!node || !inputs) {
      showToast('没有可重试的生成请求')
      return
    }
    if (isNodeBusy(nodeId)) {
      showToast('该卡片正在生成中')
      return
    }
    await submitGeneration({
      kind: (node.data.kind as MediaKind) ?? 'image',
      prompt: inputs.prompt,
      params: inputs.params,
      refs: inputs.refs.filter((r) => r.sourceNodeId).map((r) => r.sourceNodeId as string),
      targetNodeId: nodeId
    })
  }

  /* ---------------- 版本清理（在途防护） ---------------- */

  const clearGenerateVersions = (nodeId: string) => {
    if (isNodeBusy(nodeId)) {
      showToast('该卡片正在生成中，暂不能清空版本')
      return
    }
    mutateNodeData(nodeId, (d) => ({
      ...d,
      versions: undefined,
      activeVersionId: undefined,
      pendingJob: undefined,
      // 历史清掉后引用链（从 inputs 派生）随之消失；legacy 手动链也一并清
      references: undefined,
      refs: undefined,
      refRoles: undefined
    }))
    showToast('已清空生成历史（保留卡片与当前文件）')
  }

  const requestClearGenerateVersions = (nodeId: string) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node) return
    if (isNodeBusy(nodeId)) {
      showToast('该卡片正在生成中，暂不能清空版本')
      return
    }
    set({
      confirm: {
        title: `清空「${node.data.name}」的生成历史？`,
        body: '全部版本记录与引用链将消失（此操作不可逆）；各版本对应的文件仍留在工作目录，卡片继续引用当前文件。',
        confirmLabel: '清空历史',
        danger: true,
        onConfirm: () => clearGenerateVersions(nodeId)
      }
    })
  }

  return {
    handleJobEvent,
    reconcileJobs,
    submitGeneration,
    retryGeneration,
    mediaCapsFor,
    clearGenerateVersions,
    requestClearGenerateVersions
  }
}
