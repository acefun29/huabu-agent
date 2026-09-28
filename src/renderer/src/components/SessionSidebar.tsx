import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Eraser, Layers, MessageSquare, Plus, Settings, X } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import { useSettingsUi } from '../store/settingsStore'
import { isTransferDrag, LibrariesPanel, useLibrariesPanelStore } from './sidebar/LibrariesPanel'
import { SessionsPanel } from './sidebar/SessionsPanel'

type SideTab = 'sessions' | 'libraries'

const SIDE_TABS: { key: SideTab; label: string; icon: ReactNode; tourKey: string }[] = [
  { key: 'sessions', label: '会话', icon: <MessageSquare size={16} />, tourKey: 'rail-sessions' },
  { key: 'libraries', label: '素材库', icon: <Layers size={16} />, tourKey: 'rail-libraries' },
]

/**
 * 左侧常驻图标栏（壳）：
 * 一列竖向图标按钮，点某个图标不挤压画布，而是在旁边浮出一块圆角半透明面板，装载该图标对应的内容
 * （会话目录 / 素材库清单）。再点一次、点面板外、或按 Esc 收起；画布宽度始终不变。
 *
 * 拆分后壳只保留低频状态（面板开合、清空两步确认）；会话/素材库面板下沉到 sidebar/ 下的
 * SessionsPanel / LibrariesPanel —— 搜索、重命名、拖拽悬停等高频击键只重渲对应面板，
 * 画布节点增删（nodes.length）也不再重渲面板内容。
 */
export function SessionSidebar() {
  // 低频面板：节点数（rail 清空按钮禁用态）与会话数（头部计数）精确订阅；actions 恒定引用
  const nodeCount = useCanvasStore((s) => s.nodes.length)
  const sessionCount = useCanvasStore((s) => s.sessions.length)
  const { clearCanvas, switchSession, createSession } = useCanvasStore.getState()
  const { openSettings } = useSettingsUi()
  const [openTab, setOpenTab] = useState<SideTab | null>(null)
  /** 清空画布两步确认：第一次点击进入确认态，3 秒内再点才执行 */
  const [clearArmed, setClearArmed] = useState(false)
  const railRef = useRef<HTMLElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const clearTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current)
      // 素材库面板交互 state 在模块级 store（面板卸载后仍保留，对齐拆分前壳级 state 跨关开面板的持久语义）；
      // 侧栏整体卸载（回到工作区选择页）时由壳重置，对齐原“state 随侧栏卸载而清零”
      useLibrariesPanelStore.getState().reset()
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

  // 面板打开时：点面板/图标栏之外任意处、或按 Esc 收起。
  // 手写双 ref 监听而不用 lib/hooks 的 useDismiss：rail 与 panel 是两个都算“内部”的元素，单 ref 的 dismiss hook 不适用
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

  /** 会话行点击：切换会话并收起面板（回调恒定 → memo 的 SessionsPanel 不因壳重渲而重渲） */
  const onSwitchSession = useCallback(
    (id: string) => {
      switchSession(id)
      setOpenTab(null)
    },
    [switchSession]
  )

  /** 收起面板（素材库“新建笔记”后调用） */
  const onClosePanel = useCallback(() => setOpenTab(null), [])

  const activeTab = SIDE_TABS.find((t) => t.key === openTab)

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
                  <span className="ml-1.5 text-[11px] font-normal text-(--on-surface-muted)">{sessionCount} 段</span>
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
                  // 新建素材库的 creating 状态在 LibrariesPanel 的文件级 store，头部按钮跨组件直调
                  onClick={() => useLibrariesPanelStore.getState().setCreating(true)}
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
                {openTab === 'sessions' ? <SessionsPanel onSwitch={onSwitchSession} /> : <LibrariesPanel onClose={onClosePanel} />}
              </motion.div>
            </AnimatePresence>
          </motion.section>
        )}
      </AnimatePresence>
    </>
  )
}
