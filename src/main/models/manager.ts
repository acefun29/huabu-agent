import type { CredentialStore } from '@earendil-works/pi-ai'
import type {
  ChatModelApi,
  ChatProviderDef,
  EffectiveChatModel,
  EffectiveChatProvider,
  RegistrationModelInput,
  RegistrationPayload,
  WorkspaceChatConfig
} from './types'
import {
  BUILTIN_CHAT_PROVIDERS,
  mergeChatCatalog,
  sanitizeHiddenBuiltin,
  sanitizeModelOverrides,
  sanitizeUserProviders,
  type ChatCatalogUserConfig
} from './catalog'

/**
 * 聊天模型管理器（架构计划 §3 的"自研管理器是唯一枚举源"）。
 *
 * 职责边界刻意很窄，只有两件事：
 * 1. 把 workspace.json 的 `chat` 覆盖层与内置目录合并成**生效清单**（`providers()`）；
 * 2. 把生效清单翻译成 pi 的注册入参（`registrations()`），凭据从加密存储解析。
 *
 * 不做的事：不碰 ModelRuntime、不注册、不选默认模型、不做 IPC 形态的裁剪。
 * 注册与枚举源的替换发生在 host.ts（T5）；本文件只保证"喂给 pi 的东西完全由目录决定"。
 *
 * 凭据口径（安全不变量）：
 * - 明文 Key 只在主进程内存中随 payload 过一遍，`providers()` 的返回值里**没有** Key 字段，
 *   因此拿它直接进 IPC 是安全的；渲染进程要 Key 只能走 setApiKey 单向写入。
 * - 存储键 = `auth.key` 显式指定的键，缺省即 provider id。聊天用裸 id，媒体用 `media:` 前缀，
 *   两套互不覆盖（见 workspace/credentials.ts）。
 */

export interface ChatModelManagerOptions {
  credentials: CredentialStore
  /** workspace.json 的 `chat` 段原样传入（未清洗的 JSON 也收：清洗在这里做，且幂等） */
  config?: Partial<WorkspaceChatConfig> | null
  /** 测试注入用：换成假目录即可验证合并/注册语义，不必改代码 */
  builtin?: readonly ChatProviderDef[]
}

export interface ChatProviderStatus {
  id: string
  label: string
  baseUrl: string
  /** 已配置凭据（存储里有 api_key，或 auth.env 指向的环境变量存在） */
  configured: boolean
  /** 凭据来源：设置页据此显示绿点与「来自环境变量」的提示。'none' 时 never 有 configured=true */
  authSource: 'stored' | 'env' | 'none'
  /** Key 输入框的展示名（来自目录 auth.label），设置页据此渲染 */
  authLabel: string
  modelCount: number
  /** 生效协议（合并层已把缺省归一成 openai-completions），设置页显示用 */
  api: ChatModelApi
}

/** `provider/模型` 复合串 → 生效模型（defaultModel、hidden 列表、Agent 选型都靠它定位） */
export interface ModelRef {
  provider: EffectiveChatProvider
  model: EffectiveChatModel
}

/**
 * 模型管理页的一行：目录里该供应商的全部**未退役**模型，含被用户隐藏的。
 *
 * 为什么单独一个视图而不是给 `providers()` 加个 includeHidden 开关：生效清单是注册给 pi
 * 的东西，混进隐藏项就会有一次静默注册的风险；而管理页要的恰好是"全部 + 谁被藏了"。
 * 两条路径共用同一次 merge，语义不会各走一半。
 */
export interface ModelInventoryEntry {
  model: EffectiveChatModel
  /** 被用户删除（隐藏）。恢复 = 移出 hiddenBuiltin */
  hidden: boolean
  /** 被用户改过展示名或 baseUrl */
  edited: boolean
}

/**
 * 一家供应商的注册入参：`pi.ModelRuntime.registerProvider(providerId, config)` 的两个实参。
 *
 * providerId 必须与 payload 成对给出——`RegistrationPayload` 本身没有 id 字段（pi 的 config
 * 里也没有），让调用方按 `providers()` 的下标去 zip 是一次迟早会错的重排。
 */
export interface ProviderRegistration {
  providerId: string
  payload: RegistrationPayload
}

export class ChatModelManager {
  private readonly credentials: CredentialStore
  private readonly builtin: readonly ChatProviderDef[]
  private readonly config: ChatCatalogUserConfig
  private readonly _providers: EffectiveChatProvider[]

  constructor(options: ChatModelManagerOptions) {
    this.credentials = options.credentials
    this.builtin = options.builtin ?? BUILTIN_CHAT_PROVIDERS
    // 只清洗一次并留住：inventory() 要拿它换掉 hiddenBuiltin 再合并一遍（见那里的注释）
    this.config = {
      userProviders: sanitizeUserProviders(options.config?.userProviders),
      hiddenBuiltin: sanitizeHiddenBuiltin(options.config?.hiddenBuiltin),
      modelOverrides: sanitizeModelOverrides(options.config?.modelOverrides)
    }
    this._providers = mergeChatCatalog(this.builtin, this.config)
  }

  /** 生效清单：内置目录 + 覆盖层合并后的唯一事实来源（不含任何密钥） */
  providers(): readonly EffectiveChatProvider[] {
    return this._providers
  }

  find(qualifiedId: string | undefined | null): ModelRef | undefined {
    if (!qualifiedId) return undefined
    const slash = qualifiedId.indexOf('/')
    if (slash <= 0) return undefined
    const providerId = qualifiedId.slice(0, slash)
    const modelId = qualifiedId.slice(slash + 1)
    const provider = this._providers.find((p) => p.id === providerId)
    const model = provider?.models.find((m) => m.id === modelId)
    return provider && model ? { provider, model } : undefined
  }

  /**
   * 该复合串是否被用户删除（隐藏）。
   *
   * 单列一个口是为了把错误文案分准：「已被删除，可恢复」和「目录里没有这个模型」是两件事，
   * 混成一句"模型不可用"会让人去翻配置，而正确动作是去设置里点恢复。
   */
  isHidden(qualifiedId: string): boolean {
    return (this.config.hiddenBuiltin ?? []).includes(qualifiedId)
  }

  /**
   * 某供应商的完整清单视图（含被隐藏的），供设置页的「模型管理」渲染与恢复入口。
   * 供应商不存在时返回 undefined。退役模型两条路径都不出现（目录 `status` 已接管，不是用户操作）。
   */
  inventory(providerId: string): ModelInventoryEntry[] | undefined {
    const hidden = new Set(this.config.hiddenBuiltin ?? [])
    // 用"不隐藏"的同一份覆盖层再合并一次：得到条目后按 hiddenBuiltin 打标，
    // 于是隐藏项与可见项走的是同一套解析/继承规则（改名、baseUrl 镜像都在里面）。
    const unhidden = mergeChatCatalog(this.builtin, { ...this.config, hiddenBuiltin: [] })
    const provider = unhidden.find((p) => p.id === providerId)
    if (!provider) return undefined
    return provider.models.map((model) => {
      const qualified = `${providerId}/${model.id}`
      const override = this.config.modelOverrides?.[qualified]
      // 用户在同 id 内置供应商下写过能力补丁（contextWindow/maxTokens/reasoning 等）也算"改过"
      const patched = (this.config.userProviders ?? []).some(
        (u) => u.id === providerId && (u.models ?? []).some((m) => m.id === model.id)
      )
      return {
        model,
        hidden: hidden.has(qualified),
        edited: Boolean(override?.label || override?.baseUrl || patched)
      }
    })
  }

  /**
   * 注册载荷：每次都要携带**完整模型数组**。
   *
   * pi 重注册时 models 数组是整体替换而非增量合并（model-runtime.js:558-573，见 §2.4-6），
   * 少传一个模型就等于把它从运行时删掉。这也是本方法从生效清单一次性生成、
   * 不提供"改单个模型"接口的原因。
   */
  async registrations(): Promise<ProviderRegistration[]> {
    const out: ProviderRegistration[] = []
    for (const provider of this._providers) {
      const apiKey = (await this.resolveAuth(provider)).apiKey
      out.push({
        providerId: provider.id,
        payload: {
          name: provider.label,
          baseUrl: provider.baseUrl,
          api: provider.api,
          ...(apiKey ? { apiKey } : {}),
          models: provider.models.map(toRegistrationModel)
        }
      })
    }
    return out
  }

  /** 设置页用的清单（provider 粒度，带认证状态，永不含密钥） */
  async statuses(): Promise<ChatProviderStatus[]> {
    const out: ChatProviderStatus[] = []
    for (const provider of this.statusProviders()) {
      const auth = await this.resolveAuth(provider)
      out.push({
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        configured: auth.apiKey !== undefined,
        authSource: auth.source,
        authLabel: provider.auth.label,
        modelCount: provider.models.length,
        api: provider.api
      })
    }
    return out
  }

  /**
   * 设置页要看见的 provider 全集 = 生效清单 + **还没挂模型的自建供应商**。
   *
   * 空清单供应商被合并层挡在注册之外（pi 拒绝空 models），但设置页必须看得见它：
   * UI 的添加流程是「先建供应商、再往它底下加模型」，藏起来就等于第一步没生效。
   */
  private statusProviders(): EffectiveChatProvider[] {
    const listed = new Set(this._providers.map((p) => p.id))
    const extras: EffectiveChatProvider[] = []
    for (const user of this.config.userProviders ?? []) {
      if (listed.has(user.id)) continue
      const label = user.label ?? user.id
      extras.push({
        id: user.id,
        label,
        baseUrl: user.baseUrl ?? '',
        api: user.api ?? 'openai-completions',
        auth: { label: `${label} API Key`, helpUrl: '', ...(user.authKey ? { key: user.authKey } : {}) },
        source: 'user',
        models: []
      })
    }
    return [...this._providers, ...extras]
  }

  /**
   * 解析 provider 的明文 Key：加密存储优先，存储里没有时回退 `auth.env` 环境变量。
   *
   * env 回退是给无 UI 场景（自检脚本、CI、headless 诊断，以及从带 Key 的 shell 启动）用的。
   * 注意语义：**在存储里清 Key 不等于禁用该供应商**——UI 的删除走 `credentials.delete`，
   * 条目消失后 env 又会命中。要彻底断开得连环境变量一起清（桌面端从 Dock 启动时通常本来就没有）。
   */
  private async resolveAuth(
    provider: EffectiveChatProvider
  ): Promise<{ apiKey?: string; source: 'stored' | 'env' | 'none' }> {
    const storeKey = provider.auth.key ?? provider.id
    const credential = await this.credentials.read(storeKey).catch(() => undefined)
    if (credential?.type === 'api_key' && credential.key?.trim()) {
      return { apiKey: credential.key.trim(), source: 'stored' }
    }
    const fromEnv = provider.auth.env ? process.env[provider.auth.env] : undefined
    if (fromEnv?.trim()) return { apiKey: fromEnv.trim(), source: 'env' }
    return { source: 'none' }
  }
}

function toRegistrationModel(model: EffectiveChatModel): RegistrationModelInput {
  return {
    id: model.id,
    name: model.label,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: model.compat } : {})
  }
}
