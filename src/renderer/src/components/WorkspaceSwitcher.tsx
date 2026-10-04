import { useRef, useState } from 'react'
import { Check, ChevronDown, FolderKanban, FolderOpen, ListChecks, Plus, Trash2 } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import { useDismiss } from '../lib/hooks'

/**
 * 左上角工作区快速切换器：最近目录 / 打开目录 / 新建工作区（一个工作区 = 一个目录 = 一张画布）。
 * 批量管理：管理态下点行勾选（不切换），删除走确认弹窗——目录移入系统回收站，可恢复；
 * 当前打开的工作区不在可删清单里（主进程同样拒绝，正在使用中的工作区先切走才能删）。
 */
export function WorkspaceSwitcher() {
  const workspace = useCanvasStore((s) => s.workspace)
  const recents = useCanvasStore((s) => s.recents)
  const { openWorkspace, openDirDialog, createWorkspace, deleteWorkspaces, requestConfirm } =
    useCanvasStore.getState()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  /** 批量管理：多选删除；选中集只在管理态有意义 */
  const [managing, setManaging] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)

  // 可删除清单 = 最近列表去掉当前工作区（正在使用的由主进程兜底拒绝，UI 直接不列）
  const deletable = recents.filter((r) => r.path !== workspace?.path)

  /** 关浮层（点外/Esc/选完动作）：顺带退出批量管理，选中集不跨开合保留 */
  const close = () => {
    setOpen(false)
    setManaging(false)
    setSelected(new Set())
  }

  useDismiss(rootRef, open, close)

  const submitNew = () => {
    const n = name.trim()
    if (!n) return
    void createWorkspace(n)
    setName('')
    setCreating(false)
    close()
  }

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const allSelected = deletable.length > 0 && selected.size >= deletable.length
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(deletable.map((r) => r.path)))

  const onBatchDelete = () => {
    const paths = [...selected]
    if (paths.length === 0) return
    requestConfirm({
      title: `删除 ${paths.length} 个工作区？`,
      body: '工作区目录将移入系统回收站（可在回收站恢复）；画布、素材库清单与会话记录随目录一起移除。正在使用中的工作区不受影响。',
      confirmLabel: '删除工作区',
      danger: true,
      onConfirm: () => {
        void deleteWorkspaces(paths).then((result) => {
          if (result) setSelected(new Set())
        })
      }
    })
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
          {/* 头部：普通态是标题+管理入口；管理态换成已选计数+全选/删除/完成 */}
          {managing ? (
            <div className="flex items-center gap-1 px-2.5 pb-1 pt-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">
                批量管理
                <span className="ml-1.5 font-normal text-(--on-surface-muted)">
                  已选 {selected.size}/{deletable.length}
                </span>
              </span>
              <button
                onClick={toggleAll}
                className="shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium text-(--on-surface-variant) transition-colors hover:bg-(--surface-chip) hover:text-(--accent)"
                title="全选 / 取消全选"
              >
                {allSelected ? '取消全选' : '全选'}
              </button>
              <button
                data-testid="workspace-batch-delete"
                onClick={onBatchDelete}
                disabled={selected.size === 0}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${
                  selected.size === 0
                    ? 'cursor-default text-(--on-surface-muted) opacity-40'
                    : 'text-(--danger) hover:bg-(--danger)/10'
                }`}
                title="删除所选工作区（移入回收站）"
              >
                <Trash2 size={13} />
              </button>
              <button
                onClick={() => {
                  setManaging(false)
                  setSelected(new Set())
                }}
                className="flex h-6 shrink-0 items-center justify-center rounded-full px-1.5 text-[10.5px] font-medium text-(--on-surface-variant) transition-colors hover:bg-(--surface-chip) hover:text-(--accent)"
                title="完成批量管理"
              >
                完成
              </button>
            </div>
          ) : (
            <div className="flex items-center px-2.5 pb-1 pt-1.5">
              <span className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wider text-(--on-surface-muted)">
                工作区 · 一个目录一张画布
              </span>
              {deletable.length > 0 && (
                <button
                  data-testid="workspace-manage"
                  onClick={() => setManaging(true)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-(--on-surface-variant) transition-colors hover:bg-(--surface-chip) hover:text-(--accent)"
                  title="批量管理工作区（多选删除）"
                >
                  <ListChecks size={13} />
                </button>
              )}
            </div>
          )}
          {workspace && (
            <div className="px-2.5 pb-1 font-mono text-[10px] text-(--on-surface-muted)" title={workspace.path}>
              {workspace.path}
            </div>
          )}
          {deletable.map((r) =>
            managing ? (
              <div
                key={r.path}
                data-testid="workspace-item"
                data-selected={selected.has(r.path) ? 'true' : undefined}
                onClick={() => toggleSelect(r.path)}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors ${
                  selected.has(r.path) ? 'bg-(--accent)/12 ring-1 ring-(--accent)/40' : 'hover:bg-(--outline-soft)'
                }`}
              >
                <FolderKanban size={13} className="shrink-0 text-(--on-surface-muted)" />
                <span className="min-w-0 flex-1 truncate">
                  {r.name}
                  <span className="ml-1.5 font-mono text-[10px] text-(--on-surface-muted)">{r.path}</span>
                </span>
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                    selected.has(r.path)
                      ? 'border-(--accent) bg-(--accent) text-white'
                      : 'border-(--outline) bg-transparent text-transparent'
                  }`}
                >
                  <Check size={10} strokeWidth={2.5} />
                </span>
              </div>
            ) : (
              <button
                key={r.path}
                data-testid="workspace-item"
                onClick={() => {
                  void openWorkspace(r.path)
                  close()
                }}
                className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
              >
                <FolderKanban size={13} className="shrink-0 text-(--on-surface-muted)" />
                <span className="min-w-0 flex-1 truncate">
                  {r.name}
                  <span className="ml-1.5 font-mono text-[10px] text-(--on-surface-muted)">{r.path}</span>
                </span>
              </button>
            )
          )}
          <div className="mt-1 border-t border-(--outline-soft) pt-1">
            <button
              onClick={() => {
                void openDirDialog()
                close()
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
              !managing && (
                <button
                  onClick={() => setCreating(true)}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
                >
                  <Plus size={13} />
                  新建工作区
                </button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}
