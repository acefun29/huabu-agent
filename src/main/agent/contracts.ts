/**
 * 自有运行时类型底座（全量 Mastra 改造 · 批次 0）。
 *
 * 背景：凭据存储、模型目录、工具定义原先直接复用 `@earendil-works/pi-*` 导出的类型。
 * 那个复用是有价值的——pi 的 `Model.compat` 按 api 条件取类型，抄一份必然漂移，而
 * 「写错 compat 键名被 tsc 拒绝」正是我们要的安全网。但同时也把整个模型层钉死在
 * pi 的包上：删运行时就必须先能编译。
 *
 * 取舍（按计划审计结论）：**不写 `[key: string]: unknown` 兜底**。索引签名会让
 * 写错键名重新变成静默失效，等于把这层保证丢掉。这里逐键枚举 —— 键集合是用
 * `grep` + 逐文件核出来的真实写读集合：
 *
 * - 被**读**的键只有两个：`thinkingFormat`（`catalog/merge.ts:383`）、
 *   `forceAdaptiveThinking`（`catalog/merge.ts:386`）；
 * - 被**写**的键十六个，散在 `catalog/providers/*.ts`（含 `GLM_COMPAT` /
 *   `KIMI_THINKING_COMPAT` 这类被引用常量，`grep "compat:"` 抓不全）。
 *
 * 所以：本文件收录「被写的 16 个 + 被读的 2 个（含在内）」，其余键不收录。
 * 目录里一旦写了新键，tsc 会立刻报错——这正是我们要的信号，别用索引签名把它压平。
 *
 * 注意：`providers.ts` 里 `compat?: Record<string, unknown>` 那种声明是网关侧
 * 透传用的宽松形态，与本文件（目录层的强类型）分工不同，故意的。
 */

import type { TSchema } from 'typebox'

/* ---------------------------------------------------------------- 凭据 */

/**
 * API Key 凭据。`env` 是 provider 作用域的环境/配置值（如 Cloudflare account id）；
 * 本项目不使用，但既有凭据文件里可能有，保留形状以免解析时丢字段。
 */
export interface ApiKeyCredential {
  type: 'api_key'
  key?: string
  env?: Record<string, string>
}

/** OAuth 凭据（一期聊天凭据只有 API Key，保留形状以兼容历史文件与上游并发写入） */
export interface OAuthCredential {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
  [key: string]: unknown
}

/** 一家 provider 一份凭据，按 type 判别 */
export type Credential = ApiKeyCredential | OAuthCredential

/** 非机密元数据（列表/状态展示用，不解密） */
export interface CredentialInfo {
  providerId: string
  type: Credential['type']
}

/**
 * 应用自持的加密凭据存储。
 *
 * `modify` 是唯一写路径（串行读改写）——这样 OAuth 刷新与「登录期间刷新」不会
 * 互相踩。`read` 对缺失条目返回 `undefined`；只有存储故障才 reject。
 *
 * 本接口刻意不带 pi 的 `AuthOperationOptions`（取消信号）：本项目的调用方都不传，
 * 少参数在结构上仍可赋给带可选参数的接口，不会挡住任何调用点。
 */
export interface CredentialStore {
  read(providerId: string): Promise<Credential | undefined>
  list(): Promise<readonly CredentialInfo[]>
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined>
  delete(providerId: string): Promise<void>
}

/**
 * 测试用内存凭据存储（替代 `pi-ai` 的 `InMemoryCredentialStore`）。
 * 与真实实现同语义：modify 串行、缺失返回 undefined。
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<string, Credential>()

  async read(providerId: string): Promise<Credential | undefined> {
    return this.entries.get(providerId)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.entries.entries()].map(([providerId, credential]) => ({
      providerId,
      type: credential.type
    }))
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    const current = this.entries.get(providerId)
    const next = await fn(current)
    if (next === undefined) return current
    this.entries.set(providerId, next)
    return next
  }

  async delete(providerId: string): Promise<void> {
    this.entries.delete(providerId)
  }
}

/* ---------------------------------------------------------------- 思考档位 */

/** 思考档位（不含 off：off 由调用方的字符串白名单另外处理） */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 带上 off 的档位键（`thinkingLevelMap` 用；`off: null` = 该模型不能关思考） */
export type ModelThinkingLevel = 'off' | ThinkingLevel

/** 思考预算用哪个顶层请求字段承载 */
export type ThinkingTokenBudgetField = 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'

/* ---------------------------------------------------------------- 成本 */

export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 请求级价格档：总输入超过 `inputTokensAbove` 时整单按本档计价 */
export interface ModelCostTier extends ModelCostRates {
  inputTokensAbove: number
}

export interface ModelCost extends ModelCostRates {
  tiers?: ModelCostTier[]
}

/* ---------------------------------------------------------------- compat */

/**
 * OpenAI 兼容 completions 的兼容开关。
 *
 * 只收录本项目目录实际写入的键。pi 的同名接口还有十几个字段（路由偏好、
 * chat_template 参数、会话亲和头格式等），本项目不用，因此不收——
 * 真要用时从这里加，tsc 会保证目录与声明同步。
 */
export interface OpenAICompletionsCompat {
  /** 是否支持 `store` 字段 */
  supportsStore?: boolean
  /** 是否支持 `developer` 角色（否则退化为 `system`） */
  supportsDeveloperRole?: boolean
  /** 是否支持 `reasoning_effort` */
  supportsReasoningEffort?: boolean
  /** 承载 max tokens 的字段 */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens'
  /** 回放历史 assistant 消息时是否必须补空的 `reasoning_content` */
  requiresReasoningContentOnAssistantMessages?: boolean
  /**
   * 思考参数的形态。这是**必须显式写**的键之一（见 merge.ts 的目录校验）：
   * 不写会落 "openai" 兜底，而域名探测会把 moonshot/zai 的
   * `supportsReasoningEffort` 探成 false，导致 effort 字段被静默跳过。
   */
  thinkingFormat?:
    | 'openai'
    | 'openrouter'
    | 'deepseek'
    | 'together'
    | 'baseten'
    | 'zai'
    | 'qwen'
    | 'chat-template'
    | 'qwen-chat-template'
    | 'string-thinking'
    | 'ant-ling'
  /** z.ai 是否支持顶层 `tool_stream: true`（流式工具调用增量） */
  zaiToolStream?: boolean
  /** 是否支持 `strict` 工具定义字段 */
  supportsStrictMode?: boolean
  /** 是否支持 OpenAI 自定义工具（Lark/regex 语法） */
  supportsOpenAIGrammarTools?: boolean
  /** 思考预算走哪个顶层字段 */
  thinkingTokenBudgetField?: ThinkingTokenBudgetField
  /** provider 专有的延迟工具序列化模式（kimi 需要） */
  deferredToolsMode?: 'kimi'
}

/** OpenAI Responses 的兼容开关（只收目录实际写入的键） */
export interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean
  supportsStrictMode?: boolean
  supportsOpenAIGrammarTools?: boolean
  /** 是否支持消息级 `additional_tools` */
  supportsAdditionalTools?: boolean
  /** 是否支持客户端执行的工具检索（延迟工具） */
  supportsToolSearch?: boolean
  /** 是否接受 `prompt_cache_options`（GPT-5.6+） */
  supportsExplicitPromptCacheMode?: boolean
}

/** Anthropic Messages 的兼容开关（只收目录实际写入的键） */
export interface AnthropicMessagesCompat {
  /** 是否接受 `temperature`（Opus 4.7+ 拒收非默认值） */
  supportsTemperature?: boolean
  /**
   * 强制自适应思考（`thinking.type: "adaptive"` + `output_config.effort`）。
   * 这是**必须显式写**的键之一：pi 默认 false = 预算形态，新代 Anthropic 要 adaptive 形态。
   */
  forceAdaptiveThinking?: boolean
  /** 是否支持 Anthropic 严格工具 schema */
  supportsStrictTools?: boolean
}

/* ---------------------------------------------------------------- 工具定义 */

/** 工具结果里的文本块 */
export interface ToolResultText {
  type: 'text'
  text: string
}

/** 工具结果里的图片块（多模态 tool result；base64 只在主进程内流转） */
export interface ToolResultImage {
  type: 'image'
  data: string
  mimeType: string
}

export type ToolResultContent = ToolResultText | ToolResultImage

/** 工具执行结果：模型看 content，渲染/钉卡看 details（details 必须可 JSON 化） */
export interface AgentToolResult<TDetails = unknown> {
  content: ToolResultContent[]
  details?: TDetails
  isError?: boolean
}

/** 执行中的进度回执（`tool_update` 事件的来源） */
export type AgentToolUpdate = AgentToolResult<unknown>

/**
 * 工具定义（宿主装配层的统一形状）。
 *
 * 只保留本项目实际用到的成员：`toMastraTools` 读 name/description/promptSnippet/
 * label/parameters，并以 5 参形态调 execute。pi 的同名接口还有 renderCall/
 * renderResult/constrainedSampling 等 TUI 专用成员，本项目用不上，因此不收。
 *
 * `execute` 必须声明满 5 个参数：调用点固定按 5 参调用，少声明会让 tsc 报错；
 * 实现方可以只写自己用得到的前几个（多余形参在 JS 里消失，不影响行为）。
 */
export interface ToolDefinition<TDetails = unknown> {
  /** 工具名（模型看到的 function name） */
  name: string
  /** 人类可读标签（UI 工具卡标题） */
  label: string
  /** 给模型的说明 */
  description: string
  /** 默认系统提示词里「可用工具」一行的摘要；本项目大多不提供（说明已并入 description） */
  promptSnippet?: string
  /** 参数 schema（TypeBox；MCP 工具透传标准 JSON Schema） */
  parameters: TSchema
  /**
   * `params` 声明为 unknown 而不是 `Record<string, unknown>`：各工具都在实现里
   * 断言成自己的参数类型，而 `Record<string, unknown>` 还不比那些类型「宽」，
   * 断言会被 tsc 拦（"neither type sufficiently overlaps"）。unknown 与任何
   * 具体类型都允许互转，是这里唯一不需要解释的形态。
   */
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: AgentToolUpdate) => void) | undefined,
    ctx: unknown
  ): Promise<AgentToolResult<TDetails>>
}
