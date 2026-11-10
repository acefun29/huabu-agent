import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Eraser, Layers, MessageSquare, Settings } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import { useSettingsUi } from '../store/settingsStore'
import { isTransferDrag } from './sidebar/LibrariesPanel'
import type { RightPage } from './ChatPanel'

/**
 * 右侧图标栏（原型 .rail）：48px 贴边通栏，竖向排列。
 *
 * 语义与原型一致：**切换右侧栏的页面**，不弹浮窗。
 * - 对话 / 素材库：互斥的两个页面（同一块右侧空间）
 * - 清空画布：两步确认的快捷工具
 * - 设置：打开设置面板
 *
 * 再点一次当前页的图标 = 收起右侧栏（原型 toggleRightPage → right-collapsed），
 * 画布恢复全宽；再点任一图标重新展开到该页。
 */
export function SessionSidebar({
  page,
  collapsed,
  onPageChange,
}: {
  page: RightPage
  collapsed: boolean
  onPageChange: (page: RightPage) => void
}) {
  const nodeCount = useCanvasStore((s) => s.nodes.length)
  const { clearCanvas } = useCanvasStore.getState()
  const { openSettings } = useSettingsUi()
  /** 清空画布两步确认：第一次点击进入确认态，3 秒内再点才执行 */
  const [clearArmed, setClearArmed] = useState(false)
  const clearTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current)
    },
    []
  )

  const onClearClick = useCallback(() => {
    if (!clearArmed) {
      setClearArmed(true)
      clearTimer.current = window.setTimeout(() => setClearArmed(false), 3000)
      return
    }
    if (clearTimer.current) window.clearTimeout(clearTimer.current)
    setClearArmed(false)
    clearCanvas()
  }, [clearArmed, clearCanvas])

  return (
    <aside
      // 贴右边缘的通栏（原型 .rail）：48px 竖条，左侧一条分隔线，浅色底。
      // top-11 = 让出自绘标题栏（容器不用 padding 让位）。
      className="absolute bottom-0 right-0 top-11 z-50 flex w-12 flex-col items-center justify-start gap-1.5 border-l border-(--outline) bg-(--chrome-bg) py-3"
    >
      <RailButton
        icon={<MessageSquare size={16} />}
        label="对话"
        active={page === 'chat' && !collapsed}
        onClick={() => onPageChange('chat')}
        tourKey="rail-sessions"
      />
      <RailButton
        icon={<Layers size={16} />}
        label="素材库"
        active={page === 'library' && !collapsed}
        onClick={() => onPageChange('library')}
        tourKey="rail-libraries"
        // 拖着素材经过素材库图标时切到素材库页（落点仍是具体库条目）
        onDragEnter={(e) => {
          if (isTransferDrag(e)) onPageChange('library')
        }}
        onDragOver={(e) => {
          if (isTransferDrag(e)) e.preventDefault()
        }}
      />

      <span className="mt-1 h-px w-6 shrink-0 bg-(--outline)" />

      {/* 清空画布（两步确认；画布为空时禁用） */}
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
        onClick={() => openSettings()}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
        title="设置"
      >
        <Settings size={16} />
      </motion.button>
    </aside>
  )
}

/** 页面切换按钮（原型 .rail-btn / .rail-btn.active） */
function RailButton({
  icon,
  label,
  active,
  onClick,
  tourKey,
  onDragEnter,
  onDragOver,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  tourKey: string
  onDragEnter?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
}) {
  return (
    <motion.button
      data-tour={tourKey}
      whileTap={{ scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      onClick={onClick}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      className={`flex h-9 w-9 items-center justify-center rounded-2xl transition-colors ${
        active
          ? 'bg-(--surface-chip) text-(--accent) shadow-sm'
          : 'text-(--on-surface-variant) hover:bg-(--outline-soft)'
      }`}
      title={label}
      aria-label={label}
      aria-expanded={active}
    >
      {icon}
    </motion.button>
  )
}
