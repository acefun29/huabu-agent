import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { basename, resolve } from 'path'
import type { MediaKind, MediaProviderType, ModelCapabilities } from '../../../shared/media'
import type { ProviderMediaRef, ProviderPollResult, ProviderSubmitInput } from '../provider'
import { extraOf, submitRefs } from '../provider'
import { readRefBytes } from './refImage'
import { registerAdapter, type AdapterDeps } from './registry'
import { BaseGatewayProvider, buildModelRecord } from './base'

/**
 * OpenAI 兼容网关适配器（协议家族路线的第一块：一个适配器覆盖一片供应商）。
 *
 * 覆盖的端点（2026-10 对照 openai-openapi 仓库 videos.md / images.md 核实）：
 * - 图片：POST {base}/images/generations（同步），body {model, prompt, size, n}。
 *   响应 data[0].url（dall-e 系）或 data[0].b64_json（gpt-image 系只回 b64）——
 *   b64 就地落成临时文件，走 resultFile 通道交编排层收编。
 * - 图生图（有参考图时自动切换）：POST {base}/images/edits，multipart
 *   （model/prompt/size + image 或 image[] 文件）。响应与 generations 同构
 *   （url / b64_json 双通道）。只实现官方契约：不吃 image_url 之类的网关私有
 *   字段，不支持 edits 端点的网关会得到明确的 404/405 错误而不是静默丢参考图。
 * - 视频：POST {base}/videos 创建异步任务（无参考图走 JSON；带首帧参考图走
 *   multipart，input_reference 字段），轮询 GET {base}/videos/{id} 的
 *   status/progress，completed 后 GET {base}/videos/{id}/content 取回二进制
 *   mp4（该端点需认证头，不能把 URL 甩给编排层下载，故在 poll 内落临时文件）。
 *   seconds 官方只收 4/8/12 三档，其它值就近归档；取消 = DELETE 同路径。
 *   严格官方契约：content 端点 404/405 时明确报错，不吞私有直链字段。
 * - 音频：POST {base}/audio/speech（同步二进制流），body {model, input, voice,
 *   response_format:'mp3'}。时长由文本长度决定，durationSeconds 不参与请求。
 * - 认证头：默认 `Authorization: Bearer`；供应商配置 authStyle='x-api-key' 时
 *   改发 `x-api-key` 头（硅基流动之外的部分聚合网关用这种风格）。
 *
 * 兼容 OpenAI 原生、以及一切实现了同款 images/videos/speech 端点的网关（硅基流动、
 * 302.AI、Novita 等）：用户在设置页「新增供应商」选本类型 + 填 baseUrl 即可，
 * 零代码。视频任务依赖网关完整实现 /videos 三端点（创建 / 查询 / content 取回）。
 *
 * 同步返回意味着 submit 阻塞到出结果（images/speech）；视频是异步任务制，
 * jobId 编码任务 id，poll 打网关——与 dashscope/volcark 视频同构。
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** jobId 前缀：图片/音频结果是 URL 或本地临时文件；视频是异步任务 id */
const URL_PREFIX = 'oc-url|'
const FILE_PREFIX = 'oc-file|'
const VIDEO_JOB_PREFIX = 'oc-video|'

/** 官方 images 族的 output_format 枚举（b64 通道的临时文件扩展名只认这三个值） */
const IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp']

/** 官方 seconds 枚举（VideoSeconds：4 / 8 / 12）；集合外的值就近归档，规避网关 400 */
const VIDEO_SECONDS = [4, 8, 12] as const

/**
 * images 端点对 gpt-image 系只收固定档位：任意比例就近归档
 * （1:1 → 方，竖版 → 1024x1536，横版 → 1536x1024）。
 */
function sizeFor(width?: number, height?: number): string {
  if (!width || !height) return '1024x1024'
  if (Math.abs(width / height - 1) < 0.2) return '1024x1024'
  return width > height ? '1536x1024' : '1024x1536'
}

/** multipart 文件字段的文件名：本地文件取 basename，URL 素材用角色名兜底 */
function refNameForSubmit(ref: ProviderMediaRef): string {
  if (ref.absPath) return basename(ref.absPath)
  return ref.role === 'first_frame' ? 'input_reference' : `reference.${ref.mime.split('/')[1] ?? 'bin'}`
}

/** 视频尺寸：官方 size 形如 '1280x720'；请求未给像素时不下发（用网关缺省） */
function videoSizeFor(width?: number, height?: number): string | undefined {
  return width && height ? `${width}x${height}` : undefined
}

/** 视频时长：官方只收 4/8/12 三档，就近归档；未指定则不下发（用网关缺省） */
function snapVideoSeconds(durationSeconds?: number): number | undefined {
  if (!durationSeconds || durationSeconds <= 0) return undefined
  if ((VIDEO_SECONDS as readonly number[]).includes(durationSeconds)) return durationSeconds
  return VIDEO_SECONDS.reduce((best, s) => (Math.abs(s - durationSeconds) < Math.abs(best - durationSeconds) ? s : best))
}

export interface OpenAICompatModelConfig {
  kind: MediaKind
  label?: string
  /** 目录层的稳定用户可见 id（如 'openai/gpt-image-1'）；缺省 = 用线上模型名兜底 */
  userId?: string
  /** 目录层能力元数据透传（渲染端参数面板与编排层参数协商消费） */
  capabilities?: ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
  costHint?: string
}

export interface OpenAICompatProviderConfig {
  id?: string
  label?: string
  models: Record<string, OpenAICompatModelConfig>
  /** 网关基址（含 /v1）；缺省 = OpenAI 官方。兼容网关（硅基流动等）各自不同 */
  baseUrl?: string
  /** 凭据存储键（safeStorage 存储 media:<authKey>）；未录入时退回环境变量 */
  authKey?: string
  /** 环境变量名（默认 OPENAI_API_KEY） */
  authEnv?: string
  /** 认证头风格：bearer（缺省）= `Authorization: Bearer <key>`；x-api-key = `x-api-key: <key>` */
  authStyle?: 'bearer' | 'x-api-key'
}

export class OpenAICompatProvider extends BaseGatewayProvider<OpenAICompatModelConfig> {
  readonly type: MediaProviderType = 'gateway-openai-compat'
  private readonly baseUrl: string
  private readonly authStyle: 'bearer' | 'x-api-key'

  constructor(
    config: OpenAICompatProviderConfig,
    getKey: () => Promise<string | undefined>,
    /** b64/二进制产物的临时落盘目录（当前工作区媒体目录） */
    private readonly tempDir: () => string | null
  ) {
    super(config, getKey, 'OPENAI_API_KEY', { id: 'openai-compat', label: 'OpenAI 兼容网关' })
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.authStyle = config.authStyle ?? 'bearer'
  }

  /** 认证头（只含凭据部分）：x-api-key 风格供部分聚合网关用。
   *  Content-Type 由调用点按 body 形态自行附加——multipart 绝不能手动声明 */
  private authHeaders(key: string): Record<string, string> {
    return this.authStyle === 'x-api-key' ? { 'x-api-key': key } : { Authorization: `Bearer ${key}` }
  }

  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const requestModel = this.requestModelOf(model)
    if (!requestModel) this.noSuchModel(model)
    const kind = this.kindOf(model)
    if (kind === 'audio') return this.submitSpeech(key, requestModel, input)
    if (kind === 'video') return this.submitVideo(key, requestModel, input)
    return this.submitImage(key, requestModel, input)
  }

  /**
   * 视频任务创建（异步）：无参考图走 JSON；带首帧参考图走 multipart
   * （input_reference 文件字段——本地文件没法塞进 JSON 的 image_url）。
   * 官方语义只有单张首帧，第二个及以后的参考图没有对应字段，只用第一条图片参考。
   */
  private async submitVideo(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const seconds = snapVideoSeconds(input.durationSeconds)
    const size = videoSizeFor(input.width, input.height)
    // 有首帧参考图走 multipart（input_reference 是文件字段，本地文件塞不进 JSON 的
    // image_url）。官方语义只有单张首帧、没有多参考/role 概念，多余的由编排层按上限拦下
    // 素材来源两种：本地文件（refs[].absPath）与公网/临时 URL（refs[].url，先取回字节）
    const imageRefs = submitRefs(input).filter((r) => r.mediaType === 'image')
    const refImage = imageRefs[0]
    const refBytes = refImage ? await readRefBytes(refImage) : undefined
    let body: FormData | string
    let headers: Record<string, string>
    if (refImage && refBytes) {
      const form = new FormData()
      form.append('model', requestModel)
      form.append('prompt', input.prompt)
      if (seconds !== undefined) form.append('seconds', String(seconds))
      if (size) form.append('size', size)
      form.append(
        'input_reference',
        new Blob([refBytes], { type: refImage.mime }),
        refNameForSubmit(refImage)
      )
      body = form
      // multipart 不能自己写 Content-Type（boundary 由 fetch 生成），只带认证头
      headers = this.authHeaders(key)
    } else {
      body = JSON.stringify({
        model: requestModel,
        prompt: input.prompt,
        ...(seconds !== undefined ? { seconds } : {}),
        ...(size ? { size } : {})
      })
      headers = { ...this.authHeaders(key), 'Content-Type': 'application/json' }
    }
    const response = await fetch(`${this.baseUrl}/videos`, {
      method: 'POST',
      headers,
      body,
      // 只创建任务不生成：排队/鉴权都要不了几分钟，2 分钟足够
      signal: AbortSignal.timeout(120_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.httpErrorMessage(response, text, '网关认证失败', '视频任务创建失败')
    }
    const data = (await response.json()) as { id?: string; error?: { message?: string } | string }
    if (!data.id) {
      const message = typeof data.error === 'string' ? data.error : data.error?.message
      throw new Error(`视频任务创建失败：响应里没有任务 id${message ? `（${message}）` : ''}`)
    }
    return `${VIDEO_JOB_PREFIX}${data.id}`
  }

  /** 同步出图（文生图）：url 形态编码进 jobId；b64 形态落临时文件 */
  private async submitImage(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    if (submitRefs(input).some((r) => r.mediaType === 'image')) return this.submitEditImage(key, requestModel, input)
    const extras = this.imageExtras(input)
    const body: Record<string, unknown> = {
      model: requestModel,
      prompt: input.prompt,
      n: 1,
      size: sizeFor(input.width, input.height),
      ...extras.body
    }
    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { ...this.authHeaders(key), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // 同步生成端点：请求即生成，gpt-image 高质量档可超 30s，放宽到 5 分钟防误杀
      signal: AbortSignal.timeout(300_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.httpErrorMessage(response, text, '网关认证失败', '图片生成失败')
    }
    return this.ingestImageResult(
      (await response.json()) as { data?: { url?: string; b64_json?: string }[]; error?: { message?: string } },
      extras.outputFormat
    )
  }

  /**
   * 图生图：官方 images/edits 的 multipart 契约（单图字段 image、多图 image[]）。
   * 不实现网关私有扩展字段（image_url 等）：不支持 edits 的网关会在 404/405
   * 拿到带提示的错误，而不是被静默降级成文生图。
   */
  private async submitEditImage(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const form = new FormData()
    form.append('model', requestModel)
    form.append('prompt', input.prompt)
    form.append('size', sizeFor(input.width, input.height))
    const extras = this.imageExtras(input)
    for (const [field, value] of Object.entries(extras.body)) form.append(field, String(value))
    // 官方 edits：image 单文件字段名 'image'、多文件 'image[]'，上限 16 张 × 每张 <50MB。
    // 先把字节取齐再定字段名 —— 按"准备发几张"决定单/多数组，而不是按"请求里挂了几张"
    const images: { bytes: Buffer; ref: ProviderMediaRef }[] = []
    for (const ref of submitRefs(input).filter((r) => r.mediaType === 'image')) {
      const bytes = await readRefBytes(ref)
      if (bytes) images.push({ bytes, ref })
    }
    const field = images.length === 1 ? 'image' : 'image[]'
    for (const { bytes, ref } of images) {
      form.append(field, new Blob([bytes], { type: ref.mime }), refNameForSubmit(ref))
    }
    const response = await fetch(`${this.baseUrl}/images/edits`, {
      method: 'POST',
      headers: this.authHeaders(key),
      body: form,
      signal: AbortSignal.timeout(300_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const base = this.httpErrorMessage(response, text, '网关认证失败', '图片编辑失败')
      if (response.status === 404 || response.status === 405) {
        throw new Error(`${base.message}（该网关可能不支持图生图端点 /images/edits，文生图不受影响）`)
      }
      throw base
    }
    return this.ingestImageResult(
      (await response.json()) as { data?: { url?: string; b64_json?: string }[]; error?: { message?: string } },
      extras.outputFormat
    )
  }

  /** generations / edits 共用的结果解析：url 与 b64_json 双通道 */
  private ingestImageResult(
    data: { data?: { url?: string; b64_json?: string }[]; error?: { message?: string } },
    outputFormat?: string
  ): string {
    const first = data.data?.[0]
    if (first?.url) return `${URL_PREFIX}${first.url}`
    if (first?.b64_json) {
      // 请求里声明过 output_format 时临时文件跟着换扩展名（只认官方三档，别的值不进文件名）
      const ext = IMAGE_OUTPUT_FORMATS.includes(String(outputFormat)) ? `.${outputFormat}` : '.png'
      const file = this.writeTemp(Buffer.from(first.b64_json, 'base64'), ext)
      return `${FILE_PREFIX}${file}`
    }
    throw new Error(`结果里既没有 url 也没有 b64_json：${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`)
  }

  /** 声明式附加参数 → 图片请求体字段（官方 images 族支持的四个可选参数） */
  private imageExtras(input: ProviderSubmitInput): { body: Record<string, unknown>; outputFormat?: string } {
    const body: Record<string, unknown> = {}
    for (const key of ['quality', 'background', 'input_fidelity'] as const) {
      const value = extraOf(input, key)
      if (typeof value === 'string' || typeof value === 'number') body[key] = value
    }
    const format = extraOf(input, 'output_format')
    if (typeof format === 'string' && IMAGE_OUTPUT_FORMATS.includes(format)) {
      body.output_format = format
      return { body, outputFormat: format }
    }
    return { body }
  }

  /** 同步语音：响应是二进制音频流，直接落临时文件 */
  private async submitSpeech(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { ...this.authHeaders(key), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: requestModel,
        input: input.prompt,
        voice: input.voice ?? this.config.models[requestModel]?.capabilities?.voices?.[0]?.id ?? 'alloy',
        response_format: 'mp3'
      }),
      // 同步生成端点：长文本 TTS 生成耗时随篇幅增长，放宽到 5 分钟防误杀
      signal: AbortSignal.timeout(300_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.httpErrorMessage(response, text, '网关认证失败', '语音合成失败')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('语音合成返回空响应')
    const file = this.writeTemp(bytes, '.mp3')
    return `${FILE_PREFIX}${file}`
  }

  /** b64/二进制产物的落盘点：编排层 materialize 会把临时文件收编为正式产物名 */
  private writeTemp(bytes: Buffer, ext: string): string {
    const dir = this.tempDir()
    if (!dir) throw new Error('尚未打开工作区，无法落盘生成结果')
    const tempDir = resolve(dir, '.part-incoming')
    mkdirSync(tempDir, { recursive: true })
    const file = resolve(tempDir, `${randomUUID()}${ext}`)
    writeFileSync(file, bytes)
    return file
  }

  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    if (jobId.startsWith(URL_PREFIX)) {
      return { status: 'succeeded', resultUrl: jobId.slice(URL_PREFIX.length) }
    }
    if (jobId.startsWith(FILE_PREFIX)) {
      const file = jobId.slice(FILE_PREFIX.length)
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
      return {
        status: 'succeeded',
        resultFile: file,
        fileExt: ext,
        mime: ext === '.mp3' ? 'audio/mpeg' : 'image/png'
      }
    }
    if (jobId.startsWith(VIDEO_JOB_PREFIX)) {
      return this.pollVideo(jobId.slice(VIDEO_JOB_PREFIX.length))
    }
    return { status: 'failed', message: `无法识别的任务标识：${jobId.slice(0, 80)}` }
  }

  /** 视频轮询：queued/in_progress → running；completed → 取回产物；失败态携带网关原因 */
  private async pollVideo(videoId: string): Promise<ProviderPollResult> {
    const key = await this.requireKey()
    const response = await fetch(`${this.baseUrl}/videos/${encodeURIComponent(videoId)}`, {
      headers: this.authHeaders(key),
      signal: AbortSignal.timeout(60_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.httpErrorMessage(response, text, '网关认证失败', '视频任务查询失败')
    }
    const data = (await response.json()) as {
      status?: string
      progress?: number
      seconds?: number
      error?: { message?: string } | string
    }
    if (data.status === 'completed') return this.downloadVideo(key, videoId, data.seconds)
    // 官方 videos.md 的终态枚举只有 completed/failed；cancelled 与 expired 是兼容网关的私有状态
    // （不少网关自己加了取消与超时清理），一并当失败处理，不给它们编造官方语义
    if (data.status === 'failed' || data.status === 'cancelled' || data.status === 'expired') {
      const message = typeof data.error === 'string' ? data.error : data.error?.message
      return { status: 'failed', message: message ? `视频生成失败：${message}` : '视频生成失败（网关未给原因）' }
    }
    if (data.status === 'queued' || data.status === 'in_progress') {
      const percent = typeof data.progress === 'number' && data.progress > 0 ? Math.round(data.progress) : undefined
      return {
        status: 'running',
        progress: percent ? Math.min(0.95, percent / 100) : 0.05,
        message: data.status === 'queued' ? '排队中' : `生成中${percent ? ` ${percent}%` : '…'}`
      }
    }
    return { status: 'failed', message: `无法识别的视频任务状态：${String(data.status).slice(0, 80)}` }
  }

  /**
   * completed 后取回 mp4：content 端点要认证头，编排层的产物下载不带凭据，
   * 所以在这里落临时文件走 resultFile 通道（与 submitSpeech 同一模式）。
   */
  private async downloadVideo(key: string, videoId: string, seconds?: number): Promise<ProviderPollResult> {
    const response = await fetch(`${this.baseUrl}/videos/${encodeURIComponent(videoId)}/content`, {
      headers: this.authHeaders(key),
      // 成片可达几十上百 MB：与编排层下载同级的 5 分钟超时
      signal: AbortSignal.timeout(300_000)
    })
    if (!response.ok || !response.body) {
      if (response.status === 404 || response.status === 405) {
        throw new Error('下载视频失败（该网关可能未实现 GET /videos/{id}/content；OpenAI 视频协议要求用它取回产物）')
      }
      throw new Error(`下载视频失败（HTTP ${response.status}）`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('视频内容为空')
    const file = this.writeTemp(bytes, '.mp4')
    return {
      status: 'succeeded',
      resultFile: file,
      fileExt: '.mp4',
      mime: 'video/mp4',
      ...(typeof seconds === 'number' && seconds > 0 ? { durationSeconds: seconds } : {})
    }
  }

  /** 取消远端视频任务（DELETE）；图片/音频是同步结果无可取消，删除失败不阻断编排层 */
  async cancel(jobId: string): Promise<void> {
    if (!jobId.startsWith(VIDEO_JOB_PREFIX)) return
    try {
      const key = await this.requireKey()
      await fetch(`${this.baseUrl}/videos/${encodeURIComponent(jobId.slice(VIDEO_JOB_PREFIX.length))}`, {
        method: 'DELETE',
        headers: this.authHeaders(key),
        signal: AbortSignal.timeout(30_000)
      })
    } catch {
      // 远端删除失败（超时/网络）仍让编排层把任务标记 cancelled
    }
  }
}

registerAdapter(
  'gateway-openai-compat',
  (deps: AdapterDeps, config) =>
    new OpenAICompatProvider(
      {
        id: config.id,
        label: config.label,
        models: buildModelRecord<OpenAICompatModelConfig>(config.models),
        baseUrl: config.baseUrl,
        authKey: config.authKey,
        authEnv: config.authEnv,
        authStyle: config.authStyle
      },
      () => deps.resolveKey(config),
      () => deps.mediaDir()
    ),
  {
    defaultAuthEnv: 'OPENAI_API_KEY',
    supportedKinds: ['image', 'video', 'audio'],
    // 官方（2026-10 openai-openapi 核实）：素材一律走 multipart 文件字段
    // （/images/edits 的 image[] 最多 16 张、单张 <50MB；/videos 的 input_reference 单图）。
    // 视频/音频**不是**这条通道的参考素材形态 —— sora 只接受一张首帧图
    refCaps: {
      byKind: {
        image: { delivery: 'multipart', maxBytes: 50 * 1024 * 1024 },
        video: { delivery: 'none' },
        audio: { delivery: 'none' }
      }
    }
  }
)
