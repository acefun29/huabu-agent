/** 媒体供应商、模型、凭据和生成默认值的 IPC 入口。 */
import { resolve, sep } from 'path'
import { ipcMain } from './ipcMainBridge'
import { adapterSupportedKinds, getAdapterKindMatrix, isRegisteredAdapterType } from '../media/adapters'
import {
  BUILTIN_PROVIDERS,
  browseCatalog,
  mergeCatalog,
  MODEL_ID_PATTERN,
  PROVIDER_ID_PATTERN,
  sanitizeCapabilities,
  sanitizeUserProvider
} from '../media/catalog'
import { MEDIA_ROOT_REL } from '../../shared/assets'
import { IpcChannel } from '../../shared/ipc'
import type {
  ChatResult,
  MediaConfigPatch,
  MediaProviderStatus,
  MediaSettingsStatus,
  MediaUserModelInput,
  MediaUserProviderInput
} from '../../shared/ipc'
import { DEFAULT_MEDIA_CONCURRENCY, DEFAULT_MEDIA_DURATION_S, DEFAULT_MEDIA_RATIO, MEDIA_RATIOS } from '../../shared/media'
import type { MediaKind } from '../../shared/media'
import { resolveMediaTarget } from '../../shared/mediaResolve'
import type { IpcContext } from './shared'
import { describe, guardSync, invalidPayload, isNonEmptyString, ok } from './shared'

export function registerMediaSettingsIpc(ctx: IpcContext): void {
  const { store, models, currentDir } = ctx

  ipcMain.handle(IpcChannel.SettingsMediaStatus, async (): Promise<ChatResult<MediaSettingsStatus>> => {
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      const config = store.mediaConfig()
      const effective = mergeCatalog(BUILTIN_PROVIDERS, config)
      const providers: MediaProviderStatus[] = []
      for (const entry of effective) {
        const hasStored = await models.hasMediaKey(dir, entry.authKey)
        const keySource: MediaProviderStatus['keySource'] = hasStored
          ? 'workspace-store'
          : entry.authEnv && process.env[entry.authEnv]
            ? 'environment'
            : 'none'
        providers.push({
          id: entry.id,
          label: entry.label,
          type: entry.type,
          source: entry.source,
          modelCount: entry.models.length,
          keySource
        })
      }
      return {
        ok: true,
        value: {
          confirmVideo: config.confirmVideo ?? true,
          accessMode: config.accessMode ?? 'full',
          providers,
          config: {
            // 不再兜底 DEFAULT_MEDIA_PROVIDER：未设置就如实缺省，UI 显示"请选择供应商"
            //（媒体配置强制化后，"看起来已配置"的假象比缺配置更误事）
            ...(config.agentProvider ? { agentProvider: config.agentProvider } : {}),
            agentModels: config.agentModels ?? {},
            outputDir: config.outputDir ?? MEDIA_ROOT_REL,
            concurrency: normalizeConcurrency(config.concurrency),
            defaultRatio: config.defaultRatio ?? DEFAULT_MEDIA_RATIO,
            defaultDuration: config.defaultDuration ?? DEFAULT_MEDIA_DURATION_S,
            ...(config.defaultLibraryId ? { defaultLibraryId: config.defaultLibraryId } : {}),
            ...(config.kindLibraryDefaults ? { kindLibraryDefaults: config.kindLibraryDefaults } : {}),
            ...(config.hiddenBuiltin?.length ? { hiddenBuiltin: config.hiddenBuiltin } : {})
          }
        }
      }
    } catch (error) {
      return { ok: false, code: 'unknown', error: describe(error) }
    }
  })

  function normalizeConcurrency(value: unknown): number {
    return typeof value === 'number' && value >= 1 && value <= 8 ? Math.round(value) : DEFAULT_MEDIA_CONCURRENCY
  }

  ipcMain.handle(IpcChannel.MediaSetConfig, (_event, payload: unknown) => {
    const patch = (payload ?? {}) as MediaConfigPatch
    if (typeof patch !== 'object' || patch === null) return invalidPayload('media:set-config 需要配置对象')
    const clean: Record<string, unknown> = {}
    // agentProvider / agentModels 做存在性校验（强制配置的写入口）：指向不存在的
    // 供应商/模型的配置宁可不落盘，也不能让"配置好了"的假象流进解析链
    if (isNonEmptyString(patch.agentProvider)) {
      if (!mergeCatalog(BUILTIN_PROVIDERS, store.mediaConfig()).some((p) => p.id === patch.agentProvider)) {
        return invalidPayload(`media:set-config 的 agentProvider 不在供应商清单里：${patch.agentProvider}`)
      }
      clean.agentProvider = patch.agentProvider
    }
    if (patch.agentModels && typeof patch.agentModels === 'object') {
      const catalog = mergeCatalog(BUILTIN_PROVIDERS, store.mediaConfig())
      const models: Record<string, string> = {}
      for (const kind of ['image', 'video', 'audio'] as const) {
        const value = patch.agentModels[kind]
        if (!isNonEmptyString(value)) continue
        // 复用解析链校验（复合串/旧裸 id 都能命中，kind 匹配一并检查），落盘统一规范化为复合串
        const hit = resolveMediaTarget(catalog, { kind, agentModels: { [kind]: value } })
        if (!hit) {
          return invalidPayload(`media:set-config 的 agentModels.${kind} 不指向任何可用模型：${value}`)
        }
        models[kind] = hit.ref
      }
      clean.agentModels = models
    }
    if (patch.outputDir !== undefined) {
      if (!isNonEmptyString(patch.outputDir)) {
        clean.outputDir = MEDIA_ROOT_REL
      } else {
        const normalized = patch.outputDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const resolved = resolve(currentDir() ?? '', normalized)
        const base = resolve(currentDir() ?? '')
        if (!normalized || resolved === base || !resolved.startsWith(base + sep)) {
          return invalidPayload('media:set-config 的 outputDir 必须是工作区内的相对路径')
        }
        clean.outputDir = normalized
      }
    }
    if (patch.concurrency !== undefined) {
      if (typeof patch.concurrency !== 'number' || patch.concurrency < 1 || patch.concurrency > 8) {
        return invalidPayload('media:set-config 的 concurrency 需在 1..8')
      }
      clean.concurrency = Math.round(patch.concurrency)
    }
    if (patch.defaultRatio !== undefined) {
      if (!(MEDIA_RATIOS as readonly string[]).includes(patch.defaultRatio)) {
        return invalidPayload('media:set-config 的 defaultRatio 不合法')
      }
      clean.defaultRatio = patch.defaultRatio
    }
    if (patch.defaultDuration !== undefined) {
      if (typeof patch.defaultDuration !== 'number' || patch.defaultDuration < 1 || patch.defaultDuration > 60) {
        return invalidPayload('media:set-config 的 defaultDuration 需在 1..60 秒')
      }
      clean.defaultDuration = Math.round(patch.defaultDuration)
    }
    if (typeof patch.confirmVideo === 'boolean') clean.confirmVideo = patch.confirmVideo
    if (patch.defaultLibraryId !== undefined) {
      // 空串清除；特殊值 builtin-assets（画布素材）/ none（仅产物目录）；
      // 其余必须是现存素材库 id（防拼出指向不存在库的僵尸默认）
      if (!isNonEmptyString(patch.defaultLibraryId)) {
        clean.defaultLibraryId = ''
      } else if (
        patch.defaultLibraryId !== 'builtin-assets' &&
        patch.defaultLibraryId !== 'none' &&
        !store.getLibraries().some((l) => l.id === patch.defaultLibraryId)
      ) {
        return invalidPayload('media:set-config 的 defaultLibraryId 不是现存素材库')
      } else {
        clean.defaultLibraryId = patch.defaultLibraryId
      }
    }
    if (patch.kindLibraryDefaults !== undefined) {
      const known = new Set(store.getLibraries().map((l) => l.id))
      known.add('builtin-assets')
      known.add('none')
      const defaults: Record<string, string> = {}
      for (const kind of ['image', 'video', 'audio'] as const) {
        const value = patch.kindLibraryDefaults[kind]
        if (!isNonEmptyString(value)) continue
        if (!known.has(value)) return invalidPayload(`media:set-config 的 kindLibraryDefaults.${kind} 不是现存素材库`)
        defaults[kind] = value
      }
      clean.kindLibraryDefaults = defaults
    }
    return guardSync(() => {
      // 空串 defaultLibraryId = 清除语义：setMediaConfig 是 merge，undefined 覆盖后
      // JSON.stringify 会丢掉该键，达到删除效果
      if (clean.defaultLibraryId === '') {
        store.setMediaConfig({ defaultLibraryId: undefined })
        delete clean.defaultLibraryId
      }
      return store.setMediaConfig(clean)
    })
  })

  // ------------------------------------------------ media 域：用户供应商/模型管理（写 workspace.json 覆盖层）

  /**
   * 校验+清洗用的小工具：kind 只认三类媒体。这里的校验刻意与 merge.ts 的清洗
   * 同源（PROVIDER/MODEL_ID_PATTERN），用户输入错误给可读的错误文本。
   */
  const asMediaKind = (value: unknown): 'image' | 'video' | 'audio' | null =>
    value === 'image' || value === 'video' || value === 'audio' ? value : null

  ipcMain.handle(IpcChannel.MediaUserAddProvider, (_event, payload: unknown) => {
    const request = payload as Partial<MediaUserProviderInput> | null
    const rawId = request?.id
    if (!isNonEmptyString(rawId) || !PROVIDER_ID_PATTERN.test(rawId.trim())) {
      return invalidPayload('供应商 id 不合法（只允许字母/数字/点/横线/下划线）')
    }
    const providerId = rawId.trim()
    const type = request?.type
    if (typeof type !== 'string' || !isRegisteredAdapterType(type)) {
      return invalidPayload('type 必须是已实现的适配器类型（如 gateway-openai-compat）')
    }
    const first = request?.firstModel
    const firstModelId = first?.id
    if (!isNonEmptyString(firstModelId) || !MODEL_ID_PATTERN.test(firstModelId.trim())) {
      return invalidPayload('首个模型 id 不合法（只允许字母/数字/点/横线/下划线/斜杠）')
    }
    const firstKind = asMediaKind(first?.kind)
    if (!firstKind) return invalidPayload('firstModel.kind 需要 image|video|audio')
    const supported = adapterSupportedKinds(type)
    if (!supported.includes(firstKind)) {
      return invalidPayload(`接入类型 ${type} 只有 ${supported.join('/')} 端点，不支持 ${firstKind} 模型`)
    }
    const label = isNonEmptyString(request?.label) ? request.label : undefined
    const baseUrl = isNonEmptyString(request?.baseUrl) ? request.baseUrl : undefined
    const authEnv = isNonEmptyString(request?.authEnv) ? request.authEnv : undefined
    const authStyle = request?.authStyle === 'bearer' || request?.authStyle === 'x-api-key' ? request.authStyle : undefined
    const firstLabel = isNonEmptyString(first?.label) ? first.label : undefined
    // capabilities/costHint 与 MediaUserAddModel 同一清洗口径（sanitizeCapabilities 同源）
    const firstCapabilities = sanitizeCapabilities(first?.capabilities)
    const firstCostHint = isNonEmptyString(first?.costHint) ? first.costHint.trim() : undefined
    return guardSync(() => {
      const config = store.mediaConfig()
      if ((config.userProviders ?? []).some((p) => p.id === providerId)) {
        throw new Error(`用户供应商 ${providerId} 已存在；如需替换请先删除`)
      }
      // 结构化后仍过一遍 sanitize（baseUrl 等形态兜底；关键字段已手校，不会触发 warn）
      const sanitized = sanitizeUserProvider({
        id: providerId,
        type,
        ...(label ? { label } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(authEnv ? { authEnv } : {}),
        ...(authStyle ? { authStyle } : {}),
        models: {
          [firstModelId.trim()]: {
            kind: firstKind,
            ...(firstLabel ? { label: firstLabel } : {}),
            ...(firstCostHint ? { costHint: firstCostHint } : {}),
            ...(firstCapabilities ? { capabilities: firstCapabilities } : {})
          }
        }
      })
      if (!sanitized) throw new Error('供应商配置不合法，已拦截')
      return store.setMediaConfig({ userProviders: [...(config.userProviders ?? []), sanitized] })
    })
  })

  ipcMain.handle(IpcChannel.MediaUserRemoveProvider, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    return guardSync(() => {
      const config = store.mediaConfig()
      const existing = config.userProviders ?? []
      const next = existing.filter((p) => p.id !== providerId)
      if (next.length === existing.length) {
        throw new Error(`没有用户供应商 ${providerId}（内置供应商不能删除，只能移除它的模型）`)
      }
      return store.setMediaConfig({ userProviders: next })
    })
  })

  ipcMain.handle(IpcChannel.MediaUserAddModel, (_event, payload: unknown) => {
    const request = payload as Partial<MediaUserModelInput> | null
    const providerId = request?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    const rawModelId = request?.id
    if (!isNonEmptyString(rawModelId) || !MODEL_ID_PATTERN.test(rawModelId.trim())) {
      return invalidPayload('模型 id 不合法（只允许字母/数字/点/横线/下划线/斜杠）')
    }
    const modelId = rawModelId.trim()
    const kind = asMediaKind(request?.kind)
    if (!kind) return invalidPayload('kind 需要 image|video|audio')
    const label = isNonEmptyString(request?.label) ? request.label : undefined
    const costHint = isNonEmptyString(request?.costHint) ? request.costHint.trim() : undefined
    const capabilities = sanitizeCapabilities(request?.capabilities)
    return guardSync(() => {
      const config = store.mediaConfig()
      const effective = mergeCatalog(BUILTIN_PROVIDERS, config)
      const provider = effective.find((p) => p.id === providerId)
      if (!provider) throw new Error(`供应商不存在：${providerId}`)
      const supported = adapterSupportedKinds(provider.type)
      if (!supported.includes(kind)) {
        throw new Error(`${providerId} 的接入类型 ${provider.type} 只有 ${supported.join('/')} 端点，不支持 ${kind} 模型`)
      }
      // 查重要同时比对稳定 id 与网关标识：用户在内置供应商下手输裸 slug
      // （如 'wan2.7-image'）与内置带前缀 id（'dashscope/wan2.7-image'）发给网关的是
      // 同一个标识，直接放行会在适配器模型表里撞键、静默顶掉内置模型条目
      const bareId = modelId.startsWith(`${providerId}/`) ? modelId.slice(providerId.length + 1) : modelId
      const conflict = provider.models.find(
        (m) => m.id === modelId || m.id === bareId || m.requestModel === modelId || m.requestModel === bareId
      )
      if (conflict) {
        throw new Error(`已有同网关标识的模型：${conflict.id}（发给网关的标识都是 ${conflict.requestModel ?? conflict.id}）`)
      }
      const modelDef = {
        kind,
        ...(label ? { label } : {}),
        ...(costHint ? { costHint } : {}),
        ...(capabilities ? { capabilities } : {})
      }
      const userProviders = [...(config.userProviders ?? [])]
      const entryIndex = userProviders.findIndex((p) => p.id === providerId)
      if (entryIndex >= 0) {
        userProviders[entryIndex] = {
          ...userProviders[entryIndex],
          models: { ...userProviders[entryIndex].models, [modelId]: modelDef }
        }
      } else {
        // 内置供应商：经同名用户条目追加模型（type 跟随内置目录，合并层语义即覆盖子集）
        userProviders.push({
          id: providerId,
          type: provider.type,
          models: { [modelId]: modelDef }
        })
      }
      return store.setMediaConfig({ userProviders })
    })
  })

  ipcMain.handle(IpcChannel.MediaUserRemoveModel, (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; modelId?: unknown } | null
    const providerId = request?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    const modelId = request?.modelId
    if (!isNonEmptyString(modelId)) return invalidPayload('需要 modelId')
    return guardSync(() => {
      const config = store.mediaConfig()
      const effective = mergeCatalog(BUILTIN_PROVIDERS, config)
      const provider = effective.find((p) => p.id === providerId)
      if (!provider?.models.some((m) => m.id === modelId)) {
        throw new Error(`${providerId} 下没有模型 ${modelId}`)
      }
      // 用户配置里的同 id 模型删除；模型被删光的用户供应商整个清掉
      const userProviders = (config.userProviders ?? [])
        .map((p) => {
          if (p.id !== providerId || !(modelId in p.models)) return p
          const models = { ...p.models }
          delete models[modelId]
          return { ...p, models }
        })
        .filter((p) => Object.keys(p.models).length > 0)
      const patch: Record<string, unknown> = { userProviders }
      // 同时是内置模型 → 进隐藏清单（不删除目录条目，恢复随时可做）
      const isBuiltin = BUILTIN_PROVIDERS.some(
        (p) => p.id === providerId && p.models.some((m) => m.id === modelId)
      )
      if (isBuiltin) {
        patch.hiddenBuiltin = [...new Set([...(config.hiddenBuiltin ?? []), modelId])]
      }
      return store.setMediaConfig(patch)
    })
  })

  ipcMain.handle(IpcChannel.MediaUserRestoreModel, (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; modelId?: unknown } | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    const modelId = request?.modelId
    if (!isNonEmptyString(modelId)) return invalidPayload('需要 modelId')
    return guardSync(() => {
      const config = store.mediaConfig()
      const hiddenBuiltin = (config.hiddenBuiltin ?? []).filter((id) => id !== modelId)
      return store.setMediaConfig({ hiddenBuiltin })
    })
  })

  /**
   * 浏览供应商的全量模型目录（随应用打包的只读数据，见 catalog/browse.ts）。
   * enabled 标注按生效清单计算：条目 id（即发给网关的 endpoint）命中任一
   * 生效模型的 id 或 requestModel 即视为已添加；没有目录的供应商返回空数组。
   */
  ipcMain.handle(IpcChannel.MediaBrowseCatalog, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    return guardSync(() => {
      const source = browseCatalog(providerId.trim())
      if (source.length === 0) return []
      const config = store.mediaConfig()
      const effective = mergeCatalog(BUILTIN_PROVIDERS, config)
      const provider = effective.find((p) => p.id === providerId.trim())
      const enabledKeys = new Set<string>()
      for (const m of provider?.models ?? []) {
        enabledKeys.add(m.id)
        if (m.requestModel) enabledKeys.add(m.requestModel)
      }
      return source.map((item) => ({ ...item, enabled: enabledKeys.has(item.id) }))
    })
  })

  ipcMain.handle(IpcChannel.MediaAdapterKinds, () => {
    // 注册表运行时事实来源（kind 越界配置在清洗层/上面的 add handler 已被拦截）
    return { ok: true, value: getAdapterKindMatrix() } satisfies ChatResult<Record<string, MediaKind[]>>
  })

  /**
   * 凭据存储键 = 生效清单里该供应商的 authKey（workspace.json 可覆盖；内置目录缺省
   * 同 id）。按 providerId 直存会和读取路径 media:<authKey> 错位——手改过 authKey 的
   * 工作区会出现「Key 保存成功但一直报缺凭据」。查不到条目时回落 providerId。
   */
  const authKeyOf = (providerId: string): string => {
    try {
      return mergeCatalog(BUILTIN_PROVIDERS, store.mediaConfig()).find((p) => p.id === providerId)?.authKey ?? providerId
    } catch {
      return providerId
    }
  }

  ipcMain.handle(IpcChannel.SettingsMediaSetKey, async (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; apiKey?: unknown } | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.apiKey)) return invalidPayload('需要 apiKey')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      await models.setMediaKey(dir, authKeyOf(request.providerId), request.apiKey)
      return ok()
    } catch (error) {
      return { ok: false, code: 'unknown', error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsMediaRemoveKey, async (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      await models.removeMediaKey(dir, authKeyOf(providerId))
      return ok()
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.MediaSetConfirmVideo, (_event, payload: unknown) => {
    const confirm = (payload as { confirm?: unknown } | null)?.confirm
    if (typeof confirm !== 'boolean') return invalidPayload('media:set-confirm-video 需要 confirm:boolean')
    return guardSync(() => store.setMediaConfig({ confirmVideo: confirm }))
  })

  ipcMain.handle(IpcChannel.MediaSetAccessMode, (_event, payload: unknown) => {
    const mode = (payload as { mode?: unknown } | null)?.mode
    if (mode !== 'full' && mode !== 'confirm') {
      return invalidPayload('media:set-access-mode 需要 mode=full|confirm')
    }
    return guardSync(() => {
      store.setMediaConfig({ accessMode: mode as 'full' | 'confirm' })
      return undefined
    })
  })

}
