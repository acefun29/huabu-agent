import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Eraser,
  FolderOpen,
  GitBranch,
  MessageSquare,
  MousePointer2,
  Sparkles,
  Tag as TagIcon,
  Trash2,
  X,
} from 'lucide-react'
import { LIBRARY_ASSET_MIME, useCanvasStore } from '../store/canvasStore'
import { useSettings } from '../store/settingsStore'
import { bumpRender } from '../lib/perfProbe'
import { parseLibraryEntryPayload } from '../lib/dragPayload'
import { type CanvasNode, type MediaKind, type ViewState } from '../types'
import type { NodeGestureApi } from './NodeFrame'
import { NodeLayer } from './canvas/NodeLayer'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ReferenceEdgeLayer, type ReferenceEdgeSync } from './canvas/ReferenceEdgeLayer'
import { GenerationPopover } from './canvas/GenerationPopover'
import { CardInspector } from './canvas/CardInspector'

interface MenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

/**
 * 画布标签筛选条（右上角浮层）：聚合画布卡片全部标签，点击标签 = 只亮带该标签的
 * 卡片（其余降透明度），再点一次取消。标签的增删在卡片选中后的胶囊行上做（TagRow）。
 */
function TagFilterBar({ active, onChange }: { active: string | null; onChange: (tag: string | null) => void }) {
  const nodes = useCanvasStore((s) => s.nodes)
  const tags = useMemo(
    () => Array.from(new Set(nodes.flatMap((n) => n.data.tags ?? []))).sort((a, b) => a.localeCompare(b)),
    [nodes]
  )
  if (tags.length === 0) return null
  return (
    <div
      data-canvas-ui="true"
      data-tour="tag-filter"
      className="absolute right-3 top-[60px] z-20 flex max-w-[440px] flex-wrap items-center gap-1 rounded-2xl bg-(--chrome-bg) px-2.5 py-1.5 shadow-(--chrome-shadow) ring-1 ring-(--outline-soft)"
    >
      <TagIcon size={11} className="mr-0.5 shrink-0 text-(--on-surface-muted)" />
      {tags.map((t) => (
        <button
          key={t}
          onClick={() => onChange(active === t ? null : t)}
          className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors ${
            active === t
              ? 'bg-(--accent) text-white'
              : 'bg-(--surface-chip) text-(--on-surface-variant) hover:bg-(--outline-soft)'
          }`}
          title={active === t ? '点击取消筛选' : '只显示带此标签的卡片'}
        >
          {t}
        </button>
      ))}
      {active && (
        <button
          onClick={() => onChange(null)}
          className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft)"
          title="清除筛选"
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}

const SCALE_MIN = 0.4
const SCALE_MAX = 1.6
/** 缩放手势停止多久后把 view 提交进 store（落盘/缩放指示从此恢复同步） */
const WHEEL_COMMIT_MS = 150
/** 手势生效的位移阈值（px）：手抖 1~3px 仍算点击 */
const GESTURE_THRESHOLD_PX = 3
/** resize 的最小尺寸兜底（旧 react-rnd/re-resizable 无下限，这里防呆到 10px） */
const RESIZE_MIN = 10

/**
 * 事件路径上是否存在能「吃下」这次滚轮的滚动容器（对话坞消息列表、下拉面板等）。
 * 有 → 画布不缩放，滚轮归它；滚到边界后再继续滚，才轮到画布缩放 ——
 * 避免「在对话里翻历史，画面跟着放大缩小」。
 *
 * P2-6：滚动容器统一打 data-scrollable，这里只做 closest 式上溯 + 边界判断，
 * 不再每个 wheel 事件沿 DOM 链跑 getComputedStyle（强制样式计算）。
 */
function scrollableConsumes(target: EventTarget | null, deltaY: number): boolean {
  let el = target instanceof HTMLElement ? target : null
  while (el) {
    if (el.hasAttribute('data-scrollable')) {
      const atTop = el.scrollTop <= 1
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
      if ((deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom)) return true
    }
    el = el.parentElement
  }
  return false
}

/** 一帧内多个事件合并成一次 DOM 写入 */
function scheduleWrite(ref: { raf: number }, apply: () => void) {
  if (ref.raf) return
  ref.raf = requestAnimationFrame(() => {
    ref.raf = 0
    apply()
  })
}

/**
 * 无限画布（工作区公用）：左键拖空白 = 框选（Shift 追加）；中键 / 空格+左键 = 平移；
 * 滚轮以鼠标位置为中心缩放；卡片自由拖拽/右下角改大小。
 * 画布上只有媒体卡片（引用而非副本）；直接生成走锚定 Popover（右键「以此生成」/
 * 划选条/空白右键），引用链由生成事实自动形成——画布上没有任何手动连线通道。
 *
 * 性能契约（性能优化方案 P0-1）：平移/缩放/框选/拖卡进行中不触发任何 React 渲染 ——
 * 位移直写 DOM（rAF 合并），手势结束才把结果一次性提交进 store。
 * transform 层因此「非受控」：style.transform 永不出现在 JSX 里，只由 applyView 写入，
 * 任何上下文重渲染都不可能用手势中间态之外的旧 view 把画面踩回去。
 *
 * 渲染层拆分：nodes 数组的订阅下沉到 NodeLayer（canvas/NodeLayer.tsx）——单节点
 * 变化（生成进度事件 / 拖拽提交 / 打标签）只重渲节点层，不再重跑本组件函数体；
 * 主组件只保留「画布是否为空」的布尔派生，事件路径（右键菜单 / 框选命中）经
 * getState 现取最新 nodes。参考连线层（ReferenceEdgeLayer）是有意的第二个 nodes
 * 订阅者：引用线是 nodes 的纯派生投影，几何手势经 edgeSyncRef 直写其 path。
 */
export function CanvasWorkspace() {
  bumpRender('workspace')
  // 精确订阅：流式对话（chatsMap 高频变化）不再波及画布；actions 是恒定引用，经 getState 取用
  // nodes 数组已下沉到 NodeLayer 订阅（见上），这里只留空画布引导用的布尔派生（引用稳定）
  const hasNodes = useCanvasStore((s) => s.nodes.length > 0)
  const view = useCanvasStore((s) => s.view)
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds)
  const { appearance, setAppearance } = useSettings()
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** 标签筛选：非 null 时只亮带该标签的卡片（其余降透明度） */
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [osDragOver, setOsDragOver] = useState(false)
  /** 空格按住时左键拖动 = 平移（Figma 式；平时左键拖动 = 框选） */
  const [spaceDown, setSpaceDown] = useState(false)
  /** Shift+E（引用链显隐）读取的最新值：settings 是 Context，键位监听经 ref 取当前态 */
  const showEdgesRef = useRef(appearance.showReferenceEdges)
  showEdgesRef.current = appearance.showReferenceEdges
  const setAppearanceRef = useRef(setAppearance)
  setAppearanceRef.current = setAppearance
  /** 拖动 / 缩放结束后浏览器会补发一次 click，用它把这次假 click 吃掉，否则卡片会被顺带选中 */
  const suppressClickRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 变换层：transform 由 applyView 直写（非受控），React 只负责挂载 */
  const transformRef = useRef<HTMLDivElement>(null)
  /** 点阵网格层：background-size/position 跟随 view（网格跟画布一起动），同样非受控 */
  const gridRef = useRef<HTMLDivElement>(null)
  /** 框选矩形：常驻 DOM，几何由手势直写，不进 React state */
  const marqueeRef = useRef<HTMLDivElement>(null)
  /** 参考连线层的手势同步口：拖动/resize 期间直写受影响边的 path/label（不触发渲染） */
  const edgeSyncRef = useRef<ReferenceEdgeSync | null>(null)
  /** 已提交的 view。手势进行中它保持旧值（手势用闭包内的 live），提交后由渲染同步 */
  const viewRef = useRef(view)
  viewRef.current = view

  /** 把 view 写进变换层与网格层（唯一的写入点之一；另一个是手势 rAF 循环） */
  const applyView = (v: ViewState) => {
    const el = transformRef.current
    if (el) el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.scale})`
    const grid = gridRef.current
    if (grid) {
      grid.style.backgroundSize = `${26 * v.scale}px ${26 * v.scale}px`
      grid.style.backgroundPosition = `${v.x}px ${v.y}px`
    }
  }
  // 外部来源的 view 变化（载入工作区 / 手势结束提交 / 其它 setView）→ 同步一次 DOM
  useEffect(() => {
    applyView(view)
  }, [view])

  /** 交互进行中：画布根打标记，CSS 据此关闭阴影过渡/毛玻璃等昂贵效果（性能降级模式） */
  const setInteracting = (on: boolean) => {
    const el = rootRef.current
    if (!el) return
    if (on) el.setAttribute('data-interacting', '')
    else el.removeAttribute('data-interacting')
  }

  // 空格键全局监听：按住空格 → 左键拖动切换为平移。输入框里打空格不触发
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && Boolean(t.closest('input, textarea, [contenteditable="true"]'))
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        e.preventDefault()
        setSpaceDown(true)
      }
      // Shift+E：切换引用链显隐（Figma 原型连线先例；设置 → 外观同款开关）
      if (e.key.toLowerCase() === 'e' && e.shiftKey && !isTyping(e.target)) {
        e.preventDefault()
        setAppearanceRef.current({ showReferenceEdges: !showEdgesRef.current })
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  /**
   * 滚轮缩放（原生 passive 监听，绕开 React 合成事件）：
   * 以鼠标位置为中心；一帧多个 wheel 合并一次写入；停止 WHEEL_COMMIT_MS 后提交 store。
   */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const state: { live: ViewState | null; raf: { raf: number }; timer: number | null } = { live: null, raf: { raf: 0 }, timer: null }
    const commit = () => {
      state.timer = null
      if (!state.live) return
      const live = state.live
      state.live = null
      setInteracting(false)
      useCanvasStore.getState().setView(live)
    }
    const onWheel = (e: WheelEvent) => {
      if (scrollableConsumes(e.target, e.deltaY)) return
      const rect = el.getBoundingClientRect()
      if (!rect) return
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const base = state.live ?? viewRef.current
      const factor = e.deltaY < 0 ? 1.08 : 0.92
      const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, base.scale * factor))
      // 缩放前后鼠标指向的画布坐标不变
      const ratio = scale / base.scale
      state.live = { scale, x: cx - (cx - base.x) * ratio, y: cy - (cy - base.y) * ratio }
      const live = state.live
      setInteracting(true)
      scheduleWrite(state.raf, () => applyView(live))
      if (state.timer) window.clearTimeout(state.timer)
      state.timer = window.setTimeout(commit, WHEEL_COMMIT_MS)
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (state.timer) window.clearTimeout(state.timer)
      if (state.raf.raf) cancelAnimationFrame(state.raf.raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 屏幕坐标 → 画布坐标（考虑平移与缩放） */
  const toCanvas = (clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - (rect?.left ?? 0) - v.x) / v.scale,
      y: (clientY - (rect?.top ?? 0) - v.y) / v.scale,
    }
  }

  /** 空白处按下平移画布：中键拖动 或 空格 + 左键拖动。位移直写 DOM，松手提交一次 */
  const startPan = (e: React.MouseEvent) => {
    const start = { cx: e.clientX, cy: e.clientY, x: viewRef.current.x, y: viewRef.current.y }
    const write = { raf: 0 }
    let live: ViewState | null = null
    const onMove = (ev: MouseEvent) => {
      live = { ...viewRef.current, x: start.x + ev.clientX - start.cx, y: start.y + ev.clientY - start.cy }
      const current = live
      scheduleWrite(write, () => applyView(current))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (write.raf) cancelAnimationFrame(write.raf)
      setInteracting(false)
      if (live) useCanvasStore.getState().setView(live)
    }
    setInteracting(true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /**
   * 空白处左键拖动 = 框选（Figma 式）。
   * 虚线矩形直写 DOM；选中集每帧与新值做等值比较，扫过空白不再空转 setState。
   * 松手时若几乎没移动则视作普通点击：非 Shift 清空选中，Shift 保持。
   */
  const startMarquee = (e: React.MouseEvent, additive: boolean) => {
    const start = toCanvas(e.clientX, e.clientY)
    const baseIds = additive ? selectedAssetIds : []
    let moved = false
    let lastKey = ''
    const write = { raf: 0 }
    const box = marqueeRef.current
    const paint = (p: { x: number; y: number }) => {
      if (!box) return
      box.style.display = 'block'
      box.style.left = `${Math.min(start.x, p.x)}px`
      box.style.top = `${Math.min(start.y, p.y)}px`
      box.style.width = `${Math.abs(p.x - start.x)}px`
      box.style.height = `${Math.abs(p.y - start.y)}px`
    }
    paint(start)

    const hitTest = (p: { x: number; y: number }) => {
      const left = Math.min(start.x, p.x)
      const right = Math.max(start.x, p.x)
      const top = Math.min(start.y, p.y)
      const bottom = Math.max(start.y, p.y)
      // 主组件已不订阅 nodes：手势回调里现取最新态（getState 既定模式，scheduleWrite
      // 回调内同样成立），框选途中新钉入 / 被移动的卡片也能正确命中
      return useCanvasStore.getState().nodes
        .filter((n) => n.x < right && n.x + n.width > left && n.y < bottom && n.y + n.height > top)
        .map((n) => n.id)
    }

    /** 最新框选角点：松手补算最后一次命中用（rAF 可能还没跑到就被取消） */
    let latestPt = start
    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 4) moved = true
      // mousemove 只留最新坐标；命中检测（O(n) 两次 filter + 去重排序拼 key）合并进
      // rAF，与画框位移同帧生效 —— 一帧内多个事件只算一次
      const p = toCanvas(ev.clientX, ev.clientY)
      latestPt = p
      const current = p
      scheduleWrite(write, () => {
        paint(current)
        const ids = Array.from(new Set([...baseIds, ...hitTest(current)]))
        const key = ids.slice().sort().join('\u0000')
        if (key !== lastKey) {
          lastKey = key
          useCanvasStore.getState().setAssetSelection(ids)
        }
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (write.raf) cancelAnimationFrame(write.raf)
      // 松手补算最后一次命中：快速甩动松手时它还压在未执行的 rAF 里，直接取消
      // 会吞掉最后一段位移的框选结果（key 比较保证已生效时这里是空转）
      if (moved) {
        const ids = Array.from(new Set([...baseIds, ...hitTest(latestPt)]))
        const key = ids.slice().sort().join('\u0000')
        if (key !== lastKey) useCanvasStore.getState().setAssetSelection(ids)
      }
      if (box) box.style.display = 'none'
      if (!moved && !additive) useCanvasStore.getState().setAssetSelection([])
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    // 画布上的浮动 UI（划选操作条等）不参与框选/平移，否则按下即开框、松手清空选中
    if (target.closest('[data-canvas-ui]')) return
    // 两层容器（背景层 + 变换层）都算画布空白；命中节点卡片则交给 NodeFrame 自己拖
    if (!target.closest('[data-canvas-bg]')) return
    if (target.closest('.canvas-node')) return
    // 阻止浏览器默认行为（文本选中 / 中键自动滚动）
    e.preventDefault()
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      startPan(e)
    } else if (e.button === 0) {
      startMarquee(e, e.shiftKey)
    }
    // 右键交给 onContextMenu
  }

  /**
   * 节点手势（拖拽 / resize）：引用恒定，NodeFrame 靠它保持 memo。
   * 位移直写节点自己的 style，松手才 updateNode 提交。
   */
  const nodeGestureApi = useMemo<NodeGestureApi>(
    () => ({
      consumeSuppressedClick: () => {
        if (!suppressClickRef.current) return false
        suppressClickRef.current = false
        return true
      },
      beginDrag: (node, el, e) => {
        if (e.button !== 0) return
        const target = e.target as HTMLElement
        // 旧 Rnd 的 cancel 语义复刻：版本条/详情等交互控件区不拖拽；HTML5 拖拽手柄不接手
        if (target.closest('.gen-no-drag')) return
        if (target.closest('[draggable="true"]')) return
        const start = { cx: e.clientX, cy: e.clientY, x: node.x, y: node.y }
        const scale = viewRef.current.scale
        const write = { raf: 0 }
        let dragging = false
        let latest = { x: node.x, y: node.y }
        const onMove = (ev: MouseEvent) => {
          if (!dragging) {
            if (Math.abs(ev.clientX - start.cx) + Math.abs(ev.clientY - start.cy) <= GESTURE_THRESHOLD_PX) return
            dragging = true
            useCanvasStore.getState().bringToFront(node.id)
            setInteracting(true)
            el.classList.add('canvas-node-dragging')
          }
          latest = {
            x: start.x + (ev.clientX - start.cx) / scale,
            y: start.y + (ev.clientY - start.cy) / scale,
          }
          const current = latest
          scheduleWrite(write, () => {
            el.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`
            // 参考连线跟手（源/目标几何变化都要即时反映）
            edgeSyncRef.current?.refreshReferenceEdges(node.id, {
              x: current.x,
              y: current.y,
              width: node.width,
              height: node.height,
            })
          })
        }
        const finish = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', finish)
          if (write.raf) cancelAnimationFrame(write.raf)
          // 连线几何覆盖必须清除：摆放结束后回归已提交坐标
          edgeSyncRef.current?.refreshReferenceEdges(node.id, null)
          if (dragging) {
            el.classList.remove('canvas-node-dragging')
            setInteracting(false)
            suppressClickRef.current = true
            useCanvasStore.getState().updateNode(node.id, { x: latest.x, y: latest.y })
          }
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', finish)
      },
      beginResize: (node, el, e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        e.preventDefault()
        const start = { cx: e.clientX, cy: e.clientY, w: node.width, h: node.height }
        const scale = viewRef.current.scale
        const write = { raf: 0 }
        let resizing = false
        let latest = { width: node.width, height: node.height }
        const onMove = (ev: MouseEvent) => {
          if (!resizing) {
            if (Math.abs(ev.clientX - start.cx) + Math.abs(ev.clientY - start.cy) <= GESTURE_THRESHOLD_PX) return
            resizing = true
            setInteracting(true)
            el.classList.add('canvas-node-dragging')
          }
          latest = {
            width: Math.max(RESIZE_MIN, start.w + (ev.clientX - start.cx) / scale),
            height: Math.max(RESIZE_MIN, start.h + (ev.clientY - start.cy) / scale),
          }
          const current = latest
          scheduleWrite(write, () => {
            el.style.width = `${current.width}px`
            el.style.height = `${current.height}px`
            // 参考连线锚点跟手（源/目标几何变化都要即时反映）
            edgeSyncRef.current?.refreshReferenceEdges(node.id, {
              x: node.x,
              y: node.y,
              width: current.width,
              height: current.height,
            })
          })
        }
        const finish = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', finish)
          if (write.raf) cancelAnimationFrame(write.raf)
          if (resizing) {
            el.classList.remove('canvas-node-dragging')
            setInteracting(false)
            suppressClickRef.current = true
            edgeSyncRef.current?.refreshReferenceEdges(node.id, null)
            useCanvasStore.getState().updateNode(node.id, { width: latest.width, height: latest.height })
          }
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', finish)
      },
    }),
    // 手势闭包只依赖 refs 与恒定 store action（getState 永远拿到最新）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // 键位：Delete 删除选中卡片（走确认/撤销通道）；Esc 清空选中
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
      if (e.key === 'Escape') {
        useCanvasStore.getState().setAssetSelection([])
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = [...new Set(selectedAssetIds)]
        for (const id of ids) useCanvasStore.getState().requestRemoveNode(id)
        if (ids.length > 0) e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // actions 经 getState 取用（恒定引用），依赖只剩数据
  }, [selectedAssetIds])

  /** 画布空白处右键：直接生成（Popover 锚定光标）/ 清空画布 */
  const canvasItems = (at: { x: number; y: number }): ContextMenuItem[] => [
    {
      label: '生成…（图片 / 视频 / 音频）',
      icon: <Sparkles size={13} />,
      onClick: () => useCanvasStore.getState().openGenComposer({ at }),
    },
    // 菜单在事件触发时构建，nodes 现取最新态（主组件已不订阅 nodes）
    ...(useCanvasStore.getState().nodes.length > 0
      ? [
          {
            label: '清空画布（不删除文件）',
            icon: <Eraser size={13} />,
            danger: true,
            separator: true,
            onClick: () =>
              useCanvasStore.getState().requestConfirm({
                title: '清空画布上的全部卡片？',
                body: '只移除画布上的引用卡片，素材库里的文件不受影响，可随时重新钉回。',
                confirmLabel: '清空画布',
                danger: true,
                onConfirm: () => useCanvasStore.getState().clearCanvas(),
              }),
          } satisfies ContextMenuItem,
        ]
      : []),
  ]

  /** 节点右键：引用进会话 / 以此生成 / 再次生成 / 详情查看 / 清理 / 删除 */
  const nodeItems = (node: CanvasNode): ContextMenuItem[] => {
    const d = node.data
    const isMedia = d.kind === 'image' || d.kind === 'video' || d.kind === 'audio'
    const hasFile = Boolean(d.storage && d.path)
    const hasHistory = (d.versions?.length ?? 0) > 0
    const busyState = useCanvasStore.getState().jobStates[node.id]
    const busy = busyState?.status === 'queued' || busyState?.status === 'running'
    return [
      {
        label: '以此生成…（参考这张卡）',
        icon: <Sparkles size={13} />,
        disabled: !isMedia || !hasFile,
        onClick: () =>
          useCanvasStore.getState().openGenComposer({
            at: { x: node.x + node.width + 24, y: node.y },
            refs: [node.id],
            kind: d.kind as MediaKind,
          }),
      },
      {
        label: '血脉与提示词（生成链图）',
        icon: <GitBranch size={13} />,
        disabled: !isMedia,
        onClick: () => useCanvasStore.getState().openCardInspector(node.id),
      },
      {
        label: '再次生成…（按当前版本输入）',
        icon: <Sparkles size={13} />,
        disabled: !hasHistory || busy,
        onClick: () =>
          useCanvasStore.getState().openGenComposer({
            at: { x: node.x + node.width + 24, y: node.y },
            targetNodeId: node.id,
            kind: d.kind as MediaKind,
          }),
      },
      {
        label: '引用进会话（作为对话上下文）',
        icon: <MessageSquare size={13} />,
        separator: true,
        onClick: () => {
          useCanvasStore.getState().injectAsset(node.id)
          useCanvasStore.getState().showToast('已引用进会话：这张卡片将作为下一轮对话上下文（只传绝对路径）')
        },
      },
      {
        label: '在文件管理器中打开',
        icon: <FolderOpen size={13} />,
        disabled: !d.path,
        onClick: () => {
          if (d.path && window.huabu?.workspace) {
            void window.huabu.workspace.reveal(d.path).then((r) => {
              if (!r.ok) useCanvasStore.getState().showToast(`打开失败：${r.error}`)
            })
          }
        },
      },
      {
        label: '清空生成历史（保留卡片与文件）',
        icon: <Trash2 size={13} />,
        disabled: !hasHistory || busy,
        onClick: () => useCanvasStore.getState().requestClearGenerateVersions(node.id),
      },
      {
        label: '取消钉住（不删除文件）',
        icon: <Trash2 size={13} />,
        danger: true,
        separator: true,
        onClick: () => useCanvasStore.getState().requestRemoveNode(node.id),
      },
    ]
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const nodeId = (e.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id')
    // nodes 现取最新态（主组件已不订阅 nodes）；nodeItems 的入参节点由此得来
    const node = nodeId ? useCanvasStore.getState().nodes.find((n) => n.id === nodeId) : undefined
    const at = toCanvas(e.clientX, e.clientY)
    setMenu({ x: e.clientX, y: e.clientY, items: node ? nodeItems(node) : canvasItems(at) })
  }

  /** 划选条「以此为参考生成」：锚定选中包围盒右侧，选中集里的媒体卡全部带入 */
  const openComposerFromSelection = () => {
    const nodes = useCanvasStore.getState().nodes
    const chosen = nodes.filter(
      (n) => selectedAssetIds.includes(n.id) && (n.data.kind === 'image' || n.data.kind === 'video' || n.data.kind === 'audio') && n.data.storage && n.data.path
    )
    if (chosen.length === 0) {
      useCanvasStore.getState().showToast('选中的卡片里没有可作为参考的媒体文件')
      return
    }
    const right = Math.max(...chosen.map((n) => n.x + n.width))
    const top = Math.min(...chosen.map((n) => n.y))
    useCanvasStore.getState().openGenComposer({
      at: { x: right + 24, y: top },
      refs: chosen.map((n) => n.id),
    })
  }

  const selectedCount = selectedAssetIds.length

  return (
    <div
      ref={rootRef}
      data-testid="canvas"
      data-canvas-bg="true"
      className={`absolute inset-0 select-none overflow-hidden bg-(--surface) active:cursor-grabbing ${
        spaceDown ? 'cursor-grab' : 'cursor-default'
      }`}
      onMouseDownCapture={() => {
        // 每次新按下都作废上一轮遗留的标记，避免误吃后续真实点击
        suppressClickRef.current = false
      }}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDragStart={(e) => e.preventDefault()}
      onDragOver={(e) => {
        const types = e.dataTransfer.types
        // OS 文件拖入（归档进素材库）与素材库文件拖入（钉引用）都接受落点
        if (types.includes('Files') || types.includes(LIBRARY_ASSET_MIME)) {
          e.preventDefault()
          if (types.includes('Files')) setOsDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes('Files')) setOsDragOver(false)
      }}
      onDrop={(e) => {
        // OS 文件拖上画布 = 归档进素材库分类目录（asset:import-canvas）
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault()
          setOsDragOver(false)
          const at = toCanvas(e.clientX, e.clientY)
          void useCanvasStore.getState().dropFilesToCanvas(Array.from(e.dataTransfer.files), { x: at.x, y: at.y })
          return
        }
        // 素材库文件拖到画布 = 钉引用卡片在落点
        // 通道命中就先 preventDefault（dragover 已放行本通道，不能把 drop 交给浏览器默认行为），
        // 载荷解析+形状校验收口在 dragPayload（非法 = null，直接忽略）
        const raw = e.dataTransfer.getData(LIBRARY_ASSET_MIME)
        if (!raw) return
        e.preventDefault()
        const payload = parseLibraryEntryPayload(e.dataTransfer)
        if (payload) {
          useCanvasStore.getState().importFromLibrary(payload.libraryId, payload.entry, toCanvas(e.clientX, e.clientY))
        }
      }}
    >
      {/* 点阵网格：viewport 尺寸的独立层，几何由 applyView 直写（跟手缩放平移） */}
      {appearance.showGrid && <div ref={gridRef} aria-hidden="true" className="dot-grid-layer" />}
      {/* 变换层：transform 非受控（applyView / 手势 rAF 直写），React 不渲染 style.transform */}
      <div ref={transformRef} data-canvas-bg="true" className="canvas-transform absolute inset-0">
        {/* 参考连线层：nodes 的派生投影（不持久化），几何与 NodeLayer 同坐标系；
            SVG 根不拦截事件。置于卡片之下，边不遮卡面；显隐跟随外观设置（Shift+E） */}
        <ReferenceEdgeLayer syncRef={edgeSyncRef} visible={appearance.showReferenceEdges} />
        {/* 节点层：唯一的 nodes 订阅者（单节点变化只重渲这一层，不再波及主组件） */}
        <NodeLayer api={nodeGestureApi} activeTag={activeTag} />

        {/* 框选矩形：常驻 DOM，几何由手势直写；盖在卡片之上、不拦截事件 */}
        <div ref={marqueeRef} className="canvas-marquee" style={{ display: 'none' }} />
      </div>

      {/* 标签筛选条：聚合画布卡片标签，点击只亮带该标签的卡片 */}
      <TagFilterBar active={activeTag} onChange={setActiveTag} />

      {/* 空画布引导：不拦截任何鼠标事件（显隐由 hasNodes 布尔订阅驱动） */}
      {!hasNodes && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-3xl bg-(--glass) px-8 py-7 text-center ring-1 ring-(--outline-soft) backdrop-blur">
            <MousePointer2 size={20} className="text-(--on-surface-muted)" />
            <div className="text-[13px] font-medium text-(--on-surface)">这块画布还没有素材</div>
            <div className="text-[12px] leading-relaxed text-(--on-surface-muted)">
              右键画布直接生成，或选中卡片后右键「以此生成…」；
              <br />
              从左侧素材库点击 / 拖拽钉入素材；把电脑里的文件直接拖进来 = 自动归档（assets/&lt;分类&gt;/）；
              <br />
              也可以在底部输入框描述需求，产物会自动落到这里并形成引用链。
            </div>
          </div>
        </div>
      )}

      {/* 划选后的浮动操作条：以此为参考生成 / 批量引用进会话 / 批量移除（文件不动） */}
      {selectedCount > 0 && (
        <div
          data-canvas-ui="true"
          data-tour="selection-bar"
          data-testid="selection-bar"
          className="absolute left-1/2 top-3 z-20 flex h-11 -translate-x-1/2 items-center gap-1.5 rounded-2xl bg-(--chrome-bg) px-3 shadow-(--chrome-shadow) ring-1 ring-(--outline-soft)"
        >
          <span className="shrink-0 pl-1 text-[12px] font-medium text-(--on-surface-variant)">已选 {selectedCount} 项</span>
          <button
            data-testid="selection-generate"
            onClick={openComposerFromSelection}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-(--on-surface) transition-colors hover:bg-(--outline-soft)"
            title="打开生成面板：选中集里的媒体卡全部作为参考（角色由系统按模型派生）"
          >
            <Sparkles size={13} />
            以此为参考生成…
          </button>
          <button
            data-testid="selection-inject"
            onClick={() => {
              selectedAssetIds.forEach((id) => useCanvasStore.getState().injectAsset(id))
              useCanvasStore.getState().showToast(`已把 ${selectedCount} 项素材引用进会话（只传绝对路径给 Agent）`)
            }}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-(--on-surface) transition-colors hover:bg-(--outline-soft)"
            title="作为本轮上下文引用进底部输入框（Agent 只收到绝对路径）"
          >
            <MessageSquare size={13} />
            引用进会话
          </button>
          <button
            data-testid="selection-remove"
            onClick={() => {
              const n = selectedAssetIds.length
              useCanvasStore.getState().removeNodes(selectedAssetIds)
              useCanvasStore.getState().showToast(`已从画布移除 ${n} 张引用卡片（文件不受影响）`)
            }}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-(--on-surface) transition-colors hover:bg-(--outline-soft)"
            title="从画布取消钉住，素材库文件不动"
          >
            <Trash2 size={13} />
            从画布移除
          </button>
          <button
            onClick={() => useCanvasStore.getState().setAssetSelection([])}
            className="flex h-7 w-7 items-center justify-center rounded-full text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
            title="取消选择"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* 生成 Popover（直接生成入口）：锚定卡片/划选/光标，经 store 的 genComposer 开合 */}
      <GenerationPopover />
      {/* 卡片检视浮层：血脉图 + 提示词详情（所有媒体卡的统一入口） */}
      <CardInspector />

      {osDragOver && (
        <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-(--accent) bg-(--active-tint)/60">
          <div className="rounded-full bg-(--surface-card) px-4 py-2 text-[12px] font-medium text-(--on-surface) shadow-md">
            松开导入：文件将归档进素材库（assets/&lt;分类&gt;/）并钉到画布
          </div>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
