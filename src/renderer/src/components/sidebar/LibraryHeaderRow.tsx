import { memo } from 'react'
import { ChevronDown, ChevronRight, Layers, Trash2 } from 'lucide-react'
import type { MaterialLibrary } from '../../types'

/** 拖拽落点动词：OS 文件=复制，画布卡/库条目=移动 */
type DropVerb = '复制' | '移动'

interface LibraryHeaderRowProps {
  lib: MaterialLibrary
  /** 当前是否展开（搜索态强制展开，由面板计算好传入） */
  open: boolean
  /** 是否为本库的拖拽落点 */
  dropping: boolean
  /** 落点动词徽标文案（dropping 时必有值） */
  dropVerb: DropVerb | null
  onToggle: (id: string, fallback: boolean) => void
  onDragOver: (e: React.DragEvent, lib: MaterialLibrary) => void
  onDragLeave: (id: string) => void
  onDrop: (e: React.DragEvent, lib: MaterialLibrary) => void
  onRemove: (id: string) => void
}

/**
 * 库头行（memo）。自定义比较：搜索过滤会把库条目拷贝出新引用（{...l, files: 过滤后}），
 * 逐字保留的 filteredLibraries 结构下 lib 身份在击键时不稳定，但头行渲染的
 * id/name/isPublic/builtin 随库 id 恒定（无改名库的 action），故按数据态比较；
 * 回调全部经 useCallback / store action 恒定引用，不参与比较。
 */
export const LibraryHeaderRow = memo(
  function LibraryHeaderRow({ lib, open, dropping, dropVerb, onToggle, onDragOver, onDragLeave, onDrop, onRemove }: LibraryHeaderRowProps) {
    return (
      <div
        onClick={() => onToggle(lib.id, Boolean(lib.isPublic || lib.builtin))}
        onDragOver={(e) => onDragOver(e, lib)}
        onDragLeave={() => onDragLeave(lib.id)}
        onDrop={(e) => onDrop(e, lib)}
        data-testid={`library-drop-${lib.id}`}
        className={`group flex cursor-pointer items-center gap-1.5 rounded-2xl px-2 py-2 transition-colors ${
          dropping ? 'bg-(--surface-chip) ring-1 ring-(--accent)/50' : 'hover:bg-(--outline-soft)'
        }`}
        title="拖放素材到此：画布卡片/库内文件 = 移动；电脑文件 = 复制"
      >
        <span className="shrink-0 text-(--on-surface-muted)">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <Layers size={13} className={`shrink-0 ${lib.isPublic ? 'text-(--accent)' : 'text-(--on-surface-muted)'}`} />
        <span title={lib.name} className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-(--on-surface-variant)">
          {lib.name}
        </span>
        {dropping && (
          <span className="shrink-0 rounded-full bg-(--accent) px-1.5 py-0.5 text-[9px] font-medium text-white">
            松开{dropVerb}到此库
          </span>
        )}
        {lib.isPublic && !dropping && (
          <span className="shrink-0 rounded-full bg-(--surface-chip) px-1.5 py-0.5 text-[9px] font-medium text-(--accent)">
            公共
          </span>
        )}
        {!lib.isPublic && !lib.builtin && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              void onRemove(lib.id)
            }}
            className="pointer-events-none shrink-0 rounded-full p-1 text-(--on-surface-muted) opacity-0 transition group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-(--surface-card) hover:text-(--danger)"
            title="移除素材库映射（不删除文件）"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    )
  },
  (a, b) => a.lib.id === b.lib.id && a.open === b.open && a.dropping === b.dropping && a.dropVerb === b.dropVerb
)
