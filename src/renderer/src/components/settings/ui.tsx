// 设置面板共用 UI 原子：Toggle / Row / Field / inputCls 与下拉 Select / ApiSelect（供各 tab 组件复用）

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { CHAT_API_LABEL, CHAT_MODEL_APIS, type ChatModelApi } from '@shared/chatApi'

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-(--accent)' : 'bg-(--toggle-off)'}`}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  )
}

export function Row({ title, desc, control }: { title: ReactNode; desc?: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-(--on-surface)">{title}</div>
        {desc && <div className="mt-0.5 text-xs leading-relaxed text-(--on-surface-muted)">{desc}</div>}
      </div>
      {control}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--on-surface-variant)">{label}</span>
      {children}
    </label>
  )
}

export const inputCls =
  'w-full rounded-lg bg-(--surface-input) px-3 py-1.5 text-[13px] text-(--on-surface) outline-none transition focus:ring-2 focus:ring-(--accent) placeholder:text-(--on-surface-muted)'

export interface SelectOption {
  value: string
  label: string
}

interface SelectPos {
  left: number
  width: number
  top?: number
  bottom?: number
}

const SELECT_GAP = 6
const SELECT_MARGIN = 8

/**
 * 表单下拉（替代原生 <select>）：触发钮沿用 inputCls 外观，选项浮层经 portal 挂到 body，
 * 与画布 ChipSelect 同一套视觉语言（圆角卡片 + ring + 勾选态）——原生下拉的系统菜单
 * 在 Windows 上与应用风格脱节且不支持深色模式。
 * 空间不足自动向上翻；Escape / 点外部 / 滚动收起；方向键移动高亮、回车选择。
 */
export function Select({
  value,
  onChange,
  options,
  variant = 'solid',
  hug = false,
  className = '',
  testId,
}: {
  value: string
  onChange: (next: string) => void
  options: SelectOption[]
  /** solid = 常规输入框外观；ghost = 透明底小字（内嵌在 chip 行里用） */
  variant?: 'solid' | 'ghost'
  /** true 时不占满父容器宽度（hug 内容），配合 className 定宽 */
  hug?: boolean
  className?: string
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActiveState] = useState(-1)
  const [pos, setPos] = useState<SelectPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  /* 回调 / 数据经 ref 供 window 级键盘监听取最新值，避免依赖变化反复解绑 */
  const optionsRef = useRef(options)
  optionsRef.current = options
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const activeRef = useRef(-1)
  const setActive = (i: number) => {
    activeRef.current = i
    setActiveState(i)
  }

  /* 打开时先隐藏挂载再量高定位：面板比下方空间高且上方更宽敞时向上翻 */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const el = triggerRef.current
    const panel = panelRef.current
    if (!el || !panel) return
    const r = el.getBoundingClientRect()
    const width = Math.max(r.width, 128)
    const left = Math.max(SELECT_MARGIN, Math.min(r.left, window.innerWidth - width - SELECT_MARGIN))
    const height = panel.offsetHeight
    const below = window.innerHeight - r.bottom - SELECT_MARGIN
    const above = r.top - SELECT_MARGIN
    if (height <= below || (height > above && below >= above)) {
      setPos({ left, width, top: r.bottom + SELECT_GAP })
    } else {
      setPos({ left, width, bottom: window.innerHeight - r.top + SELECT_GAP })
    }
  }, [open])

  /* 打开期间高亮当前选中项，并统一挂 window 级关闭 / 键盘监听 */
  useEffect(() => {
    if (!open) return
    setActive(optionsRef.current.findIndex((o) => o.value === valueRef.current))
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return
      if (triggerRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return
      e.preventDefault()
      const opts = optionsRef.current
      if (e.key === 'Enter') {
        const i = activeRef.current >= 0 ? activeRef.current : opts.findIndex((o) => o.value === valueRef.current)
        const hit = opts[i]
        if (hit) {
          onChangeRef.current(hit.value)
          setOpen(false)
        }
        return
      }
      const base = activeRef.current < 0 ? opts.findIndex((o) => o.value === valueRef.current) : activeRef.current
      setActive(Math.min(opts.length - 1, Math.max(0, base + (e.key === 'ArrowDown' ? 1 : -1))))
    }
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    window.addEventListener('wheel', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('wheel', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  /* 高亮项随键盘移动时保持可见 */
  useEffect(() => {
    if (!open || active < 0) return
    panelRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const current = options.find((o) => o.value === value)
  const triggerCls =
    variant === 'ghost'
      ? 'inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1 py-0.5 text-[11px] text-(--on-surface-muted) outline-none transition hover:text-(--on-surface) focus-visible:ring-2 focus-visible:ring-(--accent)'
      : 'flex cursor-pointer items-center gap-1.5 rounded-lg bg-(--surface-input) px-3 py-1.5 text-[13px] text-(--on-surface) outline-none transition focus:ring-2 focus:ring-(--accent)'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className={`${hug ? 'inline-flex' : 'flex w-full'} ${triggerCls} ${open ? 'ring-2 ring-(--accent)' : ''} ${className}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? ''}</span>
        <ChevronDown
          size={variant === 'ghost' ? 11 : 14}
          className={`shrink-0 opacity-55 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              left: pos?.left ?? -9999,
              width: pos?.width,
              top: pos?.top,
              bottom: pos?.bottom,
              visibility: pos ? 'visible' : 'hidden',
              transformOrigin: pos?.bottom !== undefined ? 'bottom left' : 'top left',
            }}
            data-scrollable=""
            className="ctx-menu fixed z-50 max-h-64 overflow-y-auto overscroll-contain rounded-2xl bg-(--surface-card) p-1.5 shadow-xl ring-1 ring-(--outline)"
          >
            {options.map((o, i) => {
              const selected = o.value === value
              return (
                <button
                  key={o.value}
                  type="button"
                  data-active={i === active || undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    onChange(o.value)
                    setOpen(false)
                    triggerRef.current?.focus()
                  }}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                    selected
                      ? 'bg-(--active-tint) font-medium text-(--accent)'
                      : i === active
                        ? 'bg-(--outline-soft) text-(--on-surface)'
                        : 'text-(--on-surface)'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {selected && <Check size={13} strokeWidth={3} className="shrink-0 text-(--accent)" />}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}

/**
 * 协议下拉。选项直接来自 shared/chatApi 的白名单 —— 不在这里再抄一份数组，
 * 否则主进程加第四种协议时这里会静默少一项（与 §2.5 那类"键名对、值不对"同一种错）。
 * allowFollow 时空串=不写模型级 api，跟随供应商。
 */
export function ApiSelect({
  value,
  onChange,
  allowFollow = false,
  testId
}: {
  value: ChatModelApi | ''
  onChange: (next: ChatModelApi | '') => void
  allowFollow?: boolean
  testId?: string
}) {
  return (
    <Select
      value={value}
      onChange={(next) => onChange(next as ChatModelApi | '')}
      testId={testId}
      options={[
        ...(allowFollow ? [{ value: '', label: '跟随供应商（缺省）' }] : []),
        ...CHAT_MODEL_APIS.map((api) => ({ value: api, label: `${api} · ${CHAT_API_LABEL[api]}` })),
      ]}
    />
  )
}
