import type {
  AnthropicMessagesCompat,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  ModelCost,
  ThinkingLevel,
  ThinkingTokenBudgetField
} from '@earendil-works/pi-ai'

/**
 * 聊天模型目录的类型（架构计划 §3）。
 *
 * 与 media/catalog 同构：`catalog/providers/*.ts` 是随应用发布的**代码数据**，
 * 模型清单的单一事实来源；workspace.json 只存覆盖层，运行时由 merge.ts 合成生效清单，
 * 最终由 manager 产出注册载荷喂给 pi（接缝只有 registerProvider 一处）。
 *
 * 两条铁律：
 * 1. 模型 `id` 合入后不得改名（用户配置与 Agent 默认都引用它）；厂商升级时老模型标
 *    `status:'deprecated'` 保留，新模型加新条目。
 * 2. compat 必须**显式写**，不依赖 pi 的域名自动探测。`detectCompat` 会把
 *    moonshot/zai 域名的 `supportsReasoningEffort` 探测为 false，于是 thinkingFormat
 *    分支里的 effort 字段被**静默跳过**（不报错、只少发字段）。见实施计划 §2.5。
 */

/**
 * 一期允许的对话协议白名单。定义在 `shared/chatApi.ts`（渲染端要枚举它做协议下拉，
 * 而本文件依赖 pi-ai 类型，UI 不能引），这里再导出以保住目录与合并层的 import 路径。
 */
export { CHAT_MODEL_APIS, isChatModelApi, type ChatModelApi } from '../../shared/chatApi'
import type { ChatModelApi } from '../../shared/chatApi'

/**
 * api → compat 类型映射。
 *
 * 直接复用 pi-ai 的 compat 接口，而不是自己抄一遍字段名：pi 的 `Model.compat` 本身就是
 * 按 api 条件取的（types.d.ts:736），抄一份必然漂移。复用带来的**类型级保证**正是我们需要的——
 * 写错 compat 键名（`thinkingFormats`）会被 tsc 拒绝，而运行时它是静默失效的。
 */
export type ChatCompatFor<A extends ChatModelApi> = A extends 'openai-completions'
  ? OpenAICompletionsCompat
  : A extends 'openai-responses'
    ? OpenAIResponsesCompat
    : AnthropicMessagesCompat

/** 生效清单里单个模型的形态（内置定义 + 用户覆盖合并后的结果） */
export interface ChatModelDef {
  /** 稳定 id，不做 `provider/` 前缀（pi 按 provider+id 两轴定位）。
   *
   * **id 就是上送的 `model` 值**：pi 的 Model 没有"远端模型名/别名"字段
   * （types.d.ts 的 Model 接口逐字段核过；buildParams 直接 `model: model.id`），
   * 注册接缝里给不出第二个名字。所以厂商那些"带日期的全名 / Endpoint ID"只能直接当 id 用
   * ——这也是豆包一期不入目录的原因之一：它的稳定 id 与上送 id 天然不是一回事。
   */
  id: string
  /** 展示名 */
  label: string
  /** 协议；缺省取所属 provider 的 api */
  api?: ChatModelApi
  baseUrl?: string
  /** 是否推理模型。pi 的 thinkingFormat 分支生效前提就是它（不 true 则 compat 整块不发） */
  reasoning: boolean
  /** 思考档位 → 上游值映射；`off: null` = 该模型不能关思考（关档时什么都不发） */
  thinkingLevelMap?: Partial<Record<ThinkingLevel | 'off', string | null>>
  input: Array<'text' | 'image'>
  cost: ModelCost
  /**
   * `cost` 的出处。单列成字段而不是写在 note 文案里：这样 catalog 自检可以断言
   * "标 stable 的模型不许带 unverified 价格"，把数字可信度变成机器可查的约束。
   * - official    已对厂商官方 pricing 页复核
   * - pi-upstream 取自 pi 包内 providers/data/*.json（上游人工维护，未二次复核）
   * - unverified  占位（多为 0），只保证不进 UI（当前 cost 不参与任何展示），待补
   */
  costSource?: 'official' | 'pi-upstream' | 'unverified'
  contextWindow: number
  maxTokens: number
  /**
   * 按 api 区分的 compat。用判别联合而不是 `AnyChatCompat`：否则 anthropic 模型上写
   * `thinkingFormat`（openai-completions 独有）能过编译、运行时静默无效。
   */
  compat?: ChatCompatFor<'openai-completions'> | ChatCompatFor<'openai-responses'> | ChatCompatFor<'anthropic-messages'>
  /** 生命周期。deprecated = 不进新建入口；取代关系写在 `replacedBy` 供 UI 提示 */
  status?: 'stable' | 'beta' | 'deprecated'
  replacedBy?: string
  /** 一句人话价格/限制提示（'off-peak 减半'、'Key 地域绑定'），帮用户避坑 */
  costHint?: string
  /** 已知上游偏差备注（未线上终验的敞口在此留痕，见计划 §2.5 末段） */
  note?: string
}

/** 凭据约定：设置页据此渲染 Key 录入框与帮助链接 */
export interface ChatProviderAuth {
  /** 凭据存储键；缺省 = provider id（聊天键用裸 id，媒体键 `media:` 前缀是另一套，互不覆盖） */
  key?: string
  /** 环境变量回退名（<VENDOR>_KEY），供无 UI 场景与诊断 */
  env?: string
  label: string
  helpUrl: string
  /** Key 地域/账户绑定提示（Qwen 三家 dashscope 站点 Key 不通用），设置页原文展示 */
  hint?: string
}

/** 内置供应商定义（一家一个文件） */
export interface ChatProviderDef {
  /** 稳定 id（'deepseek' | 'kimi' | …）。与内置 pi 同 id 时我们的清单整体替换之（S2 实测） */
  id: string
  label: string
  baseUrl: string
  api: ChatModelApi
  auth: ChatProviderAuth
  region?: 'global' | 'cn-direct'
  helpUrl?: string
  models: ChatModelDef[]
}

/**
 * 注册载荷 = pi `ProviderConfigInput` 的我们这一份子集（provider-composer.d.ts）。
 *
 * 刻意**不含 `headers`**：provider-composer.js:138 把模型级 headers 强制置 undefined，
 * 给了也不生效（要过 rawModelHeaders/配置通道），留字段只会误导。
 * 也不含 `oauth`/`streamSimple`/`refreshModels`——一期聊天凭据只有 API Key。
 */
export interface RegistrationModelInput {
  id: string
  name: string
  api?: ChatModelApi
  baseUrl?: string
  reasoning: boolean
  thinkingLevelMap?: ChatModelDef['thinkingLevelMap']
  input: Array<'text' | 'image'>
  cost: ModelCost
  contextWindow: number
  maxTokens: number
  compat?: ChatModelDef['compat']
}
export interface RegistrationPayload {
  name: string
  baseUrl: string
  api: ChatModelApi
  /** 明文 Key 只在主进程内存里过一遍，永不进 IPC/日志/canvas.json */
  apiKey?: string
  models: RegistrationModelInput[]
}

/** merge 阶段的诊断（坏数据只 warn 不炸，参照 media/catalog/merge.ts 的 warn 约定） */
export interface MergeDiagnostic {
  path: string
  message: string
}

/* ---------------- workspace.json `chat` 覆盖层（store.ts 引用这批类型） ---------------- */

/** 用户自建模型的原始条目（坏数据由 sanitize 逐字段清洗） */
export interface ChatUserModelConfig {
  id: string
  name?: string
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
  api?: ChatModelApi
  baseUrl?: string
  compat?: Record<string, unknown>
  thinkingLevelMap?: Record<string, string | null>
}

/** 用户自建供应商（与内置供应商共用 id 命名空间；同名 = 覆盖其模型子集） */
export interface ChatUserProviderConfig {
  id: string
  label?: string
  baseUrl?: string
  api?: ChatModelApi
  authKey?: string
  models?: ChatUserModelConfig[]
}

/** 对内置模型的展示覆盖（不改能力，只改 label） */
export interface ChatModelOverride {
  label?: string
  baseUrl?: string
}

/**
 * workspace.json 的 `chat` 段：只存覆盖层，不存内置清单副本。
 *
 * 与迁移进来的旧数据的关系见 migrate.ts：旧 `defaultModel`/`hiddenModels` 与
 * `.huabu/models.json`（Pi 原生格式）合并进本段，本段是迁移后的唯一读取路径。
 */
export interface WorkspaceChatConfig {
  /** 工作区默认模型，记法 `provider/模型id` */
  defaultModel?: string
  userProviders?: ChatUserProviderConfig[]
  /** 被用户隐藏的内置模型 id（`provider/模型id`） */
  hiddenBuiltin?: string[]
  modelOverrides?: Record<string, ChatModelOverride>
}

/**
 * 生效清单里的模型：内置定义与覆盖层合并后、注册前的形态。
 *
 * 与 `ChatModelDef` 的差别只在于"该继承的都解析完了"——`api`/`baseUrl` 不再可能是 undefined，
 * 于是 manager 产出注册载荷时不需要再做任何 fallback 推理（隐式默认正是 §2.5 那类静默失效的温床）。
 */
export interface EffectiveChatModel extends Omit<ChatModelDef, 'api' | 'baseUrl'> {
  api: ChatModelApi
  baseUrl: string
  /** 清单来源：user = 用户自建/自建同名覆盖，builtin = 随应用发布的目录 */
  source: 'builtin' | 'user'
}

export interface EffectiveChatProvider {
  id: string
  label: string
  baseUrl: string
  api: ChatModelApi
  auth: ChatProviderAuth
  region?: 'global' | 'cn-direct'
  helpUrl?: string
  source: 'builtin' | 'user'
  models: EffectiveChatModel[]
}

export type { ThinkingTokenBudgetField }
