/**
 * 设置面板「媒体生成」页：左侧为生成默认值与供应商清单，右侧按选择渲染
 * 默认值编辑、新增供应商表单或供应商详情。
 */

import { useEffect, useState } from 'react'
import { Plus, SlidersHorizontal } from 'lucide-react'
import { useMediaSettings } from '../../store/settingsStore'
import { MediaAddProviderView } from './media/AddProviderView'
import { MediaDefaultsView } from './media/DefaultsView'
import { MediaProviderDetail } from './media/ProviderDetail'
import type { MediaView } from './media/shared'

export function MediaTab() {
  const { mediaProviders, mediaStatus, mediaLoaded, mediaLoadError, refreshMedia } = useMediaSettings()
  const [view, setView] = useState<MediaView>('defaults')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!mediaLoaded) void refreshMedia()
  }, [mediaLoaded, refreshMedia])

  const agentProviderId = mediaStatus?.agentProvider ?? ''
  const selected = mediaProviders.find((p) => p.id === selectedId)
  // 供应商被删除后详情页失去目标，回落到默认值页
  const effectiveView: MediaView = view === 'provider' && !selected ? 'defaults' : view

  return (
    <div className="flex h-full gap-5" data-testid="media-tab">
      {/* 左栏：生成默认值 + 供应商清单 + 新增入口（对标「模型供应商」页的主从结构） */}
      <div data-scrollable="" className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto">
        {mediaLoadError && (
          <div role="alert" className="px-3 py-2 text-xs text-(--on-surface-muted)">
            <p>{mediaLoadError}</p>
            <button type="button" className="mt-1 underline" onClick={() => void refreshMedia()}>重试</button>
          </div>
        )}
        <div
          onClick={() => {
            setNotice(null)
            setView('defaults')
          }}
          className={`flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 transition-colors ${
            effectiveView === 'defaults' ? 'bg-(--surface-chip)' : 'hover:bg-(--outline-soft)'
          }`}
        >
          <SlidersHorizontal size={13} className="shrink-0 text-(--on-surface-muted)" />
          <span className="truncate text-[13px] font-medium text-(--on-surface)">生成默认值</span>
        </div>
        <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold tracking-wider text-(--on-surface-muted)">
          供应商（{mediaProviders.length}）
        </div>
        {mediaProviders.map((p) => (
          <div
            key={p.id}
            onClick={() => {
              setNotice(null)
              setSelectedId(p.id)
              setView('provider')
            }}
            className={`flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 transition-colors ${
              effectiveView === 'provider' && p.id === selected?.id ? 'bg-(--surface-chip)' : 'hover:bg-(--outline-soft)'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.configured ? 'bg-(--success-dot)' : 'bg-(--on-surface-muted)'}`}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-(--on-surface)">{p.label}</span>
            {p.id === agentProviderId && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--accent)" title="Agent 默认供应商" />
            )}
            <span className="shrink-0 text-[10px] text-(--on-surface-muted)" title="模型数量">
              {p.models.length}
            </span>
          </div>
        ))}
        <button
          onClick={() => {
            setNotice(null)
            setView('add')
          }}
          className={`mt-1 flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors ${
            effectiveView === 'add'
              ? 'bg-(--surface-chip) text-(--on-surface)'
              : 'text-(--on-surface-variant) hover:bg-(--outline-soft)'
          }`}
        >
          <Plus size={13} />
          新增供应商
        </button>
        <div className="mt-auto px-2 pb-1 pt-2 text-[10px] leading-relaxed text-(--on-surface-muted)">
          媒体供应商与对话供应商是两套独立配置；这里的改动都写入当前工作区 workspace.json
        </div>
      </div>

      {/* 右栏：默认值编辑页 / 新增供应商表单 / 供应商详情 */}
      <div data-scrollable="" className="min-w-0 flex-1 overflow-y-auto border-l border-(--outline-soft) pl-5">
        {notice && (
          <div
            className={`mb-3 text-[12px] ${notice.includes('失败') ? 'text-(--danger)' : 'text-(--on-surface-muted)'}`}
            data-testid="media-notice"
          >
            {notice}
          </div>
        )}
        {effectiveView === 'defaults' ? (
          <MediaDefaultsView />
        ) : effectiveView === 'add' ? (
          <MediaAddProviderView
            onDone={(id, message) => {
              setNotice(message)
              setSelectedId(id)
              setView('provider')
            }}
            onCancel={() => setView(selected ? 'provider' : 'defaults')}
            onNotice={setNotice}
          />
        ) : selected ? (
          <MediaProviderDetail providerId={selected.id} onNotice={setNotice} />
        ) : (
          <div className="pt-10 text-center text-[12px] text-(--on-surface-muted)">加载中…</div>
        )}
      </div>
    </div>
  )
}
