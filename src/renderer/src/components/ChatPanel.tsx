/**
 * 右侧面板：**覆盖在画布之上**的一层，不挤压画布。
 *
 * 为什么是覆盖层：画布是无限空间，缩窄它会让视口/卡片位置跟着变（用户正在看的
 * 构图会漂）。覆盖层则是"面板浮在画布上"，打开/调宽都不影响画布本身的坐标。
 *
 * 双页面（原型 .right-page）：**对话**与**素材库**是同一块右侧栏的两个页面，
 * 由图标栏切换、互斥显示 —— 不是浮窗、不叠加画布。素材库与对话并列在同一空间里，
 * 才能在"看着对话、翻素材库、拖素材进对话"之间无缝切换。
 *
 * 宽度可拖左边缘调整（340–720），记在 localStorage，重启保持；
 * 同时写进 CSS 变量 `--chat-w`，画布内浮动控件据此避让。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { ChatDock } from './ChatDock'
import { useCanvasStore } from '../store/canvasStore'
import { LibrariesPanel, useLibrariesPanelStore } from './sidebar/LibrariesPanel'

export type RightPage = 'chat' | 'library'

const WIDTH_KEY = 'huabu.chatPanelWidth'
const DEFAULT_WIDTH = 400
const MIN_WIDTH = 340
const MAX_WIDTH = 720

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
}

function initialWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    const parsed = raw ? Number(raw) : Number.NaN
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

/**
 * 右侧面板外壳：双页面互斥显示，宽度可拖拽。
 * `page` 由 App 统一持有（图标栏与面板共享同一状态，避免两处各存一份）；
 * `collapsed` = 图标栏再点当前页收起（原型 right-collapsed），画布恢复全宽。
 */
export function ChatPanel({ page, collapsed }: { page: RightPage; collapsed: boolean }) {
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
    event.currentTarget.setPointerCapture?.(event.pointerId)

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

  /** 双击把手 = 恢复默认宽度 */
  const onDoubleClick = (): void => {
    setWidth(DEFAULT_WIDTH)
    widthRef.current = DEFAULT_WIDTH
    persist(DEFAULT_WIDTH)
  }

  // 宽度变化同步到 CSS 变量，供画布内浮动控件避让；收起时视作 0（画布恢复全宽）
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-w', collapsed ? '0px' : `${width}px`)
    return () => {
      document.documentElement.style.removeProperty('--chat-w')
    }
  }, [width, collapsed])

  return (
    <aside
      style={{ width }}
      data-testid="chat-panel"
      data-collapsed={collapsed ? 'true' : 'false'}
      // 贴着右侧图标栏左边（rail 宽 48），与原型一致：画布 | 对话栏 | 图标栏。
      // top-11 = 让出自绘标题栏（容器不用 padding 让位）
      className={`absolute bottom-0 right-12 top-11 z-40 flex-col border-l border-(--outline) bg-(--surface-card) ${
        collapsed ? 'hidden' : 'flex'
      }`}
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
        <span
          className={`absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 transition-colors ${
            dragging ? 'bg-(--accent)' : 'bg-transparent group-hover:bg-(--outline)'
          }`}
        />
        <span
          className={`absolute left-1/2 top-1/2 h-[34px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--outline) transition-opacity ${
            dragging ? 'bg-(--accent) opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        />
      </div>

      {/*
        两个页面互斥显示（原型 .right-page / .right-page.active）：
        用 display 切换而不是条件渲染 —— 素材库的搜索词/展开态在文件级 store 里，
        但列表 DOM 保留也能避免切回对话时滚动位置丢失。
      */}
      <div className={`min-h-0 flex-1 flex-col ${page === 'chat' ? 'flex' : 'hidden'}`}>
        <ChatDock />
      </div>
      <div className={`min-h-0 flex-1 flex-col ${page === 'library' ? 'flex' : 'hidden'}`}>
        <LibraryPage />
      </div>
    </aside>
  )
}

/** 素材库页（原型 .library-page）：头部（标题 + 数量 + 新建库）+ 可滚动内容 */
function LibraryPage() {
  // 计数与面板同源：库列表变化（新建/删除）时头部自动跟着变
  const libraryCount = useCanvasStore((s) => s.libraries.length)
  const scrollerRef = useRef<HTMLDivElement>(null)

  /** 新建库的输入框在列表底部，点 + 之后要保证它露出来 */
  const startCreating = useCallback(() => {
    useLibrariesPanelStore.getState().setCreating(true)
    requestAnimationFrame(() => {
      const el = scrollerRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-(--outline-soft) px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-(--on-surface)">
          素材库
          <span className="ml-1.5 text-[11px] font-normal text-(--on-surface-muted)">{libraryCount} 个</span>
        </span>
        <button
          onClick={startCreating}
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface) active:scale-95"
          title="新建素材库"
          aria-label="新建素材库"
        >
          <Plus size={14} />
        </button>
      </div>
      <div ref={scrollerRef} data-scrollable="" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2.5">
        <LibrariesPanel onClose={() => undefined} />
      </div>
    </>
  )
}
