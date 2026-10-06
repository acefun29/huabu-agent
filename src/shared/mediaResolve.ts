import { DEFAULT_MEDIA_PROVIDER, type MediaKind, type ModelCapabilities } from './media'

/**
 * 媒体模型解析（回退链）的**唯一实现**（P0 收口）。
 *
 * 此前渲染端（settingsStore.resolveMediaModel）与主进程（ipc.resolveAgentMedia）
 * 各手写一份，语义还有分歧（阻断 vs 静默落 mock）；现在两处都调这里的纯函数，
 * 语义只有一套：
 *
 *   1. 卡片单独指定的模型（override，`provider:模型id` 复合串）——指定了就必须命中，
 *      失效（供应商被删/模型隐藏）返回 null 让调用方报错，**不静默换模型**
 *      （「界面上看到的模型就是实际在用的模型」）；
 *   2. 设置里该类媒体的默认模型（agentModels[kind]，复合串；兼容旧版裸模型 id）——
 *      失效则落回默认链，不阻断；
 *   3. 默认供应商（agentProvider ?? DEFAULT_MEDIA_PROVIDER）的首个同类模型；
 *   4. 任何供应商的首个同类模型；
 *   5. 都没有 → null（调用方给可操作错误；mock 不在这里兜底，只能显式选择）。
 *
 * 结构子集（MediaResolveProvider/MediaResolveModel）同时被主进程的
 * AdapterProviderConfig 与渲染端的 MediaProviderInfo 满足，零适配成本。
 */

export interface MediaResolveModel {
  id: string
  kind: MediaKind
  capabilities?: ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
}

export interface MediaResolveProvider {
  id: string
  models: readonly MediaResolveModel[]
}

export interface MediaResolveInput {
  kind: MediaKind
  /** 卡片级覆盖：`provider:模型id` 复合串（旧数据可能是裸模型 id） */
  override?: string
  /** 设置里的默认供应商 */
  agentProvider?: string
  /** 设置里各 kind 的默认模型（复合串；兼容旧版裸模型 id） */
  agentModels?: Partial<Record<MediaKind, string>>
}

export interface ResolvedMediaTarget {
  provider: string
  /** 命中模型的稳定 id（如 'dashscope/wan2.7-image'） */
  model: string
  /** `provider:模型id` 复合串——卡片参数与设置存储的统一记法 */
  ref: string
  /** 命中的模型条目（capabilities 等元数据随行） */
  info: MediaResolveModel
  source: 'override' | 'configured' | 'provider-default' | 'fallback'
}

/** 拼复合引用串。provider id 不含冒号（目录层 PROVIDER_ID_PATTERN 保证），模型 id 可含斜杠 */
export function toModelRef(provider: string, model: string): string {
  return `${provider}:${model}`
}

/** 拆复合引用串；没有冒号（旧版裸模型 id）返回 null，由调用方走裸 id 兼容匹配 */
export function parseModelRef(ref: string): { provider: string; model: string } | null {
  const idx = ref.indexOf(':')
  if (idx <= 0 || idx === ref.length - 1) return null
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) }
}

/**
 * 展示用模型名：内置目录的模型 id 自带供应商前缀（'dashscope/wan2.7-image'），
 * 与供应商名并列展示时剥掉前缀，避免 '阿里云百炼 / dashscope/wan2.7-image' 的重复观感。
 */
export function shortModelLabel(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model
}

function lookup(
  providers: readonly MediaResolveProvider[],
  providerId: string,
  modelId: string,
  kind: MediaKind
): ResolvedMediaTarget | null {
  const provider = providers.find((p) => p.id === providerId)
  const model = provider?.models.find((m) => m.id === modelId)
  if (!provider || !model || model.kind !== kind) return null
  return { provider: provider.id, model: model.id, ref: toModelRef(provider.id, model.id), info: model, source: 'override' }
}

/**
 * 旧版裸模型 id（无 `provider:` 前缀）的兼容匹配：先在意向供应商里找，再跨供应商找。
 * 跨家同 id 模型以意向供应商优先消歧；找到即返回复合形态。
 */
export function matchBareModelId(
  providers: readonly MediaResolveProvider[],
  bareId: string,
  kind: MediaKind,
  preferredProvider?: string
): ResolvedMediaTarget | null {
  const pools = preferredProvider
    ? [...providers].sort((a, b) => (a.id === preferredProvider ? -1 : b.id === preferredProvider ? 1 : 0))
    : [...providers]
  for (const provider of pools) {
    const model = provider.models.find((m) => m.id === bareId && m.kind === kind)
    if (model) {
      return { provider: provider.id, model: model.id, ref: toModelRef(provider.id, model.id), info: model, source: 'configured' }
    }
  }
  return null
}

export function resolveMediaTarget(
  providers: readonly MediaResolveProvider[],
  input: MediaResolveInput
): ResolvedMediaTarget | null {
  // 1. 卡片覆盖：指定了就必须命中，失效返回 null（不静默换模型）
  const override = input.override?.trim()
  if (override) {
    const ref = parseModelRef(override)
    if (ref) return lookup(providers, ref.provider, ref.model, input.kind)
    return matchBareModelId(providers, override, input.kind, input.agentProvider)
  }

  // 2. 设置的 per-kind 默认（失效则落回默认链）
  const configured = input.agentModels?.[input.kind]?.trim()
  if (configured) {
    const ref = parseModelRef(configured)
    const hit = ref
      ? lookup(providers, ref.provider, ref.model, input.kind)
      : matchBareModelId(providers, configured, input.kind, input.agentProvider)
    if (hit) return { ...hit, source: 'configured' }
  }

  // 3. 默认供应商首个同类 → 4. 任意供应商首个同类
  const preferredId = input.agentProvider ?? DEFAULT_MEDIA_PROVIDER
  const ordered = [...providers].sort((a, b) => (a.id === preferredId ? -1 : b.id === preferredId ? 1 : 0))
  for (const provider of ordered) {
    const model = provider.models.find((m) => m.kind === input.kind)
    if (model) {
      return {
        provider: provider.id,
        model: model.id,
        ref: toModelRef(provider.id, model.id),
        info: model,
        source: provider.id === preferredId ? 'provider-default' : 'fallback'
      }
    }
  }
  return null
}
