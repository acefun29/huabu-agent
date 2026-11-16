/** 全量模型库浏览（数据源 = 随应用打包的只读目录，main/media/catalog/browse.ts）。 */

import { useEffect, useState } from 'react'
import { useMediaSettings } from '../../../store/settingsStore'
import type { MediaCatalogBrowseItem } from '@shared/ipc'
import type { MediaKind } from '../../../types'
import { KIND_LABEL } from '../../../types'

export function MediaCatalogBrowser({
  providerId,
  onNotice,
}: {
  providerId: string
  onNotice: (message: string | null) => void
}) {
  const { mediaBrowseCatalog, mediaUserAddModel } = useMediaSettings()
  const [items, setItems] = useState<MediaCatalogBrowseItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<MediaKind | 'all'>('all')

  useEffect(() => {
    let alive = true
    setItems(null)
    setQuery('')
    setKindFilter('all')
    void mediaBrowseCatalog(providerId).then((list) => {
      if (alive) setItems(list)
    })
    return () => {
      alive = false
    }
  }, [providerId, mediaBrowseCatalog])

  if (items === null) {
    return <div className="text-[11px] text-(--on-surface-muted)">模型库加载中…</div>
  }
  if (items.length === 0) return null

  const q = query.trim().toLowerCase()
  const filtered = items.filter(
    (it) =>
      (kindFilter === 'all' || it.kind === kindFilter) &&
      (!q || `${it.label} ${it.id} ${it.provider ?? ''}`.toLowerCase().includes(q))
  )
  const shown = filtered.slice(0, 120)
  const countOf = (k: MediaKind) => items.reduce((n, it) => n + (it.kind === k ? 1 : 0), 0)

  const add = async (item: MediaCatalogBrowseItem) => {
    const error = await mediaUserAddModel({
      providerId,
      id: item.id,
      kind: item.kind,
      label: item.label,
      ...(item.capabilities ? { capabilities: item.capabilities } : {})
    })
    if (error) {
      onNotice(`添加模型失败：${error}`)
      return
    }
    onNotice(`已添加模型：${item.label}`)
    setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, enabled: true } : i)) ?? prev)
  }

  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-(--on-surface-variant)">
        浏览完整模型库（{items.length} 个，点「添加」进入上方可生成清单）
      </div>
      <div className="rounded-xl bg-(--surface-input) p-2">
        <div className="mb-1 flex items-center gap-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型名 / id / 提供方…"
            className="min-w-0 flex-1 rounded-lg bg-(--surface-card) px-2.5 py-1 text-[12px] text-(--on-surface) outline-none transition focus:ring-2 focus:ring-(--accent) placeholder:text-(--on-surface-muted)"
          />
          {(['all', 'image', 'video', 'audio'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={`shrink-0 rounded-full px-2 py-1 text-[11px] transition-colors ${
                kindFilter === k
                  ? 'bg-(--surface-chip) font-medium text-(--on-surface)'
                  : 'text-(--on-surface-muted) hover:bg-(--outline-soft)'
              }`}
            >
              {k === 'all' ? `全部 ${items.length}` : `${KIND_LABEL[k]} ${countOf(k)}`}
            </button>
          ))}
        </div>
        <div data-scrollable="" className="max-h-56 divide-y divide-(--outline-soft) overflow-y-auto">
          {shown.map((item) => (
            <div key={item.id} className="flex items-center gap-2 py-1.5">
              <span className="w-8 shrink-0 text-[10px] text-(--on-surface-muted)">{KIND_LABEL[item.kind]}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-(--on-surface)">{item.label}</div>
                <div className="truncate font-mono text-[10px] text-(--on-surface-muted)">
                  {item.id}
                  {item.provider ? ` · ${item.provider}` : ''}
                </div>
              </div>
              {item.needsExtra && item.needsExtra.length > 0 && (
                <span
                  className="shrink-0 rounded-full bg-(--surface-chip) px-1.5 py-0.5 text-[9px] text-(--on-surface-variant)"
                  title={`除提示词外还需 ${item.needsExtra.join('、')} 等参数，当前版本只提交提示词/比例/时长/参考图，生成可能失败`}
                >
                  需参数
                </span>
              )}
              {item.enabled ? (
                <span className="w-12 shrink-0 text-center text-[10px] text-(--success-text)">已添加</span>
              ) : (
                <button
                  onClick={() => void add(item)}
                  className="w-12 shrink-0 rounded-full bg-(--fab-bg) py-0.5 text-[10px] font-medium text-(--fab-text) transition hover:opacity-90"
                >
                  添加
                </button>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="py-3 text-center text-[11px] text-(--on-surface-muted)">没有匹配的模型</div>
          )}
        </div>
        {filtered.length > shown.length && (
          <div className="pt-1 text-center text-[10px] text-(--on-surface-muted)">
            还有 {filtered.length - shown.length} 条，请用搜索缩小范围
          </div>
        )}
      </div>
    </div>
  )
}
