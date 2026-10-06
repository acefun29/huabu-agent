import type {
  CustomModelInput,
  CustomProviderInput,
  ModelEditInput,
  ThinkingLevelName
} from '../../shared/ipc'
// 刻意值导入不用 shared/ipc（那边连着 electron）：本文件必须保持纯 Node 可加载
// （chat-catalog:check 直接跑它）。与 shared/ipc 的 THINKING_LEVELS 同源同序，改一处必改两处
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
import type { ChatUserModelConfig, ChatUserProviderConfig, WorkspaceChatConfig } from './types'
import {
  BUILTIN_CHAT_PROVIDERS,
  CHAT_MODEL_APIS,
  MODEL_ID_PATTERN,
  PROVIDER_ID_PATTERN,
  isChatModelApi,
  mergeChatCatalog
} from './catalog'

/**
 * `chat` 覆盖层的**纯**改写规则（架构计划 §3：workspace.json 的 chat 段是唯一可写面）。
 *
 * 与 overlay.ts 分家的唯一理由是"能不能被机器验"：这一份不碰磁盘也不碰 electron，
 * 因此 `pnpm chat-catalog:check` 能直接跑它（overlay.ts 经由 workspace/store 依赖 electron，
 * 纯 Node 加载不了）。写入面是最不该"只在真机上点一次"的代码——改坏了是用户配置没了。
 *
 * 三条规则：
 * 1. **只接受合法形状**：id 走目录同款正则、协议走白名单、baseUrl 必须 http(s)，
 *    不合格直接抛（设置页把 message 原文显示给用户），不留"存了但被合并层丢弃"的暗伤。
 * 2. **内置模型不可改定义**：展示名/baseUrl 走 `modelOverrides`，能力字段走同 id 补丁
 *    （merge 的 patchBuiltinModel 会打在内置定义上，compat 与价格原样保留）。
 * 3. **"删除"内置模型 = 隐藏**（进 `hiddenBuiltin`，可恢复）；用户自建条目才是真删。
 *
 * 所有 apply* 都直接改传入的 chat 对象（调用方负责克隆与落盘），需要判定来源时用
 * `mergeChatCatalog` 现算——与注册用的是同一份合并结果，不会出现"按文件判定、按清单生效"。
 */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 档位子集 → thinkingLevelMap（唯一转换处）：选中的恒等映射、未选中的显式置 null。
 * off 不进映射 —— openai-completions 下 off = 不发 reasoning_effort，恒可用；
 * 进了映射反而会在 pi 的 getSupportedThinkingLevels 里把 off 排除掉。
 * 非法档位名丢弃；全非法时返回 undefined（等价于没写映射 = 全档可用）。
 */
type ExcludingOff = Exclude<ThinkingLevelName, 'off'>
function levelsToThinkingLevelMap(levels: string[] | undefined): Record<string, string | null> | undefined {
  if (!Array.isArray(levels)) return undefined
  const selected = new Set(levels.filter((l): l is ThinkingLevelName => (THINKING_LEVELS as readonly string[]).includes(l) && l !== 'off'))
  if (selected.size === 0) return undefined
  const map = {} as Record<ExcludingOff, string | null>
  for (const level of THINKING_LEVELS) {
    if (level === 'off') continue
    map[level] = selected.has(level) ? level : null
  }
  return map
}

function entry(chat: WorkspaceChatConfig, providerId: string): ChatUserProviderConfig | undefined {
  return (chat.userProviders ?? []).find((p) => p.id === providerId)
}

function upsertEntry(chat: WorkspaceChatConfig, providerId: string): ChatUserProviderConfig {
  const existing = entry(chat, providerId)
  if (existing) return existing
  const created: ChatUserProviderConfig = { id: providerId }
  chat.userProviders = [...(chat.userProviders ?? []), created]
  return created
}

function isBuiltinProvider(providerId: string): boolean {
  return BUILTIN_CHAT_PROVIDERS.some((p) => p.id === providerId)
}

/**
 * 清掉空数组/空对象与"除了 id 什么都没剩"的供应商条目。
 *
 * 后者必须在这里收口而不是散在每个 apply* 里：一条空条目在设置页会渲染成一行没有名字的
 * 「自定义」供应商，在注册侧则被合并层丢弃（pi 拒绝空 models）——两边不一致就是"看得见但没用"。
 * 注意带 baseUrl 的条目**不是**空的：它承载端点覆盖，删掉模型也要留。
 */
export function pruneChatConfig(chat: WorkspaceChatConfig): WorkspaceChatConfig {
  if (chat.userProviders) {
    const kept = chat.userProviders.filter(
      (p) => p.label || p.baseUrl || p.api || p.authKey || p.models?.length
    )
    if (kept.length === 0) delete chat.userProviders
    else chat.userProviders = kept
  }
  if (chat.hiddenBuiltin?.length === 0) delete chat.hiddenBuiltin
  if (chat.modelOverrides && Object.keys(chat.modelOverrides).length === 0) delete chat.modelOverrides
  return chat
}

/** 按 `provider/模型` 找生效清单里的条目（判定 builtin/user 来源要用它） */
function locate(chat: WorkspaceChatConfig, providerId: string, modelId: string) {
  const provider = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, chat).find((p) => p.id === providerId)
  return { provider, model: provider?.models.find((m) => m.id === modelId) }
}

export function applyAddProvider(chat: WorkspaceChatConfig, input: CustomProviderInput): void {
  const providerId = input.providerId.trim()
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(`供应商 ID 只允许字母/数字/点/横线/下划线：${providerId}`)
  }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(`Base URL 必须以 http(s):// 开头：${input.baseUrl}`)
  }
  if (input.api !== undefined && !isChatModelApi(input.api)) {
    throw new Error(
      `协议只支持 openai-completions / openai-responses / anthropic-messages，收到：${input.api}`
    )
  }
  const api = isChatModelApi(input.api) ? input.api : undefined
  const builtin = isBuiltinProvider(providerId)
  if (entry(chat, providerId) && !builtin) {
    throw new Error(`供应商已存在：${providerId}`)
  }
  const target = upsertEntry(chat, providerId)
  if (isNonEmptyString(input.name)) target.label = input.name.trim()
  // 与内置同 id：baseUrl 覆盖照写（merge 会把它传导到该供应商全部模型），api 以内置目录为准
  target.baseUrl = baseUrl
  if (api && !builtin) target.api = api
}

export function applyRemoveProvider(chat: WorkspaceChatConfig, providerId: string): void {
  if (!entry(chat, providerId)) throw new Error(`自定义供应商不存在：${providerId}`)
  // 内置供应商的覆盖条目（baseUrl 改写、补丁模型）删掉 = 恢复官方默认
  chat.userProviders = (chat.userProviders ?? []).filter((p) => p.id !== providerId)
}

export function applyAddModel(chat: WorkspaceChatConfig, input: CustomModelInput): void {
  const providerId = input.providerId.trim()
  const modelId = input.id.trim()
  if (!providerId) throw new Error('缺少供应商 ID')
  if (!MODEL_ID_PATTERN.test(modelId)) {
    throw new Error(`模型 ID 只允许字母/数字/点/横线/下划线/斜杠/冒号：${modelId}`)
  }
  const existing = entry(chat, providerId)
  if (!existing && !isBuiltinProvider(providerId)) {
    // 「既非覆盖层里有、也非内置目录里有」的 ID 一律拒绝：否则会产生一条没人认证的僵尸供应商
    throw new Error(`供应商不存在：${providerId}（内置目录里也没有，请先「新增供应商」）`)
  }
  if (isBuiltinProvider(providerId)) {
    const defined = BUILTIN_CHAT_PROVIDERS.find((p) => p.id === providerId)!.models.some((m) => m.id === modelId)
    if (defined) throw new Error(`${providerId}/${modelId} 是内置模型，请在模型管理里编辑或删除`)
  }
  if (existing?.models?.some((m) => m.id === modelId)) {
    throw new Error(`模型已存在：${providerId}/${modelId}`)
  }
  const model: ChatUserModelConfig = { id: modelId }
  if (isNonEmptyString(input.name)) model.name = input.name.trim()
  if (input.contextWindow && input.contextWindow > 0) model.contextWindow = Math.round(input.contextWindow)
  if (input.maxTokens && input.maxTokens > 0) model.maxTokens = Math.round(input.maxTokens)
  if (input.reasoning !== undefined) model.reasoning = input.reasoning
  if (input.input_modalities?.length) model.input = [...new Set(input.input_modalities)]
  // 档位声明（仅 completions 有意义；responses/anthropic 的档位语义不同，不从这里收敛）。
  // 只在推理模型下落盘：非推理模型的映射是死配置
  if (
    (input.reasoning === true || (input.reasoning === undefined && model.reasoning === true)) &&
    (input.api === undefined || input.api === '' || input.api === 'openai-completions')
  ) {
    const map = levelsToThinkingLevelMap(input.thinkingLevels)
    if (map) model.thinkingLevelMap = map
  }
  // 模型级协议：缺省=跟随供应商。一个网关同时暴露 /chat/completions 与 /responses 时才有意义，
  // 所以它是可选项而不参与必填校验，但给了就必须是白名单内的一项（写错会静默按 completions 走）
  if (input.api !== undefined && input.api !== '') {
    if (!isChatModelApi(input.api)) {
      throw new Error(
        `协议只支持 ${CHAT_MODEL_APIS.join(' / ')}，收到：${input.api}`
      )
    }
    model.api = input.api
  }
  const target = upsertEntry(chat, providerId)
  target.models = [...(target.models ?? []), model]
}

/** 用户自建条目的真删（内置模型走 applyHideModel） */
export function applyRemoveModel(chat: WorkspaceChatConfig, providerId: string, modelId: string): void {
  const target = entry(chat, providerId)
  if (!target?.models?.some((m) => m.id === modelId)) {
    throw new Error(`自定义模型不存在：${providerId}/${modelId}`)
  }
  target.models = target.models.filter((m) => m.id !== modelId)
  if (target.models.length === 0) delete target.models
  // 条目本身要不要留，交给 pruneChatConfig 统一判（有 baseUrl/label/api 就还是有效覆盖）
}

export function applyHideModel(chat: WorkspaceChatConfig, providerId: string, modelId: string): void {
  const qualified = `${providerId}/${modelId}`
  if (chat.hiddenBuiltin?.includes(qualified)) return
  chat.hiddenBuiltin = [...new Set([...(chat.hiddenBuiltin ?? []), qualified])]
}

export function applyRestoreModel(chat: WorkspaceChatConfig, providerId: string, modelId: string): void {
  const qualified = `${providerId}/${modelId}`
  if (!chat.hiddenBuiltin?.includes(qualified)) throw new Error(`模型未被删除：${qualified}`)
  chat.hiddenBuiltin = chat.hiddenBuiltin.filter((id) => id !== qualified)
}

/**
 * 「删除模型」的统一入口（设置页只有一个删除按钮，语义却有两种）：
 * 用户自建条目直接删；内置条目转隐藏（可恢复）。
 */
export function applyDeleteModel(chat: WorkspaceChatConfig, providerId: string, modelId: string): void {
  const { model } = locate(chat, providerId, modelId)
  if (!model) throw new Error(`模型不可用：${providerId}/${modelId}`)
  if (model.source === 'user') applyRemoveModel(chat, providerId, modelId)
  else applyHideModel(chat, providerId, modelId)
}

/**
 * 编辑模型。两种落点按条目来源分派：
 * - 用户自建条目 → 直接改 `userProviders[].models[]`；
 * - 内置条目 → 展示名进 `modelOverrides`（唯一改名来源），能力字段进同 id 补丁。
 *   改名不写补丁是刻意的：补丁里留名字就有两个来源能改同一个 label，而设置页此后只写
 *   modelOverrides，老补丁里的名字会永远压着用户的新改名。
 *
 * `name` 未出现 = 用户没动这一栏（保持原值）；出现但为空 = 主动清除自定义名，回落目录默认名。
 */
export function applyEditModel(chat: WorkspaceChatConfig, input: ModelEditInput): void {
  const qualified = `${input.providerId}/${input.modelId}`
  const { provider, model } = locate(chat, input.providerId, input.modelId)
  if (!provider || !model) throw new Error(`模型不可用：${qualified}`)

  const nameGiven = input.name !== undefined
  const name = input.name?.trim()
  const capabilities = {
    ...(input.contextWindow && input.contextWindow > 0 ? { contextWindow: Math.round(input.contextWindow) } : {}),
    ...(input.maxTokens && input.maxTokens > 0 ? { maxTokens: Math.round(input.maxTokens) } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {})
  }
  const hasCapability = Object.keys(capabilities).length > 0

  if (model.source === 'user') {
    const target = upsertEntry(chat, input.providerId)
    const list = [...(target.models ?? [])]
    const index = list.findIndex((m) => m.id === input.modelId)
    const entryModel: ChatUserModelConfig = index >= 0 ? { ...list[index] } : { id: input.modelId }
    if (nameGiven) {
      if (isNonEmptyString(name)) entryModel.name = name
      else delete entryModel.name
    }
    Object.assign(entryModel, capabilities)
    // 档位声明整组替换：给了数组就重算映射；空数组或关闭推理 = 清除（非推理/未声明回退全档可用）
    if (Array.isArray(input.thinkingLevels)) {
      const map = levelsToThinkingLevelMap(input.thinkingLevels)
      if (map && entryModel.reasoning !== false) entryModel.thinkingLevelMap = map
      else delete entryModel.thinkingLevelMap
    } else if (input.reasoning === false) {
      delete entryModel.thinkingLevelMap
    }
    if (index >= 0) list[index] = entryModel
    else list.push(entryModel)
    target.models = list
    return
  }

  if (nameGiven) {
    const overrides = { ...chat.modelOverrides }
    if (isNonEmptyString(name)) overrides[qualified] = { ...overrides[qualified], label: name }
    else delete overrides[qualified]?.label
    if (overrides[qualified] && Object.keys(overrides[qualified]).length === 0) delete overrides[qualified]
    chat.modelOverrides = overrides
  }
  if (hasCapability) {
    const target = upsertEntry(chat, input.providerId)
    const list = [...(target.models ?? [])]
    const index = list.findIndex((m) => m.id === input.modelId)
    const patch: ChatUserModelConfig = index >= 0 ? { ...list[index] } : { id: input.modelId }
    Object.assign(patch, capabilities)
    // 内置模型的档位声明走同 id 补丁（merge.ts 的 patchBuiltinModel 会合并 thinkingLevelMap）
    if (Array.isArray(input.thinkingLevels)) {
      const map = levelsToThinkingLevelMap(input.thinkingLevels)
      if (map && patch.reasoning !== false) patch.thinkingLevelMap = map
      else delete patch.thinkingLevelMap
    }
    if (index >= 0) list[index] = patch
    else list.push(patch)
    target.models = list
  }
}
