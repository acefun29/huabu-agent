import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { basename, relative, resolve, sep } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type {
  MediaArtifact,
  MediaGenerateRequest,
  MediaJobState,
  MediaJobStatus,
  MediaProviderInfo
} from '../../shared/media'
import {
  DEFAULT_MEDIA_CONCURRENCY,
  MediaFailureError,
  ratioToPixels,
  sanitizeMediaExtra
} from '../../shared/media'
import type { WorkspaceMediaConfig } from '../workspace/types'
import type { AdapterProviderConfig } from './adapters/registry'
import { adapterRefCaps } from './adapters/registry'
import { imageSizeOf } from './imageSize'
import { readJobLedger, writeJobLedger } from './jobLedger'
import { resolveMediaRefs } from './mediaRefs'
import type { ProviderSubmitInput } from './provider'
import { extForUrl, mimeForKind, type MediaProviderAdapter } from './provider'

/**
 * MediaJobManager 负责媒体生成任务的异步编排。
 *
 * 与聊天的同步流式不同，媒体生成是 submit -> task_id -> poll -> 媒体 URL -> 下载落盘。
 * 本类负责：队列并发上限、轮询指数退避、整体超时、取消、产物原子落盘、
 * 状态事件推送（media:job）、重启后未完成任务标记失效（jobs.json 对账）。
 *
 * 产物落到提交时选定的工作区目录；下载先写临时文件，再改名为最终文件。
 */

const POLL_BASE_MS = 1200
const POLL_BACKOFF = 1.5
const POLL_MAX_MS = 10_000
/** 整体超时：视频最长（网关排队+生成可达十几分钟） */
const TIMEOUT_MS: Record<string, number> = { image: 240_000, audio: 300_000, video: 900_000 }

/** jobs 账本里终态任务最多保留条数（按 updatedAt 淘汰更早的，防跨会话只进不出） */
const TERMINAL_JOBS_KEEP = 50
/** 所有工作区合计的运行中任务上限。 */
const MAX_RUNNING_JOBS = 8

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
  /** 提交时固定工作区和媒体目录，切换工作区后仍写入原位置。 */
  workspaceDir?: string
  mediaDirAbs: string
  /** 净化后的产物文件主名（不含扩展名）；缺省 = jobId（随机 id 命名） */
  artifactName?: string
}

type WritableJobState = MediaJobStatus['state']
/** 媒体任务运行所需的工作区上下文（宿主注入；R04 的任务归属以此为准） */
export interface MediaJobContext {
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
  /** 凭据来源探测（media:providers 的真实 authHint 用）；宿主未提供时回落适配器静态值 */
  keySourceOf?: (auth: { authKey?: string; authEnv?: string }) => Promise<'workspace-store' | 'environment' | 'none'>
  /** 读某供应商凭据明文（上传通道换临时引用用；适配器另有同一依赖） */
  resolveKey?: (auth: { authKey?: string; authEnv?: string }) => Promise<string | undefined>
  /** 素材库内容有变化的广播（产物落进库目录后调用，渲染端据此刷新素材库面板） */
  notifyAssetsChanged: () => void
}

export class MediaJobManager {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly running = new Set<string>()
  private readonly runningByWorkspace = new Map<string, number>()
  private readonly concurrencyByWorkspace = new Map<string, number>()
  private readonly pending: string[] = []
  private readonly loadedLedgers = new Set<string>()
  /** waitForCompletion 的订阅者（patch 时全量通知，订阅者自行按 jobId/终态过滤） */
  private readonly waiters = new Set<(job: MediaJobStatus) => void>()

  constructor(
    private readonly emit: (job: MediaJobStatus) => void,
    private readonly context: () => MediaJobContext
  ) {}

  /* ------------------------------------------------------------------ */
  /* 查询与清单                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 生效供应商清单（网关用异步 isReady，设置页绿点才真实）。
   * 全部来自合并目录（内置 + 用户覆盖层），按清单顺序列出。
   */
  async providers(): Promise<MediaProviderInfo[]> {
    // 整次查询使用同一工作区快照，避免等待凭据时混入切换后的配置。
    const context = this.context()
    const list: MediaProviderInfo[] = []
    for (const adapter of context.adapters) {
      // 凭据探测要解密存储/查环境变量，逐个 await（清单最多几家，串行可忽略）
      const ready = adapter.isReady ? await adapter.isReady() : adapter.isConfigured()
      const conf = context.providers.find((p) => p.id === adapter.id)
      // authHint 反映实际凭据来源（存储 Key / 环境变量 / 未配置）：适配器静态值
      // 只区分「有没有声明 authKey」，merge 层已把 authKey 缺省化为 id，恒真不可用
      let authHint = adapter.authHint()
      if (context.keySourceOf && conf) {
        const source = await context.keySourceOf({ authKey: conf.authKey, authEnv: conf.authEnv })
        authHint = source === 'environment' ? `environment:${conf.authEnv}` : source
      }
      list.push({
        id: adapter.id,
        label: adapter.label,
        type: adapter.type,
        source: conf?.source,
        configured: ready,
        authHint,
        models: [...adapter.models]
      })
    }
    return list
  }

  /** 传输时附带归属；账本依目录区分，不需要写入绝对路径。 */
  private publicStatus(job: JobRecord): MediaJobStatus {
    const { persistenceWarning: _warning, persistenceScope: _scope, workspacePath: _workspace, ...status } = job.status
    return {
      ...status,
      ...(job.workspaceDir ? { workspacePath: job.workspaceDir } : {}),
      persistenceScope: relative(job.workspaceDir ?? job.mediaDirAbs, job.mediaDirAbs).split('\\').join('/') || '.',
      ...(this.reportedLedgerErrors.has(job.mediaDirAbs)
        ? { persistenceWarning: '任务状态保存失败，正在重试；请检查磁盘空间和权限。' }
        : {})
    }
  }

  /** 广播失败不应改变任务状态或阻断等待者。 */
  private emitStatus(job: JobRecord): void {
    try {
      this.emit(this.publicStatus(job))
    } catch (error) {
      console.error('[media-jobs] 状态广播失败：', error)
    }
  }

  /** 账本首次写入失败时，选一条任务通知界面；无需重复广播整本账本。 */
  private emitLedgerWarning(mediaDir: string): void {
    const jobs = [...this.jobs.values()].filter((job) => job.mediaDirAbs === mediaDir)
    const job = jobs.find((item) => item.status.state === 'queued' || item.status.state === 'running') ?? jobs[0]
    if (job) {
      this.ledgerWarningJobs.set(mediaDir, job)
      this.emitStatus(job)
    }
  }

  list(): MediaJobStatus[] {
    this.ensureLedgerLoaded(this.context())
    return [...this.jobs.values()].map((job) => this.publicStatus(job))
  }

  get(jobId: string): MediaJobStatus | undefined {
    const job = this.jobs.get(jobId)
    return job ? this.publicStatus(job) : undefined
  }

  /** 按工作区定位内存中的任务，供取消入口校验归属。 */
  getForWorkspace(jobId: string, workspacePath: string): MediaJobStatus | undefined {
    const job = [...this.jobs.values()].find((item) => item.status.jobId === jobId && item.workspaceDir === workspacePath)
    return job ? this.publicStatus(job) : undefined
  }

  /* ------------------------------------------------------------------ */
  /* 提交 / 取消                                                          */
  /* ------------------------------------------------------------------ */

  async submit(request: MediaGenerateRequest, expectedWorkspace?: string, signal?: AbortSignal): Promise<{ jobId: string }> {
    const ctx = this.context()
    if (!ctx.ready || !ctx.mediaDir) throw new Error('尚未打开工作区，无法提交媒体生成任务')
    if (expectedWorkspace !== undefined && ctx.workspaceDir !== expectedWorkspace) {
      throw new Error('工作区已切换，媒体任务未提交')
    }
    if (signal?.aborted) throw new Error('媒体任务已取消')
    this.ensureLedgerLoaded(ctx)
    const mediaDir = resolve(ctx.mediaDir)
    const prompt = request.prompt?.trim()
    if (!prompt) throw new Error('生成提示词不能为空')
    const adapter = ctx.adapters.find((a) => a.id === request.provider)
    if (!adapter) throw new Error(`未知媒体 provider：${request.provider}`)
    const model = adapter.models.find((m) => m.id === request.model)
    if (!model) throw new MediaFailureError(`provider ${request.provider} 下没有模型 ${request.model}（清单见 media:providers）`, 'params')
    if (model.kind !== request.kind) {
      throw new MediaFailureError(`模型 ${model.id} 是 ${model.kind} 生成，不能用于 ${request.kind}`, 'params')
    }
    if (!adapter.isConfigured()) {
      throw new MediaFailureError(`provider ${adapter.label} 未配置凭据，请先在设置面板录入`, 'config')
    }

    // 参数协商的唯一收口点（此前散在渲染端 RATIO_SIZE 与各适配器三处）：
    // 调用方传语义参数（ratio/durationSeconds），这里按目录能力校验/归档后统一换算像素；
    // 适配器只做自家协议的约束调整（火山放大到像素下限、百炼 clamp 边长）。
    const capabilities = model.capabilities
    if (capabilities?.ratios?.length && request.ratio && !capabilities.ratios.includes(request.ratio)) {
      throw new MediaFailureError(`模型 ${model.id} 不支持比例 ${request.ratio}（支持：${capabilities.ratios.join(' / ')}）`, 'params')
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
    // 附加参数：只有该模型 extraParams 声明过的键才允许进请求体。越界的键当场报错 ——
    // 猜个意思发出去是幻觉，悄悄丢掉是等于把用户的开关当成不存在
    const extra = sanitizeMediaExtra(capabilities?.extraParams, request.extra)
    if (extra.issues.length > 0) {
      throw new MediaFailureError(`模型 ${model.id} 拒绝了这些附加参数：${extra.issues.join('；')}`, 'params')
    }
    // 音色：模型声明了清单就按 id 校验，不声明的（今天只有 openai-compat 的 TTS 吃 voice）不管
    if (request.voice && capabilities?.voices?.length && !capabilities.voices.some((v) => v.id === request.voice)) {
      throw new MediaFailureError(
        `模型 ${model.id} 没有音色 ${request.voice}（支持：${capabilities.voices.map((v) => v.id).join(' / ')}）`,
        'params'
      )
    }

    let jobId: string
    do {
      jobId = randomUUID()
    } while ([...this.jobs.values()].some((job) => job.status.jobId === jobId))
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
    // 参考素材：角色/类型/配额/投递形态的判定与截断留痕全在 resolveMediaRefs
    //（画布与 Agent 两个入口在这里合流，适配器侧不再重复判）
    const mediaRoot = resolve(mediaDir)
    const wsRoot = ctx.workspaceDir ? resolve(ctx.workspaceDir) : null
    // 实际落盘目录（相对工作区根）：随任务状态持久化，卡片据此还原引用（见 MediaJobStatus.artifactDirRel）
    const artifactDirRel = wsRoot
      ? relative(wsRoot, outputDirAbs ?? mediaRoot).split(sep).join('/')
      : undefined
    const conf = ctx.providers.find((p) => p.id === adapter.id)
    const { refs: mediaRefs, notes: refNotes, echo: refEcho } = await resolveMediaRefs(
      request,
      request.kind,
      capabilities,
      adapterRefCaps(adapter.type),
      { mediaRoot, wsRoot },
      model.id,
      {
        indexFile: resolve(mediaRoot, 'upload-index.json'),
        // 上传换临时引用时网关认的是线上模型标识（百炼的 getPolicy 按模型授权）
        model: conf?.models.find((m) => m.id === model.id)?.requestModel ?? model.id,
        resolveKey: async () =>
          (await ctx.resolveKey?.({ authKey: conf?.authKey, authEnv: conf?.authEnv })) ?? null,
        ...(conf?.baseUrl ? { baseUrl: conf.baseUrl } : {})
      }
    )
    if (signal?.aborted) throw new Error('媒体任务已取消')
    if (expectedWorkspace !== undefined && this.context().workspaceDir !== expectedWorkspace) {
      throw new Error('工作区已切换，媒体任务未提交')
    }
    const input: ProviderSubmitInput = {
      prompt,
      ...(request.ratio ? { ratio: request.ratio } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(request.voice ? { voice: request.voice } : {}),
      ...(Object.keys(extra.value).length > 0 ? { extra: extra.value } : {}),
      ...(mediaRefs.length > 0 ? { refs: mediaRefs } : {})
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
        // 参考素材的处置留痕（哪条没进请求、为什么），卡片与工具结果透出
        ...(refNotes.length > 0 ? { notes: refNotes } : {}),
        // 实际进入请求的参考回执：渲染端终态时据 absPath 反查来源卡自动成链
        ...(refEcho.length > 0 ? { refs: refEcho } : {}),
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
      // 工作区归属随任务走（R04）：切工作区后不改变本任务的目录与账本
      ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
      mediaDirAbs: mediaDir,
      ...(outputDirAbs ? { outputDirAbs } : {}),
      ...(artifactName ? { artifactName } : {})
    }
    this.concurrencyByWorkspace.set(this.workspaceKey(record), this.normalizeConcurrency(ctx.config.concurrency))
    this.jobs.set(jobId, record)
    this.dirtyLedgers.add(record.mediaDirAbs)
    try {
      this.persistJobs(record.mediaDirAbs)
    } catch (error) {
      this.jobs.delete(jobId)
      this.emitLedgerWarning(record.mediaDirAbs)
      throw error
    }
    this.emitStatus(record)

    // 先提交拿远端 id（排队等并发槽位），再进入轮询队列
    this.pending.push(jobId)
    void this.drain()
    return { jobId }
  }

  /** 任务队列按工作区计数；缺少工作区时退回任务的媒体目录。 */
  private workspaceKey(record: JobRecord): string {
    return record.workspaceDir ?? record.mediaDirAbs
  }

  private normalizeConcurrency(configured: unknown): number {
    if (typeof configured === 'number' && configured >= 1 && configured <= 8) {
      return Math.round(configured)
    }
    return DEFAULT_MEDIA_CONCURRENCY
  }

  /** 按工作区限制调度，跳过已满的工作区，避免阻塞其他工作区的队列。 */
  private draining = false
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      const current = this.context()
      const currentKey = current.workspaceDir ?? current.mediaDir
      if (currentKey) {
        this.concurrencyByWorkspace.set(currentKey, this.normalizeConcurrency(current.config.concurrency))
      }
      while (this.pending.length > 0 && this.running.size < MAX_RUNNING_JOBS) {
        let selected = -1
        for (let index = 0; index < this.pending.length; index += 1) {
          const record = this.jobs.get(this.pending[index])
          if (!record || record.status.state !== 'queued') {
            this.pending.splice(index, 1)
            index -= 1
            continue
          }
          const key = this.workspaceKey(record)
          const running = this.runningByWorkspace.get(key) ?? 0
          const limit = this.concurrencyByWorkspace.get(key) ?? DEFAULT_MEDIA_CONCURRENCY
          if (running < limit) {
            selected = index
            break
          }
        }
        if (selected < 0) break
        const [jobId] = this.pending.splice(selected, 1)
        const record = this.jobs.get(jobId)
        if (!record) continue
        const key = this.workspaceKey(record)
        this.running.add(jobId)
        this.runningByWorkspace.set(key, (this.runningByWorkspace.get(key) ?? 0) + 1)
        void this.runJob(record).catch((error) => {
          console.error('[media-jobs] 任务执行异常：', error)
        }).finally(() => {
          this.running.delete(jobId)
          const remaining = (this.runningByWorkspace.get(key) ?? 1) - 1
          if (remaining > 0) this.runningByWorkspace.set(key, remaining)
          else this.runningByWorkspace.delete(key)
          void this.drain()
        })
      }
    } catch (error) {
      console.error('[media-jobs] 队列调度失败：', error)
    } finally {
      this.draining = false
    }
  }

  /** 单个任务的生命周期：提交 → 轮询（退避+超时） → 下载落盘 → 事件 */
  private async runJob(record: JobRecord): Promise<void> {
    const { status, adapter } = record
    // 任务的媒体目录在提交时钉住（R04）：切工作区后 A 的在途任务仍落在 A 的目录
    const mediaDir = record.mediaDirAbs
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
          if (record.outputDirAbs) {
            try {
              const context = this.context()
              if (context.workspaceDir === record.workspaceDir) context.notifyAssetsChanged()
            } catch (error) {
              console.error('[media-jobs] 素材刷新通知失败：', error)
            }
          }
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

  /** 更新状态并安排账本写入，然后广播并唤醒等待者；写盘失败时保留待重试标记。 */
  private patch(record: JobRecord, patch: Partial<MediaJobStatus>): void {
    record.status = { ...record.status, ...patch, updatedAt: new Date().toISOString() }
    this.dirtyLedgers.add(record.mediaDirAbs)
    const state = record.status.state
    if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
      // 终态立即尝试落盘；失败时保留脏标记并重试。
      this.evictTerminalJobs()
      this.persistJobs()
    } else {
      // 非终态进度不逐次写盘：轮询期 1.2s~10s 一次 patch，500ms 防抖合并足够
      this.schedulePersist()
    }
    this.emitStatus(record)
    for (const waiter of this.waiters) {
      try {
        waiter(this.publicStatus(record))
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
    if (terminal(record.status.state)) return Promise.resolve(this.publicStatus(record))

    const timeoutMs = (TIMEOUT_MS[record.status.kind] ?? 300_000) + 30_000
    return new Promise<MediaJobStatus>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        cleanup()
        rejectPromise(new MediaFailureError(`等待任务结果超时（${Math.round(timeoutMs / 1000)}s）：${jobId}`, 'timeout'))
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

  /** 恢复当前媒体目录的任务账本；同一目录在本进程中只恢复一次。 */
  reconcilePersistedJobs(): void {
    this.ensureLedgerLoaded(this.context())
  }

  private ensureLedgerLoaded(context: MediaJobContext): void {
    if (!context.mediaDir) return
    const mediaDir = resolve(context.mediaDir)
    if (this.loadedLedgers.has(mediaDir)) return
    const jobs = readJobLedger(mediaDir)

    const ownerDir = context.workspaceDir ?? undefined
    const placeholderAdapter = context.adapters[0]
    const interrupted: JobRecord[] = []
    for (const old of jobs) {
      // 复制工作区可能产生相同的历史任务 ID，必须分别保存两份账本。
      const direct = this.jobs.get(old.jobId)
      const key = direct && direct.mediaDirAbs !== mediaDir ? JSON.stringify([mediaDir, old.jobId]) : old.jobId
      if (this.jobs.has(key)) continue
      const isTerminal = old.state === 'succeeded' || old.state === 'failed' || old.state === 'cancelled'
      const status: MediaJobStatus = isTerminal ? old : {
        ...old,
        state: 'failed',
        error: '应用重启，任务已中断；请重新提交',
        updatedAt: new Date().toISOString()
      }
      const record: JobRecord = {
        status,
        adapter: placeholderAdapter,
        input: { prompt: old.prompt },
        mediaDirAbs: mediaDir,
        ...(ownerDir ? { workspaceDir: ownerDir } : {})
      }
      this.jobs.set(key, record)
      if (!isTerminal) interrupted.push(record)
    }
    this.loadedLedgers.add(mediaDir)
    if (interrupted.length > 0) {
      this.dirtyLedgers.add(mediaDir)
      this.persistJobs()
      for (const job of interrupted) this.emitStatus(job)
    }
  }

  /** 每个媒体目录各自保留最近的终态记录；运行中和排队中的任务不淘汰。 */
  private evictTerminalJobs(): void {
    const groups = new Map<string, Array<[string, JobRecord]>>()
    for (const entry of this.jobs) {
      const job = entry[1]
      if (job.status.state !== 'succeeded' && job.status.state !== 'failed' && job.status.state !== 'cancelled') continue
      const dir = job.mediaDirAbs
      const group = groups.get(dir) ?? []
      group.push(entry)
      groups.set(dir, group)
    }
    for (const entries of groups.values()) {
      entries.sort((a, b) => b[1].status.updatedAt.localeCompare(a[1].status.updatedAt))
      for (const [key] of entries.slice(TERMINAL_JOBS_KEEP)) this.jobs.delete(key)
    }
  }

  /** 只重写发生变化的账本；失败的目录保持脏状态并延迟重试。 */
  private readonly dirtyLedgers = new Set<string>()
  private readonly reportedLedgerErrors = new Set<string>()
  private readonly ledgerWarningJobs = new Map<string, JobRecord>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  private schedulePersist(delayMs = 500): void {
    if (this.persistTimer || this.dirtyLedgers.size === 0) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistJobs()
    }, delayMs)
    this.persistTimer.unref()
  }

  /** 提交新任务时要求其账本写入成功，其他目录的失败不阻断该任务。 */
  private persistJobs(requiredDirectory?: string): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    let requiredError: unknown
    let requiredFailed = false
    for (const mediaDir of [...this.dirtyLedgers]) {
      const jobs = [...this.jobs.values()]
        .filter((job) => job.mediaDirAbs === mediaDir)
        .map((job) => job.status)
      try {
        writeJobLedger(mediaDir, jobs)
        this.dirtyLedgers.delete(mediaDir)
        const recovered = this.reportedLedgerErrors.delete(mediaDir)
        const warningJob = this.ledgerWarningJobs.get(mediaDir)
        this.ledgerWarningJobs.delete(mediaDir)
        if (recovered && warningJob) this.emitStatus(warningJob)
      } catch (error) {
        if (!this.reportedLedgerErrors.has(mediaDir)) {
          console.warn(`[media-jobs] 任务账本写入失败：${String(error)}`)
          this.reportedLedgerErrors.add(mediaDir)
          if (mediaDir !== requiredDirectory) this.emitLedgerWarning(mediaDir)
        }
        if (mediaDir === requiredDirectory) {
          requiredFailed = true
          requiredError = error
        }
      }
    }
    if (this.dirtyLedgers.size > 0) this.schedulePersist(5000)
    if (requiredFailed) {
      const reason = requiredError instanceof Error ? requiredError.message : String(requiredError)
      throw new Error(`媒体任务账本写入失败，任务未提交：${reason}`)
    }
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
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
