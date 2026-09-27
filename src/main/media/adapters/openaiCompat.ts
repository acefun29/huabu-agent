import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { MediaKind, MediaModelInfo, MediaProviderType, ModelCapabilities } from '../../../shared/media'
import type { MediaProviderAdapter, ProviderPollResult, ProviderSubmitInput } from '../provider'
import { registerAdapter, type AdapterDeps, type AdapterModelConfig } from './registry'

/**
 * OpenAI 兼容网关适配器（协议家族路线的第一块：一个适配器覆盖一片供应商）。
 *
 * 覆盖的端点（2026-09 对照 platform.openai.com/docs/api-reference 核实）：
 * - 图片：POST {base}/images/generations（同步），body {model, prompt, size, n}。
 *   响应 data[0].url（dall-e 系）或 data[0].b64_json（gpt-image 系只回 b64）——
 *   b64 就地落成临时文件，走 resultFile 通道交编排层收编。
 * - 音频：POST {base}/audio/speech（同步二进制流），body {model, input, voice,
 *   response_format:'mp3'}。时长由文本长度决定，durationSeconds 不参与请求。
 *
 * 兼容 OpenAI 原生、以及一切实现了同款 images/speech 端点的网关（硅基流动、
 * 302.AI、Novita 等）：用户在设置页「新增供应商」选本类型 + 填 baseUrl 即可，
 * 零代码。视频类模型本端点族不支持，清单里不要配 video kind。
 *
 * 同步返回意味着 submit 阻塞到出结果（与 volcark 图片同构）；jobId 编码结果，
 * poll 原样回传 succeeded——不二次请求、无重复计费，应用重启也安全。
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** jobId 前缀：结果要么是 URL 要么是本地临时文件 */
const URL_PREFIX = 'oc-url|'
const FILE_PREFIX = 'oc-file|'

/**
 * images 端点对 gpt-image 系只收固定档位：任意比例就近归档
 * （1:1 → 方，竖版 → 1024x1536，横版 → 1536x1024）。
 */
function sizeFor(width?: number, height?: number): string {
  if (!width || !height) return '1024x1024'
  if (Math.abs(width / height - 1) < 0.2) return '1024x1024'
  return width > height ? '1536x1024' : '1024x1536'
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
}

export class OpenAICompatProvider implements MediaProviderAdapter {
  readonly id: string
  readonly type: MediaProviderType = 'gateway-openai-compat'
  readonly label: string
  readonly models: MediaModelInfo[]
  private readonly baseUrl: string

  constructor(
    private readonly config: OpenAICompatProviderConfig,
    private readonly getKey: () => Promise<string | undefined>,
    /** b64/二进制产物的临时落盘目录（当前工作区媒体目录） */
    private readonly tempDir: () => string | null
  ) {
    this.id = config.id ?? 'openai-compat'
    this.label = config.label ?? 'OpenAI 兼容网关'
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
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
    return this.config.authKey ? 'workspace-store' : `environment:${this.config.authEnv ?? 'OPENAI_API_KEY'}`
  }

  private async requireKey(): Promise<string> {
    const key = await this.getKey()
    if (!key) {
      const env = this.config.authEnv ?? 'OPENAI_API_KEY'
      throw new Error(
        `provider ${this.id} 缺少凭据：请在设置面板录入 API Key，或设置环境变量 ${env} 后重启`
      )
    }
    return key
  }

  /** 稳定 id → 线上模型名；找不到返回 undefined */
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
    return kind === 'audio' ? this.submitSpeech(key, requestModel, input) : this.submitImage(key, requestModel, input)
  }

  /** 同步出图：url 形态编码进 jobId；b64 形态落临时文件 */
  private async submitImage(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const body: Record<string, unknown> = {
      model: requestModel,
      prompt: input.prompt,
      n: 1,
      size: sizeFor(input.width, input.height)
    }
    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        throw new Error(`网关认证失败（HTTP ${response.status}）：请检查 API Key 是否正确`)
      }
      throw new Error(`图片生成失败（HTTP ${response.status}）：${text.slice(0, 300)}`)
    }
    const data = (await response.json()) as {
      data?: { url?: string; b64_json?: string }[]
      error?: { message?: string }
    }
    const first = data.data?.[0]
    if (first?.url) return `${URL_PREFIX}${first.url}`
    if (first?.b64_json) {
      const file = this.writeTemp(Buffer.from(first.b64_json, 'base64'), '.png')
      return `${FILE_PREFIX}${file}`
    }
    throw new Error(`结果里既没有 url 也没有 b64_json：${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`)
  }

  /** 同步语音：响应是二进制音频流，直接落临时文件 */
  private async submitSpeech(key: string, requestModel: string, input: ProviderSubmitInput): Promise<string> {
    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: requestModel,
        input: input.prompt,
        voice: this.config.models[requestModel]?.capabilities?.voices?.[0]?.id ?? 'alloy',
        response_format: 'mp3'
      })
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        throw new Error(`网关认证失败（HTTP ${response.status}）：请检查 API Key 是否正确`)
      }
      throw new Error(`语音合成失败（HTTP ${response.status}）：${text.slice(0, 300)}`)
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
    return { status: 'failed', message: `无法识别的任务标识：${jobId.slice(0, 80)}` }
  }

  /** 同步协议无远端任务可取消；产物文件（若有）由编排层的失败路径清理 */
  async cancel(_jobId: string): Promise<void> {}
}

registerAdapter(
  'gateway-openai-compat',
  (deps: AdapterDeps, config) =>
    new OpenAICompatProvider(
      {
        id: config.id,
        label: config.label,
        models: openAICompatModelRecord(config.models),
        baseUrl: config.baseUrl,
        authKey: config.authKey,
        authEnv: config.authEnv
      },
      () => deps.resolveKey(config),
      () => deps.mediaDir()
    ),
  { defaultAuthEnv: 'OPENAI_API_KEY' }
)

/** 合并层的模型数组（稳定 id + 可选 requestModel）→ 适配器的远端模型配置表 */
function openAICompatModelRecord(models: readonly AdapterModelConfig[]): Record<string, OpenAICompatModelConfig> {
  const record: Record<string, OpenAICompatModelConfig> = {}
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
