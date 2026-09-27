import { useEffect, useRef, type ReactNode } from 'react'

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

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  const estHeight = items.length * 34 + 16
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 12))
  const top = Math.max(8, Math.min(y, window.innerHeight - estHeight - 12))

  return (
    <div
      ref={ref}
      style={{ left, top, width: MENU_WIDTH }}
      className="ctx-menu fixed z-50 rounded-2xl bg-(--surface-card) p-1.5 shadow-xl ring-1 ring-(--outline)"
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
