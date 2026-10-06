import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs'
import { basename, relative, resolve, sep } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { MediaArtifact, MediaGenerateRequest, MediaJobState, MediaJobStatus, MediaProviderInfo } from '../../shared/media'
import { DEFAULT_MEDIA_CONCURRENCY, ratioToPixels } from '../../shared/media'
import type { WorkspaceMediaConfig } from '../workspace/store'
import { atomicWriteSync, recoverAtomicBackup } from '../fsutil/atomic'
import type { AdapterProviderConfig } from './adapters/registry'
import { imageSizeOf } from './imageSize'
import type { ProviderSubmitInput } from './provider'
import { extForUrl, mimeForKind, type MediaProviderAdapter } from './provider'

/**
 * MediaJobManager：媒体生成任务的异步编排（M11）。
 *
 * 与聊天的同步流式不同，媒体生成是 submit -> task_id -> poll -> 媒体 URL -> 下载落盘。
 * 本类负责：队列并发上限、轮询指数退避、整体超时、取消、产物原子落盘、
 * 状态事件推送（media:job）、重启后未完成任务标记失效（jobs.json 对账）。
 *
 * 产物一律落到当前工作区 `.huabu/media/<jobId><ext>`，用临时 .part 文件写完再改名
 * ——强杀进程也不会留下半截媒体文件被当成品。
 */

const POLL_BASE_MS = 1200
const POLL_BACKOFF = 1.5
const POLL_MAX_MS = 10_000
/** 整体超时：视频最长（网关排队+生成可达十几分钟） */
const TIMEOUT_MS: Record<string, number> = { image: 240_000, audio: 300_000, video: 900_000 }

/** jobs 账本里终态任务最多保留条数（按 updatedAt 淘汰更早的，防跨会话只进不出） */
const TERMINAL_JOBS_KEEP = 50

interface JobRecord {
  status: MediaJobStatus
  /** provider 侧任务标识（如 minimax 为 `mm-video|task_id`、dashscope 为 `model|task_id`） */
  remoteId?: string
  adapter: MediaProviderAdapter
  /** 规范化的生成参数（runJob 提交时用） */
  input: ProviderSubmitInput
  /** cancel 请求置位后，轮询循环收尾时落 cancelled 态 */
  cancelRequested?: boolean
  /** 本任务的落库目录（绝对路径；缺省 = 媒体产物目录），submit 时校验过越界 */
  outputDirAbs?: string
  /** 净化后的产物文件主名（不含扩展名）；缺省 = jobId（随机 id 命名） */
  artifactName?: string
}

type WritableJobState = MediaJobStatus['state']

export class MediaJobManager {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly running = new Set<string>()
  private readonly pending: string[] = []
  /** waitForCompletion 的订阅者（patch 时全量通知，订阅者自行按 jobId/终态过滤） */
  private readonly waiters = new Set<(job: MediaJobStatus) => void>()

  constructor(
    private readonly emit: (job: MediaJobStatus) => void,
    private readonly context: () => {
      /** 当前工作区媒体目录（绝对路径），未打开工作区时为 null */
      mediaDir: string | null
      /** 当前工作区根（绝对路径），落库目录越界校验用 */
      workspaceDir: string | null
      config: WorkspaceMediaConfig
      /** 合并清单（内置目录 + 用户覆盖层），清单展示与提交校验的事实来源 */
      providers: AdapterProviderConfig[]
      /** 已实例化的适配器（按合并清单顺序） */
      adapters: MediaProviderAdapter[]
      /** 提交前校验：工作区是否可用 */
      ready: boolean
      /** 素材库内容有变化的广播（产物落进库目录后调用，渲染端据此刷新素材库面板） */
      notifyAssetsChanged: () => void
    }
  ) {}

  /* ------------------------------------------------------------------ */
  /* 查询与清单                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 生效供应商清单（网关用异步 isReady，设置页绿点才真实）。
   * 全部来自合并目录（内置 + 用户覆盖层），按清单顺序列出。
   */
  async providers(): Promise<MediaProviderInfo[]> {
    const list: MediaProviderInfo[] = []
    for (const adapter of this.adapters()) {
      // 凭据探测要解密存储/查环境变量，逐个 await（清单最多几家，串行可忽略）
      const ready = adapter.isReady ? await adapter.isReady() : adapter.isConfigured()
      const conf = this.context().providers.find((p) => p.id === adapter.id)
      list.push({
        id: adapter.id,
        label: adapter.label,
        type: adapter.type,
        source: conf?.source,
        configured: ready,
        authHint: adapter.authHint(),
        models: [...adapter.models]
      })
    }
    return list
  }

  private adapters(): MediaProviderAdapter[] {
    return this.context().adapters
  }

  list(): MediaJobStatus[] {
    return [...this.jobs.values()].map((job) => ({ ...job.status }))
  }

  get(jobId: string): MediaJobStatus | undefined {
    const job = this.jobs.get(jobId)
    return job ? { ...job.status } : undefined
  }

  /* ------------------------------------------------------------------ */
  /* 提交 / 取消                                                          */
  /* ------------------------------------------------------------------ */

  async submit(request: MediaGenerateRequest): Promise<{ jobId: string }> {
    const ctx = this.context()
    if (!ctx.ready || !ctx.mediaDir) throw new Error('尚未打开工作区，无法提交媒体生成任务')
    const mediaDir = ctx.mediaDir
    const prompt = request.prompt?.trim()
    if (!prompt) throw new Error('生成提示词不能为空')
    const adapter = this.adapters().find((a) => a.id === request.provider)
    if (!adapter) throw new Error(`未知媒体 provider：${request.provider}`)
    const model = adapter.models.find((m) => m.id === request.model)
    if (!model) throw new Error(`provider ${request.provider} 下没有模型 ${request.model}（清单见 media:providers）`)
    if (model.kind !== request.kind) {
      throw new Error(`模型 ${model.id} 是 ${model.kind} 生成，不能用于 ${request.kind}`)
    }
    if (!adapter.isConfigured()) {
      throw new Error(`provider ${adapter.label} 未配置凭据，请先在设置面板录入`)
    }

    // 参数协商的唯一收口点（此前散在渲染端 RATIO_SIZE 与各适配器三处）：
    // 调用方传语义参数（ratio/durationSeconds），这里按目录能力校验/归档后统一换算像素；
    // 适配器只做自家协议的约束调整（火山放大到像素下限、百炼 clamp 边长）。
    const capabilities = model.capabilities
    if (capabilities?.ratios?.length && request.ratio && !capabilities.ratios.includes(request.ratio)) {
      throw new Error(`模型 ${model.id} 不支持比例 ${request.ratio}（支持：${capabilities.ratios.join(' / ')}）`)
    }
    let durationSeconds = request.durationSeconds
    if (capabilities?.durations?.length && durationSeconds && !capabilities.durations.includes(durationSeconds)) {
      // 模型只收档位时长（如 veo 4/6/8）：就近归档到合法档，不让整单 400
      durationSeconds = capabilities.durations.reduce((best, d) =>
        Math.abs(d - durationSeconds!) < Math.abs(best - durationSeconds!) ? d : best
      )
    }
    const pixels = !request.width && !request.height && request.ratio ? ratioToPixels(request.ratio) : undefined
    const width = request.width ?? pixels?.width
    const height = request.height ?? pixels?.height

    const jobId = randomUUID()
    const now = new Date().toISOString()
    // 落库目录（可选）：必须解析后仍在工作区之内，越界请求直接拒绝
    let outputDirAbs: string | undefined
    if (request.outputDir && request.outputDir.trim()) {
      const wsRoot = ctx.workspaceDir ? resolve(ctx.workspaceDir) : null
      if (!wsRoot) throw new Error('尚未打开工作区，无法解析落库目录')
      const normalized = request.outputDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const resolved = resolve(wsRoot, normalized)
      if (!normalized || resolved === wsRoot || !resolved.startsWith(wsRoot + sep)) {
        throw new Error(`落库目录必须是工作区内的相对路径：${request.outputDir}`)
      }
      outputDirAbs = resolved
    }
    // 参考文件（垫图/首帧）：先按媒体产物目录解析（画布卡片语义），找不到再按工作区根
    // 解析（Agent 工具递来的工作区相对路径）；越界与不存在的路径丢弃，数量按模型能力截断
    const mediaRoot = resolve(mediaDir)
    const wsRoot = ctx.workspaceDir ? resolve(ctx.workspaceDir) : null
    // 实际落盘目录（相对工作区根）：随任务状态持久化，卡片据此还原引用（见 MediaJobStatus.artifactDirRel）
    const artifactDirRel = wsRoot
      ? relative(wsRoot, outputDirAbs ?? mediaRoot).split(sep).join('/')
      : undefined
    const maxRefs = Math.min(4, capabilities?.maxRefImages ?? 4)
    const refFiles = (request.refPaths ?? [])
      .map((rel) => resolveRefFile(rel, mediaRoot, wsRoot))
      .filter((abs): abs is string => Boolean(abs))
      .slice(0, maxRefs)
    const input: ProviderSubmitInput = {
      prompt,
      ...(request.ratio ? { ratio: request.ratio } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(refFiles.length > 0 ? { refFiles } : {})
    }
    const artifactName = sanitizeArtifactName(request.name)
    const record: JobRecord = {
      status: {
        jobId,
        provider: request.provider,
        model: request.model,
        kind: request.kind,
        prompt,
        state: 'queued',
        progress: 0,
        message: '排队中',
        createdAt: now,
        updatedAt: now,
        ...(request.nodeId ? { nodeId: request.nodeId } : {}),
        ...(request.sourceChatId ? { sourceChatId : request.sourceChatId } : {}),
        ...(outputDirAbs ? { outputDir: request.outputDir!.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') } : {}),
        ...(artifactDirRel ? { artifactDirRel } : {}),
        // 协商后的实际参数（比例校验/时长归档/像素换算都已完成），工具结果与画布卡片以此为准
        ...((request.ratio || width || height || durationSeconds)
          ? {
              params: {
                ...(request.ratio ? { ratio: request.ratio } : {}),
                ...(width && height ? { width, height } : {}),
                ...(durationSeconds ? { durationSeconds } : {})
              }
            }
          : {})
      },
      adapter,
      input,
      ...(outputDirAbs ? { outputDirAbs } : {}),
      ...(artifactName ? { artifactName } : {})
    }
    this.jobs.set(jobId, record)
    this.persistJobs()
    this.emit({ ...record.status })

    // 先提交拿远端 id（排队等并发槽位），再进入轮询队列
    this.pending.push(jobId)
    void this.drain()
    return { jobId }
  }

  /** 并发上限：workspace.json media.concurrency 可覆盖，越界回退默认 */
  private maxConcurrent(): number {
    const configured = this.context().config.concurrency
    if (typeof configured === 'number' && configured >= 1 && configured <= 8) {
      return Math.round(configured)
    }
    return DEFAULT_MEDIA_CONCURRENCY
  }

  /** 并发槽位调度：串行化 drain，避免多个完成事件同时触发超额启动 */
  private draining = false
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pending.length > 0 && this.running.size < this.maxConcurrent()) {
        const jobId = this.pending.shift()
        if (!jobId) break
        const record = this.jobs.get(jobId)
        if (!record || record.status.state === 'cancelled') continue
        this.running.add(jobId)
        void this.runJob(record).finally(() => {
          this.running.delete(jobId)
          void this.drain()
        })
      }
    } finally {
      this.draining = false
    }
  }

  /** 单个任务的生命周期：提交 → 轮询（退避+超时） → 下载落盘 → 事件 */
  private async runJob(record: JobRecord): Promise<void> {
    const { status, adapter } = record
    const { mediaDir } = this.context()
    if (!mediaDir) return this.finish(record, 'failed', undefined, '工作区已关闭，任务中止')
    // 落库目录优先于默认产物目录（jobs.json 索引仍放默认目录，只有产物文件换位）
    const artifactDir = record.outputDirAbs ?? mediaDir
    const startedAt = Date.now()
    const timeoutMs = TIMEOUT_MS[status.kind] ?? 300_000
    let backoff = POLL_BASE_MS
    try {
      const remoteId = await adapter.submit(status.model, record.input)
      record.remoteId = remoteId
      this.patch(record, { state: 'running', progress: 0.05, message: '已提交，等待处理' })

      for (;;) {
        if (record.cancelRequested) {
          await adapter.cancel?.(record.remoteId ?? '')
          return this.finish(record, 'cancelled', undefined, '已取消')
        }
        if (Date.now() - startedAt > timeoutMs) {
          return this.finish(record, 'failed', undefined, `任务超时（${Math.round(timeoutMs / 1000)}s），已停止轮询`)
        }

        const poll = await adapter.poll(status.model, record.remoteId ?? '')
        if (poll.status === 'failed') {
          return this.finish(record, 'failed', undefined, poll.message ?? '生成失败')
        }
        if (poll.status === 'succeeded') {
          const artifact = await this.materialize(record, poll, artifactDir)
          this.finish(record, 'succeeded', artifact)
          // 落进素材库目录的产物要广播：素材库面板只扫 assets/<分类> 与自建库，
          // 不广播就得重开工作区才看得到。落进默认产物区的不广播（那里本就不在扫描范围，
          // 广播只是白扫一遍全库）。
          if (record.outputDirAbs) this.context().notifyAssetsChanged()
          return
        }
        this.patch(record, {
          state: 'running',
          progress: Math.max(0.05, Math.min(0.95, poll.progress ?? 0.3)),
          message: poll.message ?? '生成中'
        })
        await sleep(backoff)
        backoff = Math.min(POLL_MAX_MS, backoff * POLL_BACKOFF)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.finish(record, 'failed', undefined, message)
    }
  }

  /** 把 provider 的产物（URL 或本地文件）落成工作区内的成品文件 */
  private async materialize(
    record: JobRecord,
    poll: { resultUrl?: string; resultFile?: string; fileExt?: string; mime?: string; durationSeconds?: number },
    mediaDir: string
  ): Promise<MediaArtifact> {
    const { status } = record
    mkdirSync(mediaDir, { recursive: true })
    let target: string
    let mime: string
    let bytes: number

    if (poll.resultFile) {
      // 适配器直接给出的本地产物：已是真实文件，直接收编为最终名
      target = this.resolveTargetPath(mediaDir, record, poll.fileExt ?? '.bin')
      if (resolve(poll.resultFile) !== target) {
        rmSync(target, { force: true })
        renameSync(poll.resultFile, target)
      }
      mime = poll.mime ?? mimeForKind(status.kind, poll.fileExt)
      bytes = statSync(target).size
    } else if (poll.resultUrl) {
      const ext = extForUrl(poll.resultUrl, status.kind)
      target = this.resolveTargetPath(mediaDir, record, ext)
      const part = `${target}.part`
      // 下载生成产物（图片/视频可达几十 MB）：超时放宽到 5 分钟，别误杀大文件下载；
      // 其余接口请求是 30s（见各适配器），单个请求挂起不该占死并发槽
      const response = await fetch(poll.resultUrl, { signal: AbortSignal.timeout(300_000) })
      if (!response.ok || !response.body) {
        throw new Error(`下载产物失败（HTTP ${response.status}）`)
      }
      const stream = Readable.fromWeb(response.body as import('stream/web').ReadableStream)
      await pipeline(stream, createWriteStream(part))
      rmSync(target, { force: true })
      renameSync(part, target)
      mime = response.headers.get('content-type')?.split(';')[0] ?? mimeForKind(status.kind, ext)
      bytes = statSync(target).size
    } else {
      throw new Error('provider 未返回任何产物（既无 URL 也无本地文件）')
    }

    const dims = status.kind === 'image' ? imageSizeOf(target) : undefined
    return {
      relPath: relative(mediaDir, target).split('\\').join('/'),
      name: basename(target),
      mime,
      bytes,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
      ...(poll.durationSeconds ? { durationSeconds: poll.durationSeconds } : {})
    }
  }

  /**
   * 产物最终路径：主名 = 任务指定的名字（净化后）或 jobId；目标目录里已有同名文件时
   * 自动加 `-2`/`-3` 序号，绝不覆盖既有产物；序号耗尽回退 jobId（永不冲突的兜底）。
   */
  private resolveTargetPath(mediaDir: string, record: JobRecord, ext: string): string {
    const base = record.artifactName ?? record.status.jobId
    let target = resolve(mediaDir, `${base}${ext}`)
    for (let n = 2; existsSync(target) && n < 100; n += 1) {
      target = resolve(mediaDir, `${base}-${n}${ext}`)
    }
    if (existsSync(target)) target = resolve(mediaDir, `${record.status.jobId}${ext}`)
    return target
  }

  private finish(
    record: JobRecord,
    state: WritableJobState,
    artifact?: MediaArtifact,
    message?: string
  ): void {
    const patch: Partial<MediaJobStatus> = { state, progress: state === 'succeeded' ? 1 : record.status.progress }
    if (artifact) patch.artifact = artifact
    if (message) {
      if (state === 'failed') patch.error = message
      else patch.message = message
    }
    if (state === 'succeeded') patch.message = '完成'
    this.patch(record, patch)
  }

  /** 统一的状态更新口：改记录、落账本（终态同步写/进度防抖写）、广播事件、唤醒等待者，四处永远一致 */
  private patch(record: JobRecord, patch: Partial<MediaJobStatus>): void {
    record.status = { ...record.status, ...patch, updatedAt: new Date().toISOString() }
    const state = record.status.state
    if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
      // 终态立即同步落盘：崩溃也不丢结果，因此无需退出钩子补写
      this.evictTerminalJobs()
      this.persistJobs()
    } else {
      // 非终态进度不逐次写盘：轮询期 1.2s~10s 一次 patch，500ms 防抖合并足够
      this.schedulePersist()
    }
    this.emit({ ...record.status })
    for (const waiter of this.waiters) {
      try {
        waiter({ ...record.status })
      } catch {
        /* 等待者异常不影响任务推进 */
      }
    }
  }

  /**
   * 等待任务到终态（succeeded/failed/cancelled），返回终态快照（M13 Agent 工具同步等待用）。
   *
   * - `signal` 中止：置 cancelRequested（runJob 轮询收尾落 cancelled；pending 队列里的立即落），
   *   等待者随后拿到 cancelled 终态，不 reject。
   * - 安全兜底：正常由 runJob 的 TIMEOUT_MS 先行触发 failed；这里再给一个超时+缓冲的硬上限，
   *   防止轮询循环意外卡死让 Agent 工具永远悬挂。
   */
  waitForCompletion(
    jobId: string,
    opts?: { signal?: AbortSignal; onProgress?: (job: MediaJobStatus) => void }
  ): Promise<MediaJobStatus> {
    const record = this.jobs.get(jobId)
    if (!record) return Promise.reject(new Error(`任务不存在：${jobId}`))
    const terminal = (state: MediaJobState) =>
      state === 'succeeded' || state === 'failed' || state === 'cancelled'
    if (terminal(record.status.state)) return Promise.resolve({ ...record.status })

    const timeoutMs = (TIMEOUT_MS[record.status.kind] ?? 300_000) + 30_000
    return new Promise<MediaJobStatus>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        cleanup()
        rejectPromise(new Error(`等待任务结果超时（${Math.round(timeoutMs / 1000)}s）：${jobId}`))
      }, timeoutMs)
      const onSignal = () => {
        // 取消是协作式的：轮询循环（或 pending 收尾）落 cancelled 后由 waiter 唤醒
        void this.cancel(jobId)
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        opts?.signal?.removeEventListener('abort', onSignal)
      }
      const waiter = (job: MediaJobStatus) => {
        if (job.jobId !== jobId) return
        if (terminal(job.state)) {
          cleanup()
          resolvePromise(job)
          return
        }
        try {
          opts?.onProgress?.(job)
        } catch {
          /* 进度回调异常不影响等待 */
        }
      }
      this.waiters.add(waiter)
      if (opts?.signal) {
        if (opts.signal.aborted) onSignal()
        else opts.signal.addEventListener('abort', onSignal)
      }
    })
  }

  async cancel(jobId: string): Promise<boolean> {
    const record = this.jobs.get(jobId)
    if (!record) return false
    if (record.status.state === 'succeeded' || record.status.state === 'failed') return false
    record.cancelRequested = true
    // 还在 pending 队列里的任务直接落终态，不等轮询循环
    if (!this.running.has(jobId)) {
      this.finish(record, 'cancelled', undefined, '已取消')
    }
    return true
  }

  /* ------------------------------------------------------------------ */
  /* 重启恢复（DoD：未完成任务状态可恢复或明确标记失效）                     */
  /* ------------------------------------------------------------------ */

  /**
   * 任务账本落在媒体目录（随工作区走）。启动时调用：
   * 上次进程遗留的非终态任务已无人轮询，明确标记失效，让渲染端占位节点能对账收尾。
   */
  reconcilePersistedJobs(): void {
    const { mediaDir } = this.context()
    if (!mediaDir) return
    const file = resolve(mediaDir, 'jobs.json')
    // 读前先做崩溃恢复：上次若停在「旧文件挪成 .bak、新文件未落位」之间，账本在此还原
    recoverAtomicBackup(file)
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { jobs?: MediaJobStatus[] }
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : []
      // 历史记录只需要一个占位 adapter（永不再次提交），不依赖清单顺序之外的任何类型
      const placeholderAdapter = this.adapters()[0]
      let dirty = 0
      for (const old of jobs) {
        if (old.state === 'succeeded' || old.state === 'failed' || old.state === 'cancelled') {
          if (!this.jobs.has(old.jobId)) {
            this.jobs.set(old.jobId, { status: old, adapter: placeholderAdapter, input: { prompt: old.prompt } })
          }
          continue
        }
        const revived: MediaJobStatus = {
          ...old,
          state: 'failed',
          error: '应用重启，任务已中断；请重新提交',
          updatedAt: new Date().toISOString()
        }
        // 保留更新时间最大的那条（避免同 jobId 被旧账本覆盖本次会话的状态）
        const existing = this.jobs.get(old.jobId)
        if (!existing) {
          this.jobs.set(old.jobId, { status: revived, adapter: placeholderAdapter, input: { prompt: old.prompt } })
        }
        dirty += 1
      }
      if (dirty > 0) {
        this.persistJobs()
        for (const job of this.jobs.values()) {
          if (job.status.state === 'failed') this.emit({ ...job.status })
        }
      }
      console.log(`[media-jobs] 对账完成：标记失效 ${dirty} 个遗留任务`)
    } catch (error) {
      console.warn(`[media-jobs] jobs.json 解析失败，忽略：${String(error)}`)
    }
  }

  /**
   * 淘汰历史终态任务：jobs Map 只进不出（重启后 reconcile 还会把旧账本灌回来），
   * 终态记录按 updatedAt 降序只保留最近 TERMINAL_JOBS_KEEP 条，其余移除。
   * running/pending 绝不动；只影响 jobs.json 账本与后续 list()/get() 查询，
   * 不影响本次 patch 正在 emit 的事件。
   */
  private evictTerminalJobs(): void {
    const terminal = [...this.jobs.values()]
      .filter((job) => job.status.state === 'succeeded' || job.status.state === 'failed' || job.status.state === 'cancelled')
      .sort((a, b) => b.status.updatedAt.localeCompare(a.status.updatedAt))
    for (const job of terminal.slice(TERMINAL_JOBS_KEEP)) this.jobs.delete(job.status.jobId)
  }

  /** 进度防抖写盘的定时器与脏标记：500ms 窗口内的多次 patch 合并为一次写 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistDirty = false

  private schedulePersist(): void {
    this.persistDirty = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      if (!this.persistDirty) return
      this.persistDirty = false
      this.persistJobs()
    }, 500)
  }

  /**
   * 全量写任务账本。写盘策略：终态更新在 patch 里立即同步写（崩溃不丢结果，免去退出钩子），
   * 非终态进度经 schedulePersist 500ms 防抖合并写。写入走 fsutil/atomic 的 tmp+rename
   * （Windows 占用时旧文件挪 .bak 腾位），绝不先删旧文件再改名。
   */
  private persistJobs(): void {
    // 同步写已覆盖最新全量状态：取消已排期的防抖写，避免白写一遍
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistDirty = false
    const { mediaDir } = this.context()
    if (!mediaDir) return
    try {
      mkdirSync(mediaDir, { recursive: true })
      const file = resolve(mediaDir, 'jobs.json')
      const payload = JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        jobs: [...this.jobs.values()].map((job) => job.status)
      })
      atomicWriteSync(file, payload)
    } catch (error) {
      console.warn(`[media-jobs] 任务账本写入失败：${String(error)}`)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/** 参考文件解析：媒体产物目录优先，工作区根兜底；两个根都不收留 null（越界/不存在） */
function resolveRefFile(rel: string, mediaRoot: string, wsRoot: string | null): string | null {
  const inMedia = resolve(mediaRoot, rel)
  if (inMedia.startsWith(mediaRoot + sep) && existsSync(inMedia)) return inMedia
  if (wsRoot) {
    const inWs = resolve(wsRoot, rel)
    if (inWs !== wsRoot && inWs.startsWith(wsRoot + sep) && existsSync(inWs)) return inWs
  }
  return null
}

/** Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9），命中则追加下划线使文件名合法 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 产物主名净化（提交时收口，落盘前只此一处）：剥掉误带的扩展名（扩展名由产物格式定）、
 * 白名单外的字符替换为 `_`（与 media:import 的 sanitizeName 同一字符集）、去首点/尾点尾空格、
 * 截断 80 字符。净化后为空 → 返回 undefined（落盘回退 jobId 随机名，即历史行为）。
 */
export function sanitizeArtifactName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const cleaned = raw
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5 ]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  if (!cleaned) return undefined
  return WINDOWS_RESERVED.test(cleaned) ? `${cleaned}_` : cleaned
}
