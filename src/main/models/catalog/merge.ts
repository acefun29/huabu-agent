import type {
  ChatModelDef,
  ChatProviderDef,
  ChatUserModelConfig,
  ChatUserProviderConfig,
  EffectiveChatModel,
  EffectiveChatProvider,
  WorkspaceChatConfig
} from '../types'
import { CHAT_MODEL_APIS, isChatModelApi } from '../types'

/**
 * 合并层：内置目录（代码数据）+ 用户覆盖层（workspace.json `chat` 段）→ 生效清单。
 *
 * 这是聊天模型清单的**唯一**来源（架构计划 §3）。与媒体侧 media/catalog/merge.ts 同构，
 * 但多两条聊天侧特有的责任：
 *
 * 1. **api 白名单**（T4 要求）：自定义供应商/模型的 `api` 来自用户输入，而 pi 的 `Api`
 *    类型是 `KnownApi | (string & {})`——等于无约束，写错协议名不会编译失败、不会报错，
 *    只会在运行时找不到适配器。所以这里必须硬校验，只放
 *    `openai-completions` / `openai-responses` / `anthropic-messages`。
 * 2. **继承字段解析到底**：`api`/`baseUrl` 在生效清单里永远非 undefined，
 *    把隐式默认消灭在合并层，注册阶段不做任何推断（隐式默认正是 §2.5 那类静默失效的温床）。
 *
 * 合并语义：用户供应商与内置供应商共用一个 id 命名空间——同 id 视为**在该内置供应商上打补丁**
 * （供应商级 baseUrl/label/凭据以用户为准；同 id 模型逐字段覆盖、内置其余字段保留；新 id 追加）；
 * 异 id 直接追加。两层永不互相写脏：内置清单改动不碰用户文件，用户覆盖不进代码。
 */

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._/:@-]*$/i

/** mergeChatCatalog 需要的覆盖层（WorkspaceChatConfig 的清单相关子集） */
export type ChatCatalogUserConfig = Pick<
  WorkspaceChatConfig,
  'userProviders' | 'hiddenBuiltin' | 'modelOverrides'
>

/** 用户自建条目的兜底默认：宁保守（128K/8K），用户可在设置里改 */
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8_192

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

export function mergeChatCatalog(
  builtin: readonly ChatProviderDef[],
  userConfig: ChatCatalogUserConfig
): EffectiveChatProvider[] {
  const hidden = new Set(userConfig.hiddenBuiltin ?? [])
  const overrides = userConfig.modelOverrides ?? {}
  const users = sanitizeUserProviders(userConfig.userProviders)
  const usersById = new Map(users.map((u) => [u.id, u]))
  const effective = new Map<string, EffectiveChatProvider>()

  for (const def of builtin) {
    const user = usersById.get(def.id)
    // 供应商级 baseUrl 被用户改掉时，**模型级继承必须跟着走**：所以先造出"生效供应商定义"
    // 再解析内置模型。反过来（先解析后改 provider.baseUrl）会让镜像端点只作用于用户显式
    // 列出的那几个模型，其余模型仍偷偷打官方域名——配了镜像却还在烧官方额度，属于最难查的一类错。
    const defResolved: ChatProviderDef = { ...def, baseUrl: user?.baseUrl ?? def.baseUrl }
    const provider: EffectiveChatProvider = {
      id: def.id,
      label: user?.label ?? def.label,
      baseUrl: defResolved.baseUrl,
      api: def.api,
      auth: user?.authKey ? { ...def.auth, key: user.authKey } : def.auth,
      ...(def.region ? { region: def.region } : {}),
      ...(def.helpUrl ? { helpUrl: def.helpUrl } : {}),
      source: 'builtin',
      models: []
    }
    if (user?.api && user.api !== def.api) {
      warn(`chat.userProviders[${def.id}]`, `api（${user.api}）与内置目录（${def.api}）不一致，以内置目录为准`)
    }
    const pending = new Map((user?.models ?? []).map((m) => [m.id, m]))
    for (const model of def.models) {
      if (hidden.has(`${def.id}/${model.id}`) || model.status === 'deprecated') continue
      const resolved = resolveModel(model, defResolved, overrides)
      const patch = pending.get(model.id)
      provider.models.push(patch ? patchBuiltinModel(resolved, patch) : resolved)
      pending.delete(model.id)
    }
    // 用户在内置供应商下新增的模型 id（目录里还没有的）：按独立条目追加，不伪装成内置
    for (const model of pending.values()) provider.models.push(resolveUserModel(model, provider))
    effective.set(def.id, provider)
  }

  for (const user of users) {
    if (effective.has(user.id)) continue
    const provider: EffectiveChatProvider = {
      id: user.id,
      label: user.label ?? user.id,
      baseUrl: user.baseUrl ?? '',
      api: user.api ?? 'openai-completions',
      auth: {
        label: `${user.label ?? user.id} API Key`,
        helpUrl: '',
        ...(user.authKey ? { key: user.authKey } : {})
      },
      source: 'user',
      models: []
    }
    if (!provider.baseUrl) {
      warn(`chat.userProviders[${user.id}]`, '缺 baseUrl 且不是内置供应商，整条已丢弃')
      continue
    }
    provider.models = (user.models ?? []).map((model) => resolveUserModel(model, provider))
    effective.set(user.id, provider)
  }

  return [...effective.values()].filter((p) => p.models.length > 0)
}

/**
 * 清洗整段 userProviders（workspace.json 里可能是任意形状），并按 id 去重（同 id 只留首条）。
 *
 * 单独导出是因为管理器要在**合并之前拿到干净配置回写落盘**（见 migrate/store 的读旧写新），
 * 而 mergeChatCatalog 内部也走同一条路径，两边共用一份规则才不会漂移。
 */
export function sanitizeUserProviders(raw: unknown): ChatUserProviderConfig[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warn('chat.userProviders', `必须是数组，实际是 ${typeName(raw)}；全部用户供应商已丢弃`)
    return []
  }
  const out: ChatUserProviderConfig[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const sanitized = sanitizeUserProvider(entry, index)
    if (!sanitized) return
    if (seen.has(sanitized.id)) {
      warn(`chat.userProviders[${index}]`, `供应商 id 重复（${sanitized.id}），后出现的条目已丢弃`)
      return
    }
    seen.add(sanitized.id)
    out.push(sanitized)
  })
  return out
}

/** 内置模型 + 所属供应商 + 覆盖层 → 生效模型（继承字段全部解析） */
function resolveModel(
  model: ChatModelDef,
  provider: ChatProviderDef,
  overrides: WorkspaceChatConfig['modelOverrides']
): EffectiveChatModel {
  const qualifiedId = `${provider.id}/${model.id}`
  const override = overrides?.[qualifiedId]
  return {
    ...model,
    label: override?.label ?? model.label,
    api: model.api ?? provider.api,
    baseUrl: model.baseUrl ?? override?.baseUrl ?? provider.baseUrl,
    source: 'builtin'
  }
}

/**
 * 同 id 内置供应商下的用户条目 = 给内置定义**打补丁**，不是整条替换。
 *
 * 整条替换会让"把 deepseek 指到镜像端点"这一件事连带丢掉 compat / cost / 思考档位——
 * 而这些正是目录存在的理由。丢 compat 的后果就是 §2.5 那类静默失效：字段不发、
 * 不报错、模型不思考。规则：用户显式写了的字段才覆盖，其余保留内置值。
 * （label 以用户条目的 `name` 为准——它比 modelOverrides 的展示覆盖更刻意。）
 */
function patchBuiltinModel(base: EffectiveChatModel, patch: ChatUserModelConfig): EffectiveChatModel {
  const compat = base.compat || patch.compat ? { ...base.compat, ...patch.compat } : undefined
  return {
    ...base,
    label: patch.name ?? base.label,
    api: patch.api ?? base.api,
    ...(patch.baseUrl ? { baseUrl: patch.baseUrl } : {}),
    reasoning: patch.reasoning ?? base.reasoning,
    ...(patch.thinkingLevelMap ? { thinkingLevelMap: patch.thinkingLevelMap } : {}),
    input: patch.input ?? base.input,
    contextWindow: patch.contextWindow ?? base.contextWindow,
    maxTokens: patch.maxTokens ?? base.maxTokens,
    ...(compat ? { compat: compat as EffectiveChatModel['compat'] } : {})
  }
}

/** 用户模型 + 所属（可能内置的）供应商 → 生效模型 */
function resolveUserModel(model: ChatUserModelConfig, provider: EffectiveChatProvider): EffectiveChatModel {
  return {
    id: model.id,
    label: model.name ?? model.id,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costSource: 'unverified',
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model.compat ? { compat: model.compat as EffectiveChatModel['compat'] } : {}),
    api: model.api ?? provider.api,
    baseUrl: model.baseUrl ?? provider.baseUrl,
    source: 'user'
  }
}

/* ---------------- 清洗：坏配置只丢那一条/那一个字段，并说清是哪一条 ---------------- */

/**
 * 清洗单个用户供应商条目。返回 null = 整条丢弃。
 *
 * `api` 不在白名单时**丢字段而不是丢条目**（退回 openai-completions 通常仍可用），
 * 但要 warn——用户以为自己配了 responses 协议、实际跑的是 completions，属于必须可见的降级。
 */
export function sanitizeUserProvider(raw: unknown, index = 0): ChatUserProviderConfig | null {
  const where = `chat.userProviders[${index}]`
  if (!isPlainObject(raw)) {
    warn(where, '不是对象，已丢弃')
    return null
  }
  const id = isNonEmptyString(raw.id) ? raw.id.trim() : undefined
  if (!id || !PROVIDER_ID_PATTERN.test(id)) {
    warn(`${where}.id`, `只允许字母/数字/点/横线/下划线（${JSON.stringify(raw.id)}），整条已丢弃`)
    return null
  }
  const out: ChatUserProviderConfig = { id }
  if (isNonEmptyString(raw.label)) out.label = raw.label.trim()
  if (isNonEmptyString(raw.baseUrl)) {
    if (/^https?:\/\//.test(raw.baseUrl.trim())) out.baseUrl = raw.baseUrl.trim().replace(/\/+$/, '')
    else warn(`${where}.baseUrl`, `必须以 http(s):// 开头（${raw.baseUrl}），已忽略该字段`)
  } else if (!isNonEmptyString(raw.baseUrl) && raw.baseUrl !== undefined) {
    warn(`${where}.baseUrl`, '不是字符串，已忽略')
  }
  if (raw.api !== undefined) {
    if (isChatModelApi(raw.api)) out.api = raw.api
    else warn(`${where}.api`, `协议「${String(raw.api)}」不在白名单（${CHAT_MODEL_APIS.join(' / ')}），已忽略，按 openai-completions 处理`)
  }
  if (isNonEmptyString(raw.authKey)) out.authKey = raw.authKey.trim()
  const models = sanitizeUserModels(raw.models, `${where}.models`)
  if (models.length > 0) out.models = models
  return out
}

export function sanitizeUserModels(raw: unknown, where: string): ChatUserModelConfig[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warn(where, `必须是数组，实际是 ${typeName(raw)}；已忽略`)
    return []
  }
  const out: ChatUserModelConfig[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const at = `${where}[${index}]`
    if (!isPlainObject(entry)) {
      warn(at, '不是对象，已丢弃')
      return
    }
    const id = isNonEmptyString(entry.id) ? entry.id.trim() : undefined
    if (!id || !MODEL_ID_PATTERN.test(id)) {
      warn(`${at}.id`, `只允许字母/数字/点/横线/下划线/斜杠/冒号/@（${JSON.stringify(entry.id)}），已丢弃`)
      return
    }
    if (seen.has(id)) {
      warn(at, `模型 id 重复（${id}），后出现的已丢弃`)
      return
    }
    seen.add(id)
    const model: ChatUserModelConfig = { id }
    if (isNonEmptyString(entry.name)) model.name = entry.name.trim()
    if (typeof entry.reasoning === 'boolean') model.reasoning = entry.reasoning
    if (Array.isArray(entry.input)) {
      const input = [...new Set(entry.input.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image'))]
      model.input = input.length > 0 ? input : ['text']
    } else if (entry.input !== undefined) {
      warn(`${at}.input`, '不是数组，已忽略')
    }
    const contextWindow = positiveInt(entry.contextWindow)
    if (contextWindow) model.contextWindow = contextWindow
    else if (entry.contextWindow !== undefined) warn(`${at}.contextWindow`, '不是正数，已忽略')
    const maxTokens = positiveInt(entry.maxTokens)
    if (maxTokens) model.maxTokens = maxTokens
    else if (entry.maxTokens !== undefined) warn(`${at}.maxTokens`, '不是正数，已忽略')
    if (entry.api !== undefined) {
      if (isChatModelApi(entry.api)) model.api = entry.api
      else warn(`${at}.api`, `协议「${String(entry.api)}」不在白名单（${CHAT_MODEL_APIS.join(' / ')}），已忽略`)
    }
    if (isNonEmptyString(entry.baseUrl) && /^https?:\/\//.test(entry.baseUrl.trim())) {
      model.baseUrl = entry.baseUrl.trim().replace(/\/+$/, '')
    } else if (entry.baseUrl !== undefined) {
      warn(`${at}.baseUrl`, '需要 http(s):// 开头，已忽略')
    }
    if (isPlainObject(entry.compat)) model.compat = entry.compat
    else if (entry.compat !== undefined) warn(`${at}.compat`, '不是对象，已忽略')
    if (isPlainObject(entry.thinkingLevelMap)) {
      const map: Record<string, string | null> = {}
      for (const [k, v] of Object.entries(entry.thinkingLevelMap)) {
        if (v === null || typeof v === 'string') map[k] = v
      }
      if (Object.keys(map).length > 0) model.thinkingLevelMap = map
    }
    out.push(model)
  })
  return out
}

/** 清洗 hiddenBuiltin：去重、只留非空字符串 */
export function sanitizeHiddenBuiltin(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warn('chat.hiddenBuiltin', `必须是数组，实际是 ${typeName(raw)}；已忽略`)
    return []
  }
  return [...new Set(raw.filter(isNonEmptyString).map((id) => id.trim()))]
}

/** 清洗 modelOverrides：只留 { label?, baseUrl? } */
export function sanitizeModelOverrides(raw: unknown): NonNullable<WorkspaceChatConfig['modelOverrides']> {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) {
    warn('chat.modelOverrides', `必须是对象，实际是 ${typeName(raw)}；已忽略`)
    return {}
  }
  const out: NonNullable<WorkspaceChatConfig['modelOverrides']> = {}
  for (const [qualifiedId, override] of Object.entries(raw)) {
    if (!isNonEmptyString(qualifiedId) || !isPlainObject(override)) {
      warn(`chat.modelOverrides["${qualifiedId}"]`, '覆盖条目不合法（应为 { label?, baseUrl? }），已忽略')
      continue
    }
    const clean: { label?: string; baseUrl?: string } = {}
    if (isNonEmptyString(override.label)) clean.label = override.label.trim()
    if (isNonEmptyString(override.baseUrl) && /^https?:\/\//.test(override.baseUrl.trim())) {
      clean.baseUrl = override.baseUrl.trim().replace(/\/+$/, '')
    }
    if (Object.keys(clean).length > 0) out[qualifiedId] = clean
  }
  return out
}

/* ---------------- 内置目录自检（catalog:check / 单测共用） ---------------- */

/**
 * 校验内置目录自身——用户配错可以 warn 后丢弃，内置目录写错必须直接失败在 CI。
 *
 * 断言里最值钱的三条（都围绕同一件事：**思考字段的开关在 pi 里是"缺省即不发"的**，
 * 漏写不报错、只是模型照旧不思考/关不掉，是最难查的一类线上问题）：
 * - **同 id 重复**：注册时 models 数组整体替换（2.4-6），重复 id 会静默丢一个模型。
 * - **每个协议的"思考主开关"必须显式写**：openai-completions 是 `compat.thinkingFormat`
 *   （不写落 `"openai"` 兜底，国产模型收不到开思考的字段，§2.5）；anthropic-messages 是
 *   `compat.forceAdaptiveThinking`（pi 默认 false = 预算形态，新代 Claude 要 adaptive）；
 *   openai-responses 是 `thinkingLevelMap.off`（缺省与 null 同义 = 关不掉，见 openai-responses.js:264）。
 * - **stable 模型不许带 unverified 价格**：逼着价格复核要么做完、要么显式挂 beta。
 */
export function validateBuiltinCatalog(builtin: readonly ChatProviderDef[]): string[] {
  const errors: string[] = []
  const providerIds = new Set<string>()
  for (const provider of builtin) {
    if (!PROVIDER_ID_PATTERN.test(provider.id)) errors.push(`供应商 id 非法：${provider.id}`)
    if (providerIds.has(provider.id)) errors.push(`供应商 id 重复：${provider.id}`)
    providerIds.add(provider.id)
    if (!isChatModelApi(provider.api)) errors.push(`${provider.id}.api 不在白名单：${String(provider.api)}`)
    if (!/^https?:\/\//.test(provider.baseUrl)) errors.push(`${provider.id}.baseUrl 需要 http(s):// 开头`)
    if (provider.models.length === 0) errors.push(`${provider.id} 没有任何模型`)
    const modelIds = new Set<string>()
    for (const model of provider.models) {
      const at = `${provider.id}/${model.id}`
      if (!MODEL_ID_PATTERN.test(model.id)) errors.push(`模型 id 非法：${at}`)
      if (modelIds.has(model.id)) errors.push(`模型 id 重复：${at}`)
      modelIds.add(model.id)
      if (!isNonEmptyString(model.label)) errors.push(`${at} 缺 label`)
      if (model.contextWindow <= 0) errors.push(`${at}.contextWindow 需要正数`)
      if (model.maxTokens <= 0) errors.push(`${at}.maxTokens 需要正数`)
      if (model.maxTokens > model.contextWindow) errors.push(`${at}.maxTokens 大于 contextWindow`)
      if (model.api && !isChatModelApi(model.api)) errors.push(`${at}.api 不在白名单：${String(model.api)}`)
      // 每个协议各有自己的"思考主开关"，缺省值都会导致静默失效，所以按 api 分别要求显式声明。
      const api = model.api ?? provider.api
      const compat = model.compat as
        | { thinkingFormat?: string; forceAdaptiveThinking?: boolean }
        | undefined
      if (model.reasoning && api === 'openai-completions' && !compat?.thinkingFormat) {
        errors.push(`${at} 是推理模型但未显式写 compat.thinkingFormat（不写会落 "openai" 兜底，见 §2.5）`)
      }
      if (model.reasoning && api === 'anthropic-messages' && compat?.forceAdaptiveThinking === undefined) {
        errors.push(
          `${at} 是推理模型但未显式写 compat.forceAdaptiveThinking（pi 默认 false=预算形态，新代 Claude 要 adaptive 形态）`
        )
      }
      if (model.reasoning && api === 'openai-responses' && !('off' in (model.thinkingLevelMap ?? {}))) {
        errors.push(`${at} 是推理模型但 thinkingLevelMap 缺 off 键（缺省与 off:null 同义 = 这个模型关不掉思考）`)
      }
      if (model.status !== 'deprecated' && model.costSource === 'unverified' && model.status !== 'beta') {
        errors.push(`${at} 价格为 unverified，却未标 beta（stable 条目必须复核过价格）`)
      }
    }
  }
  return errors
}

function warn(where: string, message: string): void {
  console.warn(`[chat-catalog] ${where}：${message}`)
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
