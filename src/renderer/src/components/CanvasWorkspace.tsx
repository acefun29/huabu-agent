import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  Eraser,
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
import { parseLibraryEntryPayload } from '../lib/dragPayload'
import { useDismiss } from '../lib/hooks'
import { KIND_LABEL, type AssetData, type CanvasNode, type MediaKind, type ViewState } from '../types'
import { MEDIA_REF_ROLES, MEDIA_ROLE_KIND, REF_ROLE_LABEL, normalizeMediaCaps } from '@shared/media'
import type { MediaRefRole, ResolvedRefCaps } from '@shared/media'
import type { NodeGestureApi } from './NodeFrame'
import { NodeLayer } from './canvas/NodeLayer'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { MEDIA_REFERENCE_MIME } from './canvas/MediaConnectionHandle'
import { parseReferencePayload } from './canvas/MediaReferenceInputs'
import { ReferenceEdgeLayer, type ReferenceEdgeSync } from './canvas/ReferenceEdgeLayer'

interface MenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

/** 空白落点「用来生成」候选项：目标 kind + 首个合法角色 + 兼容模型（null = 默认链已兼容，不覆盖） */
interface RefCreateOption {
  kind: MediaKind
  role: MediaRefRole
  model: string | null
  modelLabel: string
}

/** 参考连线拖到空白画布后弹出的建卡菜单状态 */
interface RefDropMenuState {
  screen: { x: number; y: number }
  /** 落点的画布坐标（新生成卡的位置） */
  at: { x: number; y: number }
  sourceId: string
  sourceName: string
  options: RefCreateOption[]
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

/**
 * 由一个「用来生成」候选创建下游生成卡：建卡 → 需要时显式指定兼容模型 → 按合法角色挂参考 → 激活。
 * 建卡后的每次读取都必须重新 getState：nodesById 随每次 set 整表重建，旧快照里取不到新卡 id。
 * 能力/成环/配额校验仍在 store（addGenerateRef）。
 */
function createGenerateFromReference(opt: RefCreateOption, sourceId: string, at: { x: number; y: number }) {
  const genId = useCanvasStore.getState().createGenerateNode(opt.kind, at)
  const fresh = useCanvasStore.getState()
  if (opt.model) {
    const gen = fresh.nodesById.get(genId)?.data.gen
    if (gen) fresh.updateGenerate(genId, { params: { ...gen.params, model: opt.model } })
  }
  fresh.addGenerateRef(genId, sourceId, opt.role)
  fresh.setActiveGenerate(genId)
}

/**
 * 参考连线拖到空白画布的建卡菜单（reference-create-menu）：
 * 只列「已启用媒体模型里能吃这种素材」的目标 kind；点击 = 在落点建空 refs 生成卡 →
 * 默认链模型不兼容时显式指定可用模型 → addGenerateRef 按合法角色挂参考
 * （能力/成环/配额校验仍在 runtime）→ 选中新卡。Esc / 点击外部关闭。
 */
function ReferenceCreateMenu({ menu, onClose }: { menu: RefDropMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, true, onClose)
  const create = (opt: RefCreateOption) => {
    createGenerateFromReference(opt, menu.sourceId, menu.at)
    onClose()
  }
  return (
    <div
      ref={ref}
      data-testid="reference-create-menu"
      className="ctx-menu fixed z-50 rounded-2xl bg-(--surface-card) p-1.5 shadow-xl ring-1 ring-(--outline)"
      style={{
        left: Math.max(8, Math.min(menu.screen.x, window.innerWidth - 224)),
        top: Math.max(8, Math.min(menu.screen.y, window.innerHeight - 170)),
        width: 212,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-(--on-surface-muted)">
        「{menu.sourceName}」用来生成
      </div>
      {menu.options.map((opt) => (
        <button
          key={opt.kind}
          data-testid={`reference-create-${opt.kind}`}
          onClick={() => create(opt)}
          title={`模型 ${opt.modelLabel} · 角色 ${REF_ROLE_LABEL[opt.role]}（卡片上可再改）`}
          className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[12.5px] text-(--on-surface) transition-colors hover:bg-(--outline-soft)"
        >
          {opt.kind === 'image' ? <ImageIcon size={13} /> : opt.kind === 'video' ? <Video size={13} /> : <AudioLines size={13} />}
          <span className="min-w-0 flex-1 truncate">生成{MEDIA_LABEL[opt.kind]}</span>
          <span className="shrink-0 text-[10px] text-(--on-surface-muted)">{REF_ROLE_LABEL[opt.role]}</span>
        </button>
      ))}
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
  const activeGenerateId = useCanvasStore((s) => s.activeGenerateId)
  const workspace = useCanvasStore((s) => s.workspace)
  const { appearance, mediaProviders, resolveMediaModel } = useSettings()
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** 参考连线拖到空白画布后的「用来生成」菜单（reference-create-menu） */
  const [refMenu, setRefMenu] = useState<RefDropMenuState | null>(null)
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
      // 主组件已不订阅 nodes：手势回调里现取最新态（getState 既定模式，scheduleWrite
      // 回调内同样成立），框选途中新钉入 / 被移动的卡片也能正确命中
      return useCanvasStore.getState().nodes
        .filter((n) => !n.data.gen)
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
        /** 最新指针位置（client 坐标）：松手补算参考投放命中用 */
        let latestPointer = { x: e.clientX, y: e.clientY }
        // 参考投放（引用语义）：只在明确的参考接收区命中才算 —— 角色槽位
        // [data-reference-role]（或整卡接区 [data-reference-drop-zone]）。命中即挂参考
        // 并弹回原位；卡面普通重叠仍可自由摆放，「以此生成」入口在右键菜单保留。
        let refHover: { zone: HTMLElement; frame: HTMLElement; id: string } | null = null
        const setRefHover = (next: typeof refHover) => {
          if (refHover?.zone === next?.zone) return
          refHover?.frame.querySelector('[data-testid="gen-node"]')?.classList.remove('gen-ref-hover')
          next?.frame.querySelector('[data-testid="gen-node"]')?.classList.add('gen-ref-hover')
          refHover = next
        }
        const hitRefZone = (cx: number, cy: number) => {
          // 被拖卡片跟手挡在最上层：elementsFromPoint 取整叠，跳过自己子树，只认接收区
          for (const hit of document.elementsFromPoint(cx, cy)) {
            const frame = (hit as HTMLElement).closest?.('.canvas-node')
            if (!frame || frame === el) continue
            const zone = (hit as HTMLElement).closest?.('[data-reference-role], [data-reference-drop-zone]')
            if (!zone || !frame.contains(zone)) continue
            const id = frame.getAttribute('data-node-id')
            if (!id || id === node.id) continue
            if (useCanvasStore.getState().nodesById.get(id)?.data.gen) {
              return { zone: zone as HTMLElement, frame: frame as HTMLElement, id }
            }
          }
          return null
        }
        const onMove = (ev: MouseEvent) => {
          latestPointer = { x: ev.clientX, y: ev.clientY }
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
          const pt = latestPointer
          scheduleWrite(write, () => {
            el.style.transform = `translate3d(${current.x}px, ${current.y}px, 0)`
            // 参考连线跟手 + 投放命中检测合并进同一帧（elementsFromPoint 是强制命中测试）
            edgeSyncRef.current?.refreshReferenceEdges(node.id, {
              x: current.x,
              y: current.y,
              width: node.width,
              height: node.height,
            })
            setRefHover(hitRefZone(pt.x, pt.y))
          })
        }
        const finish = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', finish)
          if (write.raf) cancelAnimationFrame(write.raf)
          // 松手补算最后一次命中：快速甩动松手时它还压在未执行的 rAF 里，直接取消
          // 会漏判（setRefHover 内部有等值短路，命中已生效时这里是空转）
          if (dragging) setRefHover(hitRefZone(latestPointer.x, latestPointer.y))
          const dropped = refHover
          setRefHover(null)
          // 连线几何覆盖必须清除：摆放与引用两条路径随后回归已提交坐标
          edgeSyncRef.current?.refreshReferenceEdges(node.id, null)
          if (dragging) {
            el.classList.remove('canvas-node-dragging')
            setInteracting(false)
            suppressClickRef.current = true
            if (dropped) {
              // 命中接收区 = 挂参考并弹回原位（引用手势不改摆放）。角色取槽位显式值，
              // 未带则由 addGenerateRef 按模型能力自动推荐；能力/成环/配额校验都在 runtime
              el.style.transform = `translate3d(${start.x}px, ${start.y}px, 0)`
              const roleAttr = dropped.zone.getAttribute('data-reference-role')
              const role = MEDIA_REF_ROLES.includes(roleAttr as MediaRefRole) ? (roleAttr as MediaRefRole) : undefined
              useCanvasStore.getState().addGenerateRef(dropped.id, node.id, role)
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

  /** 画布空白处右键：新建生成卡片 / 清空画布 */
  const canvasItems = (at: { x: number; y: number }): ContextMenuItem[] => [
    { header: '新建生成卡片' },
    { label: '生成图片', icon: <ImageIcon size={13} />, onClick: () => useCanvasStore.getState().createGenerateNode('image', at) },
    { label: '生成视频', icon: <Video size={13} />, onClick: () => useCanvasStore.getState().createGenerateNode('video', at) },
    { label: '生成音频', icon: <AudioLines size={13} />, onClick: () => useCanvasStore.getState().createGenerateNode('audio', at) },
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
    // 「以此生成」与空白落点建卡走同一套能力判定：只列当前已配置模型能吃这种素材的
    // 目标 kind，角色标签取真实判定结果（不再写死垫图/首帧，也不再绕过校验直挂 refs）
    const refSource = d.kind === 'image' || d.kind === 'video' || d.kind === 'audio'
    const refOptions = refSource ? buildReferenceCreateOptions(d.kind as MediaKind) : []
    const deriveItems: ContextMenuItem[] = refSource
      ? [
          { header: `以此生成 · ${d.name}` },
          ...(refOptions.length === 0
            ? [
                {
                  label: '当前已启用的媒体模型都不接受此素材作参考',
                  disabled: true,
                } satisfies ContextMenuItem,
              ]
            : refOptions.map(
                (opt): ContextMenuItem => ({
                  label: `生成${MEDIA_LABEL[opt.kind]}（${REF_ROLE_LABEL[opt.role]}）`,
                  icon:
                    opt.kind === 'image' ? (
                      <ImageIcon size={13} />
                    ) : opt.kind === 'video' ? (
                      <Video size={13} />
                    ) : (
                      <AudioLines size={13} />
                    ),
                  onClick: () => createGenerateFromReference(opt, node.id, deriveAt),
                })
              )),
        ]
      : []
    return [
      ...deriveItems,
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
    const nodeId = (e.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id')
    // nodes 现取最新态（主组件已不订阅 nodes）；nodeItems 的入参节点由此得来
    const node = nodeId ? useCanvasStore.getState().nodes.find((n) => n.id === nodeId) : undefined
    const at = toCanvas(e.clientX, e.clientY)
    setMenu({ x: e.clientX, y: e.clientY, items: node ? nodeItems(node) : canvasItems(at) })
  }

  /** 某来源素材大类在某模型 caps 里可担当的首个角色（官方枚举顺序；无则 null） */
  const firstAcceptingRole = (sourceKind: MediaKind, caps: ResolvedRefCaps): MediaRefRole | null =>
    MEDIA_REF_ROLES.find((role) => MEDIA_ROLE_KIND[role] === sourceKind && (caps.quota[role] ?? 0) > 0) ?? null

  /**
   * 空白落点「用来生成」候选：目标 kind 三类逐一判 —— 先看默认链模型是否已兼容
   * （兼容就不覆盖 params.model），不兼容再找第一个能吃这种素材的已配置模型显式指定。
   * 只列实际可提交的候选：供应商必须 configured（凭据已就绪），模型不取 deprecated
   * （生命周期约定：deprecated 不出现在新建入口）。全都不兼容的 kind 不进菜单。
   */
  const buildReferenceCreateOptions = (sourceKind: MediaKind): RefCreateOption[] => {
    const options: RefCreateOption[] = []
    for (const kind of ['image', 'video', 'audio'] as MediaKind[]) {
      const resolved = resolveMediaModel(kind)
      const providerInfo = resolved ? mediaProviders.find((p) => p.id === resolved.provider) : undefined
      const info = providerInfo?.models.find((m) => m.id === resolved?.model)
      // 默认链命中的供应商也必须已配置凭据，否则该候选提交必失败，落往下方的已配置兜底
      if (info && providerInfo?.configured) {
        const role = firstAcceptingRole(sourceKind, normalizeMediaCaps(info.capabilities, kind))
        if (role) {
          options.push({ kind, role, model: null, modelLabel: info.label ?? info.id })
          continue
        }
      }
      for (const p of mediaProviders) {
        if (!p.configured) continue
        const model = p.models.find((m) => {
          if (m.kind !== kind || m.status === 'deprecated') return false
          return firstAcceptingRole(sourceKind, normalizeMediaCaps(m.capabilities, kind)) !== null
        })
        if (model) {
          options.push({
            kind,
            role: firstAcceptingRole(sourceKind, normalizeMediaCaps(model.capabilities, kind))!,
            model: `${p.id}:${model.id}`,
            modelLabel: model.label ?? model.id,
          })
          break
        }
      }
    }
    return options
  }

  /** 参考连线拖到空白画布：弹「用来生成」菜单搭生成链。卡片上的 drop 已由卡片自身消费（不落到这里） */
  const handleReferenceDrop = (e: React.DragEvent) => {
    // 普通素材卡等未消费的卡片落点不接管（只有空白位置才建卡）
    if ((e.target as HTMLElement).closest?.('[data-node-id]')) return
    const sourceId = parseReferencePayload(e.dataTransfer)
    if (!sourceId) return
    const source = useCanvasStore.getState().nodesById.get(sourceId)
    if (!source) return
    const kind = source.data.kind
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
      useCanvasStore.getState().showToast('文档/代码等文件不能作为媒体生成的参考素材')
      return
    }
    const options = buildReferenceCreateOptions(kind)
    if (options.length === 0) {
      useCanvasStore.getState().showToast(`当前已启用的媒体模型都不接受${KIND_LABEL[kind]}参考，可在设置 → 媒体供应商中启用支持参考输入的模型`)
      return
    }
    setRefMenu({
      screen: { x: e.clientX, y: e.clientY },
      at: toCanvas(e.clientX, e.clientY),
      sourceId,
      sourceName: source.data.name,
      options,
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
        // 参考连线通道优先放行：拖到空白画布 = 搭生成链（drop 里弹菜单）；
        // 生成卡片上的 drop 由卡片自身消费（stopPropagation），不经过这里
        if (types.includes(MEDIA_REFERENCE_MIME)) {
          e.preventDefault()
          return
        }
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
        // 通道〇：参考连线拖到空白画布 = 弹「用来生成」菜单搭生成链
        if (e.dataTransfer.types.includes(MEDIA_REFERENCE_MIME)) {
          e.preventDefault()
          handleReferenceDrop(e)
          return
        }
        // 通道一：OS 文件拖上画布 = 归档进素材库分类目录（asset:import-canvas）
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
            SVG 根不拦截事件，只有边线命中描边可点选。置于卡片之下，边不遮卡面 */}
        <ReferenceEdgeLayer syncRef={edgeSyncRef} />
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
        左键拖动框选 · 中键 / 空格+左键平移 · 滚轮缩放 · 拖卡片到生成卡参考槽位 = 挂参考 · 拖把手到空白 =
        搭生成链 · 清空画布在右上角
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {refMenu && <ReferenceCreateMenu menu={refMenu} onClose={() => setRefMenu(null)} />}
    </div>
  )
}
