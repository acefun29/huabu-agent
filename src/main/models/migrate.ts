import type { CredentialStore } from '@earendil-works/pi-ai'
import type { ChatModelOverride, ChatUserModelConfig, ChatUserProviderConfig, WorkspaceChatConfig } from './types'
import { BUILTIN_CHAT_PROVIDERS } from './catalog'

/**
 * 一次性迁移：旧模型层 → workspace.json 的 `chat` 覆盖层（架构计划 §3 决策5）。
 *
 * 旧状态散在三处，本文件把它们收成一处：
 * - `.huabu/models.json`（Pi 原生格式）：`providers[id].models` = 自定义供应商/模型，
 *   `providers[id].modelOverrides` = 对内置模型的编辑；
 * - workspace.json 顶层 `defaultModel` / `hiddenModels`（`provider/model` 记法）；
 * - 加密凭据存储里以 **pi 内置 provider id** 为键的旧 Key（moonshotai-cn / zai …）。
 *
 * 两条设计约束：
 * 1. **规划与执行分离**：`migrateChatConfig` 是纯函数（只吃数据、只出计划），能在纯 Node
 *    里逐路径单测；凭据搬运单独由 `applyCredentialMoves` 执行（要读解密存储）。
 *    迁移是最不该"只在真机上验一次"的代码。
 * 2. **不静默丢弃**：旧格式能表达、新目录表达不了的（国际站 endpoint、自定义供应商下的
 *    隐藏项、无法解析的 defaultModel、无对应供应商的旧凭据键），一律进 `notes` 由调用方
 *    显示。宁可多说一句，也不要让用户第二天发现"模型没了但不知道为什么"。
 */

/** 旧 `.huabu/models.json` 的单模型条目（pi 原生格式的子集，只声明用得到的字段） */
export interface LegacyModelDef {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
}

export interface LegacyProviderDef {
  name?: string
  baseUrl?: string
  api?: string
  models?: LegacyModelDef[]
  modelOverrides?: Record<string, LegacyModelDef>
}

export interface LegacyModelsFile {
  providers?: Record<string, LegacyProviderDef>
}

export interface ChatMigrationInput {
  /** workspace.json 顶层旧字段 */
  defaultModel?: string
  hiddenModels?: string[]
  modelsFile?: LegacyModelsFile | null
  /**
   * 存储里现存的凭据键（`CredentialStore.list()` 的 providerId，不含任何密钥内容）。
   * 给了才能把凭据搬运表和 endpoint 提醒收敛到"真存在"的键上；不给则按最保守策略
   * 列出全部已知映射（搬运本身是幂等 no-op，多列无害）。
   */
  storedCredentialKeys?: string[]
}

export interface CredentialMove {
  /** 旧凭据键（pi 内置 provider id） */
  from: string
  /** 新凭据键（我们目录的 provider id） */
  to: string
}

export interface ChatMigrationPlan {
  config: WorkspaceChatConfig
  credentialMoves: CredentialMove[]
  notes: string[]
}

/**
 * pi 内置 provider id → 我们的目录 id，以及该旧键实际打的 endpoint 说明。
 *
 * 只列"我们目录里确实有这家、且旧键能指向同一个可用服务"的映射。故意不搬的三类：
 * - `qwen-token-plan*`：订阅制通道，那份凭据不是百炼 API Key，搬过来必然打不通；
 * - `kimi-coding`：endpoint 与模型 id 都另成一套（`api.kimi.com/coding` + `k3`/`kimi-for-coding`）；
 * - `anthropic` / `openai` 等：一期不在五家目录内，凭据留在旧键里无害。
 * endpoint 与我们目录默认值不同的，搬运时一并出 note 让用户核对 baseUrl——
 * 与其静默改写配置，不如把"你的 Key 属于哪个站"说清楚。
 */
const CREDENTIAL_REMAP: Record<string, { to: string; endpointNote?: string }> = {
  'moonshotai-cn': { to: 'kimi' },
  moonshotai: {
    to: 'kimi',
    endpointNote: '旧 Kimi 凭据属于国际站 api.moonshot.ai，新目录默认打 CN 站 api.moonshot.cn：如需国际站请覆盖 Kimi 的 baseUrl'
  },
  zai: {
    to: 'glm',
    endpointNote: '旧 GLM 凭据属于 api.z.ai（国际 Coding 端点），新目录默认打 open.bigmodel.cn：如需 z.ai 请覆盖 GLM 的 baseUrl'
  },
  'zai-coding-cn': {
    to: 'glm',
    endpointNote: '旧 GLM 凭据属于 Coding 套餐端点 /api/coding/paas/v4，新目录默认打通用端点 /api/paas/v4：请覆盖 GLM 的 baseUrl'
  }
}

/** 与新层无任何交集的旧凭据键（连改名都没有），只在 notes 里交代 */
const ORPHAN_CREDENTIAL_KEYS = ['kimi-coding', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual']

const CHAT_PROVIDER_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

/**
 * 目录 id → **可见**模型 id 集合（判断迁移后的 `provider/model` 是否还在生效清单里）。
 *
 * 只统计非 deprecated 的条目：merge 层会把退役模型从生效清单里过滤掉，
 * 迁移若把它们算成"可解析"，就会把老配置里指向已下线模型的 defaultModel 原样搬进新层，
 * 结果和旧行为（应用级退役 id 视为未设置）不一致。
 */
const CATALOG_INDEX = new Map<string, Set<string>>(
  BUILTIN_CHAT_PROVIDERS.map((p) => [
    p.id,
    new Set(p.models.filter((m) => m.status !== 'deprecated').map((m) => m.id))
  ])
)

/** 目录内已退役的模型：旧 hiddenModels 里的这些条目不必搬进新层（catalog status 已接管） */
const DEPRECATED_QUALIFIED = new Set<string>(
  BUILTIN_CHAT_PROVIDERS.flatMap((p) =>
    p.models.filter((m) => m.status === 'deprecated').map((m) => `${p.id}/${m.id}`)
  )
)

export function migrateChatConfig(input: ChatMigrationInput): ChatMigrationPlan {
  const notes: string[] = []
  const userProviders = new Map<string, ChatUserProviderConfig>()
  const modelOverrides: Record<string, ChatModelOverride> = {}

  for (const [id, def] of Object.entries(input.modelsFile?.providers ?? {})) {
    if (!def || typeof def !== 'object') continue
    const entry: ChatUserProviderConfig = { id }
    if (def.name) entry.label = def.name
    if (def.baseUrl) entry.baseUrl = def.baseUrl
    if (def.api) {
      if (CHAT_PROVIDER_APIS.has(def.api)) entry.api = def.api as ChatUserProviderConfig['api']
      else notes.push(`自定义供应商「${id}」的协议 ${def.api} 不在新目录白名单内，已按 openai-completions 处理`)
    }
    if (!CATALOG_INDEX.has(id) && !entry.baseUrl) {
      notes.push(`自定义供应商「${id}」缺 baseUrl，新目录会丢弃整条：请在设置里补全`)
    }
    const models: ChatUserModelConfig[] = []

    for (const model of def.models ?? []) {
      const migrated = toUserModel(model, id, notes)
      if (migrated) models.push(migrated)
    }

    // 旧 modelOverrides 把"编辑内置模型"和"新增条目"混在同一种形态里。拆两路：
    // 能力字段（contextWindow/maxTokens/reasoning）落成同 id 的 userProviders 补丁——
    // merge 层的 patchBuiltinModel 会把它打到内置定义上，compat 与价格原样保留；
    // 展示字段（name）留在 chat.modelOverrides，与设置页"改显示名"的语义一致。
    for (const [modelId, override] of Object.entries(def.modelOverrides ?? {})) {
      const qualified = `${id}/${modelId}`
      const hasCapability =
        override.contextWindow !== undefined || override.maxTokens !== undefined || override.reasoning !== undefined
      // 只有能力字段才落成补丁条目：纯改名不该在 userProviders 里留下痕迹（否则 modelOverrides 会被误当成配置源）
      if (hasCapability) {
        // name 必须剥掉：改名只走 modelOverrides 一条路。留着它就有两个来源能改同一个 label，
        // 而设置页此后只写 modelOverrides —— 老补丁里的名字会永远压着用户的新改名。
        const capabilityOnly: LegacyModelDef = { ...override, id: modelId }
        delete capabilityOnly.name
        const patched = toUserModel(capabilityOnly, id, notes)
        if (patched) models.push(patched)
      }
      if (override.name?.trim()) modelOverrides[qualified] = { label: override.name.trim() }
    }

    if (models.length > 0) entry.models = models
    if (entry.label || entry.baseUrl || entry.api || entry.models) userProviders.set(id, entry)
  }

  const hiddenBuiltin = (input.hiddenModels ?? []).flatMap((raw) => {
    const qualified = remapQualified(raw, notes)
    if (!qualified || DEPRECATED_QUALIFIED.has(qualified)) return []
    const [providerId, ...rest] = qualified.split('/')
    if (!CATALOG_INDEX.get(providerId)?.has(rest.join('/'))) {
      notes.push(`隐藏清单里的「${qualified}」不在内置目录中，迁移后不再生效：自定义模型请直接删除该条目`)
      return []
    }
    return [qualified]
  })

  const config: WorkspaceChatConfig = {}
  const hidden = new Set(hiddenBuiltin)
  const defaultModel = input.defaultModel?.trim() ? remapQualified(input.defaultModel.trim(), notes) : undefined
  if (defaultModel) {
    if (resolvable(defaultModel, userProviders, hidden)) {
      config.defaultModel = defaultModel
    } else {
      // 与旧行为对齐：指向已退役/不存在/已被用户删除的模型的 defaultModel 视为未设置，而不是搬过去让
      // pickModel 每次静默回退（旧 readMeta 就是靠 DEFAULT_HIDDEN_MODELS 做这件事的）。
      notes.push(`默认模型「${defaultModel}」迁移后不在生效清单里，已视为未设置：请在设置里重选`)
    }
  }
  if (userProviders.size > 0) config.userProviders = [...userProviders.values()]
  if (hiddenBuiltin.length > 0) config.hiddenBuiltin = [...new Set(hiddenBuiltin)]
  if (Object.keys(modelOverrides).length > 0) config.modelOverrides = modelOverrides

  const present = input.storedCredentialKeys ? new Set(input.storedCredentialKeys) : undefined
  const credentialMoves: CredentialMove[] = []
  for (const [from, rule] of Object.entries(CREDENTIAL_REMAP)) {
    if (present && !present.has(from)) continue
    credentialMoves.push({ from, to: rule.to })
    if (rule.endpointNote) notes.push(rule.endpointNote)
  }
  for (const key of ORPHAN_CREDENTIAL_KEYS) {
    if (present && !present.has(key)) continue
    notes.push(`旧凭据键「${key}」在新目录里没有对应供应商：该通道的 Key 需要重新录入（或该厂商暂不可用）`)
  }

  return { config, credentialMoves, notes }
}

/** 迁移后的默认模型是否还在**生效清单**里：目录可见条目或用户自建条目，且没被隐藏清单删掉 */
function resolvable(
  qualified: string,
  userProviders: Map<string, ChatUserProviderConfig>,
  hidden: Set<string>
): boolean {
  if (hidden.has(qualified)) return false
  const [providerId, ...rest] = qualified.split('/')
  const modelId = rest.join('/')
  if (CATALOG_INDEX.get(providerId)?.has(modelId)) return true
  return userProviders.get(providerId)?.models?.some((m) => m.id === modelId) ?? false
}

/** 旧 `provider/model` → 新记法（供应商改名时出 note）；记法不合法返回 undefined */
function remapQualified(raw: string, notes: string[]): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) {
    notes.push(`旧模型 id「${raw}」不是 provider/model 记法，已忽略`)
    return undefined
  }
  const providerId = trimmed.slice(0, slash)
  const modelId = trimmed.slice(slash + 1)
  const mapped = CREDENTIAL_REMAP[providerId]?.to ?? providerId
  if (mapped !== providerId) notes.push(`「${raw}」随供应商改名迁移为 ${mapped}/${modelId}`)
  return `${mapped}/${modelId}`
}

function toUserModel(model: LegacyModelDef, providerId: string, notes: string[]): ChatUserModelConfig | undefined {
  const id = model?.id?.trim()
  if (!id) {
    notes.push(`供应商「${providerId}」下有一条模型缺 id，已丢弃`)
    return undefined
  }
  const out: ChatUserModelConfig = { id }
  if (model.name?.trim()) out.name = model.name.trim()
  if (typeof model.reasoning === 'boolean') out.reasoning = model.reasoning
  if (Array.isArray(model.input) && model.input.length > 0) out.input = [...new Set(model.input)]
  if (model.contextWindow && model.contextWindow > 0) out.contextWindow = Math.round(model.contextWindow)
  if (model.maxTokens && model.maxTokens > 0) out.maxTokens = Math.round(model.maxTokens)
  if (model.baseUrl) out.baseUrl = model.baseUrl.replace(/\/+$/, '')
  if (model.api) {
    if (CHAT_PROVIDER_APIS.has(model.api)) out.api = model.api as ChatUserModelConfig['api']
    else notes.push(`「${providerId}/${id}」的协议 ${model.api} 不在白名单内，已按所属供应商协议处理`)
  }
  return out
}

/**
 * 执行凭据搬运：读旧键 → 若无新键则写新键 → 删旧键。
 *
 * 三条硬规则：
 * - **新键已有凭据** ⇒ 不覆盖（用户可能已在新 UI 录过），只清掉旧键并记 skipped；
 * - 任何日志/返回值都不出现密钥内容，只有 provider id；
 * - 旧键不存在 ⇒ no-op，因此可重复调用（幂等），中途失败重来不会写坏。
 *   失败只记键名：搬运失败不该让整次迁移回滚——旧键还在，下次再搬。
 */
export async function applyCredentialMoves(
  store: CredentialStore,
  moves: readonly CredentialMove[]
): Promise<{ moved: string[]; skipped: string[]; failed: string[] }> {
  const moved: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  for (const move of moves) {
    try {
      const legacy = await store.read(move.from)
      if (!legacy) continue
      if (await store.read(move.to)) {
        await store.delete(move.from)
        skipped.push(move.from)
        continue
      }
      await store.modify(move.to, async () => legacy)
      await store.delete(move.from)
      moved.push(move.from)
    } catch {
      failed.push(move.from)
    }
  }
  return { moved, skipped, failed }
}
