import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  ChatModelOption,
  CustomModelInput,
  ManagedModelInfo,
  McpServerConfig,
  McpServerRuntimeInfo,
  MediaCatalogBrowseItem,
  MediaProviderInfo,
  MediaSettingsStatus,
  MediaUserModelInput,
  MediaUserProviderInput,
  ModelEditInput,
  ProviderAuthInfo,
  ProviderTestResult,
  SkillInfo
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
 * - Skills 走 workspace.json skills 段 + .huabu/skills/ 目录扫描（settings:skills-*）；
 * - MCP 走全局配置 userData/huabu-state/mcp.json（settings:mcp-*），工具随会话注入；
 * - 外观（主题/网格）localStorage，全局即时生效。
 */

export type { SkillInfo, McpServerConfig, McpServerRuntimeInfo }

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

  /* ---------------- Skills / MCP（真实 IPC） / 外观（localStorage） ---------------- */
  /** 工作区技能清单（.huabu/skills/ 扫描 + skills.disabled 名单合并） */
  skills: SkillInfo[]
  toggleSkill: (name: string) => void
  /** MCP 服务器配置 + 连接运行态（全局配置；徽章数据含 status/toolCount/error） */
  mcpServers: McpServerRuntimeInfo[]
  toggleMcp: (name: string) => void
  addMcp: (server: { name: string; command: string; args: string; env: string }) => Promise<string | null>
  removeMcp: (name: string) => void
  /** 手动重连（徽章错误时的重试入口；底层 = sync + 刷新） */
  refreshMcp: () => void
  appearance: AppearanceSettings
  setAppearance: (patch: Partial<AppearanceSettings>) => void
}

const STORAGE_KEY = 'huabu-settings-ui'

const DEFAULT_APPEARANCE: AppearanceSettings = { theme: 'light', showGrid: true }

interface PersistedUi {
  appearance: AppearanceSettings
}

function loadPersistedUi(): PersistedUi {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { appearance: DEFAULT_APPEARANCE }
    const parsed = JSON.parse(raw) as Partial<PersistedUi>
    return {
      appearance: { ...DEFAULT_APPEARANCE, ...parsed.appearance }
    }
  } catch {
    return { appearance: DEFAULT_APPEARANCE }
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

  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerRuntimeInfo[]>([])
  const [appearance, setAppearanceState] = useState(initial.appearance)

  // 外观是纯 UI 偏好，留在 localStorage（Skills/MCP 已改走真实 IPC 持久化）
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ appearance }))
    } catch {
      /* 忽略写入失败 */
    }
  }, [appearance])

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

  /** Skills / MCP 清单刷新（挂到 refreshAll；mcp:status 事件也走这里更新徽章） */
  const refreshSkillsAndMcp = useCallback(async () => {
    if (!hasBridge()) return
    const [skillsResult, mcpResult] = await Promise.all([
      window.huabu.settings.skillsList(),
      window.huabu.settings.mcpStatus()
    ])
    if (skillsResult.ok) setSkills(skillsResult.value.skills)
    if (mcpResult.ok) setMcpServers(mcpResult.value.servers)
  }, [])

  // MCP 连接状态是异步收敛的（npx 冷启动可达十几秒）：订阅 mcp:status 拉最新徽章
  useEffect(() => {
    if (!hasBridge()) return
    return window.huabu.settings.onMcpStatus(() => {
      void window.huabu.settings.mcpStatus().then((result) => {
        if (result.ok) setMcpServers(result.value.servers)
      })
    })
  }, [])

  /** 工作区切换后由 CanvasProvider 调用：默认模型与媒体配置都锚定在 workspace.json 上 */
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshChat(), refreshMedia(), refreshSkillsAndMcp()])
  }, [refreshChat, refreshMedia, refreshSkillsAndMcp])

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

  /**
   * 技能开关：乐观更新 + 整表提交 disabled 名单（主进程写 workspace.json）。
   * IPC 在 updater 外触发——updater 会被 StrictMode 双调用，副作用放里面会双发。
   */
  const toggleSkill = useCallback(
    (name: string) => {
      const next = skills.map((s) => (s.name === name ? { ...s, enabled: !s.enabled } : s))
      setSkills(next)
      if (hasBridge()) {
        void window.huabu.settings
          .skillsSetDisabled({ disabled: next.filter((s) => !s.enabled).map((s) => s.name) })
          .then((result) => {
            if (!result.ok) void refreshSkillsAndMcp()
          })
      }
    },
    [skills, refreshSkillsAndMcp]
  )

  /** 整表提交 MCP 服务器配置（主进程落盘 + 同步连接池，返回最新运行态） */
  const setMcpServersRemote = useCallback(async (servers: McpServerConfig[]): Promise<McpServerRuntimeInfo[] | null> => {
    if (!hasBridge()) return null
    const result = await window.huabu.settings.mcpSet({ servers })
    if (!result.ok) return null
    setMcpServers(result.value.servers)
    return result.value.servers
  }, [])

  /** 剥掉运行态字段，得到可提交的纯配置 */
  const toConfig = (list: McpServerRuntimeInfo[]): McpServerConfig[] =>
    list.map(({ status: _s, toolCount: _t, error: _e, ...config }) => config)

  const toggleMcp = useCallback(
    (name: string) => {
      const next = mcpServers.map((s) => (s.name === name ? { ...s, enabled: !s.enabled } : s))
      setMcpServers(
        next.map((s) =>
          s.name === name ? { ...s, status: s.enabled ? ('starting' as const) : ('disabled' as const) } : s
        )
      )
      void setMcpServersRemote(toConfig(next))
    },
    [mcpServers, setMcpServersRemote]
  )

  /**
   * 新增 MCP 服务器（表单文本 → 结构化配置）。args 按空白分词、env 按行解析 KEY=VALUE。
   * 返回错误文案（名称非法/重复等，主进程校验），成功返回 null。
   */
  const addMcp = useCallback(
    async (server: { name: string; command: string; args: string; env: string }): Promise<string | null> => {
      const name = server.name.trim()
      const command = server.command.trim()
      if (!name) return '名称不能为空'
      if (!command) return '启动命令不能为空'
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return '名称只允许字母/数字/横线/下划线'
      const args = server.args.trim().split(/\s+/).filter(Boolean)
      const env: Record<string, string> = {}
      for (const line of server.env.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) return `环境变量格式应为 KEY=VALUE：${trimmed}`
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
      }
      const result = await setMcpServersRemote([
        ...toConfig(mcpServers),
        { id: `mcp-${name}-${Date.now()}`, name, command, args, ...(Object.keys(env).length > 0 ? { env } : {}), enabled: true }
      ])
      return result ? null : '保存失败（详见主进程日志）'
    },
    [mcpServers, setMcpServersRemote]
  )

  const removeMcp = useCallback(
    (name: string) => {
      const next = mcpServers.filter((s) => s.name !== name)
      setMcpServers(next)
      void setMcpServersRemote(toConfig(next))
    },
    [mcpServers, setMcpServersRemote]
  )

  const refreshMcp = useCallback(() => {
    void refreshSkillsAndMcp()
  }, [refreshSkillsAndMcp])

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
      refreshMcp,
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
      resolveMediaModel, mediaModelOptions,
      skills, toggleSkill, mcpServers, toggleMcp, addMcp, removeMcp, refreshMcp,
      appearance, setAppearance
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
