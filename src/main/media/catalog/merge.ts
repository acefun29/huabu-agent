import type { MediaKind, MediaProviderType, MediaRatio, ModelCapabilities } from '../../../shared/media'
import { MEDIA_RATIOS } from '../../../shared/media'
import { adapterDefaultAuthEnv, isRegisteredAdapterType } from '../adapters/registry'
import type { AdapterModelConfig, AdapterProviderConfig } from '../adapters/registry'
import type { BuiltinProviderDef } from './types'
import type { MediaModelOverride, WorkspaceMediaProviderConfig } from '../../workspace/store'

/**
 * 合并层：内置目录（代码数据）+ 用户覆盖层（workspace.json）→ 生效供应商清单。
 *
 * 这是**唯一的**清单来源：media:providers、settings:media-status、Agent 工具解析
 * 全部从这里取数（§5）。workspace.json 只存增量：
 *   - userProviders   用户自建供应商（原 providers 字段的语义，字段名迁移见 store.ts）
 *   - hiddenBuiltin   被用户隐藏的内置模型 id
 *   - modelOverrides  对内置模型的展示名等覆盖
 * 两层永不互相写脏：内置清单改动不碰用户文件，用户覆盖不进代码。
 */

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/i
const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video', 'audio']

/** id 格式约定的唯一声明处（设置页新增供应商/模型的输入校验与清洗共用） */
export { PROVIDER_ID_PATTERN, MODEL_ID_PATTERN }

/** mergeCatalog 需要的覆盖层字段（WorkspaceMediaConfig 的 media 相关子集） */
export interface CatalogUserConfig {
  userProviders?: WorkspaceMediaProviderConfig[]
  hiddenBuiltin?: string[]
  modelOverrides?: Record<string, MediaModelOverride>
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把内置目录与用户覆盖层合并成生效清单。
 *
 * 合并语义（§3.4）：用户供应商与内置供应商共用一个 id 命名空间——
 * 用户配置里出现同名 id 视为**覆盖该内置供应商的模型子集**（同 id 模型覆盖，
 * 新模型追加，凭据/展示名以用户配置优先）；异 id 直接追加。
 */
export function mergeCatalog(builtin: readonly BuiltinProviderDef[], userConfig: CatalogUserConfig): AdapterProviderConfig[] {
  const hidden = new Set(userConfig.hiddenBuiltin ?? [])
  const overrides = userConfig.modelOverrides ?? {}
  const effective = new Map<string, AdapterProviderConfig>()

  for (const def of builtin) {
    const models: AdapterModelConfig[] = []
    for (const model of def.models) {
      // hiddenBuiltin 是用户主动隐藏；deprecated 不出现在新建入口（老任务回放不依赖清单）
      if (hidden.has(model.id) || model.status === 'deprecated') continue
      const override = overrides[model.id]
      models.push({
        id: model.id,
        kind: model.kind,
        label: override?.label ?? model.label,
        requestModel: model.remoteModel ?? defaultRemoteModel(def.id, model.id),
        ...(model.costHint ? { costHint: model.costHint } : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
        ...(model.status ? { status: model.status } : {}),
        ...resultKeyHint(model)
      })
    }
    effective.set(def.id, {
      id: def.id,
      type: def.adapter,
      label: def.label,
      source: 'builtin',
      authKey: def.auth.key ?? def.id,
      authEnv: def.auth.env,
      models
    })
  }

  userConfig.userProviders?.forEach((user, index) => {
    const sanitized = sanitizeUserProvider(user, index)
    if (!sanitized) return
    const userLabel = sanitized.label ?? sanitized.id
    const userAuthKey = sanitized.authKey ?? sanitized.id
    const existing = effective.get(sanitized.id)
    if (existing && existing.source === 'builtin') {
      // 同名覆盖：用户的模型子集并入内置供应商（凭据与展示名以用户配置优先）
      if (sanitized.type !== existing.type) {
        warn('media.userProviders', `供应商 ${sanitized.id} 与内置目录的适配器类型不一致（${sanitized.type} ≠ ${existing.type}），类型以内置目录为准`)
      }
      if (sanitized.label !== undefined) existing.label = userLabel
      existing.authKey = userAuthKey
      if (sanitized.authEnv) existing.authEnv = sanitized.authEnv
      if (sanitized.baseUrl) existing.baseUrl = sanitized.baseUrl
      if (sanitized.authStyle) existing.authStyle = sanitized.authStyle
      const byId = new Map(existing.models.map((m) => [m.id, m]))
      for (const [modelId, modelDef] of Object.entries(sanitized.models)) {
        byId.set(modelId, userModelToAdapterConfig(modelId, modelDef))
      }
      existing.models = [...byId.values()]
    } else {
      effective.set(sanitized.id, {
        id: sanitized.id,
        type: sanitized.type,
        label: userLabel,
        source: 'user',
        authKey: userAuthKey,
        // 环境变量回退名：用户配置 > 适配器声明（如 gateway-fal → FAL_KEY）
        ...(sanitized.authEnv ?? adapterDefaultAuthEnv(sanitized.type)
          ? { authEnv: sanitized.authEnv ?? adapterDefaultAuthEnv(sanitized.type) }
          : {}),
        ...(sanitized.baseUrl ? { baseUrl: sanitized.baseUrl } : {}),
        ...(sanitized.authStyle ? { authStyle: sanitized.authStyle } : {}),
        models: Object.entries(sanitized.models).map(([modelId, modelDef]) =>
          userModelToAdapterConfig(modelId, modelDef)
        )
      })
    }
  })

  return [...effective.values()]
}

function userModelToAdapterConfig(
  modelId: string,
  modelDef: { kind: MediaKind; label?: string; resultKey?: string; capabilities?: ModelCapabilities; costHint?: string }
): AdapterModelConfig {
  return {
    id: modelId,
    kind: modelDef.kind,
    ...(modelDef.label ? { label: modelDef.label } : {}),
    ...(modelDef.resultKey ? { resultKey: modelDef.resultKey } : {}),
    ...(modelDef.capabilities ? { capabilities: modelDef.capabilities } : {}),
    ...(modelDef.costHint ? { costHint: modelDef.costHint } : {})
  }
}

/**
 * 清洗用户模型条目的 capabilities（workspace.json / media:user-add-model 共用）：
 * 比例过滤到 MEDIA_RATIOS union；时长只收正有限数、去重升序；maxRefImages 正整数；
 * voices/extraParams 逐条校验形态。不认识的字段丢弃，坏字段 warn 后丢弃该字段而不是整条模型。
 */
export function sanitizeCapabilities(raw: unknown, where = 'capabilities'): ModelCapabilities | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) {
    warn(where, `capabilities 不是对象，已忽略`)
    return undefined
  }
  const out: ModelCapabilities = {}
  if (raw.ratios !== undefined) {
    if (Array.isArray(raw.ratios)) {
      const ratios = [...new Set(raw.ratios.filter((r): r is MediaRatio => MEDIA_RATIOS.includes(r as MediaRatio)))]
      if (ratios.length > 0) out.ratios = ratios
      else warn(where, 'ratios 没有合法比例（1:1/3:4/4:3/9:16/16:9），已忽略')
    } else warn(where, 'ratios 不是数组，已忽略')
  }
  if (raw.durations !== undefined) {
    if (Array.isArray(raw.durations)) {
      const durations = [...new Set(raw.durations.filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d > 0))].sort(
        (a, b) => a - b
      )
      if (durations.length > 0) out.durations = durations
      else warn(where, 'durations 没有正数档位，已忽略')
    } else warn(where, 'durations 不是数组，已忽略')
  }
  if (raw.maxRefImages !== undefined) {
    if (typeof raw.maxRefImages === 'number' && Number.isInteger(raw.maxRefImages) && raw.maxRefImages > 0) {
      out.maxRefImages = raw.maxRefImages
    } else warn(where, `maxRefImages 不是正整数（${JSON.stringify(raw.maxRefImages)}），已忽略`)
  }
  if (raw.voices !== undefined) {
    if (Array.isArray(raw.voices)) {
      const voices = raw.voices.filter(
        (v): v is { id: string; label: string } => isPlainObject(v) && isNonEmptyString(v.id) && isNonEmptyString(v.label)
      )
      if (voices.length > 0) out.voices = voices
    } else warn(where, 'voices 不是数组，已忽略')
  }
  if (raw.extraParams !== undefined) {
    if (Array.isArray(raw.extraParams)) {
      type ExtraParam = NonNullable<ModelCapabilities['extraParams']>[number]
      const extraParams = (raw.extraParams as unknown[])
        .filter(
          (p): p is ExtraParam =>
            isPlainObject(p) &&
            isNonEmptyString(p.key) &&
            isNonEmptyString(p.label) &&
            (p.type === 'select' || p.type === 'number' || p.type === 'text')
        )
        .map((p) => ({
          key: p.key,
          label: p.label,
          type: p.type,
          ...(Array.isArray(p.options) ? { options: p.options.filter(isNonEmptyString) } : {}),
          ...(p.default !== undefined ? { default: p.default } : {})
        }))
      if (extraParams.length > 0) out.extraParams = extraParams
    } else warn(where, 'extraParams 不是数组，已忽略')
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function defaultRemoteModel(providerId: string, modelId: string): string {
  return modelId.startsWith(`${providerId}/`) ? modelId.slice(providerId.length + 1) : modelId
}

function resultKeyHint(model: { adapterHints?: Record<string, unknown> }): { resultKey?: string } {
  const hint = model.adapterHints?.resultKey
  return typeof hint === 'string' && hint.trim() ? { resultKey: hint.trim() } : {}
}

/**
 * 清洗单个用户供应商条目（workspace.json userProviders 形态）：坏配置报
 * 「哪条模型哪个字段错了」并丢弃该条，绝不让一个坏条目炸掉整个清单链路（§5）。
 * 返回 null 表示整个条目无效。
 */
export function sanitizeUserProvider(raw: unknown, index = 0): WorkspaceMediaProviderConfig | null {
  const where = `media.userProviders[${index}]`
  if (!isPlainObject(raw)) {
    warn(where, '不是对象，已丢弃')
    return null
  }
  if (!isNonEmptyString(raw.id) || !PROVIDER_ID_PATTERN.test(raw.id.trim())) {
    warn(where, `id 不合法（${JSON.stringify(raw.id)}）：只允许字母/数字/点/横线/下划线，已丢弃`)
    return null
  }
  const providerId = raw.id.trim()
  const rawType = raw.type
  if (typeof rawType !== 'string' || rawType === 'mock' || !isRegisteredAdapterType(rawType)) {
    warn(
      where,
      `type 不合法（${JSON.stringify(rawType)}）：必须是已实现的适配器类型（gateway-fal 等），已丢弃供应商 ${providerId}`
    )
    return null
  }
  const type = rawType as Exclude<MediaProviderType, 'mock'>
  if (!isPlainObject(raw.models)) {
    warn(where, `供应商 ${providerId} 缺少 models 对象（形如 { "fal-ai/xxx": { "kind": "image" } }），已丢弃`)
    return null
  }
  const models: WorkspaceMediaProviderConfig['models'] = {}
  for (const [modelId, modelDef] of Object.entries(raw.models)) {
    const modelWhere = `${where}.models["${modelId}"]`
    if (!isNonEmptyString(modelId) || !MODEL_ID_PATTERN.test(modelId)) {
      warn(modelWhere, '模型 id 不合法（只允许字母/数字/点/横线/下划线/斜杠），已丢弃该模型')
      continue
    }
    if (!isPlainObject(modelDef)) {
      warn(modelWhere, '不是对象（应为 { kind, label?, resultKey? }），已丢弃该模型')
      continue
    }
    if (!MEDIA_KINDS.includes(modelDef.kind as MediaKind)) {
      warn(modelWhere, `kind 不合法（${JSON.stringify(modelDef.kind)}）：需要 image|video|audio，已丢弃该模型`)
      continue
    }
    if (modelDef.label !== undefined && modelDef.label !== '' && !isNonEmptyString(modelDef.label)) {
      warn(modelWhere, `label 不是字符串（${JSON.stringify(modelDef.label)}），已忽略 label`)
    }
    if (modelDef.resultKey !== undefined && !isNonEmptyString(modelDef.resultKey)) {
      warn(modelWhere, `resultKey 不是非空字符串（${JSON.stringify(modelDef.resultKey)}），已忽略 resultKey`)
    }
    if (modelDef.costHint !== undefined && !isNonEmptyString(modelDef.costHint)) {
      warn(modelWhere, `costHint 不是非空字符串（${JSON.stringify(modelDef.costHint)}），已忽略 costHint`)
    }
    const capabilities = sanitizeCapabilities(modelDef.capabilities, `${modelWhere}.capabilities`)
    models[modelId] = {
      kind: modelDef.kind as MediaKind,
      ...(isNonEmptyString(modelDef.label) ? { label: modelDef.label.trim() } : {}),
      ...(isNonEmptyString(modelDef.resultKey) ? { resultKey: modelDef.resultKey.trim() } : {}),
      ...(isNonEmptyString(modelDef.costHint) ? { costHint: modelDef.costHint.trim() } : {}),
      ...(capabilities ? { capabilities } : {})
    }
  }
  if (Object.keys(models).length === 0) {
    warn(where, `供应商 ${providerId} 没有任何合法模型，已丢弃`)
    return null
  }
  // baseUrl（gateway-openai-compat 等协议家族用）：只收 http(s) 绝对地址；
  // authStyle（通用协议认证头风格）：只收 bearer | x-api-key
  let baseUrl: string | undefined
  if (raw.baseUrl !== undefined && raw.baseUrl !== null && raw.baseUrl !== '') {
    if (typeof raw.baseUrl !== 'string' || !/^https?:\/\//.test(raw.baseUrl.trim())) {
      warn(where, `baseUrl 不是 http(s) 绝对地址（${JSON.stringify(raw.baseUrl)}），已忽略`)
    } else {
      baseUrl = raw.baseUrl.trim().replace(/\/+$/, '')
    }
  }
  const authStyle = raw.authStyle === 'bearer' || raw.authStyle === 'x-api-key' ? raw.authStyle : undefined
  return {
    id: providerId,
    type,
    ...(isNonEmptyString(raw.label) ? { label: raw.label.trim() } : {}),
    authKey: isNonEmptyString(raw.authKey) ? raw.authKey.trim() : providerId,
    ...(isNonEmptyString(raw.authEnv) ? { authEnv: raw.authEnv.trim() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(authStyle ? { authStyle } : {}),
    models
  }
}

/** 清洗整个 userProviders 数组：非数组/坏条目按条丢弃并给出可定位的警告 */
export function sanitizeUserProviders(raw: unknown): WorkspaceMediaProviderConfig[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    warn('media.userProviders', `必须是数组，实际是 ${typeName(raw)}；全部用户供应商已丢弃`)
    return []
  }
  const out: WorkspaceMediaProviderConfig[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const sanitized = sanitizeUserProvider(entry, index)
    if (!sanitized) return
    if (seen.has(sanitized.id)) {
      warn(`media.userProviders[${index}]`, `供应商 id 重复（${sanitized.id}），后出现的条目已丢弃`)
      return
    }
    seen.add(sanitized.id)
    out.push(sanitized)
  })
  return out
}

/** 清洗 hiddenBuiltin：去重、只留非空字符串 */
export function sanitizeHiddenBuiltin(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warn('media.hiddenBuiltin', `必须是数组，实际是 ${typeName(raw)}；已忽略`)
    return []
  }
  return [...new Set(raw.filter(isNonEmptyString).map((id) => id.trim()))]
}

/** 清洗 modelOverrides：只留 { label?: string } 形态的条目 */
export function sanitizeModelOverrides(raw: unknown): Record<string, MediaModelOverride> {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) {
    warn('media.modelOverrides', `必须是对象，实际是 ${typeName(raw)}；已忽略`)
    return {}
  }
  const out: Record<string, MediaModelOverride> = {}
  for (const [modelId, override] of Object.entries(raw)) {
    if (!isNonEmptyString(modelId) || !isPlainObject(override)) {
      warn(`media.modelOverrides["${modelId}"]`, '覆盖条目不合法（应为 { label?: string }），已忽略')
      continue
    }
    const clean: MediaModelOverride = {}
    if (isNonEmptyString(override.label)) clean.label = override.label.trim()
    if (Object.keys(clean).length > 0) out[modelId] = clean
  }
  return out
}

function warn(where: string, message: string): void {
  console.warn(`[media-catalog] ${where}：${message}`)
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
