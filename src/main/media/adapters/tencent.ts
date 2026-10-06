import { createHash, createHmac } from 'crypto'
import type { MediaKind, MediaProviderType, ModelCapabilities } from '../../../shared/media'
import type { ProviderPollResult, ProviderSubmitInput } from '../provider'
import { registerAdapter, type AdapterDeps } from './registry'
import { BaseGatewayProvider, buildModelRecord } from './base'
import { firstImageRefDataUri } from './refImage'

/**
 * 腾讯云混元适配器（TC3-HMAC-SHA256 签名协议，2026-10 对照 cloud.tencent.com
 * 官方接口文档逐页核实）：
 *
 * - 生图（hunyuan 服务，hunyuan.tencentcloudapi.com，Version 2023-09-01，
 *   Region 仅 ap-guangzhou）：
 *   · SubmitHunyuanImageJob：Prompt ≤1024 字（中文推荐）、Resolution 是「宽:高」
 *     字符串枚举（768:768 / 768:1024 / 1024:768 / 1024:1024 / 720:1280 / 1280:720 /
 *     768:1280 / 1280:768，默认 1024:1024；**上传参考图时仅支持前四种**，9:16/16:9
 *     就近归档到 3:4/4:3）、ContentImage 为参考图（Image 结构，单边 <5000px、
 *     Base64 后 <8MB、jpg/jpeg/png）、LogoAdd 默认 1（加"AI 生成"水印，置 0 需控制台
 *     申请后生效，这里显式传 0）。→ JobId
 *   · QueryHunyuanImageJob：JobId → JobStatusCode（1 等待 / 2 运行 / 4 失败 /
 *     5 完成）+ ResultImage[]（URL 1 小时有效）+ JobErrorCode/JobErrorMsg。
 * - 生视频（vclm 服务，vclm.tencentcloudapi.com，Version 2024-05-23，就近接入）：
 *   · SubmitHunyuanToVideoJob：Prompt 必填且 ≤200 字、Image 可选（有图即首帧图生视频，
 *     Base64/Url 二选一，base64 ≤8M）、Resolution 目前仅 720p、无时长参数（模型自定）、
 *     LogoAdd 默认 1（同上显式置 0）。→ JobId
 *   · DescribeHunyuanToVideoJob：JobId → Status（WAIT/RUN/FAIL/DONE）+
 *     ResultVideoUrl（24 小时有效）+ ErrorCode/ErrorMessage。
 * - 签名：TC3-HMAC-SHA256（官方签名 v3）。凭据是 SecretId + SecretKey **两个**值，
 *   而本应用的凭据模型是单 Key 字符串——约定用冒号拼接「SecretId:SecretKey」录入。
 * - 错误：响应体 {Response:{Error:{Code,Message}}}，HTTP 状态多为 200/4xx，按体判定。
 */

const IMAGE_HOST = 'hunyuan.tencentcloudapi.com'
const IMAGE_VERSION = '2023-09-01'
const VIDEO_HOST = 'vclm.tencentcloudapi.com'
const VIDEO_VERSION = '2024-05-23'
/** 生图接口官方声明仅支持 ap-guangzhou；生视频就近接入，同一 Region 两服务通用 */
const REGION = 'ap-guangzhou'

/** jobId 前缀：标识任务属于哪个服务（poll 时决定查询 Action） */
const IMAGE_JOB_PREFIX = 'tc-img|'
const VIDEO_JOB_PREFIX = 'tc-vid|'

export interface TencentModelConfig {
  kind: MediaKind
  label?: string
  /** 目录层的稳定用户可见 id（如 'tencent/hunyuan-image'）；缺省 = 用线上模型名兜底 */
  userId?: string
  /** 目录层能力元数据透传（渲染端参数面板与编排层参数协商消费） */
  capabilities?: ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
  costHint?: string
}

export interface TencentProviderConfig {
  id?: string
  label?: string
  models: Record<string, TencentModelConfig>
  /** 凭据存储键（safeStorage 存储 media:<authKey>）；未录入时退回环境变量 */
  authKey?: string
  /** 环境变量名（默认 TENCENT_KEY） */
  authEnv?: string
}

export class TencentHunyuanProvider extends BaseGatewayProvider<TencentModelConfig> {
  readonly type: MediaProviderType = 'gateway-tencent'

  constructor(
    config: TencentProviderConfig,
    getKey: () => Promise<string | undefined>
  ) {
    super(config, getKey, 'TENCENT_KEY', { id: 'tencent', label: '腾讯混元' })
  }

  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const { secretId, secretKey } = parseSecrets(await this.requireKey())
    const requestModel = this.requestModelOf(model)
    if (!requestModel) this.noSuchModel(model)
    const kind = this.kindOf(model)
    const refDataUri = await firstImageRefDataUri(input.refFiles)
    const refBase64 = refDataUri ? base64Of(refDataUri) : undefined
    if (kind === 'video') {
      const { Response } = await tc3Request<{ JobId?: string }>({
        host: VIDEO_HOST,
        service: 'vclm',
        action: 'SubmitHunyuanToVideoJob',
        version: VIDEO_VERSION,
        secretId,
        secretKey,
        payload: {
          // 官方硬上限 200 字：防御性截断，别让超长提示词把整单打成 400
          Prompt: truncateChars(input.prompt, 200),
          ...(refBase64 ? { Image: { Base64: refBase64 } } : {}),
          Resolution: '720p',
          LogoAdd: 0
        }
      })
      const jobId = Response?.JobId
      if (!jobId) throw new Error(`腾讯响应缺少 JobId：${JSON.stringify(Response).slice(0, 200)}`)
      return `${VIDEO_JOB_PREFIX}${jobId}`
    }
    const { Response } = await tc3Request<{ JobId?: string }>({
      host: IMAGE_HOST,
      service: 'hunyuan',
      action: 'SubmitHunyuanImageJob',
      version: IMAGE_VERSION,
      secretId,
      secretKey,
      payload: {
        Prompt: truncateChars(input.prompt, 1024),
        ...(refBase64 ? { ContentImage: { Base64: refBase64 } } : {}),
        ...(input.ratio ? { Resolution: imageResolution(input.ratio, Boolean(refBase64)) } : {}),
        LogoAdd: 0
      }
    })
    const jobId = Response?.JobId
    if (!jobId) throw new Error(`腾讯响应缺少 JobId：${JSON.stringify(Response).slice(0, 200)}`)
    return `${IMAGE_JOB_PREFIX}${jobId}`
  }

  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    const { secretId, secretKey } = parseSecrets(await this.requireKey())
    if (jobId.startsWith(VIDEO_JOB_PREFIX)) {
      const { Response } = await tc3Request<{
        Status?: string
        ResultVideoUrl?: string
        ErrorMessage?: string
        ErrorCode?: string
      }>({
        host: VIDEO_HOST,
        service: 'vclm',
        action: 'DescribeHunyuanToVideoJob',
        version: VIDEO_VERSION,
        secretId,
        secretKey,
        payload: { JobId: jobId.slice(VIDEO_JOB_PREFIX.length) }
      })
      const status = Response?.Status
      if (status === 'WAIT') return { status: 'running', progress: 0.1, message: '排队中' }
      if (status === 'RUN') return { status: 'running', progress: 0.5, message: '生成中' }
      if (status === 'DONE') {
        const url = Response?.ResultVideoUrl
        if (!url) {
          return { status: 'failed', message: `腾讯结果里找不到视频 URL：${JSON.stringify(Response).slice(0, 200)}` }
        }
        return { status: 'succeeded', resultUrl: url }
      }
      const reason = Response?.ErrorMessage ?? Response?.ErrorCode ?? status ?? '未知状态'
      return { status: 'failed', message: `腾讯任务未成功：${reason}` }
    }
    if (jobId.startsWith(IMAGE_JOB_PREFIX)) {
      const { Response } = await tc3Request<{
        JobStatusCode?: number
        ResultImage?: string[]
        JobErrorMsg?: string
        JobErrorCode?: string
      }>({
        host: IMAGE_HOST,
        service: 'hunyuan',
        action: 'QueryHunyuanImageJob',
        version: IMAGE_VERSION,
        secretId,
        secretKey,
        payload: { JobId: jobId.slice(IMAGE_JOB_PREFIX.length) }
      })
      const code = Response?.JobStatusCode
      if (code === 1) return { status: 'running', progress: 0.1, message: '排队中' }
      if (code === 2) return { status: 'running', progress: 0.5, message: '生成中' }
      if (code === 5) {
        const url = Response?.ResultImage?.[0]
        if (!url) {
          return { status: 'failed', message: `腾讯结果里找不到图片 URL：${JSON.stringify(Response).slice(0, 200)}` }
        }
        return { status: 'succeeded', resultUrl: url }
      }
      const reason = Response?.JobErrorMsg ?? Response?.JobErrorCode ?? String(code ?? '未知状态')
      return { status: 'failed', message: `腾讯任务未成功：${reason}` }
    }
    return { status: 'failed', message: `无法识别的任务标识：${jobId.slice(0, 80)}` }
  }

  /** 取消远端任务：腾讯无独立的任务取消接口，放弃远端任务（编排层照常落本地终态） */
  async cancel(_jobId: string): Promise<void> {}
}

/**
 * TC3-HMAC-SHA256 签名请求（官方签名 v3，POST application/json 形态）：
 * Action/Version/Region/Timestamp 走请求头，业务参数是 JSON body。
 * 返回 {Response:{...}}；Response.Error 存在时抛可操作错误。
 */
async function tc3Request<TResponse extends Record<string, unknown> = Record<string, unknown>>(opts: {
  host: string
  service: string
  action: string
  version: string
  secretId: string
  secretKey: string
  payload: Record<string, unknown>
}): Promise<{ Response?: TResponse }> {
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const body = JSON.stringify(opts.payload)
  const hashedPayload = createHash('sha256').update(body).digest('hex')
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json\nhost:${opts.host}\n`,
    'content-type;host',
    hashedPayload
  ].join('\n')
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    `${date}/${opts.service}/tc3_request`,
    createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n')
  const kDate = createHmac('sha256', `TC3${opts.secretKey}`).update(date).digest()
  const kService = createHmac('sha256', kDate).update(opts.service).digest()
  const kSigning = createHmac('sha256', kService).update('tc3_request').digest()
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  const response = await fetch(`https://${opts.host}/`, {
    method: 'POST',
    headers: {
      // host 头由 fetch 按 URL 自动补（签名 CanonicalHeaders 里的 host 与之一致）
      Authorization:
        `TC3-HMAC-SHA256 Credential=${opts.secretId}/${date}/${opts.service}/tc3_request, ` +
        'SignedHeaders=content-type;host, ' +
        `Signature=${signature}`,
      'Content-Type': 'application/json',
      'X-TC-Action': opts.action,
      'X-TC-Version': opts.version,
      'X-TC-Region': REGION,
      'X-TC-Timestamp': String(timestamp)
    },
    body,
    // 提交/轮询都是轻量 JSON 请求：30s 硬超时（生成本身是异步任务，不占这次请求）
    signal: AbortSignal.timeout(30_000)
  })
  const data = (await response.json().catch(() => ({}))) as {
    Response?: TResponse & { Error?: { Code?: string; Message?: string } }
  }
  const err = data.Response?.Error
  if (err) {
    throw new Error(`腾讯接口错误（${err.Code ?? 'Unknown'}）：${err.Message ?? '未知错误'}`)
  }
  if (!response.ok && !data.Response) {
    throw new Error(`腾讯接口请求失败（HTTP ${response.status}）`)
  }
  return data as { Response?: TResponse }
}

/** 单 Key 字段承载腾讯双凭据：冒号拼接「SecretId:SecretKey」 */
function parseSecrets(key: string): { secretId: string; secretKey: string } {
  const idx = key.indexOf(':')
  if (idx <= 0 || idx === key.length - 1) {
    throw new Error(
      '腾讯云凭据格式不正确：请按「SecretId:SecretKey」（冒号分隔）录入，两值都在控制台「访问管理 → API 密钥管理」页获取'
    )
  }
  return { secretId: key.slice(0, idx).trim(), secretKey: key.slice(idx + 1).trim() }
}

/** data URI → 裸 base64（腾讯 Image.Base64 收原始编码串，不带 data: 前缀） */
function base64Of(dataUri: string): string {
  const idx = dataUri.indexOf(',')
  return idx >= 0 ? dataUri.slice(idx + 1) : dataUri
}

/**
 * 应用比例 → 官方 Resolution「宽:高」枚举（8 档正好覆盖全部 5 种比例）。
 * 官方限制：上传参考图时仅支持 768:768 / 768:1024 / 1024:768 / 1024:1024 四档
 * （即 1:1 / 3:4 / 4:3），9:16/16:9 就近归档，不让整单报错。
 */
function imageResolution(ratio: string, hasRef: boolean): string {
  const table: Record<string, string> = {
    '1:1': '1024:1024',
    '3:4': '768:1024',
    '4:3': '1024:768',
    '9:16': '768:1280',
    '16:9': '1280:768'
  }
  const mapped = table[ratio] ?? '1024:1024'
  if (hasRef && (mapped === '768:1280' || mapped === '1280:768')) {
    return mapped === '768:1280' ? '768:1024' : '1024:768'
  }
  return mapped
}

/** 按 Unicode 码点截断（官方按 utf-8 字符计数，code point 与之最接近） */
function truncateChars(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

registerAdapter(
  'gateway-tencent',
  (deps: AdapterDeps, config) =>
    new TencentHunyuanProvider(
      {
        id: config.id,
        label: config.label,
        models: buildModelRecord<TencentModelConfig>(config.models),
        authKey: config.authKey,
        authEnv: config.authEnv
      },
      () => deps.resolveKey(config)
    ),
  { defaultAuthEnv: 'TENCENT_KEY' }
)
