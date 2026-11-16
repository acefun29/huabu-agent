import type { MediaKind, MediaProviderType, ModelCapabilities } from '../../../shared/media'
import { submitRefs, type ProviderPollResult, type ProviderSubmitInput } from '../provider'
import { registerAdapter, type AdapterDeps } from './registry'
import { BaseGatewayProvider, buildModelRecord, nearestRatio } from './base'
import { clamp, videoDurationWindow } from './dashscope'
import { prepareRefs } from './refImage'

/**
 * 阿里云百炼 Token Plan（订阅制）适配器：与标准百炼**协议同源但端点族不同**，不可复用
 * gateway-dashscope（2026-10-25 对照 help.aliyun.com/zh/model-studio 的
 * token-plan-personal-quick-start 与 token-plan-multimodal-gen 逐页核实）：
 *
 * - 域名：`https://token-plan.cn-beijing.maas.aliyuncs.com`（个人版/团队版共用；国际版为
 *   ap-southeast-1 域，一期不做，留 config.baseUrl 覆盖口）。
 * - 认证：套餐 API Key（`sk-sp-` 前缀）走 `Authorization: Bearer`；订阅到期 Key 即失效。
 * - **图片是同步接口**，且端点是 `multimodal-generation/generation`（不是标准百炼的
 *   `image-generation/generation`）：body `{model, input:{messages:[{role:'user',
 *   content:[{text}]}]}, parameters:{size:'宽*高'}}`，不带 `X-DashScope-Async`；
 *   产物直接在 `output.choices[].message.content[].image`（URL，与标准百炼同源有 24h
 *   时效，编排层 succeeded 后即下载落盘）。size 缺省 1024*1024（官方示例值）。
 *   submit 阻塞到出图，URL 编进 jobId（同 openaiCompat 的 `oc-url|` 双通道思路）。
 * - **视频是异步任务制**，端点与标准百炼同名：POST video-generation/video-synthesis +
 *   header `X-DashScope-Async: enable`，body `{model, input:{prompt, media?}, parameters:
 *   {resolution, ratio, duration}}`；轮询 GET /api/v1/tasks/{id} 的 task_status 与
 *   video_url。Token Plan 官方接入页现已列出 HappyHorse 1.1 的 t2v/i2v/r2v，并注明
 *   wan3.0-video 可接收图片或参考素材；HappyHorse R2V 官方 API 明确给出 media 数组、
 *   reference_image 角色及 Base64 data URI。此处先开放官方列明的 HappyHorse i2v/r2v，
 *   使用同 endpoint 的公开请求形态；Token Plan 未单独注明的其它 wan3 参考模式仍关闭。
 *
 * 图生图仍不支持：Token Plan 图像接口文档尚未证实参考图编辑的请求形态。视频参考只
 *   允许图片 data URI（上限 20MB），视频和音频类型不开放，避免把本地路径误发到网关。
 * 附加参数（watermark/prompt_extend）文档未记载，不装配——目录也不声明 extraParams，
 * 白名单闸门保证它们永远到不了这里。
 */

const DEFAULT_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com'
const IMAGE_ENDPOINT = '/api/v1/services/aigc/multimodal-generation/generation'
const VIDEO_ENDPOINT = '/api/v1/services/aigc/video-generation/video-synthesis'
const TASK_ENDPOINT = '/api/v1/tasks'
const MAX_REF_IMAGE_BYTES = 20 * 1024 * 1024

/** jobId 通道：图片同步结果是 URL；视频是异步任务 id（前缀后接 task_id） */
const URL_PREFIX = 'tp-url|'
const TASK_PREFIX = 'tp-task|'

export interface TokenPlanModelConfig {
  kind: MediaKind
  label?: string
  /** 目录层的稳定用户可见 id（如 'token-plan/wan2.7-image'）；缺省 = 用线上模型名兜底 */
  userId?: string
  /** 目录层能力元数据透传（渲染端参数面板与编排层参数协商消费） */
  capabilities?: ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
  costHint?: string
}

export interface TokenPlanProviderConfig {
  id?: string
  label?: string
  models: Record<string, TokenPlanModelConfig>
  /** 网关基址；缺省 = 国内（北京）域。国际版用户自建供应商时填 ap-southeast-1 域 */
  baseUrl?: string
  /** 凭据存储键（safeStorage 存储 media:<authKey>）；未录入时退回环境变量 */
  authKey?: string
  /** 环境变量名（默认 TOKEN_PLAN_KEY） */
  authEnv?: string
}

export class TokenPlanProvider extends BaseGatewayProvider<TokenPlanModelConfig> {
  readonly type: MediaProviderType = 'gateway-token-plan'
  private readonly baseUrl: string

  constructor(config: TokenPlanProviderConfig, getKey: () => Promise<string | undefined>) {
    super(config, getKey, 'TOKEN_PLAN_KEY', { id: 'token-plan', label: '阿里云 Token Plan' })
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const requestModel = this.requestModelOf(model)
    if (!requestModel) this.noSuchModel(model)
    const kind = this.kindOf(model)
    if (kind === 'video') return this.submitVideo(key, requestModel, input)
    return this.submitImage(key, requestModel, input)
  }

  /** 文生图（同步）：请求即生成，产物 URL 编进 jobId，poll 首轮直接回成功 */
  private async submitImage(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const parameters: Record<string, unknown> = {}
    // 官方示例缺省 1024*1024：调用方没给像素就不传 size，吃网关默认。
    // IPC 的宽高覆盖项直通到这里（不经过比例闸门），边长按族窗口 clamp 到
    // [512,2048]（官方 API 参考：qwen-image 全系 [512²,2048²]、wan2.7 [768²,2048²]，
    // 取两族交集的边长闸口；总像素上下限由真机核验再收紧）——同 slug 模型在
    // gateway-dashscope 会被归一成功，这里裸传会静默吃 400，属行为分歧。
    if (input.width && input.height) parameters.size = `${clamp(input.width, 512, 2048)}*${clamp(input.height, 512, 2048)}`
    const response = await fetch(`${this.baseUrl}${IMAGE_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: requestModel,
        input: { messages: [{ role: 'user', content: [{ text: input.prompt }] }] },
        ...(Object.keys(parameters).length > 0 ? { parameters } : {})
      }),
      // 同步生成端点：订阅制高峰排队可能明显慢于按量通道，照 openaiCompat 的 5 分钟上限
      signal: AbortSignal.timeout(300_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.httpErrorMessage(
        response,
        text,
        'Token Plan 认证失败',
        'Token Plan 图片提交失败',
        '请检查 sk-sp- 前缀的套餐 Key 是否正确、订阅是否在有效期内'
      )
    }
    const data = (await response.json()) as {
      output?: { choices?: { message?: { content?: { type?: string; image?: string }[] } }[] }
      code?: string
      message?: string
    }
    const url = data.output?.choices
      ?.flatMap((c) => c.message?.content ?? [])
      .find((c) => c.type === 'image' && c.image)?.image
    if (!url) {
      throw new Error(
        `Token Plan 响应缺少 output.choices[].image：${data.code ?? ''} ${data.message ?? JSON.stringify(data).slice(0, 200)}`
      )
    }
    return `${URL_PREFIX}${url}`
  }

  /** 文生视频（异步）：提交任务拿 task_id，轮询走标准百炼同款任务协议 */
  private async submitVideo(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const referenceMode = /^happyhorse-1\.1-(i2v|r2v)$/i.exec(requestModel)?.[1]
    const refs = referenceMode
      ? await prepareRefs(submitRefs(input), { image: MAX_REF_IMAGE_BYTES })
      : { items: [], skipped: [] }
    if (referenceMode === 'i2v' && !refs.items.some((ref) => ref.role === 'first_frame')) {
      throw new Error('Token Plan HappyHorse 图生视频需要一张可读取的首帧参考图（单张不超过 20MB）')
    }
    if (referenceMode === 'r2v' && !refs.items.some((ref) => ref.role === 'reference_image')) {
      throw new Error('Token Plan HappyHorse 参考生视频需要至少一张可读取的参考图（最多 9 张，每张不超过 20MB）')
    }
    const parameters: Record<string, unknown> = {}
    // resolution 与 ratio 成对下发（官方示例即成对），且 ratio **像素优先**派生：
    // ratio 与 width/height 并存时宽高是事实源（shared/media 的并存契约），
    // input.ratio 直接压过宽高会与 resolution 打架——gateway-dashscope 同端点族
    // 就是 pixels-first（dashscope.ts videoBody），两处规则必须一致。
    if (input.width && input.height) {
      parameters.resolution = input.height >= 1000 ? '1080P' : '720P'
      parameters.ratio = nearestRatio(input.width, input.height)
    } else if (input.ratio) {
      // 只给了语义比例没给像素：resolution 不能缺位，补官方缺省档
      parameters.resolution = '720P'
      parameters.ratio = input.ratio
    }
    if (input.durationSeconds) {
      // 时长窗口走 dashscope.ts 的族表单点声明（wan3.0 2~30、happyhorse 3~15、
      // wan2.x 2~15）：Token Plan 文档只示例了 5 秒，区间沿用标准百炼口径
      const [minDuration, maxDuration] = videoDurationWindow(requestModel)
      parameters.duration = clamp(input.durationSeconds, minDuration, maxDuration)
    }
    const response = await fetch(`${this.baseUrl}${VIDEO_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        // 生成类接口只支持异步调用，漏掉该 header 会报「不支持同步调用」（与标准百炼同规）
        'X-DashScope-Async': 'enable',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: requestModel,
        input: {
          prompt: input.prompt,
          ...(refs.items.length > 0
            ? { media: refs.items.map((ref) => ({ type: ref.role, url: ref.url })) }
            : {})
        },
        ...(Object.keys(parameters).length > 0 ? { parameters } : {})
      }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.httpErrorMessage(
        response,
        text,
        'Token Plan 认证失败',
        'Token Plan 提交失败',
        '请检查 sk-sp- 前缀的套餐 Key 是否正确、订阅是否在有效期内'
      )
    }
    const data = (await response.json()) as { output?: { task_id?: string }; code?: string; message?: string }
    const taskId = data.output?.task_id
    if (!taskId) {
      throw new Error(
        `Token Plan 响应缺少 output.task_id：${data.code ?? ''} ${data.message ?? JSON.stringify(data).slice(0, 200)}`
      )
    }
    return `${TASK_PREFIX}${taskId}`
  }

  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    if (jobId.startsWith(URL_PREFIX)) {
      return { status: 'succeeded', resultUrl: jobId.slice(URL_PREFIX.length) }
    }
    if (!jobId.startsWith(TASK_PREFIX)) {
      return { status: 'failed', message: `Token Plan jobId 形态不认识：${jobId.slice(0, 80)}` }
    }
    const key = await this.requireKey()
    const taskId = jobId.slice(TASK_PREFIX.length)
    const response = await fetch(`${this.baseUrl}${TASK_ENDPOINT}/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      return { status: 'failed', message: `Token Plan 状态查询失败（HTTP ${response.status}）` }
    }
    const data = (await response.json()) as {
      output?: { task_status?: string; video_url?: string; message?: string; code?: string }
      code?: string
      message?: string
    }
    const status = data.output?.task_status
    if (status === 'PENDING') {
      return { status: 'running', progress: 0.1, message: '排队中' }
    }
    if (status === 'RUNNING') {
      return { status: 'running', progress: 0.5, message: '生成中' }
    }
    if (status === 'SUCCEEDED') {
      const url = data.output?.video_url
      if (!url) {
        return { status: 'failed', message: `Token Plan 结果里找不到 video_url：${JSON.stringify(data.output).slice(0, 200)}` }
      }
      return { status: 'succeeded', resultUrl: url }
    }
    const reason = data.output?.message ?? data.output?.code ?? data.message ?? data.code ?? status ?? '未知状态'
    return { status: 'failed', message: `Token Plan 任务未成功：${reason}` }
  }

  /** 取消远端任务：token-plan 文档未记载 cancel 路由，best-effort（同 dashscope 姿势，失败不阻塞本地终态） */
  async cancel(jobId: string): Promise<void> {
    if (!jobId.startsWith(TASK_PREFIX)) return
    let key: string | undefined
    try {
      key = await this.getKey()
    } catch {
      return
    }
    if (!key) return
    const taskId = jobId.slice(TASK_PREFIX.length)
    try {
      await fetch(`${this.baseUrl}${TASK_ENDPOINT}/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(30_000)
      })
    } catch {
      // 网络异常或路由不存在时放弃远端取消
    }
  }
}

registerAdapter(
  'gateway-token-plan',
  (deps: AdapterDeps, config) =>
    new TokenPlanProvider(
      {
        id: config.id,
        label: config.label,
        models: buildModelRecord<TokenPlanModelConfig>(config.models),
        baseUrl: config.baseUrl,
        authKey: config.authKey,
        authEnv: config.authEnv
      },
      () => deps.resolveKey(config)
    ),
  {
    defaultAuthEnv: 'TOKEN_PLAN_KEY',
    supportedKinds: ['image', 'video'],
    // Token Plan 官方目录确认 HappyHorse i2v/r2v 接受参考图；HappyHorse API 文档明确支持
    // Base64 data URI。其余图像、视频、音频参考形态仍保守关闭。
    refCaps: {
      byKind: {
        image: { delivery: 'data_uri', maxBytes: MAX_REF_IMAGE_BYTES },
        video: { delivery: 'none' },
        audio: { delivery: 'none' }
      }
    }
  }
)
