import { memo, useCallback, useMemo } from 'react'
import { create } from 'zustand'
import { Plus, Search, StickyNote, Tag as TagIcon, X } from 'lucide-react'
import type { MaterialLibrary } from '../../types'
import { useCanvasStore } from '../../store/canvasStore'
import {
  dragSourceTypes,
  parseAssetIdsPayload,
  parseLegacyAssetPayload,
  parseLibraryEntryPayload
} from '../../lib/dragPayload'
import { LibraryFileRow } from './LibraryFileRow'
import { LibraryHeaderRow } from './LibraryHeaderRow'
import { Stagger } from './Stagger'

/** 素材库面板的文件条目类型（LIBRARY_ASSET_MIME 载荷里的 entry） */
type LibraryEntry = MaterialLibrary['files'][number]

/** 拖拽落点动词：OS 文件=复制，画布卡/库条目=移动 */
type DropVerb = '复制' | '移动'

/**
 * 素材库面板的交互 state（从壳下沉至此）。
 *
 * 为什么是模块级 store 而不是 useState：面板内容包在壳的 AnimatePresence mode="wait"
 * motion.div（key=openTab）里，切页与关/开面板都会把本组件整棵卸载；拆分前这些 state
 * 挂在常驻的 SessionSidebar 壳上，搜索词、展开态、重命名/新建草稿跨切页与关开面板都保留。
 * useState 下沉会被卸载清零（行为变化），模块 store 等价保留原持久语义；
 * 侧栏整体卸载（回到工作区选择页）时由壳调 reset()，对齐原“state 随侧栏卸载而清零”。
 */
interface LibrariesPanelState {
  /** 素材库搜索：按文件名或标签（支持 #前缀 写法），与标签 chips 过滤叠加 */
  query: string
  tagFilter: string | null
  /** 条目内联重命名：正在编辑的条目 relPath 与草稿 */
  renaming: { relPath: string; draft: string } | null
  /** 展开状态：公共库默认展开 */
  expanded: Record<string, boolean>
  /** 拖拽悬停的库条目（含落点动词） */
  dropTarget: { id: string; verb: DropVerb } | null
  creating: boolean
  libName: string
  setQuery: (query: string) => void
  setTagFilter: (tag: string | null) => void
  setRenaming: (renaming: { relPath: string; draft: string } | null) => void
  toggleExpanded: (id: string, fallback: boolean) => void
  hoverLibrary: (id: string, verb: DropVerb) => void
  leaveLibrary: (id: string) => void
  clearDropTarget: () => void
  setCreating: (creating: boolean) => void
  setLibName: (name: string) => void
  reset: () => void
}

const INITIAL_PANEL_STATE = {
  query: '',
  tagFilter: null,
  renaming: null,
  expanded: {},
  dropTarget: null,
  creating: false,
  libName: ''
} satisfies Partial<LibrariesPanelState>

export const useLibrariesPanelStore = create<LibrariesPanelState>()((set) => ({
  ...INITIAL_PANEL_STATE,
  setQuery: (query) => set({ query }),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  setRenaming: (renaming) => set({ renaming }),
  toggleExpanded: (id, fallback) => set((s) => ({ expanded: { ...s.expanded, [id]: !(s.expanded[id] ?? fallback) } })),
  // 等价于原 setDropTarget((prev) => (prev?.id === id && prev.verb === verb ? prev : { id, verb }))：
  // 命中时返回原 state（zustand 跳过通知，与 React setState 的 bail-out 一致）
  hoverLibrary: (id, verb) => set((s) => (s.dropTarget?.id === id && s.dropTarget.verb === verb ? s : { dropTarget: { id, verb } })),
  leaveLibrary: (id) => set((s) => (s.dropTarget?.id === id ? { dropTarget: null } : s)),
  clearDropTarget: () => set((s) => (s.dropTarget === null ? s : { dropTarget: null })),
  setCreating: (creating) => set({ creating }),
  setLibName: (libName) => set({ libName }),
  reset: () => set({ ...INITIAL_PANEL_STATE })
}))

/* ---------------- 拖拽源识别：三种源都收（OS 文件=复制，画布卡/库条目=移动） ---------------- */

/** 是否为可归档拖拽（壳的 rail 素材库图标 hover 展开也用它判断，故导出） */
export const isTransferDrag = (e: React.DragEvent): boolean => {
  const k = dragSourceTypes(e.dataTransfer.types)
  return k.osFiles || k.libraryEntry || k.canvasNodes
}

/**
 * 素材库面板内容：搜索 + 标签 chips + 库清单 + 新建入口。
 * query/tagFilter/renaming/expanded/dropTarget/creating/libName 全部下沉到本文件级 store ——
 * 搜索/重命名击键只重渲本面板与受影响的行，壳与会话面板不再重渲。
 */
export const LibrariesPanel = memo(function LibrariesPanel({ onClose }: { onClose: () => void }) {
  // 低频面板：素材库精确订阅；actions 恒定引用
  const libraries = useCanvasStore((s) => s.libraries)
  const { createLibrary, removeLibrary, importFromLibrary, createNote, renameAsset } = useCanvasStore.getState()
  const query = useLibrariesPanelStore((s) => s.query)
  const tagFilter = useLibrariesPanelStore((s) => s.tagFilter)
  const renaming = useLibrariesPanelStore((s) => s.renaming)
  const expanded = useLibrariesPanelStore((s) => s.expanded)
  const dropTarget = useLibrariesPanelStore((s) => s.dropTarget)
  const creating = useLibrariesPanelStore((s) => s.creating)
  const libName = useLibrariesPanelStore((s) => s.libName)
  const setQuery = useLibrariesPanelStore((s) => s.setQuery)
  const setTagFilter = useLibrariesPanelStore((s) => s.setTagFilter)
  const setRenaming = useLibrariesPanelStore((s) => s.setRenaming)
  const setCreating = useLibrariesPanelStore((s) => s.setCreating)
  const setLibName = useLibrariesPanelStore((s) => s.setLibName)
  const toggleExpanded = useLibrariesPanelStore((s) => s.toggleExpanded)
  const hoverLibrary = useLibrariesPanelStore((s) => s.hoverLibrary)
  const leaveLibrary = useLibrariesPanelStore((s) => s.leaveLibrary)
  const clearDropTarget = useLibrariesPanelStore((s) => s.clearDropTarget)

  /* ---------------- 拖拽归档：库条目 dragover/drop（行为逐字保留） ---------------- */

  const onLibDragOver = useCallback(
    (e: React.DragEvent, lib: MaterialLibrary) => {
      if (!isTransferDrag(e)) return
      e.preventDefault()
      const k = dragSourceTypes(e.dataTransfer.types)
      const verb: DropVerb = k.osFiles && !k.libraryEntry && !k.canvasNodes ? '复制' : '移动'
      e.dataTransfer.dropEffect = verb === '复制' ? 'copy' : 'move'
      hoverLibrary(lib.id, verb)
    },
    [hoverLibrary]
  )

  const onLibDrop = useCallback(
    (e: React.DragEvent, lib: MaterialLibrary) => {
      if (!isTransferDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      clearDropTarget()
      const store = useCanvasStore.getState()
      const k = dragSourceTypes(e.dataTransfer.types)
      if (k.osFiles && e.dataTransfer.files.length > 0) {
        void store.dropFilesToLibrary(Array.from(e.dataTransfer.files), lib.id)
        return
      }
      if (k.libraryEntry) {
        // 载荷解析+形状校验收口在 dragPayload（非法 = null，直接忽略）
        const payload = parseLibraryEntryPayload(e.dataTransfer)
        if (payload) void store.moveLibraryFile(payload.libraryId, payload.entry, lib.id)
        return
      }
      // 画布卡片：批量（ASSET_IDS_MIME）优先，单卡回退遗留通道（LEGACY_ASSET_MIME）
      const ids = parseAssetIdsPayload(e.dataTransfer)
      if (ids && ids.length > 0) {
        void store.moveAssetsToLibrary(ids, lib.id)
        return
      }
      const single = parseLegacyAssetPayload(e.dataTransfer)
      if (single) void store.moveAssetsToLibrary([single], lib.id)
    },
    [clearDropTarget]
  )

  /* ---------------- 素材库搜索：文件名/标签文本 + 标签 chips 过滤（与画布标签同源） ---------------- */

  const allTags = useMemo(
    () => Array.from(new Set(libraries.flatMap((l) => l.files.flatMap((f) => f.tags ?? [])))).sort((a, b) => a.localeCompare(b)),
    [libraries]
  )
  const matchEntry = (f: LibraryEntry): boolean => {
    if (tagFilter && !(f.tags ?? []).includes(tagFilter)) return false
    const q = query.trim().toLowerCase().replace(/^#/, '')
    if (!q) return true
    if (f.name.toLowerCase().includes(q)) return true
    return (f.tags ?? []).some((t) => t.toLowerCase().includes(q))
  }
  const searching = query.trim() !== '' || tagFilter !== null
  const filteredLibraries = useMemo(
    () => (searching ? libraries.map((l) => ({ ...l, files: l.files.filter(matchEntry) })).filter((l) => l.files.length > 0) : libraries),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [libraries, query, tagFilter]
  )

  const isExpanded = (lib: MaterialLibrary) => expanded[lib.id] ?? Boolean(lib.isPublic || lib.builtin)

  /* ---------------- 素材条目操作：重命名 / 删除（二次确认）/ 在文件管理器中显示 ---------------- */

  /** 在系统文件管理器中显示文件（无 bridge 环境直接提示；失败 toast） */
  const revealEntry = useCallback((f: LibraryEntry) => {
    if (!window.huabu?.workspace) {
      useCanvasStore.getState().showToast('当前环境不支持打开文件管理器')
      return
    }
    void window.huabu.workspace.reveal(f.relPath).then((r) => {
      if (!r.ok) useCanvasStore.getState().showToast(`打开失败：${r.error}`)
    })
  }, [])

  /** 删除素材条目：真删文件并清画布引用卡，走全局 ConfirmDialog 二次确认 */
  const confirmDeleteEntry = useCallback((f: LibraryEntry) => {
    useCanvasStore.getState().requestConfirm({
      title: `删除「${f.name}」？`,
      body: '将永久删除工作区内的文件（不可恢复），画布上引用它的卡片也会一并移除。',
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => {
        void useCanvasStore.getState().deleteAsset(f)
      },
    })
  }, [])

  /** 提交内联重命名：草稿为空或与原名相同只退出编辑，不调 store（编辑态经 getState 现取，回调引用恒定） */
  const submitRename = useCallback(
    (f: LibraryEntry) => {
      const cur = useLibrariesPanelStore.getState().renaming
      if (!cur || cur.relPath !== f.relPath) return
      const draft = cur.draft.trim()
      setRenaming(null)
      if (draft && draft !== f.name) void renameAsset(f, draft)
    },
    [setRenaming, renameAsset]
  )

  const submitLibrary = useCallback(() => {
    const n = libName.trim()
    if (!n) return
    void createLibrary(n)
    setLibName('')
    setCreating(false)
  }, [libName, createLibrary, setLibName, setCreating])

  // 文件行的重命名回调：引用恒定（memo 行 props 稳定的前提）
  const onStartRename = useCallback((file: LibraryEntry) => setRenaming({ relPath: file.relPath, draft: file.name }), [setRenaming])
  const onRenameChange = useCallback((relPath: string, draft: string) => setRenaming({ relPath, draft }), [setRenaming])
  const onCancelRename = useCallback(() => setRenaming(null), [setRenaming])

  return (
    <>
      {/* 素材库搜索：文件名 / 标签（支持 #前缀）；与下方标签 chips 过滤叠加 */}
      <div className="mb-1 px-1.5">
        <div className="flex items-center gap-1.5 rounded-xl bg-(--surface-input) px-2.5 py-1.5 ring-1 ring-(--outline-soft) focus-within:ring-2 focus-within:ring-(--accent)/40">
          <Search size={12} className="shrink-0 text-(--on-surface-muted)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="搜索文件名或 #标签…"
            className="min-w-0 flex-1 bg-transparent text-[11.5px] text-(--on-surface) outline-none placeholder:text-(--on-surface-muted)"
          />
          {searching && (
            <button
              onClick={() => {
                setQuery('')
                setTagFilter(null)
              }}
              className="shrink-0 rounded-full p-0.5 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface)"
              title="清除搜索与标签过滤"
            >
              <X size={11} />
            </button>
          )}
        </div>
        {allTags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {allTags.map((t) => (
              <button
                key={t}
                onClick={() => setTagFilter(tagFilter === t ? null : t)}
                className={`flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium transition-colors ${
                  tagFilter === t
                    ? 'bg-(--accent) text-white'
                    : 'bg-(--surface-chip) text-(--on-surface-variant) hover:bg-(--outline-soft)'
                }`}
                title={tagFilter === t ? '点击取消该标签过滤' : '只看带此标签的文件'}
              >
                <TagIcon size={8} />
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {filteredLibraries.length === 0 && (
        <div className="px-3 py-4 text-center text-[11px] text-(--on-surface-muted)">没有匹配的文件</div>
      )}
      {filteredLibraries.map((lib, i) => {
        const open = searching ? true : isExpanded(lib)
        const dropping = dropTarget?.id === lib.id
        return (
          <Stagger key={lib.id} index={i}>
            <div className="mb-0.5">
              <LibraryHeaderRow
                lib={lib}
                open={open}
                dropping={dropping}
                dropVerb={dropping && dropTarget ? dropTarget.verb : null}
                onToggle={toggleExpanded}
                onDragOver={onLibDragOver}
                onDragLeave={leaveLibrary}
                onDrop={onLibDrop}
                onRemove={removeLibrary}
              />
              {open && (
                <div className="pb-1 pl-6 pr-1">
                  <div className="truncate px-1 pb-1 font-mono text-[9.5px] text-(--on-surface-muted)" title={lib.path}>
                    {lib.path}
                  </div>
                  {lib.files.length === 0 && (
                    <div className="rounded-lg border border-dashed border-(--outline) px-2 py-1.5 text-[10.5px] text-(--on-surface-muted)">
                      暂无文件 · 可把素材拖到这里
                    </div>
                  )}
                  {lib.files.map((f) => {
                    const editing = renaming?.relPath === f.relPath
                    return (
                      <LibraryFileRow
                        key={f.relPath}
                        libraryId={lib.id}
                        file={f}
                        renaming={editing}
                        draft={editing && renaming ? renaming.draft : ''}
                        onStartRename={onStartRename}
                        onRenameChange={onRenameChange}
                        onSubmitRename={submitRename}
                        onCancelRename={onCancelRename}
                        onImport={importFromLibrary}
                        onReveal={revealEntry}
                        onDelete={confirmDeleteEntry}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </Stagger>
        )
      })}

      {/* 新建素材库 / 新建笔记（md，落公共素材库并钉到画布） */}
      <div className="mt-1.5 border-t border-(--outline-soft) pt-1.5">
        <div className="flex items-center gap-1">
          {creating ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1">
              <input
                autoFocus
                value={libName}
                onChange={(e) => setLibName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitLibrary()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setCreating(false)
                  }
                }}
                placeholder="素材库名称（映射到 素材库/名称/）"
                className="min-w-0 flex-1 rounded-lg bg-(--surface-input) px-2 py-1.5 text-[11.5px] text-(--on-surface) outline-none placeholder:text-(--on-surface-muted)"
              />
              <button
                onClick={submitLibrary}
                className="rounded-lg bg-(--fab-bg) p-1.5 text-(--fab-text) transition hover:opacity-90"
                title="创建"
              >
                <Plus size={12} />
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => setCreating(true)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[12px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
              >
                <Plus size={13} />
                新建素材库
              </button>
              <button
                onClick={() => {
                  void createNote()
                  onClose()
                }}
                className="flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-2 text-[12px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
                title="新建 md 笔记：落在公共素材库并钉到画布"
              >
                <StickyNote size={13} />
                新建笔记
              </button>
            </>
          )}
        </div>
      </div>
    </>
  )
})
