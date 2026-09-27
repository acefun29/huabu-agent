import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderKanban, FolderOpen, Plus } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'

/** 左上角工作区快速切换器：最近目录 / 打开目录 / 新建工作区（一个工作区 = 一个目录 = 一张画布） */
export function WorkspaceSwitcher() {
  const workspace = useCanvasStore((s) => s.workspace)
  const recents = useCanvasStore((s) => s.recents)
  const { openWorkspace, openDirDialog, createWorkspace } = useCanvasStore.getState()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const submitNew = () => {
    const n = name.trim()
    if (!n) return
    void createWorkspace(n)
    setName('')
    setCreating(false)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="workspace-badge"
        data-path={workspace?.path ?? ''}
        className="flex items-center gap-1.5 rounded-full bg-(--surface-chip) px-2.5 py-1 text-xs text-(--on-surface-variant) transition-colors hover:bg-(--surface-hover)"
        title="切换工作区（一个工作区绑定一个目录）"
      >
        <FolderKanban size={12} className="text-(--accent)" />
        <span className="max-w-[140px] truncate font-medium">{workspace?.name ?? '未选择工作区'}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="ctx-menu absolute left-0 top-full z-40 mt-2 w-72 rounded-2xl bg-(--surface-card) p-1.5 shadow-lg ring-1 ring-(--outline)">
          <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--on-surface-muted)">
            工作区 · 一个目录一张画布
          </div>
          {workspace && (
            <div className="px-2.5 pb-1 font-mono text-[10px] text-(--on-surface-muted)" title={workspace.path}>
              {workspace.path}
            </div>
          )}
          {recents
            .filter((r) => r.path !== workspace?.path)
            .map((r) => (
              <button
                key={r.path}
                onClick={() => {
                  void openWorkspace(r.path)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
              >
                <FolderKanban size={13} className="shrink-0 text-(--on-surface-muted)" />
                <span className="min-w-0 flex-1 truncate">
                  {r.name}
                  <span className="ml-1.5 font-mono text-[10px] text-(--on-surface-muted)">{r.path}</span>
                </span>
              </button>
            ))}
          <div className="mt-1 border-t border-(--outline-soft) pt-1">
            <button
              onClick={() => {
                void openDirDialog()
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
            >
              <FolderOpen size={13} />
              打开目录…
            </button>
            {creating ? (
              <div className="flex items-center gap-1 px-1.5 py-1">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitNew()
                    if (e.key === 'Escape') setCreating(false)
                  }}
                  placeholder="工作区名称"
                  className="min-w-0 flex-1 rounded-lg bg-(--surface-input) px-2 py-1.5 text-[12px] text-(--on-surface) outline-none placeholder:text-(--on-surface-muted)"
                />
                <button
                  onClick={submitNew}
                  className="rounded-lg bg-(--fab-bg) p-1.5 text-(--fab-text) transition hover:opacity-90"
                  title="创建"
                >
                  <Plus size={12} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
              >
                <Plus size={13} />
                新建工作区
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
