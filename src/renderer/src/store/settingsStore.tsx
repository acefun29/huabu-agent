import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  ChatModelOption,
  CustomModelInput,
  ManagedModelInfo,
  MediaCatalogBrowseItem,
  MediaProviderInfo,
  MediaSettingsStatus,
  MediaUserModelInput,
  MediaUserProviderInput,
  ModelEditInput,
  ProviderAuthInfo,
  ProviderTestResult
} from '@shared/ipc'
import type { ChatModelApi } from '@shared/chatApi'
import type { MediaConfigPatch } from '@shared/api'
import { resolveMediaTarget, toModelRef } from '@shared/mediaResolve'
import type { MediaKind } from '../types'

/**
 * 设置状态（v2 设置面板的真实数据层）。
 *
 * 应用逻辑.md 第七节的分界在这里落地：**对话供应商与媒体供应商是两套独立配置**。
 * - 对话一侧走 Pi 的 provider 清单（凭据加密存储，零密钥过 IPC）；
 * - 媒体一侧走 workspace.json 的 media 段（provider/模型/输出目录/并发/默认比例时长/确认闸门）；
 * - Skills 与 MCP 目前只是配置陈列（原型现状），持久化在 localStorage；
 * - 外观（主题/网格）localStorage，全局即时生效。
 */

export interface SkillItem {
  id: string
  name: string
  description: string
  source: 'builtin' | 'workspace'
  enabled: boolean
}

export interface McpServer {
  id: string
  name: string
  command: string
  args: string
  enabled: boolean
}

export interface AppearanceSettings {
  theme: 'light' | 'dark'
  showGrid: boolean
}

/** 某个 kind 当前生效的模型（`provider:model` 复合串），走完整回退链后的结果 */
export interface ResolvedMediaModel {
  provider: string
  model: string
  composite: string
}

/**
 * 面板开合的 UI 层，走独立小 Context。
 * 之前 isOpen 与全部数据域打在同一个 context value 里，开/关一次设置面板就会重建整个
 * value，把画布上每张生成卡片（AssetNode）、Composer 等所有 useSettings 消费者全部重渲；
 * 拆层后开关只重渲订阅 UI 层的组件（SessionSidebar / SettingsPanel 自身）。
 */
export interface SettingsUiState {
  isOpen: boolean
  openSettings: () => void
  closeSettings: () => void
}

interface SettingsState {
  /* ---------------- 对话供应商（真实 IPC） ---------------- */
  chatProviders: ProviderAuthInfo[]
  /** 可选对话模型清单（chat:runtime，含认证状态与推理档位；失败静默为空） */
  chatModels: ChatModelOption[]
  credentialsHint: string
  chatLoaded: boolean
  refreshChat: () => Promise<void>
  setApiKey: (providerId: string, apiKey: string) => Promise<string | null>
  removeApiKey: (providerId: string) => Promise<string | null>
  testProvider: (providerId: string) => Promise<ProviderTestResult | null>
  /** 工作区默认聊天模型（provider/model），新建会话继承 */
  defaultModel: string | null
  setDefaultModel: (modelId: string | null) => Promise<void>
  modelsList: (providerId: string) => Promise<ManagedModelInfo[]>
  customAddProvider: (providerId: string, name: string, baseUrl: string, api?: ChatModelApi) => Promise<string | null>
  customRemoveProvider: (providerId: string) => Promise<string | null>
  /** 新增自定义模型：完整字段（显示名/上下文/最大输出/输入类型/推理） */
  customAddModel: (input: CustomModelInput) => Promise<string | null>
  /** 删除模型（自定义=删条目；内置=隐藏，可用 modelRestore 恢复） */
  modelRemove: (providerId: string, modelId: string) => Promise<string | null>
  /** 编辑模型（自定义=改条目；内置=改名进 modelOverrides、改能力进补丁条目） */
  modelEdit: (input: ModelEditInput) => Promise<string | null>
  /** 恢复被隐藏的内置模型 */
  modelRestore: (providerId: string, modelId: string) => Promise<string | null>

  /* ---------------- 媒体生成（真实 IPC） ---------------- */
  mediaProviders: MediaProviderInfo[]
  mediaStatus: MediaSettingsStatus['config'] | null
  confirmVideo: boolean
  mediaLoaded: boolean
  refreshMedia: () => Promise<void>
  /** 工作区切换后由 CanvasProvider 调用：默认模型与媒体配置都锚定在 workspace.json 上 */
  refreshAll: () => Promise<void>
  updateMediaConfig: (patch: MediaConfigPatch) => Promise<string | null>
  setMediaKey: (providerId: string, apiKey: string) => Promise<string | null>
  removeMediaKey: (providerId: string) => Promise<string | null>
  /* 用户自建供应商/模型管理（写 workspace.json 覆盖层，成功后清单自动刷新） */
  mediaUserAddProvider: (input: MediaUserProviderInput) => Promise<string | null>
  mediaUserRemoveProvider: (providerId: string) => Promise<string | null>
  mediaUserAddModel: (input: MediaUserModelInput) => Promise<string | null>
  mediaUserRemoveModel: (providerId: string, modelId: string) => Promise<string | null>
  mediaUserRestoreModel: (providerId: string, modelId: string) => Promise<string | null>
  /** 浏览供应商的全量模型目录（设置页「浏览完整模型库」；无目录的供应商返回空数组） */
  mediaBrowseCatalog: (providerId: string) => Promise<MediaCatalogBrowseItem[]>
  /** 模型回退链：卡片指定 → 设置里该类媒体默认 → 默认供应商首个同类模型 */
  resolveMediaModel: (kind: MediaKind, override?: string) => ResolvedMediaModel | null
  /** 某 kind 的全部可选模型（复合 id = `provider:model`） */
  mediaModelOptions: (kind: MediaKind) => Array<{ id: string; label: string }>

  /* ---------------- Skills / MCP / 外观（localStorage 陈列） ---------------- */
  skills: SkillItem[]
  toggleSkill: (id: string) => void
  mcpServers: McpServer[]
  toggleMcp: (id: string) => void
  addMcp: (server: Omit<McpServer, 'id' | 'enabled'>) => void
  removeMcp: (id: string) => void
  appearance: AppearanceSettings
  setAppearance: (patch: Partial<AppearanceSettings>) => void
}

const STORAGE_KEY = 'huabu-settings-ui'

const DEFAULT_SKILLS: SkillItem[] = [
  { id: 'sk-canvas', name: 'canvas-context', description: '全感知画布上下文：读取选中节点与画布结构作为 Agent 输入', source: 'builtin', enabled: true },
  { id: 'sk-media', name: 'media-generation', description: '图片 / 视频 / 音频生成与编辑工具集，产出自动落回画布', source: 'builtin', enabled: true },
  { id: 'sk-code', name: 'code-assistant', description: '代码文件读写、重构与解释', source: 'builtin', enabled: false },
  { id: 'sk-brand', name: 'brand-poster', description: '工作区级 Skill：品牌海报生成工作流（.huabu/skills/brand-poster）', source: 'workspace', enabled: true }
]

const DEFAULT_MCP: McpServer[] = [
  { id: 'mcp-fs', name: 'filesystem', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem .', enabled: false }
]

const DEFAULT_APPEARANCE: AppearanceSettings = { theme: 'light', showGrid: true }

interface PersistedUi {
  skills: SkillItem[]
  mcpServers: McpServer[]
  appearance: AppearanceSettings
}

function loadPersistedUi(): PersistedUi {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { skills: DEFAULT_SKILLS, mcpServers: DEFAULT_MCP, appearance: DEFAULT_APPEARANCE }
    const parsed = JSON.parse(raw) as Partial<PersistedUi>
    return {
      skills: parsed.skills?.length ? parsed.skills : DEFAULT_SKILLS,
      mcpServers: parsed.mcpServers?.length ? parsed.mcpServers : DEFAULT_MCP,
      appearance: { ...DEFAULT_APPEARANCE, ...parsed.appearance }
    }
  } catch {
    return { skills: DEFAULT_SKILLS, mcpServers: DEFAULT_MCP, appearance: DEFAULT_APPEARANCE }
  }
}

/** window.huabu 是否存在（纯浏览器打开 dev server 时整体降级） */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.huabu)
}

function errorText(result: { ok: false; error: string } | { ok: true }): string | null {
  return result.ok ? null : result.error
}

const SettingsContext = createContext<SettingsState | null>(null)
const SettingsUiContext = createContext<SettingsUiState | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(loadPersistedUi)
  const [isOpen, setIsOpen] = useState(false)

  const [chatProviders, setChatProviders] = useState<ProviderAuthInfo[]>([])
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([])
  const [credentialsHint, setCredentialsHint] = useState('')
  const [chatLoaded, setChatLoaded] = useState(false)
  const [defaultModel, setDefaultModelState] = useState<string | null>(null)

  const [mediaProviders, setMediaProviders] = useState<MediaProviderInfo[]>([])
  const [mediaStatus, setMediaStatus] = useState<MediaSettingsStatus['config'] | null>(null)
  const [confirmVideo, setConfirmVideo] = useState(true)
  const [mediaLoaded, setMediaLoaded] = useState(false)

  const [skills, setSkills] = useState(initial.skills)
  const [mcpServers, setMcpServers] = useState(initial.mcpServers)
  const [appearance, setAppearanceState] = useState(initial.appearance)

  // UI 陈列项持久化
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ skills, mcpServers, appearance }))
    } catch {
      /* 忽略写入失败 */
    }
  }, [skills, mcpServers, appearance])

  // 主题全局生效
  useEffect(() => {
    document.documentElement.dataset.theme = appearance.theme
  }, [appearance.theme])

  const refreshChat = useCallback(async () => {
    if (!hasBridge()) return
    const [providersResult, stateResult, runtimeResult] = await Promise.all([
      window.huabu.settings.chatProviders(),
      window.huabu.workspace.state(),
      window.huabu.chat.runtime()
    ])
    if (providersResult.ok) {
      setChatProviders(providersResult.value.providers)
      setCredentialsHint(providersResult.value.credentialsHint)
    }
    if (stateResult.workspace) {
      setDefaultModelState(stateResult.workspace.defaultModel ?? null)
    }
    // 模型清单只供对话框的模型/档位菜单消费，失败静默保持空
    if (runtimeResult.ok) setChatModels(runtimeResult.value.models)
    setChatLoaded(true)
  }, [])

  const refreshMedia = useCallback(async () => {
    if (!hasBridge()) return
    const [providersResult, statusResult] = await Promise.all([
      window.huabu.media.providers(),
      window.huabu.settings.mediaStatus()
    ])
    if (providersResult.ok) setMediaProviders(providersResult.value)
    if (statusResult.ok) {
      setMediaStatus(statusResult.value.config)
      setConfirmVideo(statusResult.value.confirmVideo)
    }
    setMediaLoaded(true)
  }, [])

  /** 工作区切换后由 CanvasProvider 调用：默认模型与媒体配置都锚定在 workspace.json 上 */
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshChat(), refreshMedia()])
  }, [refreshChat, refreshMedia])

  const setApiKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return errorText(await window.huabu.settings.setApiKey(providerId, apiKey))
  }, [])

  const removeApiKey = useCallback(async (providerId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return errorText(await window.huabu.settings.removeApiKey(providerId))
  }, [])

  const testProvider = useCallback(async (providerId: string) => {
    if (!hasBridge()) return null
    const result = await window.huabu.settings.testProvider(providerId)
    return result.ok ? result.value : null
  }, [])

  const setDefaultModel = useCallback(async (modelId: string | null) => {
    setDefaultModelState(modelId)
    if (!hasBridge()) return
    await window.huabu.workspace.setDefaultModel(modelId)
  }, [])

  const modelsList = useCallback(async (providerId: string) => {
    if (!hasBridge()) return []
    const result = await window.huabu.settings.modelsList(providerId)
    return result.ok ? result.value : []
  }, [])

  const customAddProvider = useCallback(
    async (providerId: string, name: string, baseUrl: string, api: ChatModelApi = 'openai-completions') => {
      if (!hasBridge()) return '当前环境没有可用的设置服务'
      return errorText(await window.huabu.settings.customAddProvider({ providerId, name, baseUrl, api }))
    },
    []
  )

  const customRemoveProvider = useCallback(async (providerId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return errorText(await window.huabu.settings.customRemoveProvider(providerId))
  }, [])

  const customAddModel = useCallback(async (input: CustomModelInput) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return errorText(await window.huabu.settings.customAddModel(input))
  }, [])

  const modelRemove = useCallback(async (providerId: string, modelId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return errorText(await window.huabu.settings.modelRemove(providerId, modelId))
  }, [])

  const modelEdit = useCallback(async (input: ModelEditInput) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return errorText(await window.huabu.settings.modelEdit(input))
  }, [])

  const modelRestore = useCallback(async (providerId: string, modelId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return errorText(await window.huabu.settings.modelRestore(providerId, modelId))
  }, [])

  const updateMediaConfig = useCallback(async (patch: MediaConfigPatch) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.setConfig(patch)
    if (!result.ok) return result.error
    // 以主进程落盘后的配置为准回显
    await refreshMedia()
    return null
  }, [refreshMedia])

  const setMediaKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.settings.mediaSetKey(providerId, apiKey)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const removeMediaKey = useCallback(async (providerId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.settings.mediaRemoveKey(providerId)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserAddProvider = useCallback(async (input: MediaUserProviderInput) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userAddProvider(input)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserRemoveProvider = useCallback(async (providerId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userRemoveProvider(providerId)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserAddModel = useCallback(async (input: MediaUserModelInput) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userAddModel(input)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserRemoveModel = useCallback(async (providerId: string, modelId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userRemoveModel(providerId, modelId)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserRestoreModel = useCallback(async (providerId: string, modelId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userRestoreModel(providerId, modelId)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaBrowseCatalog = useCallback(async (providerId: string) => {
    if (!hasBridge()) return []
    const result = await window.huabu.media.browseCatalog(providerId)
    return result.ok ? result.value : []
  }, [])

  const resolveMediaModel = useCallback(
    (kind: MediaKind, override?: string): ResolvedMediaModel | null => {
      // 回退链的唯一实现在 shared/mediaResolve.ts，主进程 Agent 工具走同一条链
      const resolved = resolveMediaTarget(mediaProviders, {
        kind,
        override,
        agentProvider: mediaStatus?.agentProvider,
        agentModels: mediaStatus?.agentModels
      })
      return resolved ? { provider: resolved.provider, model: resolved.model, composite: resolved.ref } : null
    },
    [mediaProviders, mediaStatus]
  )

  const mediaModelOptions = useCallback(
    (kind: MediaKind) =>
      mediaProviders.flatMap((p) =>
        p.models
          .filter((m) => m.kind === kind)
          .map((m) => ({ id: toModelRef(p.id, m.id), label: `${p.label} · ${m.label ?? m.id}` }))
      ),
    [mediaProviders]
  )

  const toggleSkill = useCallback((id: string) => {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
  }, [])

  const toggleMcp = useCallback((id: string) => {
    setMcpServers((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
  }, [])

  const addMcp = useCallback((server: Omit<McpServer, 'id' | 'enabled'>) => {
    setMcpServers((prev) => [...prev, { ...server, id: `mcp-${Date.now()}`, enabled: true }])
  }, [])

  const removeMcp = useCallback((id: string) => {
    setMcpServers((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const setAppearance = useCallback((patch: Partial<AppearanceSettings>) => {
    setAppearanceState((prev) => ({ ...prev, ...patch }))
  }, [])

  // 面板开合的稳定回调：只进 UI 层 value，开/关面板不会牵动数据域 value 的重建
  const openSettings = useCallback(() => setIsOpen(true), [])
  const closeSettings = useCallback(() => setIsOpen(false), [])

  const value = useMemo<SettingsState>(
    () => ({
      chatProviders,
      chatModels,
      credentialsHint,
      chatLoaded,
      refreshChat,
      setApiKey,
      removeApiKey,
      testProvider,
      defaultModel,
      setDefaultModel,
      modelsList,
      customAddProvider,
      customRemoveProvider,
      customAddModel,
      modelRemove,
      modelEdit,
      modelRestore,
      mediaProviders,
      mediaStatus,
      confirmVideo,
      mediaLoaded,
      refreshMedia,
      refreshAll,
      updateMediaConfig,
      setMediaKey,
      removeMediaKey,
      mediaUserAddProvider,
      mediaUserRemoveProvider,
      mediaUserAddModel,
      mediaUserRemoveModel,
      mediaUserRestoreModel,
      mediaBrowseCatalog,
      resolveMediaModel,
      mediaModelOptions,
      skills,
      toggleSkill,
      mcpServers,
      toggleMcp,
      addMcp,
      removeMcp,
      appearance,
      setAppearance
    }),
    [
      chatProviders, chatModels, credentialsHint, chatLoaded, refreshChat, setApiKey, removeApiKey,
      testProvider, defaultModel, setDefaultModel, modelsList, customAddProvider,
      customRemoveProvider, customAddModel, modelRemove, modelEdit, modelRestore,
      mediaProviders, mediaStatus, confirmVideo,
      mediaLoaded, refreshMedia, refreshAll, updateMediaConfig, setMediaKey, removeMediaKey,
      mediaUserAddProvider, mediaUserRemoveProvider, mediaUserAddModel, mediaUserRemoveModel,
      mediaUserRestoreModel, mediaBrowseCatalog,
      resolveMediaModel, mediaModelOptions, skills, toggleSkill, mcpServers, toggleMcp,
      addMcp, removeMcp, appearance, setAppearance
    ]
  )

  // UI 层只依赖 isOpen（openSettings/closeSettings 恒定），面板开合不再重建数据域 value
  const uiValue = useMemo<SettingsUiState>(
    () => ({ isOpen, openSettings, closeSettings }),
    [isOpen, openSettings, closeSettings]
  )

  return (
    <SettingsContext.Provider value={value}>
      <SettingsUiContext.Provider value={uiValue}>{children}</SettingsUiContext.Provider>
    </SettingsContext.Provider>
  )
}

export function useSettings(): SettingsState {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider')
  return ctx
}

/** 面板开合专用：只订阅 isOpen/openSettings/closeSettings，数据域变化不波及这层消费者 */
export function useSettingsUi(): SettingsUiState {
  const ctx = useContext(SettingsUiContext)
  if (!ctx) throw new Error('useSettingsUi must be used within a SettingsProvider')
  return ctx
}
