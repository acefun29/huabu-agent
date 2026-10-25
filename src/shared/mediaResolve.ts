import { type MediaKind, type ModelCapabilities } from './media'

/**
 * 媒体模型解析的**唯一实现**（P0 收口；媒体配置强制化后不再有"首个同类"兜底）。
 *
 * 此前渲染端（settingsStore.resolveMediaModel）与主进程（ipc.resolveAgentMedia）
 * 各手写一份，语义还有分歧（阻断 vs 静默落 mock）；现在两处都调这里的纯函数，
 * 语义只有一套：
 *
 *   1. 卡片单独指定的模型（override，`provider:模型id` 复合串）——指定了就必须命中，
 *      失效（供应商被删/模型隐藏）返回 null 让调用方报错，**不静默换模型**
 *      （「界面上看到的模型就是实际在用的模型」）；
 *   2. 设置里该类媒体的默认模型（agentModels[kind]，复合串；兼容旧版裸模型 id）——
 *      必须显式选择且命中，失效返回 null，**不落回供应商首个同类模型**
 *      （选哪个模型是用户的配置任务，宿主绝不替用户挑）；
 *   3. 都没有 → null（调用方给可操作错误引导去「设置 → 媒体生成」；
 *      mock 不在这里兜底，只能显式选择）。
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
  /** override = 卡片级指定；configured = 设置里的显式默认 */
  source: 'override' | 'configured'
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

  // 2. 设置的 per-kind 默认：必须显式选择且命中；未选择/失效一律 null，
  //    不落回"供应商首个同类模型"（强制配置：选模型是用户的任务）
  const configured = input.agentModels?.[input.kind]?.trim()
  if (configured) {
    const ref = parseModelRef(configured)
    const hit = ref
      ? lookup(providers, ref.provider, ref.model, input.kind)
      : matchBareModelId(providers, configured, input.kind, input.agentProvider)
    if (hit) return { ...hit, source: 'configured' }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* 配置完成度评估（设置面板清单与首启引导共用）                                  */
/* -------------------------------------------------------------------------- */

/** 单类媒体的配置状态 */
export type MediaKindReadinessState =
  | 'ok' // 已显式选择且命中，供应商也已配置凭据
  | 'unselected' // 未选择默认模型（该类生成会被拦截）
  | 'stale' // 选择过的模型已失效（供应商被删/模型隐藏）
  | 'no-key' // 模型有效但供应商未录入凭据（提交时会被拦截）
  | 'unavailable' // 所有供应商都没有该类模型（豁免强制，但该类生成不可用）

/** 带 configured 标记的供应商（MediaProviderInfo / manager.providers() 均满足） */
export interface MediaReadinessProvider extends MediaResolveProvider {
  /** 是否已可提交（加密存储或环境变量有 Key）；缺省按未配置处理 */
  configured?: boolean
}

export interface MediaKindReadiness {
  state: MediaKindReadinessState
  /** 已选择时的复合串（ok/no-key 为有效命中；stale 为存储原值，可能已失效） */
  ref?: string
}

export interface MediaConfigReadiness {
  /** Agent 供应商选择状态（强制填写项，与三类模型并列） */
  provider: { state: 'ok' | 'unselected' | 'stale'; ref?: string }
  kinds: Record<MediaKind, MediaKindReadiness>
  /** 全部就绪：供应商已选 + 每类都 ok 或 unavailable（豁免） */
  complete: boolean
  /** 是否存在阻碍生成的未完成项（unavailable 不算——选无可选） */
  blocking: boolean
  /** 未完成的类（生成会被拦截的那几类；用于文案枚举） */
  blockingKinds: MediaKind[]
}

function hasKindModel(providers: readonly MediaReadinessProvider[], kind: MediaKind): boolean {
  return providers.some((p) => p.models.some((m) => m.kind === kind))
}

/**
 * 媒体配置完成度评估（纯函数）：不改变解析语义，只把"显式选择 + 凭据"两个维度
 * 归类成 UI 可直接渲染的状态。生成闸门本身由 resolveMediaTarget（null 即拦）
 * 与提交层凭据检查分头执行，这里只负责展示与首启引导的判定。
 */
export function assessMediaReadiness(
  providers: readonly MediaReadinessProvider[],
  input: { agentProvider?: string; agentModels?: Partial<Record<MediaKind, string>> }
): MediaConfigReadiness {
  const providerId = input.agentProvider?.trim() ?? ''
  const providerState = !providerId
    ? 'unselected'
    : providers.some((p) => p.id === providerId)
      ? 'ok'
      : 'stale'

  const kinds = {} as Record<MediaKind, MediaKindReadiness>
  const blockingKinds: MediaKind[] = []
  let complete = providerState === 'ok'
  for (const kind of ['image', 'video', 'audio'] as const) {
    const stored = input.agentModels?.[kind]?.trim() ?? ''
    let readiness: MediaKindReadiness
    if (!stored) {
      readiness = { state: hasKindModel(providers, kind) ? 'unselected' : 'unavailable' }
    } else {
      const ref = parseModelRef(stored)
      const hit = ref
        ? lookup(providers, ref.provider, ref.model, kind)
        : matchBareModelId(providers, stored, kind, providerId || undefined)
      if (!hit) {
        readiness = { state: 'stale', ref: stored }
      } else {
        const configured = providers.find((p) => p.id === hit.provider)?.configured
        readiness = configured ? { state: 'ok', ref: hit.ref } : { state: 'no-key', ref: hit.ref }
      }
    }
    kinds[kind] = readiness
    // unavailable 豁免：选无可选不算未完成；no-key 算未完成（清单单独标红，与提交层拦截一致）
    if (readiness.state !== 'ok' && readiness.state !== 'unavailable') blockingKinds.push(kind)
    if (readiness.state !== 'ok' && readiness.state !== 'unavailable') complete = false
  }

  return {
    provider: providerState === 'ok' ? { state: 'ok', ref: providerId } : { state: providerState },
    kinds,
    complete,
    blocking: blockingKinds.length > 0 || providerState !== 'ok',
    blockingKinds
  }
}
