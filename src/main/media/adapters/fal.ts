import type { MediaKind, MediaModelInfo, MediaProviderType, ModelCapabilities } from '../../../shared/media'
import type { MediaProviderAdapter, ProviderPollResult, ProviderSubmitInput } from '../provider'
import { registerAdapter, type AdapterDeps, type AdapterModelConfig } from './registry'
import { firstImageRefDataUri } from './refImage'

/**
 * fal.ai 网关适配器（queue API，配置驱动）。
 *
 * 接入形态与官方文档见 docs/media-api-integration.md §5.2：
 * POST queue.fal.run/{model} → request_id → status 轮询 → 结果 JSON 里抽产物 URL。
 * 模型清单来自合并层（内置目录 + 用户覆盖），模型记录可带 resultKey 微调产物抽取路径。
 */

export interface FalModelConfig {
  kind: MediaKind
  label?: string
  /** 目录层的稳定用户可见 id（如 'fal/flux-2-flash'）；缺省 = 用线上 slug 兜底 */
  userId?: string
  /** 覆盖产物抽取路径的默认行为（默认按 images/videos/audio 数组顺序取第一个 url） */
  resultKey?: string
  /** 目录层能力元数据透传（渲染端参数面板与编排层参数协商消费） */
  capabilities?: ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
  costHint?: string
}

export interface FalProviderConfig {
  id?: string
  label?: string
  models: Record<string, FalModelConfig>
  /** 凭据存储键（safeStorage 存储 media:<authKey>）；未录入时退回环境变量 */
  authKey?: string
  /** 环境变量名（默认 FAL_KEY） */
  authEnv?: string
}

export class FalGatewayProvider implements MediaProviderAdapter {
  readonly id: string
  readonly type: MediaProviderType = 'gateway-fal'
  readonly label: string
  readonly models: MediaModelInfo[]

  constructor(
    private readonly config: FalProviderConfig,
    /** 读凭据（解密后的明文）。只在本层内存中出现，绝不进日志/IPC */
    private readonly getKey: () => Promise<string | undefined>
  ) {
    this.id = config.id ?? 'fal'
    this.label = config.label ?? 'fal.ai 网关'
    // 对外暴露稳定 id（目录层承诺不改名），线上 slug 只在 submit 时解析 —— 用户配置
    // 引用的是稳定 id，厂商改 slug 只动 remoteModel 字段
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
    // 由 manager 组装（需要异步），这里给静态占位
    return this.config.authKey ? 'workspace-store' : `environment:${this.config.authEnv ?? 'FAL_KEY'}`
  }

  private async requireKey(): Promise<string> {
    const key = await this.getKey()
    if (!key) {
      const env = this.config.authEnv ?? 'FAL_KEY'
      throw new Error(
        `provider ${this.id} 缺少凭据：请在设置面板录入 API Key，或设置环境变量 ${env} 后重启`
      )
    }
    return key
  }

  /** 稳定 id → 线上 slug（提交与轮询 URL 用）；找不到返回 undefined */
  private requestModelOf(model: string): string | undefined {
    for (const [requestModel, entry] of Object.entries(this.config.models)) {
      if (entry.userId === model || requestModel === model) return requestModel
    }
    return undefined
  }

  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const requestModel = this.requestModelOf(model)
    if (!requestModel) throw new Error(`provider ${this.id} 下没有模型 ${model}（清单见 media:providers）`)
    const body: Record<string, unknown> = { prompt: input.prompt }
    if (input.width || input.height) {
      body.image_size = {
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {})
      }
    }
    if (input.durationSeconds) body.duration = String(input.durationSeconds)
    // 参考图（垫图/首帧）：fal 的图生图/首帧模型普遍吃 image_url，data URI 是官方支持的离线形态
    const refDataUri = firstImageRefDataUri(input.refFiles)
    if (refDataUri) body.image_url = refDataUri
    const response = await fetch(`https://queue.fal.run/${requestModel}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        throw new Error(`fal.ai 认证失败（HTTP ${response.status}）：请检查 API Key 是否正确`)
      }
      throw new Error(`fal.ai 提交失败（HTTP ${response.status}）：${text.slice(0, 300)}`)
    }
    const data = (await response.json()) as { request_id?: string; status_url?: string }
    if (!data.request_id) throw new Error(`fal.ai 响应缺少 request_id：${JSON.stringify(data).slice(0, 200)}`)
    // jobId 里存线上 slug（状态/结果地址由它反推），不存稳定 id
    return `${requestModel}|${data.request_id}`
  }

  private static statusUrl(pair: string): string {
    return `https://queue.fal.run/${pair.replace('|', '/requests/')}/status`
  }

  private static responseUrl(pair: string): string {
    return `https://queue.fal.run/${pair.replace('|', '/requests/')}`
  }

  async poll(model: string, jobId: string): Promise<ProviderPollResult> {
    const key = await this.requireKey()
    const headers = { Authorization: `Key ${key}` }
    const statusResponse = await fetch(FalGatewayProvider.statusUrl(jobId), { headers })
    if (!statusResponse.ok) {
      return { status: 'failed', message: `fal.ai 状态查询失败（HTTP ${statusResponse.status}）` }
    }
    const status = (await statusResponse.json()) as {
      status?: string
      queue_position?: number
      error?: string | null
    }
    if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') {
      return {
        status: 'running',
        progress: status.status === 'IN_PROGRESS' ? 0.5 : 0.1,
        message:
          status.status === 'IN_QUEUE' ? `排队中（位置 ${status.queue_position ?? '?'}）` : '生成中'
      }
    }
    if (status.status !== 'COMPLETED') {
      return { status: 'failed', message: `fal.ai 任务异常：${status.error ?? status.status ?? '未知状态'}` }
    }
    const response = await fetch(FalGatewayProvider.responseUrl(jobId), { headers })
    if (!response.ok) {
      return { status: 'failed', message: `fal.ai 结果获取失败（HTTP ${response.status}）` }
    }
    const data = (await response.json()) as Record<string, unknown>
    // jobId 里存的是线上 slug；kind 仅作抽取兜底提示，按稳定 id 或线上 slug 都能对上
    const kind =
      this.models.find((m) => m.id === model)?.kind ??
      Object.entries(this.config.models).find(([slug]) => slug === model)?.[1].kind ??
      'image'
    const url = this.extractResultUrl(data, model, kind)
    if (!url) {
      return { status: 'failed', message: `fal.ai 结果里找不到产物 URL：${JSON.stringify(data).slice(0, 200)}` }
    }
    return { status: 'succeeded', resultUrl: url }
  }

  /** 默认按 kind 取 images/videos/audio[0].url；模型配置了 resultKey 时按配置点取 */
  private extractResultUrl(data: Record<string, unknown>, model: string, kind: MediaKind): string | undefined {
    const configKey = this.config.models[model]?.resultKey
    if (configKey) {
      const value = configKey
        .split('.')
        .reduce<unknown>(
          (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
          data
        )
      if (typeof value === 'string') return value
    }
    const arrays = ['images', 'videos', 'audio', 'audio_url', 'video_url', 'image_url']
    for (const key of arrays) {
      const value = data[key]
      if (typeof value === 'string') return value
      if (Array.isArray(value) && value.length > 0) {
        const first = value[0] as { url?: string }
        if (typeof first?.url === 'string') return first.url
      }
    }
    // 兜底：kind 对应的默认数组
    void kind
    return undefined
  }

  /**
   * 取消远端任务：fal 官方支持 DELETE /{model}/requests/{request_id}（docs §5.2），
   * 取消后远端不再继续计费；请求失败不阻塞本地 cancelled 终态。
   */
  async cancel(jobId: string): Promise<void> {
    if (!jobId.includes('|')) return
    let key: string | undefined
    try {
      key = await this.getKey()
    } catch {
      return
    }
    if (!key) return
    try {
      await fetch(`https://queue.fal.run/${jobId.replace('|', '/requests/')}`, {
        method: 'DELETE',
        headers: { Authorization: `Key ${key}` }
      })
    } catch {
      // 网络异常时放弃远端取消；编排层已落本地终态
    }
  }
}

registerAdapter(
  'gateway-fal',
  (deps: AdapterDeps, config) =>
    new FalGatewayProvider(
      {
        id: config.id,
        label: config.label,
        models: falModelRecord(config.models),
        authKey: config.authKey,
        authEnv: config.authEnv
      },
      () => deps.resolveKey(config)
    ),
  // 用户配置未声明 authEnv 时的环境变量回退（原硬编码 FAL_KEY 的声明化）
  { defaultAuthEnv: 'FAL_KEY' }
)

/** 合并层的模型数组（稳定 id + 可选 requestModel）→ fal 适配器的远端模型配置表 */
function falModelRecord(models: readonly AdapterModelConfig[]): Record<string, FalModelConfig> {
  const record: Record<string, FalModelConfig> = {}
  for (const model of models) {
    const requestModel = model.requestModel ?? model.id
    record[requestModel] = {
      kind: model.kind,
      // 目录/用户配置的稳定 id 随行保存：MediaModelInfo.id 用它，线上 slug 只做 URL
      userId: model.id,
      ...(model.label ? { label: model.label } : {}),
      ...(model.resultKey ? { resultKey: model.resultKey } : {}),
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      ...(model.status ? { status: model.status } : {}),
      ...(model.costHint ? { costHint: model.costHint } : {})
    }
  }
  return record
}
