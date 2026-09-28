import { memo } from 'react'
import { Check, FolderOpen, PenLine, StickyNote, Trash2, X } from 'lucide-react'
import type { MaterialLibrary } from '../../types'
import { LIBRARY_ASSET_MIME } from '../../store/canvasStore'
import { kindIcon } from '../AssetNode'

/** 素材库面板的文件条目类型（LIBRARY_ASSET_MIME 载荷里的 entry） */
type LibraryEntry = MaterialLibrary['files'][number]

interface LibraryFileRowProps {
  /** 所属库 id（拖拽载荷与钉画布入参用；按值传入保持 props 稳定） */
  libraryId: string
  file: LibraryEntry
  /** 本行是否处于重命名编辑态（受控：state 在面板，草稿值经 draft 传入） */
  renaming: boolean
  /** 重命名草稿（renaming 时为输入框受控值） */
  draft: string
  onStartRename: (file: LibraryEntry) => void
  onRenameChange: (relPath: string, draft: string) => void
  onSubmitRename: (file: LibraryEntry) => void
  onCancelRename: () => void
  onImport: (libraryId: string, file: LibraryEntry) => void
  onReveal: (file: LibraryEntry) => void
  onDelete: (file: LibraryEntry) => void
}

/**
 * 单个文件条目行（memo，重命名/普通两态）：file 引用随 zustand 库条目恒定、回调恒定，
 * 搜索击键与重命名击键都只有受影响的行重渲。
 */
export const LibraryFileRow = memo(function LibraryFileRow({
  libraryId,
  file: f,
  renaming,
  draft,
  onStartRename,
  onRenameChange,
  onSubmitRename,
  onCancelRename,
  onImport,
  onReveal,
  onDelete
}: LibraryFileRowProps) {
  if (renaming) {
    return (
      /* 重命名模式：条目原位换成输入框 + 确认/取消（Enter 提交 / Esc 取消 / 失焦提交） */
      <div className="flex items-center gap-1 rounded-lg px-2 py-1">
        <input
          autoFocus
          value={draft}
          onChange={(e) => onRenameChange(f.relPath, e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmitRename(f)
            if (e.key === 'Escape') {
              e.stopPropagation()
              onCancelRename()
            }
          }}
          onBlur={() => onSubmitRename(f)}
          className="min-w-0 flex-1 rounded-md bg-(--surface-input) px-2 py-1 text-[11.5px] text-(--on-surface) outline-none ring-1 ring-(--accent)/40"
        />
        <button
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            onSubmitRename(f)
          }}
          className="shrink-0 rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--accent)"
          title="确认重命名（Enter）"
        >
          <Check size={11} />
        </button>
        <button
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            onCancelRename()
          }}
          className="shrink-0 rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--danger)"
          title="取消重命名（Esc）"
        >
          <X size={11} />
        </button>
      </div>
    )
  }
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(LIBRARY_ASSET_MIME, JSON.stringify({ libraryId, entry: f }))
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onClick={() => onImport(libraryId, f)}
      className="group flex cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-(--outline-soft) active:cursor-grabbing"
      title="点击钉到画布 · 拖到画布任意位置 · 拖到其他素材库 = 移动"
    >
      <span className="shrink-0 text-(--on-surface-muted)">
        {f.kind === 'doc' && /\.md$/i.test(f.name) ? <StickyNote size={11} /> : kindIcon(f.kind, 11)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-(--on-surface)">{f.name}</span>
      {/* 右侧组：标签徽标（最多 2 个）+ hover 淡入的条目操作；常驻占位避免悬停时列表跳动 */}
      <span className="flex shrink-0 items-center gap-1.5">
        {(f.tags ?? []).slice(0, 2).map((t) => (
          <span key={t} className="rounded-full bg-(--active-tint) px-1.5 py-px text-[9px] font-medium text-(--accent)">
            {t}
          </span>
        ))}
        <span className="pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onStartRename(f)
            }}
            className="rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--accent)"
            title="重命名"
          >
            <PenLine size={11} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onReveal(f)
            }}
            className="rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--accent)"
            title="在文件管理器中显示"
          >
            <FolderOpen size={11} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete(f)
            }}
            className="rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--danger)"
            title="删除（不可恢复）"
          >
            <Trash2 size={11} />
          </button>
        </span>
      </span>
    </div>
  )
})
