import type { MediaKind, MediaProviderType, ModelCapabilities } from '../../../shared/media'
import type { ProviderPollResult, ProviderSubmitInput } from '../provider'
import { registerAdapter, type AdapterDeps } from './registry'
import { BaseGatewayProvider, buildModelRecord } from './base'
import { firstImageRefDataUri } from './refImage'

/**
 * MiniMax 开放平台适配器（2026-10 对照 platform.minimax.io 官方文档逐页核实；
 * 国内域名 api.minimaxi.com 经实测与本契约同构，可直接用 baseUrl 覆盖切换国际站）。
 *
 * 协议（官方 API 参考）：
 * - 图片（同步）：POST /v1/image_generation，body {model:'image-01', prompt,
 *   aspect_ratio, response_format:'url'}。aspect_ratio 枚举 1:1/16:9/4:3/3:2/2:3/
 *   3:4/9:16/21:9 —— 本应用的 5 档比例全部直接可用；垫图走 subject_reference
 *   [{type:'character', image_file}]（人像主体参考，支持 data URI，JPG/PNG ≤10MB）。
 *   注意：该 API 失败不走 HTTP 错误码，而是 HTTP 200 + base_resp.status_code
 *   （0=成功；1004 鉴权失败、1008 余额不足、2013 参数非法……），错误处理按此分支。
 *   结果在 data.image_urls[]（URL 24 小时有效，编排层立即下载落盘）。
 * - 视频（异步 V2）：POST /v2/video_generation，content 数组（text 必带 ≤7000 字 +
 *   可选 image_url 首帧，支持 data URI）。模型 MiniMax-H3（768P/2K，4~15s）与
 *   MiniMax-H3-Max（480P/768P 快速档，5~15s，不支持 2K）。ratio 枚举 adaptive/
 *   21:9/16:9/4:3/1:1/3:4/9:16 —— 文生视频 ratio 必填且不能 adaptive；图生视频
 *   （首帧）比例固定随输入图，传具体值也被官方按 adaptive 处理，故有参考图时不传。
 * - 查询：GET /v2/query/video_generation/{task_id} → task.status ∈ queued/running/
 *   succeeded/failed/cancelled，产物在 task.content.url（时效 URL，编排层下载落盘）。
 * - 取消：DELETE /v2/video_generation/{task_id}（queued 取消；终态则为删除记录）。
 * - 认证：Authorization: Bearer <MINIMAX_KEY>。错误体为 OpenAI 风格
 *   {error:{type,message,http_code}}。
 */

const IMAGE_ENDPOINT = '/v1/image_generation'
const VIDEO_ENDPOINT = '/v2/video_generation'

/** jobId 前缀：图片是同步结果 URL 本身；视频是 task_id（状态地址由它反推） */
const IMAGE_URL_PREFIX = 'mm-url|'
const VIDEO_TASK_PREFIX = 'mm-video|'

export interface MiniMaxModelConfig {
  kind: MediaKind
  label?: string
  /** 目录层的稳定用户可见 id（如 'minimax/h3'）；缺省 = 用线上模型名兜底 */
  userId?: string
  /** 目录层能力元数据透传（渲染端参数面板与编排层参数协商消费） */
  capabilities?: ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
  costHint?: string
}

export interface MiniMaxProviderConfig {
  id?: string
  label?: string
  models: Record<string, MiniMaxModelConfig>
  /** 凭据存储键（safeStorage 存储 media:<authKey>）；未录入时退回环境变量 */
  authKey?: string
  /** 环境变量名（默认 MINIMAX_KEY） */
  authEnv?: string
  /** 网关基址；缺省 = 国内站 api.minimaxi.com（国际站 api.minimax.io 可经用户配置覆盖） */
  baseUrl?: string
}

export class MiniMaxProvider extends BaseGatewayProvider<MiniMaxModelConfig> {
  readonly type: MediaProviderType = 'gateway-minimax'
  private readonly baseUrl: string

  constructor(
    config: MiniMaxProviderConfig,
    getKey: () => Promise<string | undefined>
  ) {
    super(config, getKey, 'MINIMAX_KEY', { id: 'minimax', label: 'MiniMax' })
    this.baseUrl = (config.baseUrl ?? 'https://api.minimaxi.com').replace(/\/+$/, '')
  }

  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const requestModel = this.requestModelOf(model)
    if (!requestModel) this.noSuchModel(model)
    const kind = this.kindOf(model)
    return kind === 'video' ? this.submitVideo(key, requestModel, input) : this.submitImage(key, input)
  }

  /** 同步生图：结果 URL 直接编进 jobId，poll 原样回传 succeeded */
  private async submitImage(key: string, input: ProviderSubmitInput): Promise<string> {
    const refDataUri = await firstImageRefDataUri(input.refFiles)
    const body: Record<string, unknown> = {
      model: 'image-01',
      prompt: input.prompt,
      response_format: 'url',
      ...(input.ratio ? { aspect_ratio: input.ratio } : {}),
      ...(refDataUri ? { subject_reference: [{ type: 'character', image_file: refDataUri }] } : {})
    }
    const response = await fetch(`${this.baseUrl}${IMAGE_ENDPOINT}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // 同步生成端点：放宽到 2 分钟防误杀（异步任务提交/查询仍 30s，下同）
      signal: AbortSignal.timeout(120_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.httpErrorMessage(response, text, 'MiniMax 认证失败', 'MiniMax 生图提交失败')
    }
    const data = (await response.json()) as {
      base_resp?: { status_code?: number; status_msg?: string }
      data?: { image_urls?: string[] }
    }
    // 官方契约：失败也回 HTTP 200，业务错误在 base_resp.status_code（0=成功）
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax 生图失败（${data.base_resp.status_code}）：${data.base_resp.status_msg ?? '未知错误'}`)
    }
    const url = data.data?.image_urls?.[0]
    if (!url) throw new Error(`MiniMax 结果里找不到产物 URL：${JSON.stringify(data).slice(0, 200)}`)
    return `${IMAGE_URL_PREFIX}${url}`
  }

  /** 异步视频：提交拿 task_id，轮询 /v2/query/video_generation/{task_id} */
  private async submitVideo(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const refDataUri = await firstImageRefDataUri(input.refFiles)
    const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }]
    if (refDataUri) content.push({ type: 'image_url', image_url: { url: refDataUri }, role: 'first_frame' })
    const body: Record<string, unknown> = {
      model: requestModel,
      content,
      // 分辨率按画布高度就近归档：H3 收 768P/2K，H3-Max 只收 480P/768P（2K 官方不支持）
      resolution: this.resolutionFor(requestModel, input.height),
      // duration 必填整数；官方 H3 [4,15]、H3-Max [5,15]，缺省 5s 两档都合法
      duration: clamp(Math.round(input.durationSeconds ?? 5), requestModel === 'MiniMax-H3-Max' ? 5 : 4, 15),
      // 文生视频 ratio 必填且不能 adaptive；图生视频比例固定随首帧，传了也被忽略，不传
      ...(!refDataUri ? { ratio: input.ratio ?? '16:9' } : {})
    }
    const response = await fetch(`${this.baseUrl}${VIDEO_ENDPOINT}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.httpErrorMessage(response, text, 'MiniMax 认证失败', 'MiniMax 视频提交失败')
    }
    const data = (await response.json()) as { task_id?: string; error?: { message?: string } }
    if (!data.task_id) {
      throw new Error(`MiniMax 响应缺少 task_id：${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`)
    }
    return `${VIDEO_TASK_PREFIX}${data.task_id}`
  }

  /** H3：高度 ≥1000 归 2K，其余 768P；H3-Max：固定 768P（2K 不支持、480P 质量差一档） */
  private resolutionFor(requestModel: string, height?: number): string {
    if (requestModel === 'MiniMax-H3-Max') return '768P'
    return (height ?? 0) >= 1000 ? '2K' : '768P'
  }

  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    // 同步图片：jobId 即结果 URL，submit 成功即任务成功
    if (!jobId.startsWith(VIDEO_TASK_PREFIX)) {
      return { status: 'succeeded', resultUrl: jobId.slice(IMAGE_URL_PREFIX.length) }
    }
    const key = await this.requireKey()
    const taskId = jobId.slice(VIDEO_TASK_PREFIX.length)
    const response = await fetch(`${this.baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      return { status: 'failed', message: `MiniMax 状态查询失败（HTTP ${response.status}）` }
    }
    const data = (await response.json()) as {
      task?: {
        status?: string
        content?: { url?: string; prompt?: string }
        fail_reason?: string
      }
      error?: { message?: string }
    }
    const task = data.task
    if (!task) {
      return { status: 'failed', message: `MiniMax 查询结果缺少 task：${JSON.stringify(data).slice(0, 200)}` }
    }
    if (task.status === 'queued') return { status: 'running', progress: 0.1, message: '排队中' }
    if (task.status === 'running') return { status: 'running', progress: 0.5, message: '生成中' }
    if (task.status === 'succeeded') {
      const url = task.content?.url
      if (!url) {
        return { status: 'failed', message: `MiniMax 结果里找不到视频 URL：${JSON.stringify(task).slice(0, 200)}` }
      }
      return { status: 'succeeded', resultUrl: url }
    }
    const reason = task.fail_reason ?? data.error?.message ?? task.status ?? '未知状态'
    return { status: 'failed', message: `MiniMax 任务未成功：${reason}` }
  }

  /** 取消远端任务（queued 取消、终态删除记录）；同步图片无远端任务可取消 */
  async cancel(jobId: string): Promise<void> {
    if (!jobId.startsWith(VIDEO_TASK_PREFIX)) return
    let key: string | undefined
    try {
      key = await this.getKey()
    } catch {
      return
    }
    if (!key) return
    const taskId = jobId.slice(VIDEO_TASK_PREFIX.length)
    try {
      await fetch(`${this.baseUrl}${VIDEO_ENDPOINT}/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(30_000)
      })
    } catch {
      // 网络异常时放弃远端取消；编排层已落本地 cancelled 终态
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

registerAdapter(
  'gateway-minimax',
  (deps: AdapterDeps, config) =>
    new MiniMaxProvider(
      {
        id: config.id,
        label: config.label,
        models: buildModelRecord<MiniMaxModelConfig>(config.models),
        authKey: config.authKey,
        authEnv: config.authEnv,
        baseUrl: config.baseUrl
      },
      () => deps.resolveKey(config)
    ),
  { defaultAuthEnv: 'MINIMAX_KEY' }
)
