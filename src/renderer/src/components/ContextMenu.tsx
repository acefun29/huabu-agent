import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useDismiss } from '../lib/hooks'

export interface ContextMenuItem {
  /** 分组标题（不可点击） */
  header?: string
  label?: string
  icon?: ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  /** 在该项前画分隔线 */
  separator?: boolean
}

const MENU_WIDTH = 212

/** 画布通用右键菜单：新建 / 导入 / 以此生成 / fork / 删除 等操作的统一入口 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // outside-click + Esc 关公共实现；wheel 滚动关闭是菜单特有行为，单独挂。
  // 菜单内部滚轮留给 max-height 溢出滚动，不关菜单
  useDismiss(ref, true, onClose)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWheel)
  }, [onClose])

  // 先按估算值定位（首帧不闪），绘制前用实测尺寸修正钳制——
  // items 多时实际高度远超估算，且 max-height 兜底后 top 必须按真实高度算
  const estHeight = Math.min(items.length * 34 + 16, window.innerHeight - 24)
  const [pos, setPos] = useState({
    left: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 12)),
    top: Math.max(8, Math.min(y, window.innerHeight - estHeight - 12)),
  })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const left = Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 12))
    const top = Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 12))
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }))
  }, [x, y, items])

  return (
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH, maxHeight: 'calc(100vh - 20px)' }}
      className="ctx-menu fixed z-50 overflow-y-auto rounded-2xl bg-(--surface-card) p-1.5 shadow-xl ring-1 ring-(--outline)"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.header) {
          return (
            <div
              key={`h-${i}`}
              className={`px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-(--on-surface-muted) ${
                item.separator ? 'mt-1 border-t border-(--outline-soft)' : ''
              }`}
            >
              {item.header}
            </div>
          )
        }
        return (
          <button
            key={`${item.label}-${i}`}
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.()
              onClose()
            }}
            className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              item.separator ? 'mt-1 border-t border-(--outline-soft) pt-2.5' : ''
            } ${
              item.danger
                ? 'text-(--danger) hover:bg-(--outline-soft)'
                : 'text-(--on-surface) hover:bg-(--outline-soft)'
            }`}
          >
            <span className="shrink-0 text-(--on-surface-muted)">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
