import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Eraser,
  FileCode,
  FileText,
  FolderOpen,
  GitFork,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  PenLine,
  Plus,
  Search,
  Settings,
  StickyNote,
  Tag as TagIcon,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import type { AssetKind, MaterialLibrary } from '../types'
import { ASSET_IDS_MIME, LIBRARY_ASSET_MIME, useCanvasStore } from '../store/canvasStore'
import { useSettingsUi } from '../store/settingsStore'

type SideTab = 'sessions' | 'libraries'

/** 素材库面板的文件条目类型（LIBRARY_ASSET_MIME 载荷里的 entry） */
type LibraryEntry = MaterialLibrary['files'][number]

const SIDE_TABS: { key: SideTab; label: string; icon: ReactNode; tourKey: string }[] = [
  { key: 'sessions', label: '会话', icon: <MessageSquare size={16} />, tourKey: 'rail-sessions' },
  { key: 'libraries', label: '素材库', icon: <Layers size={16} />, tourKey: 'rail-libraries' },
]

function kindIcon(kind: AssetKind, size = 13) {
  if (kind === 'image') return <ImageIcon size={size} />
  if (kind === 'video') return <Video size={size} />
  if (kind === 'audio') return <AudioLines size={size} />
  if (kind === 'doc') return <FileText size={size} />
  return <FileCode size={size} />
}

function formatDay(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 列表项入场：轻微错开，面板打开时有一层层铺开的感觉 */
function Stagger({ index, children }: { index: number; children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.018, 0.14), duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  )
}

/**
 * 左侧常驻图标栏：
 * 一列竖向图标按钮，点某个图标不挤压画布，而是在旁边浮出一块圆角半透明面板，装载该图标对应的内容
 * （会话目录 / 素材库清单）。再点一次、点面板外、或按 Esc 收起；画布宽度始终不变。
 */
export function SessionSidebar() {
  // 低频面板：节点数/会话清单/素材库精确订阅；actions 恒定引用
  const nodeCount = useCanvasStore((s) => s.nodes.length)
  const sessions = useCanvasStore((s) => s.sessions)
  const activeSessionId = useCanvasStore((s) => s.activeSessionId)
  const libraries = useCanvasStore((s) => s.libraries)
  const { clearCanvas, switchSession, createSession, requestRemoveSession, forkSession, createLibrary, removeLibrary, importFromLibrary, createNote, renameAsset } =
    useCanvasStore.getState()
  const { openSettings } = useSettingsUi()
  const [openTab, setOpenTab] = useState<SideTab | null>(null)
  const [creating, setCreating] = useState(false)
  const [libName, setLibName] = useState('')
  /** 展开状态：公共库默认展开 */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** 拖拽悬停的库条目（含落点动词：OS 文件=复制，画布卡/库条目=移动） */
  const [dropTarget, setDropTarget] = useState<{ id: string; verb: '复制' | '移动' } | null>(null)
  /** 素材库搜索：按文件名或标签（支持 #前缀 写法），与标签 chips 过滤叠加 */
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  /** 条目内联重命名：正在编辑的条目 relPath 与草稿 */
  const [renaming, setRenaming] = useState<{ relPath: string; draft: string } | null>(null)
  /** 清空画布两步确认：第一次点击进入确认态，3 秒内再点才执行 */
  const [clearArmed, setClearArmed] = useState(false)
  const railRef = useRef<HTMLElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const clearTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current)
    },
    []
  )

  const onClearClick = () => {
    if (!clearArmed) {
      setClearArmed(true)
      clearTimer.current = window.setTimeout(() => setClearArmed(false), 3000)
      return
    }
    if (clearTimer.current) window.clearTimeout(clearTimer.current)
    setClearArmed(false)
    clearCanvas()
  }

  // 面板打开时：点面板/图标栏之外任意处、或按 Esc 收起
  useEffect(() => {
    if (!openTab) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (railRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpenTab(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenTab(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [openTab])

  const isExpanded = (lib: MaterialLibrary) => expanded[lib.id] ?? Boolean(lib.isPublic || lib.builtin)
  const toggleExpanded = (id: string, fallback: boolean) =>
    setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? fallback) }))

  const submitLibrary = () => {
    const n = libName.trim()
    if (!n) return
    void createLibrary(n)
    setLibName('')
    setCreating(false)
  }

  /* ---------------- 拖拽归档：三种源都收（OS 文件=复制，画布卡/库条目=移动） ---------------- */

  const dragSources = (types: readonly string[]) => ({
    osFiles: types.includes('Files'),
    libraryEntry: types.includes(LIBRARY_ASSET_MIME),
    canvasNodes: types.includes(ASSET_IDS_MIME) || types.includes('application/x-huabu-asset')
  })

  const isTransferDrag = (e: React.DragEvent): boolean => {
    const k = dragSources(e.dataTransfer.types)
    return k.osFiles || k.libraryEntry || k.canvasNodes
  }

  const onLibDragOver = (e: React.DragEvent, lib: MaterialLibrary) => {
    if (!isTransferDrag(e)) return
    e.preventDefault()
    const k = dragSources(e.dataTransfer.types)
    const verb: '复制' | '移动' = k.osFiles && !k.libraryEntry && !k.canvasNodes ? '复制' : '移动'
    e.dataTransfer.dropEffect = verb === '复制' ? 'copy' : 'move'
    setDropTarget((prev) => (prev?.id === lib.id && prev.verb === verb ? prev : { id: lib.id, verb }))
  }

  const onLibDrop = (e: React.DragEvent, lib: MaterialLibrary) => {
    if (!isTransferDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const store = useCanvasStore.getState()
    const k = dragSources(e.dataTransfer.types)
    if (k.osFiles && e.dataTransfer.files.length > 0) {
      void store.dropFilesToLibrary(Array.from(e.dataTransfer.files), lib.id)
      return
    }
    if (k.libraryEntry) {
      try {
        const { libraryId, entry } = JSON.parse(e.dataTransfer.getData(LIBRARY_ASSET_MIME)) as {
          libraryId: string
          entry: LibraryEntry
        }
        void store.moveLibraryFile(libraryId, entry, lib.id)
      } catch {
        /* 非法载荷忽略 */
      }
      return
    }
    // 画布卡片：批量（ASSET_IDS_MIME）优先，单卡回退 application/x-huabu-asset
    const idsRaw = e.dataTransfer.getData(ASSET_IDS_MIME)
    try {
      const ids = idsRaw ? (JSON.parse(idsRaw) as string[]) : []
      if (Array.isArray(ids) && ids.length > 0) {
        void store.moveAssetsToLibrary(ids, lib.id)
        return
      }
    } catch {
      /* 落到单卡通道 */
    }
    const single = e.dataTransfer.getData('application/x-huabu-asset')
    if (single) void store.moveAssetsToLibrary([single], lib.id)
  }

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

  const activeTab = SIDE_TABS.find((t) => t.key === openTab)

  /* ---------------- 素材条目操作：重命名 / 删除（二次确认）/ 在文件管理器中显示 ---------------- */

  /** 在系统文件管理器中显示文件（无 bridge 环境直接提示；失败 toast） */
  const revealEntry = (f: LibraryEntry) => {
    if (!window.huabu?.workspace) {
      useCanvasStore.getState().showToast('当前环境不支持打开文件管理器')
      return
    }
    void window.huabu.workspace.reveal(f.relPath).then((r) => {
      if (!r.ok) useCanvasStore.getState().showToast(`打开失败：${r.error}`)
    })
  }

  /** 删除素材条目：真删文件并清画布引用卡，走全局 ConfirmDialog 二次确认 */
  const confirmDeleteEntry = (f: LibraryEntry) => {
    useCanvasStore.getState().requestConfirm({
      title: `删除「${f.name}」？`,
      body: '将永久删除工作区内的文件（不可恢复），画布上引用它的卡片也会一并移除。',
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => {
        void useCanvasStore.getState().deleteAsset(f)
      },
    })
  }

  /** 提交内联重命名：草稿为空或与原名相同只退出编辑，不调 store */
  const submitRename = (f: LibraryEntry) => {
    if (renaming?.relPath !== f.relPath) return
    const draft = renaming.draft.trim()
    setRenaming(null)
    if (draft && draft !== f.name) void renameAsset(f, draft)
  }

  return (
    <>
      {/* 图标栏：常驻浮层，竖向排列；上半是会话/素材库面板入口，下半是清空画布快捷工具与设置入口 */}
      <aside
        ref={railRef}
        className="absolute left-3 top-[56px] z-20 flex w-12 flex-col items-center gap-1.5 rounded-2xl bg-(--chrome-bg) py-2.5 shadow-(--chrome-shadow) ring-1 ring-(--outline-soft)"
      >
        {SIDE_TABS.map((t) => {
          const active = openTab === t.key
          return (
            <motion.button
              key={t.key}
              data-tour={t.tourKey}
              whileTap={{ scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              onClick={() => setOpenTab((prev) => (prev === t.key ? null : t.key))}
              // 拖着素材经过素材库图标时自动展开面板（hover 展开，落点仍是具体库条目）
              onDragEnter={(e) => {
                if (t.key === 'libraries' && isTransferDrag(e)) setOpenTab('libraries')
              }}
              onDragOver={(e) => {
                if (t.key === 'libraries' && isTransferDrag(e)) e.preventDefault()
              }}
              className={`flex h-9 w-9 items-center justify-center rounded-2xl transition-colors ${
                active
                  ? 'bg-(--surface-chip) text-(--accent) shadow-sm'
                  : 'text-(--on-surface-variant) hover:bg-(--outline-soft)'
              }`}
              title={`${t.label} · 点开浮层面板`}
              aria-expanded={active}
            >
              {t.icon}
            </motion.button>
          )
        })}

        <span className="mt-1 h-px w-6 shrink-0 bg-(--outline)" />

        {/* 快捷工具：清空画布（两步确认；画布为空时禁用） */}
        <motion.button
          data-tour="rail-clear"
          data-testid="clear-canvas"
          data-confirming={clearArmed ? 'true' : 'false'}
          whileTap={{ scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          onClick={onClearClick}
          disabled={nodeCount === 0}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl transition-colors ${
            clearArmed
              ? 'bg-(--danger) text-white'
              : nodeCount === 0
                ? 'cursor-default text-(--on-surface-muted) opacity-40'
                : 'text-(--on-surface-variant) hover:bg-(--outline-soft)'
          }`}
          title={
            nodeCount === 0
              ? '画布为空'
              : clearArmed
                ? '再点一次确认清空（只移除画布引用卡片，素材库文件不受影响）'
                : '清空画布 · 点两次确认（只移除引用卡片，素材库文件不受影响）'
          }
        >
          <Eraser size={16} />
        </motion.button>

        <motion.button
          data-tour="rail-settings"
          whileTap={{ scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          onClick={openSettings}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
          title="设置"
        >
          <Settings size={16} />
        </motion.button>
      </aside>

      {/* 浮层面板：圆角、半透明、弹簧入场 */}
      <AnimatePresence>
        {openTab && activeTab && (
          <motion.section
            ref={panelRef}
            key="side-panel"
            initial={{ opacity: 0, x: -16, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -12, scale: 0.97, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }}
            transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.85 }}
            style={{ transformOrigin: 'left center', willChange: 'transform, opacity' }}
            className="absolute left-[72px] top-[56px] z-40 flex max-h-[min(620px,calc(100%-68px))] w-[304px] flex-col overflow-hidden rounded-3xl bg-(--panel-float) shadow-[0_18px_50px_rgba(0,0,0,0.16)] ring-1 ring-(--outline) backdrop-blur-2xl"
          >
            {/* 面板头部 */}
            <div className="flex shrink-0 items-center gap-2 px-4 pb-2.5 pt-3.5">
              <span className="min-w-0 truncate text-[13px] font-semibold">
                {activeTab.label}
                {openTab === 'sessions' && (
                  <span className="ml-1.5 text-[11px] font-normal text-(--on-surface-muted)">{sessions.length} 段</span>
                )}
              </span>
              {openTab === 'sessions' ? (
                <button
                  data-testid="create-session"
                  onClick={() => createSession()}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-(--on-surface-variant) transition-colors hover:bg-(--surface-chip) hover:text-(--accent)"
                  title="新建会话"
                >
                  <Plus size={14} />
                </button>
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-(--on-surface-variant) transition-colors hover:bg-(--surface-chip) hover:text-(--accent)"
                  title="新建素材库"
                >
                  <Plus size={14} />
                </button>
              )}
              <button
                onClick={() => setOpenTab(null)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-(--on-surface-muted) transition-colors hover:bg-(--surface-chip) hover:text-(--on-surface)"
                title="收起面板（Esc）"
              >
                <X size={13} />
              </button>
            </div>

            {/* 面板内容：切页时轻微交叉淡入 */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={openTab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15, ease: [0.2, 0.8, 0.2, 1] }}
                data-scrollable=""
                className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
              >
                {openTab === 'sessions' ? (
                  <>
                    {sessions.length === 0 && (
                      <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-(--on-surface-muted)">
                        还没有会话
                        <br />
                        点标题栏的 + 新建一个
                      </div>
                    )}
                    {sessions.map((s, i) => {
                      const active = s.id === activeSessionId
                      return (
                        <Stagger key={s.id} index={i}>
                          <div
                            data-testid="session-item"
                            onClick={() => {
                              switchSession(s.id)
                              setOpenTab(null)
                            }}
                            className={`group mb-0.5 cursor-pointer rounded-2xl px-3 py-2 transition-colors ${
                              active ? 'bg-(--surface-chip) ring-1 ring-(--accent)/30' : 'hover:bg-(--outline-soft)'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <MessageSquare size={13} className={`shrink-0 ${active ? 'text-(--accent)' : 'text-(--on-surface-muted)'}`} />
                              <span
                                title={s.title}
                                className={`min-w-0 flex-1 truncate text-[12.5px] ${active ? 'font-semibold text-(--on-surface)' : 'font-medium text-(--on-surface-variant)'}`}
                              >
                                {s.title}
                              </span>
                              {/* 常驻占位 + 只切换透明度：悬停不改变任何尺寸，避免列表跳动 */}
                              <span className="pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void forkSession(s.id)
                                  }}
                                  className="rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--accent)"
                                  title="分叉新会话（复制本会话对话历史；画布为工作区公用，不受影响）"
                                >
                                  <GitFork size={12} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    requestRemoveSession(s.id)
                                  }}
                                  className="rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--danger)"
                                  title="删除会话（不删除素材文件）"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 pl-[21px] text-[10px] text-(--on-surface-muted)">
                              {s.forkedFromLabel ? (
                                <span className="flex min-w-0 items-center gap-1">
                                  <GitFork size={9} className="shrink-0" />
                                  <span className="truncate">来自 {s.forkedFromLabel}</span>
                                </span>
                              ) : (
                                <span>{formatDay(s.createdAt)} 创建</span>
                              )}
                            </div>
                          </div>
                        </Stagger>
                      )
                    })}
                  </>
                ) : (
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
                            <div
                              onClick={() => toggleExpanded(lib.id, Boolean(lib.isPublic || lib.builtin))}
                              onDragOver={(e) => onLibDragOver(e, lib)}
                              onDragLeave={() => setDropTarget((prev) => (prev?.id === lib.id ? null : prev))}
                              onDrop={(e) => onLibDrop(e, lib)}
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
                                  松开{dropTarget.verb}到此库
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
                                    void removeLibrary(lib.id)
                                  }}
                                  className="pointer-events-none shrink-0 rounded-full p-1 text-(--on-surface-muted) opacity-0 transition group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-(--surface-card) hover:text-(--danger)"
                                  title="移除素材库映射（不删除文件）"
                                >
                                  <Trash2 size={11} />
                                </button>
                              )}
                            </div>
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
                                {lib.files.map((f) =>
                                  renaming?.relPath === f.relPath ? (
                                    /* 重命名模式：条目原位换成输入框 + 确认/取消（Enter 提交 / Esc 取消 / 失焦提交） */
                                    <div key={f.relPath} className="flex items-center gap-1 rounded-lg px-2 py-1">
                                      <input
                                        autoFocus
                                        value={renaming.draft}
                                        onChange={(e) => setRenaming({ relPath: f.relPath, draft: e.target.value })}
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') submitRename(f)
                                          if (e.key === 'Escape') {
                                            e.stopPropagation()
                                            setRenaming(null)
                                          }
                                        }}
                                        onBlur={() => submitRename(f)}
                                        className="min-w-0 flex-1 rounded-md bg-(--surface-input) px-2 py-1 text-[11.5px] text-(--on-surface) outline-none ring-1 ring-(--accent)/40"
                                      />
                                      <button
                                        onMouseDown={(e) => {
                                          e.preventDefault()
                                          e.stopPropagation()
                                        }}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          submitRename(f)
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
                                          setRenaming(null)
                                        }}
                                        className="shrink-0 rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--danger)"
                                        title="取消重命名（Esc）"
                                      >
                                        <X size={11} />
                                      </button>
                                    </div>
                                  ) : (
                                    <div
                                      key={f.relPath}
                                      draggable
                                      onDragStart={(e) => {
                                        e.dataTransfer.setData(LIBRARY_ASSET_MIME, JSON.stringify({ libraryId: lib.id, entry: f }))
                                        e.dataTransfer.effectAllowed = 'copyMove'
                                      }}
                                      onClick={() => importFromLibrary(lib.id, f)}
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
                                              setRenaming({ relPath: f.relPath, draft: f.name })
                                            }}
                                            className="rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--accent)"
                                            title="重命名"
                                          >
                                            <PenLine size={11} />
                                          </button>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation()
                                              revealEntry(f)
                                            }}
                                            className="rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--accent)"
                                            title="在文件管理器中显示"
                                          >
                                            <FolderOpen size={11} />
                                          </button>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation()
                                              confirmDeleteEntry(f)
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
                                )}
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
                                setOpenTab(null)
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
                )}
              </motion.div>
            </AnimatePresence>
          </motion.section>
        )}
      </AnimatePresence>
    </>
  )
}
