import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SkillInfo } from '@shared/ipc'
import { useMediaSettingsState, type MediaSettingsState } from './settings/media'
import { useChatSettingsState, type ChatSettingsState } from './settings/chat'
import { useSkillsSettingsState, type SkillsSettingsState } from './settings/skills'
export { hasBridge } from './settings/bridge'

/** 组合聊天、媒体、扩展和外观设置，同时提供各域独立订阅。 */

export type { SkillInfo }

/** 设置面板的 tab 键（SettingsPanel 的导航分派；openSettings(tab) 直达用） */
export type SettingsTabKey = 'providers' | 'media' | 'skills' | 'appearance'

export interface AppearanceSettings {
  theme: 'light' | 'dark'
  showGrid: boolean
  /** 画布引用链（生成事实的只读投影）显隐；快捷键 Shift+E 同步切换 */
  showReferenceEdges: boolean
}

export type { ResolvedMediaModel } from './settings/media'

/** 设置面板的打开状态与目标页。 */
export interface SettingsUiState {
  isOpen: boolean
  /**
   * 打开设置面板；带 tab 时直达该页（如媒体配置引导 openSettings('media')）。
   * requestedTab 在面板打开期间保持，SettingsPanel 据此同步内部 tab state。
   */
  openSettings: (tab?: SettingsTabKey) => void
  /** 最近一次 openSettings(tab) 指定的 tab；不带 tab 的打开为 null（保持用户上次所在页） */
  requestedTab: SettingsTabKey | null
  closeSettings: () => void
}

type AppearanceState = {
  appearance: AppearanceSettings
  setAppearance: (patch: Partial<AppearanceSettings>) => void
}

type SettingsState = ChatSettingsState & MediaSettingsState & SkillsSettingsState & AppearanceState & {
  refreshAll: (workspacePath?: string) => Promise<void>
}

const STORAGE_KEY = 'huabu-settings-ui'

const DEFAULT_APPEARANCE: AppearanceSettings = { theme: 'light', showGrid: true, showReferenceEdges: true }

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

const SettingsContext = createContext<SettingsState | null>(null)
const MediaSettingsContext = createContext<MediaSettingsState | null>(null)
const ChatSettingsContext = createContext<ChatSettingsState | null>(null)
const AppearanceContext = createContext<AppearanceState | null>(null)
const SettingsUiContext = createContext<SettingsUiState | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(loadPersistedUi)
  const [isOpen, setIsOpen] = useState(false)

  const chat = useChatSettingsState()
  const media = useMediaSettingsState()
  const skillsState = useSkillsSettingsState()
  const { refreshChat, resetChatWorkspace } = chat
  const { refreshMedia, resetMediaWorkspace } = media
  const { refreshSkills, resetSkills } = skillsState

  const [appearance, setAppearanceState] = useState(initial.appearance)

  // 外观是纯 UI 偏好，留在 localStorage（Skills 已改走真实 IPC 持久化）
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

  /** 工作区切换后由 CanvasProvider 调用：默认模型与媒体配置都锚定在 workspace.json 上 */
  const refreshAll = useCallback(async (workspacePath?: string) => {
    if (workspacePath) {
      resetChatWorkspace()
      resetMediaWorkspace()
      resetSkills()
    }
    await Promise.all([refreshChat(workspacePath), refreshMedia(workspacePath), refreshSkills()])
  }, [refreshChat, refreshMedia, refreshSkills, resetChatWorkspace, resetMediaWorkspace, resetSkills])

  const setAppearance = useCallback((patch: Partial<AppearanceSettings>) => {
    setAppearanceState((prev) => ({ ...prev, ...patch }))
  }, [])

  // 面板开合的稳定回调：只进 UI 层 value，开/关面板不会牵动数据域 value 的重建。
  // openSettings(tab) 记录目标页：媒体配置强制引导等场景直达「媒体生成」tab
  const [requestedTab, setRequestedTab] = useState<SettingsTabKey | null>(null)
  const openSettings = useCallback((tab?: SettingsTabKey) => {
    setRequestedTab(tab ?? null)
    setIsOpen(true)
  }, [])
  const closeSettings = useCallback(() => setIsOpen(false), [])

  const appearanceValue = useMemo<AppearanceState>(
    () => ({ appearance, setAppearance }),
    [appearance, setAppearance]
  )
  const value = useMemo<SettingsState>(
    () => ({ ...chat, ...media, ...skillsState, ...appearanceValue, refreshAll }),
    [chat, media, skillsState, appearanceValue, refreshAll]
  )

  // UI 层只依赖 isOpen/requestedTab（openSettings/closeSettings 恒定），面板开合不再重建数据域 value
  const uiValue = useMemo<SettingsUiState>(
    () => ({ isOpen, requestedTab, openSettings, closeSettings }),
    [isOpen, requestedTab, openSettings, closeSettings]
  )

  return (
    <SettingsContext.Provider value={value}>
      <ChatSettingsContext.Provider value={chat}>
        <MediaSettingsContext.Provider value={media}>
          <AppearanceContext.Provider value={appearanceValue}>
            <SettingsUiContext.Provider value={uiValue}>{children}</SettingsUiContext.Provider>
          </AppearanceContext.Provider>
        </MediaSettingsContext.Provider>
      </ChatSettingsContext.Provider>
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

/** 只订阅媒体设置，避免其他设置域变化触发更新。 */
export function useMediaSettings(): MediaSettingsState {
  const ctx = useContext(MediaSettingsContext)
  if (!ctx) throw new Error('useMediaSettings must be used within a SettingsProvider')
  return ctx
}

/** 只订阅聊天设置。 */
export function useChatSettings(): ChatSettingsState {
  const ctx = useContext(ChatSettingsContext)
  if (!ctx) throw new Error('useChatSettings must be used within a SettingsProvider')
  return ctx
}

/** 只订阅外观设置。 */
export function useAppearanceSettings(): AppearanceState {
  const ctx = useContext(AppearanceContext)
  if (!ctx) throw new Error('useAppearanceSettings must be used within a SettingsProvider')
  return ctx
}
