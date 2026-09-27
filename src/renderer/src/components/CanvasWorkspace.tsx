import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  Eraser,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  MessageSquare,
  MousePointer2,
  Sparkles,
  Tag as TagIcon,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import { LIBRARY_ASSET_MIME, MEDIA_LABEL, useCanvasStore } from '../store/canvasStore'
import { useSettings } from '../store/settingsStore'
import { bumpRender } from '../lib/perfProbe'
import { type AssetData, type CanvasNode, type MediaKind, type ViewState } from '../types'
import { kindIcon } from './AssetNode'
import { NodeFrame, type NodeGestureApi } from './NodeFrame'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import type { AssetLibraryFile } from '@shared/ipc'

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
 * 会话不再上画布 —— 画布上只有文件卡片（引用而非副本）。
 *
 * 性能契约（性能优化方案 P0-1）：平移/缩放/框选/拖卡进行中不触发任何 React 渲染 ——
 * 位移直写 DOM（rAF 合并），手势结束才把结果一次性提交进 store。
 * transform 层因此「非受控」：style.transform 永不出现在 JSX 里，只由 applyView 写入，
 * 任何上下文重渲染都不可能用手势中间态之外的旧 view 把画面踩回去。
 */
export function CanvasWorkspace() {
  bumpRender('workspace')
  // 精确订阅：流式对话（chatsMap 高频变化）不再波及画布；actions 是恒定引用，经 getState 取用
  const nodes = useCanvasStore((s) => s.nodes)
  const view = useCanvasStore((s) => s.view)
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds)
  const activeGenerateId = useCanvasStore((s) => s.activeGenerateId)
  const libraries = useCanvasStore((s) => s.libraries)
  const dirFiles = useCanvasStore((s) => s.dirFiles)
  const workspace = useCanvasStore((s) => s.workspace)
  const { appearance } = useSettings()
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** 标签筛选：非 null 时只亮带该标签的卡片（其余降透明度） */
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [osDragOver, setOsDragOver] = useState(false)
  /** 空格按住时左键拖动 = 平移（Figma 式；平时左键拖动 = 框选） */
  const [spaceDown, setSpaceDown] = useState(false)
  /** 拖动 / 缩放结束后浏览器会补发一次 click，用它把这次假 click 吃掉，否则卡片会被顺带选中 */
  const suppressClickRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 变换层：transform 由 applyView 直写（非受控），React 只负责挂载 */
  const transformRef = useRef<HTMLDivElement>(null)
  /** 点阵网格层：background-size/position 跟随 view（网格跟画布一起动），同样非受控 */
  const gridRef = useRef<HTMLDivElement>(null)
  /** 框选矩形：常驻 DOM，几何由手势直写，不进 React state */
  const marqueeRef = useRef<HTMLDivElement>(null)
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
      // 只框选普通素材卡片（生成控制台卡片有自己的激活态，不参与引用选中）
      return nodes
        .filter((n) => !n.data.gen)
        .filter((n) => n.x < right && n.x + n.width > left && n.y < bottom && n.y + n.height > top)
        .map((n) => n.id)
    }

    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 4) moved = true
      const p = toCanvas(ev.clientX, ev.clientY)
      const current = p
      scheduleWrite(write, () => paint(current))
      const ids = Array.from(new Set([...baseIds, ...hitTest(p)]))
      const key = ids.slice().sort().join('\u0000')
      if (key !== lastKey) {
        lastKey = key
        useCanvasStore.getState().setAssetSelection(ids)
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (write.raf) cancelAnimationFrame(write.raf)
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
    useCanvasStore.getState().setActiveGenerate(null)
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
      onCardMouseDown: (node) => {
        // 带生成状态的卡片自己接管选中高亮；点其余卡片则取消生成卡片高亮
        if (!node.data.gen) useCanvasStore.getState().setActiveGenerate(null)
      },
      consumeSuppressedClick: () => {
        if (!suppressClickRef.current) return false
        suppressClickRef.current = false
        return true
      },
      beginDrag: (node, el, e) => {
        if (e.button !== 0) return
        const target = e.target as HTMLElement
        // 旧 Rnd 的 cancel 语义复刻：生成卡片的交互控件区不拖拽；HTML5 拖拽手柄不接手
        if (node.data.gen && target.closest('.gen-no-drag')) return
        if (target.closest('[draggable="true"]')) return
        const start = { cx: e.clientX, cy: e.clientY, x: node.x, y: node.y }
        const scale = viewRef.current.scale
        const write = { raf: 0 }
        let dragging = false
        let latest = { x: node.x, y: node.y }
        // 参考投放（「+ 参考」）：拖动途中悬停到某张生成卡片上即高亮，松手把它加为
        // 参考（垫图 / 首帧）并弹回原位——本手势语义是「引用」不是「摆放」，与
        // HTML5 把手拖到生成卡片的 drop 同效（onDropRef 的自引用/去重规则一致）。
        let refTarget: HTMLElement | null = null
        const setRefHover = (next: HTMLElement | null) => {
          if (next === refTarget) return
          refTarget?.querySelector('[data-testid="gen-node"]')?.classList.remove('gen-ref-hover')
          next?.querySelector('[data-testid="gen-node"]')?.classList.add('gen-ref-hover')
          refTarget = next
        }
        const hitRefTarget = (cx: number, cy: number) => {
          // 被拖卡片跟手挡在最上层，elementsFromPoint 取整叠：跳过自己，找底下带
          // 生成状态的卡片
          for (const hit of document.elementsFromPoint(cx, cy)) {
            const frame = (hit as HTMLElement).closest?.('.canvas-node')
            if (!frame || frame === el) continue
            const id = frame.getAttribute('data-node-id')
            if (!id || id === node.id) continue
            if (useCanvasStore.getState().nodes.find((n) => n.id === id)?.data.gen) return frame as HTMLElement
          }
          return null
        }
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
          setRefHover(hitRefTarget(ev.clientX, ev.clientY))
          scheduleWrite(write, () => {
            el.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`
          })
        }
        const finish = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', finish)
          if (write.raf) cancelAnimationFrame(write.raf)
          const droppedOn = refTarget
          setRefHover(null)
          if (dragging) {
            el.classList.remove('canvas-node-dragging')
            setInteracting(false)
            suppressClickRef.current = true
            if (droppedOn) {
              // 落在生成卡片上 = 加参考并弹回原位（引用手势不改摆放）
              el.style.transform = `translate3d(${start.x}px, ${start.y}px, 0)`
              const genId = droppedOn.getAttribute('data-node-id')
              const gen = genId ? useCanvasStore.getState().nodes.find((n) => n.id === genId)?.data.gen : undefined
              if (genId && gen) {
                if (gen.refs.includes(node.id)) {
                  useCanvasStore.getState().showToast('该卡片已在参考列表中')
                } else {
                  useCanvasStore.getState().updateGenerate(genId, { refs: [...gen.refs, node.id] })
                  useCanvasStore.getState().showToast('已加入参考（垫图 / 首帧）')
                }
              }
            } else {
              useCanvasStore.getState().updateNode(node.id, { x: latest.x, y: latest.y })
            }
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

  // 键位：Delete 删除选中卡片（走确认/撤销通道）；Esc 清空选中并退出生成模式
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
      if (e.key === 'Escape') {
        useCanvasStore.getState().setAssetSelection([])
        useCanvasStore.getState().setActiveGenerate(null)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = [...new Set([...selectedAssetIds, ...(activeGenerateId ? [activeGenerateId] : [])])]
        for (const id of ids) useCanvasStore.getState().requestRemoveNode(id)
        if (ids.length > 0) e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // actions 经 getState 取用（恒定引用），依赖只剩数据
  }, [activeGenerateId, selectedAssetIds])

  /** 画布空白处右键：新建生成卡片 / 从素材库钉引用 / 从工作目录导入 */
  const canvasItems = (at: { x: number; y: number }): ContextMenuItem[] => [
    { header: '新建生成卡片' },
    { label: '生成图片', icon: <ImageIcon size={13} />, onClick: () => useCanvasStore.getState().createGenerateNode('image', at) },
    { label: '生成视频', icon: <Video size={13} />, onClick: () => useCanvasStore.getState().createGenerateNode('video', at) },
    { label: '生成音频', icon: <AudioLines size={13} />, onClick: () => useCanvasStore.getState().createGenerateNode('audio', at) },
    ...libraries
      .filter((lib) => lib.files.length > 0)
      .flatMap((lib): ContextMenuItem[] => [
        { header: `素材库 · ${lib.name}`, separator: true },
        ...lib.files.slice(0, 10).map((f) => ({
          label: f.name,
          icon: kindIcon(f.kind, 13),
          onClick: () => useCanvasStore.getState().importFromLibrary(lib.id, f, at),
        })),
      ]),
    { header: '从工作目录导入', separator: true },
    ...(dirFiles.length === 0
      ? [{ label: '（暂未读到文件，稍后重试）', icon: <FileText size={13} />, disabled: true } satisfies ContextMenuItem]
      : dirFiles.slice(0, 10).map(
          (f): ContextMenuItem => ({
            label: f.path,
            icon: kindIcon(f.kind, 13),
            onClick: () => useCanvasStore.getState().importFromDirectory(f),
          })
        )),
    ...(nodes.length > 0
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

  /** 节点右键：文件卡片按是否带生成状态分支 */
  const nodeItems = (node: CanvasNode): ContextMenuItem[] => {
    const d = node.data as AssetData
    if (d.gen) {
      const busy = d.gen.status === 'queued' || d.gen.status === 'running'
      const kind = d.kind as MediaKind
      return [
        {
          label: busy ? '生成中…' : `立即生成${MEDIA_LABEL[kind]}`,
          icon: <Sparkles size={13} />,
          disabled: busy || !d.gen.prompt,
          onClick: () => void useCanvasStore.getState().submitGeneration(node.id, d.gen!.prompt),
        },
        {
          label: '引用进会话（作为对话上下文）',
          icon: <MessageSquare size={13} />,
          onClick: () => {
            useCanvasStore.getState().injectAsset(node.id)
            useCanvasStore.getState().setActiveGenerate(null)
            useCanvasStore.getState().showToast('已引用进会话：这张卡片将作为下一轮对话上下文（只传绝对路径）')
          },
        },
        {
          label: '清空结果（保留卡片）',
          icon: <Trash2 size={13} />,
          disabled: d.gen.versions.length === 0 || busy,
          onClick: () => useCanvasStore.getState().requestClearGenerateVersions(node.id),
        },
        {
          label: '删除卡片',
          icon: <Trash2 size={13} />,
          danger: true,
          separator: true,
          onClick: () => useCanvasStore.getState().requestRemoveNode(node.id),
        },
      ]
    }

    const deriveAt = { x: node.x + 48, y: node.y + 48 }
    return [
      { header: `以此生成 · ${d.name}` },
      {
        label: '生成图片（作为垫图）',
        icon: <ImageIcon size={13} />,
        disabled: d.kind !== 'image',
        onClick: () => useCanvasStore.getState().createGenerateNode('image', deriveAt, [node.id]),
      },
      {
        label: '生成视频（作为首帧）',
        icon: <Video size={13} />,
        disabled: d.kind !== 'image' && d.kind !== 'video',
        onClick: () => useCanvasStore.getState().createGenerateNode('video', deriveAt, [node.id]),
      },
      {
        label: '引用进会话（作为对话上下文）',
        icon: <MessageSquare size={13} />,
        onClick: () => useCanvasStore.getState().injectAsset(node.id),
      },
      {
        label: '在文件管理器中打开',
        icon: <FolderOpen size={13} />,
        separator: true,
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
        label: '取消钉住（不删除文件）',
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => useCanvasStore.getState().requestRemoveNode(node.id),
      },
    ]
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    void useCanvasStore.getState().refreshDirFiles()
    const nodeId = (e.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id')
    const node = nodeId ? nodes.find((n) => n.id === nodeId) : undefined
    const at = toCanvas(e.clientX, e.clientY)
    setMenu({ x: e.clientX, y: e.clientY, items: node ? nodeItems(node) : canvasItems(at) })
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
        // OS 文件拖入（归档进素材库）与素材库文件拖入（钉引用）都接受落点
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(LIBRARY_ASSET_MIME)) {
          e.preventDefault()
          if (e.dataTransfer.types.includes('Files')) setOsDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes('Files')) setOsDragOver(false)
      }}
      onDrop={(e) => {
        // 通道一：OS 文件拖上画布 = 归档进素材库分类目录（asset:import-canvas）
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault()
          setOsDragOver(false)
          const at = toCanvas(e.clientX, e.clientY)
          void useCanvasStore.getState().dropFilesToCanvas(Array.from(e.dataTransfer.files), { x: at.x, y: at.y })
          return
        }
        // 素材库文件拖到画布 = 钉引用卡片在落点
        const raw = e.dataTransfer.getData(LIBRARY_ASSET_MIME)
        if (!raw) return
        e.preventDefault()
        try {
          const { libraryId, entry } = JSON.parse(raw) as { libraryId: string; entry: AssetLibraryFile }
          useCanvasStore.getState().importFromLibrary(libraryId, entry, toCanvas(e.clientX, e.clientY))
        } catch {
          /* 非法载荷忽略 */
        }
      }}
    >
      {/* 点阵网格：viewport 尺寸的独立层，几何由 applyView 直写（跟手缩放平移） */}
      {appearance.showGrid && <div ref={gridRef} aria-hidden="true" className="dot-grid-layer" />}
      {/* 变换层：transform 非受控（applyView / 手势 rAF 直写），React 不渲染 style.transform */}
      <div ref={transformRef} data-canvas-bg="true" className="canvas-transform absolute inset-0">
        {nodes.map((node) => (
          <NodeFrame
            key={node.id}
            node={node}
            api={nodeGestureApi}
            dimmed={Boolean(activeTag && !(node.data.tags ?? []).includes(activeTag))}
          />
        ))}

        {/* 框选矩形：常驻 DOM，几何由手势直写；盖在卡片之上、不拦截事件 */}
        <div ref={marqueeRef} className="canvas-marquee" style={{ display: 'none' }} />
      </div>

      {/* 标签筛选条：聚合画布卡片标签，点击只亮带该标签的卡片 */}
      <TagFilterBar active={activeTag} onChange={setActiveTag} />

      {/* 空画布引导：不拦截任何鼠标事件 */}
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-3xl bg-(--glass) px-8 py-7 text-center ring-1 ring-(--outline-soft) backdrop-blur">
            <MousePointer2 size={20} className="text-(--on-surface-muted)" />
            <div className="text-[13px] font-medium text-(--on-surface)">这块画布还没有素材</div>
            <div className="text-[12px] leading-relaxed text-(--on-surface-muted)">
              右键画布新建生成卡片，或从左侧素材库点击 / 拖拽钉入素材；
              <br />
              把电脑里的文件直接拖进来 = 自动归档到素材库目录（assets/&lt;分类&gt;/）；
              <br />
              也可以在底部输入框描述需求，产物会自动落到这里。
            </div>
          </div>
        </div>
      )}

      {/* 划选后的浮动操作条：批量引用进会话 / 批量移除（文件不动） */}
      {selectedCount > 0 && (
        <div
          data-canvas-ui="true"
          data-tour="selection-bar"
          data-testid="selection-bar"
          className="absolute left-1/2 top-3 z-20 flex h-11 -translate-x-1/2 items-center gap-1.5 rounded-2xl bg-(--chrome-bg) px-3 shadow-(--chrome-shadow) ring-1 ring-(--outline-soft)"
        >
          <span className="shrink-0 pl-1 text-[12px] font-medium text-(--on-surface-variant)">已选 {selectedCount} 项</span>
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

      {osDragOver && (
        <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-(--accent) bg-(--active-tint)/60">
          <div className="rounded-full bg-(--surface-card) px-4 py-2 text-[12px] font-medium text-(--on-surface) shadow-md">
            松开导入：文件将归档进素材库（assets/&lt;分类&gt;/）并钉到画布
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-2 left-3 right-3 truncate text-[11px] text-(--on-surface-muted)">
        工作目录 {workspace?.path ?? '未打开'}（Agent 可读写全部文件）· 缩放 {Math.round(view.scale * 100)}% ·
        左键拖动框选 · 中键 / 空格+左键平移 · 滚轮缩放 · 清空画布在右上角
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
