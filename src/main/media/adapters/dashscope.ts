import type { MediaKind, MediaProviderType, ModelCapabilities } from '../../../shared/media'
import type { ProviderPollResult, ProviderSubmitInput } from '../provider'
import { registerAdapter, type AdapterDeps } from './registry'
import { BaseGatewayProvider, buildModelRecord, nearestRatio } from './base'
import { firstImageRefDataUri } from './refImage'

/**
 * 阿里云百炼（DashScope）适配器：异步任务制（与 openaiCompat 的同步制是两种网关形态）。
 *
 * 协议（2026-09 对照 help.aliyun.com/zh/model-studio 官方文档核实）：
 * - 图片（wan2.5 及以下旧协议）：POST /api/v1/services/aigc/text2image/image-synthesis
 * - 视频：POST /api/v1/services/aigc/video-generation/video-synthesis
 *   两者都必须带 header `X-DashScope-Async: enable`，返回 output.task_id。
 * - 轮询：GET /api/v1/tasks/{task_id}，状态流转 PENDING → RUNNING → SUCCEEDED /
 *   FAILED / CANCELED / UNKNOWN；结果图片在 output.results[0].url，视频在
 *   output.video_url（产物 OSS 链接 24 小时有效，编排层下载落盘后无时效问题）。
 * - 取消：POST /api/v1/tasks/{task_id}/cancel，失败不阻塞本地 cancelled 终态。
 *
 * 新协议（2026-09 对照官方文档补齐）：
 * - 图片 wan2.6 起：POST /api/v1/services/aigc/image-generation/generation，
 *   input.messages[{role:'user', content:[{text}]}]，size 仍是「宽*高」但总像素限
 *   [1280×1280, 1440×1440]；产物不再走 results[].url，而是
 *   output.choices[].message.content[].image（URL）。
 * - 视频 wan2.7 起：端点/轮询不变，parameters 从 size 换成 resolution("720P"/"1080P")
 *   + ratio("16:9" 等) + duration 整数 [2,15]，产物仍是 output.video_url。
 *
 * 图生图 / 图生视频（2026-09-25 对照官方 API 参考核实，data URI 支持=本地垫图可离线）：
 * - 图生图 wan2.6-image / wan2.7-image(-pro)：与文生图共用 image-generation/generation
 *   端点，content 数组追加 {image: <URL 或 data URI>} 即为图生图；官方支持
 *   "data:{MIME};base64,{base64_data}"（wan2.7 单图 ≤20MB，宽高 [240,8000]，wan2.7 可 0-9 张）；
 *   有图输入时输出比例缺省随最后一张输入图；调用方显式给了比例（width/height）时必须传
 *   size 覆盖，否则竖版请求会静默出成参考图的横版（官方允许显式 size，编辑模式像素
 *   窗口 [768²,2048²] 包含本适配器的归一窗口）；未指定比例时不传 size，保持随参考图。
 * - 图生视频 wan2.7-i2v / wan3.0-video(-prime)：input 从 {prompt} 扩为
 *   {prompt, media:[{type:'first_frame', url}]}，url 同样吃 Base64 data URI（≤20MB）；
 *   wan2.7-i2v 无 ratio 参数、duration [2,15]；wan3.0-video 支持 ratio（默认 adaptive）
 *   且 duration [2,30]。尾帧 last_frame 一期不做（编排层只有单参考图语义）。
 */

const BASE_URL = 'https://dashscope.aliyuncs.com'
const IMAGE_ENDPOINT = '/api/v1/services/aigc/text2image/image-synthesis'
const IMAGE_GEN_ENDPOINT = '/api/v1/services/aigc/image-generation/generation'
const VIDEO_ENDPOINT = '/api/v1/services/aigc/video-generation/video-synthesis'
const TASK_ENDPOINT = '/api/v1/tasks'

/** jobId 里的分隔符：slug|task_id（状态地址由 slug 无关、仅 task_id 决定） */
const JOB_SEP = '|'

export interface DashScopeModelConfig {
  kind: MediaKind
  label?: string
  /** 目录层的稳定用户可见 id（如 'dashscope/wan2.2-t2i-flash'）；缺省 = 用线上模型名兜底 */
  userId?: string
  /** 目录层能力元数据透传（渲染端参数面板与编排层参数协商消费） */
  capabilities?: ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
  costHint?: string
}

export interface DashScopeProviderConfig {
  id?: string
  label?: string
  models: Record<string, DashScopeModelConfig>
  /** 凭据存储键（safeStorage 存储 media:<authKey>）；未录入时退回环境变量 */
  authKey?: string
  /** 环境变量名（默认 DASHSCOPE_KEY） */
  authEnv?: string
}

export class DashScopeProvider extends BaseGatewayProvider<DashScopeModelConfig> {
  readonly type: MediaProviderType = 'gateway-dashscope'

  constructor(
    config: DashScopeProviderConfig,
    getKey: () => Promise<string | undefined>
  ) {
    super(config, getKey, 'DASHSCOPE_KEY', { id: 'dashscope', label: '阿里云百炼' })
  }

  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const requestModel = this.requestModelOf(model)
    if (!requestModel) this.noSuchModel(model)
    const kind = this.kindOf(model)

    const endpoint = kind === 'video' ? VIDEO_ENDPOINT : isNewImageProtocol(requestModel) ? IMAGE_GEN_ENDPOINT : IMAGE_ENDPOINT
    const body = kind === 'video' ? await videoBody(requestModel, input) : await imageBody(requestModel, input)
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        // 百炼生成类接口只支持异步调用，漏掉该 header 会报「不支持同步调用」
        'X-DashScope-Async': 'enable',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      // 单请求 30s 硬超时：服务器不回包时中止，不让单个请求占死并发槽（下同）
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.httpErrorMessage(
        response,
        text,
        '百炼认证失败',
        '百炼提交失败',
        '请检查 API Key 是否正确、是否与北京地域匹配'
      )
    }
    const data = (await response.json()) as {
      output?: { task_id?: string }
      code?: string
      message?: string
    }
    const taskId = data.output?.task_id
    if (!taskId) {
      throw new Error(`百炼响应缺少 output.task_id：${data.code ?? ''} ${data.message ?? JSON.stringify(data).slice(0, 200)}`)
    }
    // jobId 里存线上模型名 + task_id（poll 时用于 kind 兜底与调试）
    return `${requestModel}${JOB_SEP}${taskId}`
  }

  async poll(model: string, jobId: string): Promise<ProviderPollResult> {
    const key = await this.requireKey()
    const taskId = jobId.split(JOB_SEP).pop() ?? ''
    // jobId 里带着提交时的线上模型名（submit 处拼接），用于识别新协议图片的产物结构
    const requestModel = jobId.includes(JOB_SEP) ? jobId.slice(0, jobId.lastIndexOf(JOB_SEP)) : undefined
    const response = await fetch(`${BASE_URL}${TASK_ENDPOINT}/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      return { status: 'failed', message: `百炼状态查询失败（HTTP ${response.status}）` }
    }
    const data = (await response.json()) as {
      output?: {
        task_id?: string
        task_status?: string
        results?: { url?: string; code?: string; message?: string }[]
        video_url?: string
        choices?: { message?: { content?: { type?: string; image?: string; text?: string }[] } }[]
        message?: string
        code?: string
      }
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
      const url = this.kindOf(model) === 'video'
        ? data.output?.video_url
        : requestModel && isNewImageProtocol(requestModel)
          ? data.output?.choices?.flatMap((c) => c.message?.content ?? []).find((c) => c.type === 'image' && c.image)?.image
          : data.output?.results?.[0]?.url
      if (!url) {
        return { status: 'failed', message: `百炼结果里找不到产物 URL：${JSON.stringify(data.output).slice(0, 200)}` }
      }
      return { status: 'succeeded', resultUrl: url }
    }
    const reason = data.output?.message ?? data.output?.code ?? data.message ?? data.code ?? status ?? '未知状态'
    return { status: 'failed', message: `百炼任务未成功：${reason}` }
  }

  /** 取消远端任务：失败不阻塞本地 cancelled 终态（编排层已落本地终态） */
  async cancel(jobId: string): Promise<void> {
    if (!jobId.includes(JOB_SEP)) return
    let key: string | undefined
    try {
      key = await this.getKey()
    } catch {
      return
    }
    if (!key) return
    const taskId = jobId.split(JOB_SEP).pop() ?? ''
    try {
      await fetch(`${BASE_URL}${TASK_ENDPOINT}/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(30_000)
      })
    } catch {
      // 网络异常时放弃远端取消
    }
  }
}

/** 通义万相线上模型名的版本号（wan2.6-t2i / wanx2.1-t2i-turbo → [2, 6] / [2, 1]） */
function wanVersion(requestModel: string): [number, number] | null {
  const m = /^wanx?(\d+)\.(\d+)-/i.exec(requestModel)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** 图片新协议：wan2.6 起（image-generation/generation + messages + choices 产物） */
function isNewImageProtocol(requestModel: string): boolean {
  const v = wanVersion(requestModel)
  return v !== null && (v[0] > 2 || (v[0] === 2 && v[1] >= 6))
}

/** 视频新参数：wan2.7 起（resolution+ratio 替代 size，duration 为整数） */
function isNewVideoParams(requestModel: string): boolean {
  const v = wanVersion(requestModel)
  return v !== null && (v[0] > 2 || (v[0] === 2 && v[1] >= 7))
}

async function imageBody(requestModel: string, input: ProviderSubmitInput): Promise<Record<string, unknown>> {
  if (isNewImageProtocol(requestModel)) {
    // 图生图（官方 API 参考）：content 追加 {image}，data URI 是官方支持的离线形态。
    // 编辑模式缺省输出比例随最后一张输入图 —— 调用方显式给了比例（width/height）时
    // 必须传 size 覆盖，否则 3:4/9:16 的竖版请求会静默出成参考图的横版；
    // 未指定比例时不传 size，保持「随参考图」的图生图缺省语义。
    const refDataUri = await firstImageRefDataUri(input.refFiles)
    const content: Record<string, unknown>[] = [{ text: input.prompt }]
    if (refDataUri) content.push({ image: refDataUri })
    return {
      model: requestModel,
      input: { messages: [{ role: 'user', content }] },
      // wan2.6/2.7 size 仍是「宽*高」，按画布尺寸归一到总像素 [1280²,1440²] 窗口
      //（官方编辑模式窗口 [768²,2048²] 更大，包含本窗口，显式 size 对图生图同样合法）
      parameters: {
        n: 1,
        ...(input.width && input.height ? { size: wan26PixelSize(input.width, input.height) } : {})
      }
    }
  }
  const parameters: Record<string, unknown> = { n: 1 }
  if (input.width && input.height) {
    // 百炼旧协议 size 是「宽*高」字符串；wan2.2 及以下两边都限 [512,1440]
    parameters.size = `${clamp(input.width, 512, 1440)}*${clamp(input.height, 512, 1440)}`
  }
  return { model: requestModel, input: { prompt: input.prompt }, parameters }
}

async function videoBody(requestModel: string, input: ProviderSubmitInput): Promise<Record<string, unknown>> {
  // 图生视频（wan2.7-i2v / wan3.0-video，官方 API 参考核实）：input 扩为 media 数组，
  // 首帧图吃 data URI；wan2.7-i2v 无 ratio 参数且 duration [2,15]，wan3.0-video [2,30]
  // 且支持 ratio（默认 adaptive —— 有首帧时自适应输入图，正是图生视频语义，故不传）
  if (isMediaVideoModel(requestModel)) {
    const refDataUri = await firstImageRefDataUri(input.refFiles)
    const parameters: Record<string, unknown> = { n: 1 }
    if (input.width && input.height) {
      parameters.resolution = input.height >= 1000 ? '1080P' : '720P'
    }
    if (input.durationSeconds) {
      parameters.duration = isWan3Video(requestModel)
        ? clamp(Math.round(input.durationSeconds), 2, 30)
        : clamp(Math.round(input.durationSeconds), 2, 15)
    }
    return {
      model: requestModel,
      input: {
        prompt: input.prompt,
        ...(refDataUri ? { media: [{ type: 'first_frame', url: refDataUri }] } : {})
      },
      parameters
    }
  }

  const parameters: Record<string, unknown> = { n: 1 }
  if (isNewVideoParams(requestModel)) {
    // wan2.7 t2v 起：resolution + ratio + duration 整数 [2,15]（官方文档核实，无 size 字段）
    if (input.width && input.height) {
      parameters.resolution = input.height >= 1000 ? '1080P' : '720P'
      parameters.ratio = nearestRatio(input.width, input.height)
    }
    if (input.durationSeconds) parameters.duration = clamp(Math.round(input.durationSeconds), 2, 15)
  } else {
    if (input.width && input.height) {
      parameters.size = `${clamp(input.width, 512, 1440)}*${clamp(input.height, 512, 1440)}`
    }
    if (input.durationSeconds) parameters.duration = String(Math.round(input.durationSeconds))
  }
  return { model: requestModel, input: { prompt: input.prompt }, parameters }
}

/**
 * 「media 数组」形态的视频模型：wan2.x-i2v 系与 wan3.0-video（All-in-One）。
 * 与 t2v 的 {input:{prompt}} 形态不同，它们把首帧图放进 input.media（官方 API 参考：
 * media[].type = first_frame/last_frame/reference_image…，url 支持 Base64 data URI）。
 */
function isMediaVideoModel(requestModel: string): boolean {
  return /-i2v/i.test(requestModel) || isWan3Video(requestModel)
}

function isWan3Video(requestModel: string): boolean {
  return /^wan3\.0-video/i.test(requestModel)
}

/** wan2.6 图片：保持比例，把总像素归一到 [1280×1280, 1440×1440] 窗口 */
function wan26PixelSize(width: number, height: number): string {
  let w = Math.round(width)
  let h = Math.round(height)
  const px = w * h
  const minPx = 1280 * 1280
  const maxPx = 1440 * 1440
  if (px < minPx || px > maxPx) {
    const scale = Math.sqrt((px < minPx ? minPx : maxPx) / px)
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }
  return `${w}*${h}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

registerAdapter(
  'gateway-dashscope',
  (deps: AdapterDeps, config) =>
    new DashScopeProvider(
      {
        id: config.id,
        label: config.label,
        models: buildModelRecord<DashScopeModelConfig>(config.models),
        authKey: config.authKey,
        authEnv: config.authEnv
      },
      () => deps.resolveKey(config)
    ),
  { defaultAuthEnv: 'DASHSCOPE_KEY' }
)
