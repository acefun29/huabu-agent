/**
 * 右侧对话面板：**覆盖在画布之上**的一层，不挤压画布。
 *
 * 为什么是覆盖层：画布是无限空间，缩窄它会让视口/卡片位置跟着变（用户正在看的
 * 构图会漂）。覆盖层则是"面板浮在画布上"，打开/调宽都不影响画布本身的坐标。
 *
 * 宽度可拖左边缘调整（340–720），记在 localStorage，重启保持。
 * 宽度同时写进容器上的 CSS 变量 `--chat-w`，画布内的浮动控件（筛选条）据此避让。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatDock } from './ChatDock'

const WIDTH_KEY = 'huabu.chatPanelWidth'
const DEFAULT_WIDTH = 400
const MIN_WIDTH = 340
const MAX_WIDTH = 720

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
}

/** 读初始宽度：localStorage 坏值一律回落默认（面板宽度不值得让界面崩） */
function initialWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    const parsed = raw ? Number(raw) : Number.NaN
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

export function ChatPanel() {
  const [width, setWidth] = useState(initialWidth)
  const [dragging, setDragging] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width

  const persist = useCallback((next: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(next))
    } catch {
      // 隐私模式等：本次会话仍有效
    }
  }, [])

  /** 拖动左边缘：向右拖变窄、向左拖变宽（与面板在右侧一致） */
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current
    setDragging(true)
    const target = event.currentTarget
    target.setPointerCapture?.(event.pointerId)

    const onMove = (e: PointerEvent): void => {
      const next = clampWidth(startWidth - (e.clientX - startX))
      widthRef.current = next
      setWidth(next)
    }
    const onEnd = (): void => {
      setDragging(false)
      persist(widthRef.current)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  /** 双击把手 = 恢复默认宽度（拖歪了不用一点点拖回来） */
  const onDoubleClick = (): void => {
    setWidth(DEFAULT_WIDTH)
    widthRef.current = DEFAULT_WIDTH
    persist(DEFAULT_WIDTH)
  }

  // 宽度变化同步到 CSS 变量，供画布内浮动控件避让
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-w', `${width}px`)
    return () => {
      document.documentElement.style.removeProperty('--chat-w')
    }
  }, [width])

  return (
    <aside
      style={{ width }}
      data-testid="chat-panel"
      // 贴着右侧图标栏左边（rail 宽 48），与原型一致：画布 | 对话栏 | 图标栏。
      // top-11 = 让出自绘标题栏（容器不用 padding 让位）
      className="absolute bottom-0 right-12 top-11 z-40 flex flex-col border-l border-(--outline) bg-(--surface-card)"
    >
      {/*
        左边缘拖拽把手（原型 .chat-resize）：
        - 命中区宽 6px（好点），但**视觉只有 1px 线**，绝不铺整条高亮底
        - 悬停/拖拽时：1px 线变强调色，中段浮出一小截 3px 把手
      */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整对话栏宽度（双击恢复默认）"
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        className="group absolute bottom-0 left-0 top-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize touch-none"
      >
        {/* 1px 竖线：静默透明，悬停/拖拽才显色 */}
        <span
          className={`absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 transition-colors ${
            dragging ? 'bg-(--accent)' : 'bg-transparent group-hover:bg-(--outline)'
          }`}
        />
        {/* 中段小把手：只有悬停/拖拽时出现 */}
        <span
          className={`absolute left-1/2 top-1/2 h-[34px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--outline) transition-opacity ${
            dragging ? 'bg-(--accent) opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        />
      </div>
      <ChatDock />
    </aside>
  )
}
