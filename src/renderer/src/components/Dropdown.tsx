import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { motion } from 'motion/react'

const GAP = 6
const MARGIN = 8
/** 触发按钮与面板共用的最小宽度，保证「默认 · mock/image-v1」不被压扁 */
const PANEL_MIN_WIDTH = 196

interface Pos {
  left: number
  width: number
  top?: number
  bottom?: number
}

/**
 * 卡片参数条上的下拉 chip：点击在触发按钮旁浮出选项面板。
 * 用 portal 挂到 body——卡片本身 overflow-hidden，面板若留在卡片内会被裁掉；
 * 空间不足时自动向上翻转，画布平移 / 缩放下自动收起。
 */
export function ChipSelect({
  icon,
  label,
  title,
  overridden,
  open,
  onOpenChange,
  minWidth = PANEL_MIN_WIDTH,
  disabled,
  children,
}: {
  icon?: ReactNode
  label: string
  title?: string
  /** 该值被卡片手动覆盖（区别于跟随默认），chip 用强调色标记 */
  overridden?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  minWidth?: number
  disabled?: boolean
  children: (close: () => void) => ReactNode
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos | null>(null)

  const place = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = Math.max(minWidth, r.width)
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN))
    const below = window.innerHeight - r.bottom - MARGIN
    const above = r.top - MARGIN
    // 下方放不下且上方更宽敞时向上翻
    if (below < 220 && above > below) {
      setPos({ left, width, bottom: window.innerHeight - r.top + GAP })
    } else {
      setPos({ left, width, top: r.bottom + GAP })
    }
  }

  useLayoutEffect(() => {
    if (open) place()
    else setPos(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return
      if (triggerRef.current?.contains(e.target as Node)) return
      onOpenChange(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    const onScroll = (e: Event) => {
      // 面板自身滚动（模型列表）不算
      if (panelRef.current?.contains(e.target as Node)) return
      onOpenChange(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('wheel', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('wheel', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onOpenChange])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        onClick={(e) => {
          e.stopPropagation()
          onOpenChange(!open)
        }}
        className={`flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[10.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          overridden
            ? 'bg-(--active-tint) text-(--accent) hover:brightness-[0.98]'
            : 'bg-(--surface-chip) text-(--on-surface-variant) hover:bg-(--surface-hover)'
        } ${open ? 'ring-1 ring-(--accent)' : ''}`}
      >
        {icon && <span className="flex shrink-0 items-center opacity-80">{icon}</span>}
        <span className="max-w-[96px] truncate">{label}</span>
        <ChevronDown size={11} className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open &&
        pos &&
        createPortal(
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: pos.top !== undefined ? -4 : 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.13, ease: 'easeOut' }}
            style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            onMouseDown={(e) => e.stopPropagation()}
            // portal 里的 React 事件仍沿组件树冒泡到画布根节点，会被当成缩放手势
            onWheel={(e) => e.stopPropagation()}
            data-scrollable=""
            className="ctx-menu fixed z-50 max-h-64 overflow-y-auto overscroll-contain rounded-2xl bg-(--surface-card) p-1.5 shadow-xl ring-1 ring-(--outline)"
          >
            {children(() => onOpenChange(false))}
          </motion.div>,
          document.body
        )}
    </>
  )
}

/** 面板分组标题：跟随默认 / 供应商分组 */
export function MenuGroup({ label, first }: { label: string; first?: boolean }) {
  return (
    <div
      className={`px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-(--on-surface-muted) ${
        first ? 'pt-1.5' : 'mt-1 border-t border-(--outline-soft) pt-2'
      }`}
    >
      {label}
    </div>
  )
}

/** 面板选项：选中态用强调色 + 勾，标签单行截断，右侧可挂一段弱提示 */
export function MenuItem({
  label,
  hint,
  icon,
  selected,
  disabled,
  onClick,
}: {
  label: ReactNode
  hint?: string
  icon?: ReactNode
  selected?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        selected ? 'bg-(--active-tint) font-medium text-(--accent)' : 'text-(--on-surface) hover:bg-(--outline-soft)'
      }`}
    >
      {icon && <span className="flex shrink-0 items-center opacity-80">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 font-mono text-[10px] text-(--on-surface-muted)">{hint}</span>}
      {selected && <Check size={12} strokeWidth={3} className="shrink-0 text-(--accent)" />}
    </button>
  )
}

/** 面板脚注：解释默认值来源 / 兜底优先级 */
export function MenuNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 border-t border-(--outline-soft) px-2 pb-0.5 pt-1.5 text-[10px] leading-relaxed text-(--on-surface-muted)">
      {children}
    </div>
  )
}
