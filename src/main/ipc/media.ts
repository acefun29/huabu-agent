/**
 * media 域 IPC（M11/M12 生成与导入；M13 确认闸门）。
 *
 * 覆盖通道：
 * - 确认闸门：media:confirm-resolve（回执；请求经 requestMediaApproval 发 media:confirm-request）
 * - 状态/配置：settings:media-status / media:set-config / media:set-confirm-video /
 *   media:set-access-mode
 * - 用户供应商/模型管理（写 workspace.json 覆盖层）：media:user-add-provider /
 *   media:user-remove-provider / media:user-add-model / media:user-remove-model /
 *   media:user-restore-model / media:browse-catalog
 * - 媒体 Key（Settings 前缀的 media 通道）：settings:media-set-key / settings:media-remove-key
 * - 运行时：media:providers / media:generate / media:cancel / media:jobs / media:import
 *
 * 另承载：确认闸门（pendingApprovals / requestMediaApproval / settleApprovalsForNode）、
 * 运行时工厂 createMediaRuntime（编排器在 chat 域注册前调用）、
 * MediaImport 专用的四个纯函数工具（guessKind/mimeFromExt/defaultMime/sanitizeName）。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { mkdirSync, statSync } from 'fs'
import { writeFile } from 'fs/promises'
import { basename, extname, join, resolve, sep } from 'path'
import type { AgentHost } from '../agent/host'
import type { MediaApprovalInfo } from '../agent/mediaTools'
import { MediaJobManager } from '../media/manager'
import type { MediaProviderAdapter } from '../media/provider'
import {
  createAdapters,
  isRegisteredAdapterType,
  type AdapterDeps,
  type AdapterProviderConfig
} from '../media/adapters'
import {
  BUILTIN_PROVIDERS,
  browseCatalog,
  mergeCatalog,
  MODEL_ID_PATTERN,
  PROVIDER_ID_PATTERN,
  sanitizeCapabilities,
  sanitizeUserProvider
} from '../media/catalog'
import { buildMediaUrl } from '../media/protocol'
import { copyIntoDir, type WorkspaceStore } from '../workspace/store'
import { MEDIA_ROOT_REL } from '../../shared/assets'
import { IpcChannel } from '../../shared/ipc'
import type {
  ChatResult,
  MediaConfigPatch,
  MediaConfirmPayload,
  MediaGenerateRequest,
  MediaImportRequest,
  MediaJobStatus,
  MediaProviderInfo,
  MediaProviderStatus,
  MediaSettingsStatus,
  MediaUserModelInput,
  MediaUserProviderInput
} from '../../shared/ipc'
import type { MediaKind, MediaRatio } from '../../shared/media'
import {
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_MEDIA_DURATION_S,
  DEFAULT_MEDIA_PROVIDER,
  DEFAULT_MEDIA_RATIO,
  MEDIA_RATIOS
} from '../../shared/media'
import type { IpcContext } from './shared'
import { describe, guardSync, invalidPayload, isNonEmptyString, ok } from './shared'
import { consumeSourcePath } from './workspace'

// ---------------------------------------------------------------- media 域：Agent 变更前确认（accessMode=confirm）

/** 变更前确认的挂起表：requestId → { nodeId, resolve }；回执/中止任一路径都会 settle */
const pendingApprovals = new Map<string, { nodeId: string; resolve: (accepted: boolean) => void }>()

/** 发确认卡事件并等待渲染端回执；signal 中止 = 拒绝。settle 后广播 media:confirm-resolved 供渲染端撤卡（幂等） */
export const requestMediaApproval = (
  kind: 'image' | 'video' | 'audio',
  info: MediaApprovalInfo,
  nodeId: string,
  signal: AbortSignal | undefined
): Promise<boolean> => {
  const requestId = randomUUID()
  return new Promise<boolean>((resolvePromise) => {
    let settled = false
    const settle = (accepted: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout) // 超时兜底与回执/中止谁先到都收敛在同一路径，settle 幂等
      pendingApprovals.delete(requestId)
      resolvePromise(accepted)
      // 撤卡广播：用户点击（本窗口已 resolve）、中止清理都要让所有窗口收卡
      for (const window of BrowserWindow.getAllWindows()) {
        try {
          window.webContents.send(IpcChannel.MediaConfirmResolvedEvent, { requestId })
        } catch {
          /* 窗口可能正在销毁 */
        }
      }
    }
    pendingApprovals.set(requestId, { nodeId, resolve: settle })
    // 10 分钟兜底超时：回执与 signal 中止都不来的话（渲染端假死、事件丢失），
    // Promise 永久悬挂会把 agent 工具的 execute 一起挂死；超时按拒绝处理并撤卡
    const timeout = setTimeout(() => settle(false), 10 * 60 * 1000)
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        window.webContents.send(IpcChannel.MediaConfirmRequest, {
          requestId,
          nodeId,
          kind,
          prompt: info.prompt,
          ...(info.provider ? { provider: info.provider } : {}),
          ...(info.model ? { model: info.model } : {}),
          ...(info.ratio ? { ratio: info.ratio } : {}),
          ...(info.durationSeconds ? { durationSeconds: info.durationSeconds } : {}),
          refCount: info.refCount
        } satisfies MediaConfirmPayload)
      } catch {
        /* 窗口可能正在销毁 */
      }
    }
    if (signal) {
      if (signal.aborted) settle(false)
      else signal.addEventListener('abort', () => settle(false), { once: true })
    }
  })
}

/** chat:dispose 成功后调用：该会话不会再有回执，其挂起的确认请求按拒绝 settle，防孤儿挂起 */
export function settleApprovalsForNode(nodeId: string): void {
  for (const entry of pendingApprovals.values()) {
    if (entry.nodeId === nodeId) entry.resolve(false)
  }
}

// ---------------------------------------------------------------- media 域（M11/M12）

/** mediaContext 的返回形态（MediaJobManager 与 Agent 媒体工具装配共同消费） */
export type MediaContextReturnType = {
  mediaDir: string | null
  workspaceDir: string | null
  config: ReturnType<WorkspaceStore['mediaConfig']>
  providers: AdapterProviderConfig[]
  adapters: MediaProviderAdapter[]
  ready: boolean
  notifyAssetsChanged: () => void
}

/** createMediaRuntime 的依赖：由编排器（src/main/ipc.ts）在注册各域 handler 前提供 */
export interface MediaRuntimeDeps {
  store: WorkspaceStore
  host: AgentHost
  currentDir: () => string | null
  broadcastAssetChanged: () => void
  broadcastMediaJob: (job: MediaJobStatus) => void
}

/**
 * 创建 media 域运行时：凭据解析、适配器缓存、mediaContext 与 MediaJobManager
 * （含启动时 reconcile 持久化任务）。chat 域的 assembleMediaTools 也消费这里的
 * mediaManager/mediaContext，因此必须在各域 handler 注册之前调用。
 */
export function createMediaRuntime(
  deps: MediaRuntimeDeps
): { mediaManager: MediaJobManager; mediaContext: () => MediaContextReturnType } {
  const { store, host, currentDir, broadcastAssetChanged, broadcastMediaJob } = deps

  /**
   * 媒体凭据读取：加密存储优先，退回供应商声明的环境变量（合并层已按
   * 目录 auth.env / 适配器默认值缺省化，这里不再写死任何厂商约定）。
   */
  const resolveMediaKey =
    async (auth: { authKey?: string; authEnv?: string }): Promise<string | undefined> => {
      const dir = currentDir()
      if (!dir) return undefined
      if (auth.authKey) {
        const stored = await host.getMediaKey(dir, auth.authKey)
        if (stored) return stored
      }
      return auth.authEnv ? process.env[auth.authEnv] : undefined
    }

  const adapterDeps: AdapterDeps = {
    mediaDir: () => store.mediaDir(),
    resolveKey: resolveMediaKey
  }

  /**
   * 适配器按「工作区 + 合并清单指纹」缓存：config 指纹不变则复用实例，
   * 避免每次 context() 都重建全部适配器。
   */
  let adapterCache: { workspace: string | null; fingerprint: string; adapters: MediaProviderAdapter[] } | null = null

  const mediaContext = (): MediaContextReturnType => {
    const mediaDir = store.mediaDir()
    const config = store.mediaConfig()
    const workspace = currentDir()
    // mergeCatalog 是清单的唯一入口：内置目录 + workspace.json 覆盖层 → 生效供应商
    const providers = mergeCatalog(BUILTIN_PROVIDERS, config)
    const fingerprint = JSON.stringify(providers)
    if (!adapterCache || adapterCache.workspace !== workspace || adapterCache.fingerprint !== fingerprint) {
      adapterCache = {
        workspace,
        fingerprint,
        adapters: createAdapters(providers, adapterDeps)
      }
    }
    return {
      mediaDir,
      workspaceDir: workspace,
      config,
      providers,
      adapters: adapterCache.adapters,
      ready: Boolean(workspace),
      // 产物落进素材库目录后由 MediaJobManager 调用，面板才会即时出现新文件（否则要重开工作区）
      notifyAssetsChanged: broadcastAssetChanged
    }
  }

  const mediaManager = new MediaJobManager(broadcastMediaJob, mediaContext)
  mediaManager.reconcilePersistedJobs()

  return { mediaManager, mediaContext }
}

export function registerMediaIpc(ctx: IpcContext): void {
  const store = ctx.store
  const host = ctx.host
  const currentDir = ctx.currentDir
  const mediaManager = ctx.mediaManager

  ipcMain.handle(IpcChannel.SettingsMediaStatus, async (): Promise<ChatResult<MediaSettingsStatus>> => {
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      const config = store.mediaConfig()
      const effective = mergeCatalog(BUILTIN_PROVIDERS, config)
      const providers: MediaProviderStatus[] = []
      for (const entry of effective) {
        const hasStored = await host.hasMediaKey(dir, entry.authKey)
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
            agentProvider: config.agentProvider ?? DEFAULT_MEDIA_PROVIDER,
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
    if (isNonEmptyString(patch.agentProvider)) clean.agentProvider = patch.agentProvider
    if (patch.agentModels && typeof patch.agentModels === 'object') {
      const models: Record<string, string> = {}
      for (const kind of ['image', 'video', 'audio'] as const) {
        const value = patch.agentModels[kind]
        if (isNonEmptyString(value)) models[kind] = value
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
    const label = isNonEmptyString(request?.label) ? request.label : undefined
    const baseUrl = isNonEmptyString(request?.baseUrl) ? request.baseUrl : undefined
    const authEnv = isNonEmptyString(request?.authEnv) ? request.authEnv : undefined
    const firstLabel = isNonEmptyString(first?.label) ? first.label : undefined
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
        models: {
          [firstModelId.trim()]: {
            kind: firstKind,
            ...(firstLabel ? { label: firstLabel } : {})
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
      if (provider.models.some((m) => m.id === modelId)) {
        throw new Error(`模型已存在：${modelId}`)
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

  ipcMain.handle(IpcChannel.SettingsMediaSetKey, async (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; apiKey?: unknown } | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.apiKey)) return invalidPayload('需要 apiKey')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      await host.setMediaKey(dir, request.providerId, request.apiKey)
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
      await host.removeMediaKey(dir, providerId)
      return ok()
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.MediaProviders, async (): Promise<ChatResult<MediaProviderInfo[]>> => {
    try {
      // 异步凭据探测（isReady：查加密存储/环境变量），设置页绿点才真实
      return { ok: true, value: await mediaManager.providers() }
    } catch (error) {
      return { ok: false, code: 'unknown', error: describe(error) }
    }
  })

  ipcMain.handle(
    IpcChannel.MediaGenerate,
    async (_event, payload: unknown): Promise<ChatResult<{ jobId: string }>> => {
      const request = payload as Partial<MediaGenerateRequest> | null
      if (!isNonEmptyString(request?.provider)) return invalidPayload('media:generate 需要 provider')
      if (!isNonEmptyString(request.model)) return invalidPayload('media:generate 需要 model')
      if (!isNonEmptyString(request.prompt)) return invalidPayload('media:generate 需要 prompt')
      if (request.kind !== 'image' && request.kind !== 'video' && request.kind !== 'audio') {
        return invalidPayload('media:generate 需要 kind=image|video|audio')
      }
      const generateRequest: MediaGenerateRequest = {
        provider: request.provider,
        model: request.model,
        kind: request.kind,
        prompt: request.prompt
      }
      if (isNonEmptyString(request.nodeId)) generateRequest.nodeId = request.nodeId
      if (isNonEmptyString(request.sourceChatId)) generateRequest.sourceChatId = request.sourceChatId
      // 比例是语义参数（像素换算在编排层收口）；width/height 仅作高级覆盖保留
      if (isNonEmptyString(request.ratio)) {
        if (!(MEDIA_RATIOS as readonly string[]).includes(request.ratio)) {
          return invalidPayload(`media:generate 的 ratio 不合法（可选：${MEDIA_RATIOS.join('/')}）`)
        }
        generateRequest.ratio = request.ratio as MediaRatio
      }
      if (typeof request.width === 'number' && request.width > 0) {
        generateRequest.width = Math.min(4096, Math.round(request.width))
      }
      if (typeof request.height === 'number' && request.height > 0) {
        generateRequest.height = Math.min(4096, Math.round(request.height))
      }
      if (typeof request.durationSeconds === 'number' && request.durationSeconds > 0) {
        generateRequest.durationSeconds = Math.min(120, Math.round(request.durationSeconds))
      }
      if (Array.isArray(request.refPaths)) {
        const refPaths = request.refPaths.filter((p): p is string => isNonEmptyString(p)).slice(0, 4)
        if (refPaths.length > 0) generateRequest.refPaths = refPaths
      }
      // 落库目录（相对工作区根）：越界校验在 MediaJobManager.submit 内做
      if (isNonEmptyString(request.outputDir)) generateRequest.outputDir = request.outputDir
      // 产物命名：净化与重名序号在 MediaJobManager.submit/materialize 内收口
      if (isNonEmptyString(request.name)) generateRequest.name = request.name
      try {
        return { ok: true, value: await mediaManager.submit(generateRequest) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, code: 'unknown', error: message }
      }
    }
  )

  ipcMain.handle(IpcChannel.MediaCancel, async (_event, payload: unknown) => {
    const jobId = (payload as { jobId?: unknown } | null)?.jobId
    if (!isNonEmptyString(jobId)) return invalidPayload('media:cancel 需要 jobId')
    const cancelled = await mediaManager.cancel(jobId)
    return {
      ok: cancelled,
      ...(cancelled ? {} : { code: 'unknown' as const, error: '任务不存在或已结束' })
    }
  })

  ipcMain.handle(IpcChannel.MediaJobs, () => {
    return { ok: true, value: mediaManager.list() } satisfies ChatResult<MediaJobStatus[]>
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

  ipcMain.handle(IpcChannel.MediaConfirmResolve, (_event, payload: unknown) => {
    const request = payload as { requestId?: unknown; accepted?: unknown } | null
    if (!isNonEmptyString(request?.requestId) || typeof request.accepted !== 'boolean') {
      return invalidPayload('media:confirm-resolve 需要 requestId 与 accepted:boolean')
    }
    // 未知 requestId 静默 ok：回执可能晚于中止/清理的先行 settle，幂等
    pendingApprovals.get(request.requestId)?.resolve(request.accepted === true)
    return ok()
  })

  /**
   * 导入 OS 媒体文件：拷入当前工作区 .huabu/media/，返回产物描述。
   * sourcePath 来自 preload 的 webUtils.getPathForFile（不把文件字节搬过 IPC）；
   * 剪贴板图片没有磁盘路径，走 base64 兜底通道。
   */
  ipcMain.handle(IpcChannel.MediaImport, async (_event, payload: unknown): Promise<ChatResult<unknown>> => {
    const request = payload as Partial<MediaImportRequest> | null
    const dir = store.mediaDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    if (!request || (typeof request.sourcePath !== 'string' && typeof request.base64 !== 'string')) {
      return invalidPayload('media:import 需要 sourcePath 或 base64')
    }
    const kind: MediaKind =
      request.kind === 'video' || request.kind === 'audio' || request.kind === 'image'
        ? request.kind
        : guessKind(request.sourcePath ?? '', request.mime)
    try {
      mkdirSync(dir, { recursive: true })
      let target: string
      let displayName: string
      if (typeof request.base64 === 'string') {
        // base64 通道在解码前先卡长度：渲染端异常可把数百 MB 文本灌进主进程，
        // Buffer.from + 写盘会瞬时膨胀内存并冻结 UI（写盘已走 fs/promises）
        if (request.base64.length > 32 * 1024 * 1024) {
          return invalidPayload('剪贴板图片超过 32MB 上限，已拒绝导入')
        }
        const ext = request.mime?.includes('jpeg') ? '.jpg' : '.png'
        displayName = `clipboard-${randomUUID().slice(0, 8)}${ext}`
        target = join(dir, displayName)
        await writeFile(target, Buffer.from(request.base64, 'base64'))
      } else if (typeof request.sourcePath === 'string') {
        // 安全闸：sourcePath 只可能来自 preload pathForFile 的拖拽登记（未 resolve 的原样字符串）；
        // 未登记的路径一律拒绝，堵住「伪造路径把任意用户文件复制进工作区」的口子
        if (!consumeSourcePath(request.sourcePath)) {
          return invalidPayload('导入路径未经过拖拽登记，已拒绝：请重新把文件拖入画布')
        }
        const source = resolve(request.sourcePath)
        displayName = `${randomUUID().slice(0, 8)}-${sanitizeName(request.name ?? basename(source))}`
        target = await copyIntoDir(source, dir, displayName)
      } else {
        return invalidPayload('media:import 需要 sourcePath 或 base64')
      }
      const bytes = statSync(target).size
      const mime = request.mime ?? mimeFromExt(extname(target)) ?? defaultMime(kind)
      const relPath = basename(target)
      return {
        ok: true,
        value: {
          artifact: {
            relPath,
            name: sanitizeName(request.name ?? relPath),
            mime,
            bytes
          },
          url: buildMediaUrl(relPath)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'unknown', error: `导入失败：${message}` }
    }
  })
}

/**
 * Agent 媒体工具的 provider/model 解析。
 *
 * 回退链的唯一实现在 shared/mediaResolve.ts（与渲染端卡片共用同一纯函数，语义一致）。
 * 默认供应商不存在、没有同类模型、没配 Key 时，都给可操作错误，绝不静默生成假图。
 */
/**
 * 生成产物的默认落库目录与 Agent 媒体解析已收拢进 agent/mediaToolAssembly.ts
 * （T12）：它们只服务 Agent 工具路径，此处原先的两份实现随之删除。
 */

/** 从扩展名猜媒体大类（导入时渲染端可不传 kind） */
function guessKind(pathOrName: string, mime?: string): MediaKind {
  if (mime?.startsWith('video/')) return 'video'
  if (mime?.startsWith('audio/')) return 'audio'
  const ext = extname(pathOrName).toLowerCase()
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext)) return 'audio'
  return 'image'
}

function mimeFromExt(ext: string): string | undefined {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac'
  }
  return map[ext.toLowerCase()]
}

function defaultMime(kind: MediaKind): string {
  return kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/wav' : 'image/png'
}

/** 文件名只保留安全字符，防止路径穿越与奇怪字符进 canvas.json */
function sanitizeName(name: string): string {
  const cleaned = basename(name)
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5 ]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120)
  return cleaned || 'media'
}
