// 设置面板壳：Tab 定义 + 面板骨架与 tab 分派（各 tab 实现见 ./settings/）

import { useState, type ReactNode } from 'react'
import { Bot, Boxes, CirclePlay, Palette, PlugZap, Sparkles, Wand2, X } from 'lucide-react'
import { useSettingsUi } from '../store/settingsStore'
import { useEsc } from '../lib/hooks'
import { GuideTab, SkillsTab, McpTab, AgentTab, AppearanceTab } from './settings/tabs'
import { ProvidersTab } from './settings/ProvidersTab'
import { MediaTab } from './settings/MediaTab'

type TabKey = 'guide' | 'providers' | 'media' | 'skills' | 'mcp' | 'agent' | 'appearance'

const TABS: { key: TabKey; label: string; icon: ReactNode }[] = [
  { key: 'guide', label: '使用引导', icon: <CirclePlay size={15} /> },
  { key: 'providers', label: '模型供应商', icon: <Boxes size={15} /> },
  { key: 'media', label: '媒体生成', icon: <Wand2 size={15} /> },
  { key: 'skills', label: 'Skills', icon: <Sparkles size={15} /> },
  { key: 'mcp', label: 'MCP', icon: <PlugZap size={15} /> },
  { key: 'agent', label: 'Agent 接入', icon: <Bot size={15} /> },
  { key: 'appearance', label: '外观', icon: <Palette size={15} /> },
]

/* -------------------------------------------------------------------------- */

export function SettingsPanel() {
  const { isOpen, closeSettings } = useSettingsUi()
  const [tab, setTab] = useState<TabKey>('providers')

  useEsc(isOpen, closeSettings)

  return (
    <>
      {isOpen && (
        <div
          data-testid="settings-panel"
          onClick={closeSettings}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="ctx-menu flex h-[76vh] w-full max-w-4xl overflow-hidden rounded-[24px] bg-(--surface) shadow-2xl ring-1 ring-(--outline)"
          >
            <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-(--outline-soft) bg-(--glass) p-3 backdrop-blur">
              <div className="mb-2 px-2 text-[11px] font-semibold tracking-wider text-(--on-surface-muted) uppercase">
                设置
              </div>
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors ${
                    tab === t.key
                      ? 'bg-(--surface-chip) text-(--on-surface)'
                      : 'text-(--on-surface-variant) hover:bg-(--outline-soft)'
                  }`}
                >
                  <span className={tab === t.key ? 'text-(--accent)' : 'text-(--on-surface-muted)'}>{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between border-b border-(--outline-soft) px-6 py-4">
                <h2 className="text-[15px] font-semibold text-(--on-surface)">
                  {TABS.find((t) => t.key === tab)?.label}
                </h2>
                <button
                  onClick={closeSettings}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
                >
                  <X size={16} />
                </button>
              </div>
              <div data-scrollable="" className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                {tab === 'guide' && <GuideTab />}
                {tab === 'providers' && <ProvidersTab />}
                {tab === 'media' && <MediaTab />}
                {tab === 'skills' && <SkillsTab />}
                {tab === 'mcp' && <McpTab />}
                {tab === 'agent' && <AgentTab />}
                {tab === 'appearance' && <AppearanceTab />}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
