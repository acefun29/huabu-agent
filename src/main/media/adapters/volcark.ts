import type { MediaKind, MediaModelInfo, MediaProviderType, ModelCapabilities } from '../../../shared/media'
import type { MediaProviderAdapter, ProviderPollResult, ProviderSubmitInput } from '../provider'
import { registerAdapter, type AdapterDeps, type AdapterModelConfig } from './registry'
import { firstImageRefDataUri } from './refImage'

/**
 * 火山方舟（Volcengine Ark）适配器：图片同步 API + 视频异步任务制。
 *
 * 协议（2026-09 对照 www.volcengine.com/docs/82379 官方文档核实）：
 * - 图片：POST /api/v3/images/generations（同步），body 里 model/prompt/size
 *   （'宽x高'）/response_format:'url'/watermark，参考图走 image 字段（data URI 官方
 *   支持）→ data[0].url（OSS 链接 24 小时有效）。注意模型对总像素有下限
 *   （Seedream 4.0 ≥ 2560×1440），画布传来的小尺寸按比例放大到合法区间再提交。
 * - 视频创建：POST /api/v3/contents/generations/tasks → {id, status:'queued'}。
 *   Seedance 2.x（2.0/2.5，2026-09 对照 docs.volcengine.com/docs/ark/
 *   create-video-generation-task-api 核实）：content 为 [{type:'text', text}]，
 *   分辨率/比例/时长走顶层结构化字段（resolution/ratio/duration，duration [4,30]）；
 *   1.x 老模型（deprecated 保留）沿用 --resolution/--ratio/--duration 文本后缀旗标。
 * - 视频查询：GET 同路径 /{id}，status ∈ queued/running/succeeded/failed/
 *   cancelled/expired，成功取 content.video_url；取消 DELETE 同路径 /{id}。
 * - 认证：Authorization: Bearer <ARK_KEY>。
 *
 * 图片同步返回意味着 submit 会阻塞到出图（数秒～数十秒）；成功后把结果 URL 直接
 * 编进 jobId，poll 原样回传 succeeded —— 不二次请求、无重复计费，应用重启也安全。
 */

const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const IMAGES_ENDPOINT = '/images/generations'
const VIDEO_TASKS_ENDPOINT = '/contents/generations/tasks'

/** 视频异步任务的 jobId 前缀；不带该前缀的 jobId 是同步图片的结果 URL 本身 */
const VIDEO_JOB_PREFIX = 'ark-video|'

export interface VolcArkModelConfig {
  kind: MediaKind
  label?: string
  /** 目录层的稳定用户可见 id（如 'volcark/seedream-4.0'）；缺省 = 用线上模型 ID 兜底 */
  userId?: string
  /** 目录层能力元数据透传（渲染端参数面板与编排层参数协商消费） */
  capabilities?: ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
  costHint?: string
}

export interface VolcArkProviderConfig {
  id?: string
  label?: string
  models: Record<string, VolcArkModelConfig>
  /** 凭据存储键（safeStorage 存储 media:<authKey>）；未录入时退回环境变量 */
  authKey?: string
  /** 环境变量名（默认 ARK_KEY） */
  authEnv?: string
}

export class VolcArkProvider implements MediaProviderAdapter {
  readonly id: string
  readonly type: MediaProviderType = 'gateway-volcark'
  readonly label: string
  readonly models: MediaModelInfo[]

  constructor(
    private readonly config: VolcArkProviderConfig,
    private readonly getKey: () => Promise<string | undefined>
  ) {
    this.id = config.id ?? 'volcark'
    this.label = config.label ?? '火山方舟'
    this.models = Object.entries(config.models).map(([requestModel, model]) => {
      const id = model.userId ?? requestModel
      return {
        id,
        kind: model.kind,
        label: model.label ?? id,
        provider: this.id,
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
        ...(model.status ? { status: model.status } : {}),
        ...(model.costHint ? { costHint: model.costHint } : {})
      }
    })
  }

  isConfigured(): boolean {
    // 同步上下文里只做保守判断；实际提交时 key 缺失会报可操作错误
    return true
  }

  async isReady(): Promise<boolean> {
    return Boolean(await this.getKey())
  }

  authHint(): string {
    return this.config.authKey ? 'workspace-store' : `environment:${this.config.authEnv ?? 'ARK_KEY'}`
  }

  private async requireKey(): Promise<string> {
    const key = await this.getKey()
    if (!key) {
      const env = this.config.authEnv ?? 'ARK_KEY'
      throw new Error(
        `provider ${this.id} 缺少凭据：请在设置面板录入 API Key，或设置环境变量 ${env} 后重启`
      )
    }
    return key
  }

  /** 稳定 id → 线上模型 ID；找不到返回 undefined */
  private requestModelOf(model: string): string | undefined {
    for (const [requestModel, entry] of Object.entries(this.config.models)) {
      if (entry.userId === model || requestModel === model) return requestModel
    }
    return undefined
  }

  private kindOf(model: string): MediaKind {
    return (
      this.models.find((m) => m.id === model)?.kind ??
      Object.entries(this.config.models).find(([name]) => name === model)?.[1].kind ??
      'image'
    )
  }

  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const requestModel = this.requestModelOf(model)
    if (!requestModel) throw new Error(`provider ${this.id} 下没有模型 ${model}（清单见 media:providers）`)
    const kind = this.kindOf(model)
    if (kind === 'video') return this.submitVideo(key, requestModel, input)
    return this.submitImage(key, requestModel, input)
  }

  /** 同步出图：submit 阻塞到返回结果 URL，URL 即 jobId */
  private async submitImage(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const body: Record<string, unknown> = {
      model: requestModel,
      prompt: input.prompt,
      response_format: 'url',
      // 产物走干净版（控制台预览水印与 API 水印默认值不同，显式关掉）
      watermark: false
    }
    if (input.width && input.height) body.size = seedreamSize(input.width, input.height)
    const refDataUri = await firstImageRefDataUri(input.refFiles)
    if (refDataUri) body.image = [refDataUri]

    const response = await fetch(`${BASE_URL}${IMAGES_ENDPOINT}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // 同步生成端点：请求即生成，Seedream 高质量档可超 30s，放宽到 5 分钟防误杀；
      // 异步任务制（视频提交/轮询）与其余接口仍 30s（见下）
      signal: AbortSignal.timeout(300_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        throw new Error(`方舟认证失败（HTTP ${response.status}）：请检查 API Key 是否正确、模型是否已开通`)
      }
      throw new Error(`方舟提交失败（HTTP ${response.status}）：${text.slice(0, 300)}`)
    }
    const data = (await response.json()) as { data?: { url?: string }[]; error?: { code?: string; message?: string } }
    const url = data.data?.[0]?.url
    if (!url) {
      throw new Error(`方舟结果里找不到产物 URL：${JSON.stringify(data).slice(0, 200)}`)
    }
    return url
  }

  /** 文生视频：异步任务制。Seedance 2.x 起官方协议为 content 对象数组 + 顶层结构化参数（resolution/ratio/duration）；1.x 老模型保留 --flag 文本后缀约定 */
  private async submitVideo(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const legacy = /^doubao-seedance-1-/.test(requestModel)
    let body: Record<string, unknown>
    if (legacy) {
      const flags: string[] = ['--watermark false']
      if (input.durationSeconds) flags.push(`--duration ${Math.max(1, Math.round(input.durationSeconds))}`)
      if (input.width && input.height) {
        flags.push(`--resolution ${resolutionFor(input.height)}`)
        flags.push(`--ratio ${ratioFor(input.width, input.height)}`)
      }
      body = { model: requestModel, content: [{ type: 'text', text: [input.prompt, ...flags].join(' ') }] }
    } else {
      body = {
        model: requestModel,
        content: [{ type: 'text', text: input.prompt }],
        watermark: false
      }
      // Seedance 2.5：duration [4,30] 秒（-1 = 模型自选，缺省不传即自动）；2.0 系列 [5,10]
      if (input.durationSeconds) body.duration = Math.max(4, Math.round(input.durationSeconds))
      if (input.width && input.height) {
        body.resolution = resolutionFor(input.height)
        body.ratio = ratioFor(input.width, input.height)
      }
    }
    const response = await fetch(`${BASE_URL}${VIDEO_TASKS_ENDPOINT}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        throw new Error(`方舟认证失败（HTTP ${response.status}）：请检查 API Key 是否正确、模型是否已开通`)
      }
      throw new Error(`方舟提交失败（HTTP ${response.status}）：${text.slice(0, 300)}`)
    }
    const data = (await response.json()) as { id?: string; error?: { message?: string } }
    if (!data.id) {
      throw new Error(`方舟响应缺少任务 id：${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`)
    }
    return `${VIDEO_JOB_PREFIX}${data.id}`
  }

  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    // 同步图片：jobId 即结果 URL，submit 成功即任务成功
    if (!jobId.startsWith(VIDEO_JOB_PREFIX)) {
      return { status: 'succeeded', resultUrl: jobId }
    }
    const key = await this.requireKey()
    const taskId = jobId.slice(VIDEO_JOB_PREFIX.length)
    const response = await fetch(`${BASE_URL}${VIDEO_TASKS_ENDPOINT}/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      return { status: 'failed', message: `方舟状态查询失败（HTTP ${response.status}）` }
    }
    const data = (await response.json()) as {
      status?: string
      content?: { video_url?: string }
      error?: { code?: string; message?: string }
    }
    if (data.status === 'queued') {
      return { status: 'running', progress: 0.1, message: '排队中' }
    }
    if (data.status === 'running') {
      return { status: 'running', progress: 0.5, message: '生成中' }
    }
    if (data.status === 'succeeded') {
      const url = data.content?.video_url
      if (!url) {
        return { status: 'failed', message: `方舟结果里找不到 video_url：${JSON.stringify(data).slice(0, 200)}` }
      }
      return { status: 'succeeded', resultUrl: url }
    }
    const reason = data.error?.message ?? data.error?.code ?? data.status ?? '未知状态'
    return { status: 'failed', message: `方舟任务未成功：${reason}` }
  }

  /** 取消远端视频任务；同步图片 jobId 无远端可取消。失败不阻塞本地 cancelled 终态 */
  async cancel(jobId: string): Promise<void> {
    if (!jobId.startsWith(VIDEO_JOB_PREFIX)) return
    let key: string | undefined
    try {
      key = await this.getKey()
    } catch {
      return
    }
    if (!key) return
    const taskId = jobId.slice(VIDEO_JOB_PREFIX.length)
    try {
      await fetch(`${BASE_URL}${VIDEO_TASKS_ENDPOINT}/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(30_000)
      })
    } catch {
      // 网络异常时放弃远端取消
    }
  }
}

/**
 * Seedream 对总像素有下限（4.0 起 ≥ 2560×1440）与边长上限（4096）：画布常给
 * 1024×1024 这类小尺寸，直接提交会被整单 400，这里按比例放大到合法区间。
 */
function seedreamSize(width: number, height: number): string {
  let w = Math.max(256, Math.round(width))
  let h = Math.max(256, Math.round(height))
  const minPixels = 2560 * 1440
  if (w * h < minPixels) {
    const scale = Math.sqrt(minPixels / (w * h))
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }
  w = Math.min(4096, w)
  h = Math.min(4096, h)
  // 偶数对齐：部分编解码链路对奇数尺寸不友好
  return `${w - (w % 2)}x${h - (h % 2)}`
}

/** Seedance 的分辨率档位按高度就近归档（480p/720p/1080p） */
function resolutionFor(height: number): string {
  if (height >= 1000) return '1080p'
  if (height >= 600) return '720p'
  return '480p'
}

/** 画布宽高就近映射到 Seedance 支持的比例旗标 */
function ratioFor(width: number, height: number): string {
  const aspect = width / height
  const table: [string, number][] = [
    ['16:9', 16 / 9],
    ['4:3', 4 / 3],
    ['1:1', 1],
    ['3:4', 3 / 4],
    ['9:16', 9 / 16]
  ]
  let best = table[0]
  for (const entry of table) {
    if (Math.abs(entry[1] - aspect) < Math.abs(best[1] - aspect)) best = entry
  }
  return best[0]
}

registerAdapter(
  'gateway-volcark',
  (deps: AdapterDeps, config) =>
    new VolcArkProvider(
      {
        id: config.id,
        label: config.label,
        models: volcArkModelRecord(config.models),
        authKey: config.authKey,
        authEnv: config.authEnv
      },
      () => deps.resolveKey(config)
    ),
  { defaultAuthEnv: 'ARK_KEY' }
)

/** 合并层的模型数组（稳定 id + 可选 requestModel）→ 适配器的远端模型配置表 */
function volcArkModelRecord(models: readonly AdapterModelConfig[]): Record<string, VolcArkModelConfig> {
  const record: Record<string, VolcArkModelConfig> = {}
  for (const model of models) {
    record[model.requestModel ?? model.id] = {
      kind: model.kind,
      userId: model.id,
      ...(model.label ? { label: model.label } : {}),
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      ...(model.status ? { status: model.status } : {}),
      ...(model.costHint ? { costHint: model.costHint } : {})
    }
  }
  return record
}
