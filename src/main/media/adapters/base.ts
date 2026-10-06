import type { MediaKind, MediaModelInfo, MediaProviderType, ModelCapabilities } from '../../../shared/media'
import { nearestMediaRatio } from '../../../shared/media'
import type { MediaProviderAdapter, ProviderPollResult, ProviderSubmitInput } from '../provider'
import type { AdapterModelConfig } from './registry'

/**
 * 网关适配器公共基类（dashscope / volcark / openaiCompat / minimax / tencent 的公约数）。
 *
 * 收敛各份逐字重复的实现：模型目录映射（config.models → MediaModelInfo[]）、
 * 凭据方法组（isConfigured/isReady/authHint/requireKey）、模型查找
 * （requestModelOf/kindOf）、「没有模型」与 HTTP 非 2xx 的错误形态。
 *
 * 必须留在子类的协议差异不要上提：dashscope 的 X-DashScope-Async 头与按 wan 版本
 * 分形态的 body/产物；volcark 的同步图片 submit（300s 超时）/legacy --flag 视频；
 * openaiCompat 的可变 baseUrl 与 oc-url|/oc-file| 双通道 jobId；minimax 的
 * 视频异步任务两跳；tencent 的 TC3-HMAC-SHA256 签名与异步任务轮询。
 */

/** 网关模型配置的公共形状（各子类的 XxxModelConfig 与其结构兼容） */
export interface GatewayModelConfig {
  kind: MediaKind
  /** 目录层的稳定用户可见 id；缺省 = 用线上模型标识兜底 */
  userId?: string
  label?: string
  /** 目录层能力元数据透传（渲染端参数面板与编排层参数协商消费） */
  capabilities?: ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
  costHint?: string
}

/** 网关适配器的供应商配置公共形状（各子类的 XxxProviderConfig 与其结构兼容） */
export interface GatewayProviderConfig<TModelConfig> {
  id?: string
  label?: string
  models: Record<string, TModelConfig>
  /** 凭据存储键（safeStorage 存储 media:<authKey>）；未录入时退回环境变量 */
  authKey?: string
  /** 环境变量名；缺省用构造器传入的 defaultEnv（与 registerAdapter 的 defaultAuthEnv 同源） */
  authEnv?: string
}

export abstract class BaseGatewayProvider<TModelConfig extends GatewayModelConfig> implements MediaProviderAdapter {
  readonly id: string
  readonly label: string
  readonly models: MediaModelInfo[]

  /** 子类按协议差异读取的原始配置（如 openaiCompat 的 voices 都在 models 里） */
  protected readonly config: GatewayProviderConfig<TModelConfig>
  protected readonly getKey: () => Promise<string | undefined>
  /** config.authEnv 未声明时的环境变量回退名：authHint/requireKey 单点取用，消灭三处重复 */
  private readonly defaultEnv: string

  constructor(
    config: GatewayProviderConfig<TModelConfig>,
    /** 读凭据（解密后的明文）。只在本层内存中出现，绝不进日志/IPC */
    getKey: () => Promise<string | undefined>,
    defaultEnv: string,
    /** config.id / config.label 缺省时的厂商兜底值（四家各不相同，由子类传入） */
    defaults: { id: string; label: string }
  ) {
    this.id = config.id ?? defaults.id
    this.label = config.label ?? defaults.label
    this.config = config
    this.getKey = getKey
    this.defaultEnv = defaultEnv
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

  /** 各子类保持自己的字面量（gateway-dashscope / gateway-volcark / …） */
  abstract readonly type: MediaProviderType

  /** 提交/轮询的协议差异必须留在子类（header、body 形态、超时值、jobId 编码各不相同） */
  abstract submit(model: string, input: ProviderSubmitInput): Promise<string>
  abstract poll(model: string, jobId: string): Promise<ProviderPollResult>

  isConfigured(): boolean {
    // 同步上下文里只做保守判断；实际提交时 key 缺失会报可操作错误
    return true
  }

  async isReady(): Promise<boolean> {
    return Boolean(await this.getKey())
  }

  authHint(): string {
    // 由 manager 组装（需要异步），这里给静态占位
    return this.config.authKey ? 'workspace-store' : `environment:${this.config.authEnv ?? this.defaultEnv}`
  }

  protected async requireKey(): Promise<string> {
    const key = await this.getKey()
    if (!key) {
      const env = this.config.authEnv ?? this.defaultEnv
      throw new Error(
        `provider ${this.id} 缺少凭据：请在设置面板录入 API Key，或设置环境变量 ${env} 后重启`
      )
    }
    return key
  }

  /** 稳定 id → 线上模型标识（提交与轮询 URL 用）；找不到返回 undefined */
  protected requestModelOf(model: string): string | undefined {
    for (const [requestModel, entry] of Object.entries(this.config.models)) {
      if (entry.userId === model || requestModel === model) return requestModel
    }
    return undefined
  }

  /** 按稳定 id 或线上模型标识查 kind；都对不上时兜底 image */
  protected kindOf(model: string): MediaKind {
    return (
      this.models.find((m) => m.id === model)?.kind ??
      Object.entries(this.config.models).find(([name]) => name === model)?.[1].kind ??
      'image'
    )
  }

  /** 「provider X 下没有模型」可操作错误（清单入口提示 media:providers） */
  protected noSuchModel(model: string): never {
    throw new Error(`provider ${this.id} 下没有模型 ${model}（清单见 media:providers）`)
  }

  /**
   * 网关 HTTP 非 2xx → 可操作 Error：401/403 归因为认证，其余附上响应体前 300 字符。
   * 文案参数逐字来自原各家的错误模板，拼接后与历史文案一致：
   * - authPrefix：如 '百炼认证失败' / '方舟认证失败'
   * - failPrefix：如 '百炼提交失败' / '图片生成失败'
   * - authSuffix：认证失败的检查提示尾巴，缺省 = 通用「请检查 API Key 是否正确」
   *   （百炼的「是否与北京地域匹配」、方舟的「模型是否已开通」由调用点传完整尾巴）
   */
  protected httpErrorMessage(
    response: Response,
    text: string,
    authPrefix: string,
    failPrefix: string,
    authSuffix = '请检查 API Key 是否正确'
  ): Error {
    if (response.status === 401 || response.status === 403) {
      return new Error(`${authPrefix}（HTTP ${response.status}）：${authSuffix}`)
    }
    return new Error(`${failPrefix}（HTTP ${response.status}）：${text.slice(0, 300)}`)
  }
}

/**
 * 合并层的模型数组（稳定 id + 可选 requestModel）→ 适配器的远端模型配置表。
 *
 * 公共字段以 dashscope/volcark/openaiCompat 的三份同构实现为基准；子类特有字段
 * （如 minimax 的模板 id 映射）用 extra 钩子吸收（展开位置：label 之后、capabilities 之前）。
 */
export function buildModelRecord<TModelConfig extends GatewayModelConfig>(
  models: readonly AdapterModelConfig[],
  extra?: (model: AdapterModelConfig) => Partial<TModelConfig>
): Record<string, TModelConfig> {
  const record: Record<string, TModelConfig> = {}
  for (const model of models) {
    const requestModel = model.requestModel ?? model.id
    // 泛型字面量无法被静态证明 assignable 给 TModelConfig（extra 可能补齐可选字段），
    // 收敛为一次受控断言；必填的 kind 由 GatewayModelConfig 约束兜底
    record[requestModel] = {
      kind: model.kind,
      // 目录/用户配置的稳定 id 随行保存：MediaModelInfo.id 用它，线上 slug 只做 URL
      userId: model.id,
      ...(model.label ? { label: model.label } : {}),
      ...(extra ? extra(model) : {}),
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      ...(model.status ? { status: model.status } : {}),
      ...(model.costHint ? { costHint: model.costHint } : {})
    } as TModelConfig
  }
  return record
}

/** 宽高就近映射到网关支持的比例枚举（dashscope 与 volcark 视频参数用）；换算表在 shared 唯一声明 */
export function nearestRatio(width: number, height: number): string {
  return nearestMediaRatio(width, height) ?? '16:9'
}
