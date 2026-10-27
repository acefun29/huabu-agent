import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { REF_ROLE_LABEL } from '@shared/media'
import type { MediaRefRole } from '@shared/media'
import { useCanvasStore } from '../../store/canvasStore'
import { getCardReferences } from '../../lib/mediaReferenceGraph'
import type { CanvasNode } from '../../types'

/**
 * 引用连线层（引用链可视化）：把每张卡当前引用链的来源卡连成有向曲线。
 *
 * 职责边界：
 * - 纯派生、不持久化：连线只是 getCardReferences（激活版本 inputs.refs → 迁移
 *   references → legacy refs/refRoles 三级解析）的投影，随 nodes/selection 派生
 *   重算，不存任何 edges 字段；
 * - **只读**：链条是生成事实的记录，用户与 Agent 都不能建链/删链 —— 本层没有
 *   边删除按钮，只有悬停/端点选中的高亮；可在设置里整体隐藏（Shift+E）；
 * - 无来源不画虚假边：来源卡已删除（或画布外文件无 sourceNodeId）的引用跳过，
 *   失效信息由版本详情面板呈现；
 * - 性能契约与画布手势对齐（P0-1）：拖动/resize 期间 store 不提交，本层经
 *   refreshReferenceEdges(nodeId, geom) 直写受影响 path 的 d 与 label 位置
 *   （算法唯一出口 = 纯几何函数 referenceEdgePath；路径缓存于注册表，不逐 mousemove
 *   扫 DOM、不触发 React 渲染）；手势结束/取消传 geom=null 回归已提交坐标。
 *
 * 命中与高亮：SVG 根 pointer-events:none，不拦画布平移/框选/滚轮；每条边只有透明
 * 宽描边（.reference-edge-hit，pointer-events:stroke）可悬停/点按高亮（查看关系用）。
 */

/** 节点几何（画布坐标系，与 NodeFrame 的 x/y/width/height 同义） */
export interface EdgeGeom {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 锚点：源卡右缘出、目标卡左缘入。同源同目标的多条边（同一素材挂不同角色）按
 * slot 在两卡相对的卡缘上纵向散开（count=1 时取中点），路径/标签/命中区互不重叠；
 * 手势同步（paintEdge）传同一组 slot/slotCount，几何口径一致。
 */
function edgeAnchors(from: EdgeGeom, to: EdgeGeom, slot = 0, count = 1) {
  const frac = count > 1 ? (slot + 1) / (count + 1) : 0.5
  return {
    sx: from.x + from.width,
    sy: from.y + from.height * frac,
    tx: to.x,
    ty: to.y + to.height * frac,
  }
}

/** 纯几何：边路径 d（三次贝塞尔 + 水平控制点 —— 出右侧、入左侧，弓向即方向） */
export function referenceEdgePath(from: EdgeGeom, to: EdgeGeom, slot = 0, count = 1): string {
  const { sx, sy, tx, ty } = edgeAnchors(from, to, slot, count)
  const k = Math.max(48, Math.abs(tx - sx) * 0.42)
  return `M ${sx} ${sy} C ${sx + k} ${sy}, ${tx - k} ${ty}, ${tx} ${ty}`
}

/** 纯几何：t=0.5 中点（角色 label 的落点） */
export function referenceEdgeMidpoint(
  from: EdgeGeom,
  to: EdgeGeom,
  slot = 0,
  count = 1
): { x: number; y: number } {
  const { sx, sy, tx, ty } = edgeAnchors(from, to, slot, count)
  const k = Math.max(48, Math.abs(tx - sx) * 0.42)
  return { x: (sx + 3 * (sx + k) + 3 * (tx - k) + tx) / 8, y: (sy + ty) / 2 }
}

/** 画布手势期间的轻量 DOM 同步口（挂在 CanvasWorkspace 的 ref 上，随图层卸载置空） */
export interface ReferenceEdgeSync {
  /** geom=null = 清除该节点的手势覆盖、回归已提交坐标（手势结束与取消都必须调） */
  refreshReferenceEdges: (nodeId: string, geom: EdgeGeom | null) => void
}

interface DerivedEdge {
  referenceId: string
  sourceId: string
  targetId: string
  role: MediaRefRole
  /** 悬停时显示：源名-目标名-角色 */
  label: string
  from: EdgeGeom
  to: EdgeGeom
  /** 同源同目标边组内的位次与组大小（卡缘纵向散开用，0 起） */
  slot: number
  slotCount: number
  /** 端点被选中 → 直接关系高亮 */
  hot: boolean
  d: string
  mid: { x: number; y: number }
}

interface EdgeElements {
  line: SVGPathElement
  hit: SVGPathElement
  label: SVGTextElement
}

const geomOf = (n: CanvasNode): EdgeGeom => ({ x: n.x, y: n.y, width: n.width, height: n.height })

const NOOP_SYNC: ReferenceEdgeSync = { refreshReferenceEdges: () => {} }

export function ReferenceEdgeLayer({
  syncRef,
  visible,
}: {
  syncRef: RefObject<ReferenceEdgeSync | null>
  /** 引用链显隐（设置 → 外观 / Shift+E）；隐藏时本层不渲染，手势同步退化为空操作 */
  visible: boolean
}) {
  // 引用链是 nodes 的派生：这里是有意的第二个 nodes 订阅者（NodeLayer 之外），
  // 单节点变化只重渲本层；主组件保持不订阅 nodes（CanvasWorkspace 性能契约）。
  const nodes = useCanvasStore((s) => s.nodes)
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds)
  const svgRef = useRef<SVGSVGElement>(null)

  const edges = useMemo<DerivedEdge[]>(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const selected = new Set(selectedAssetIds)
    const raw: Omit<DerivedEdge, 'slot' | 'slotCount' | 'd' | 'mid'>[] = []
    for (const target of nodes) {
      for (const ref of getCardReferences(target, nodes)) {
        const source = byId.get(ref.sourceNodeId)
        if (!source) continue
        const hot = selected.has(source.id) || selected.has(target.id)
        raw.push({
          referenceId: ref.id,
          sourceId: source.id,
          targetId: target.id,
          role: ref.role,
          label: `${source.data.name}→${target.data.name}·${REF_ROLE_LABEL[ref.role]}`,
          from: geomOf(source),
          to: geomOf(target),
          hot,
        })
      }
    }
    // 同源同目标的边（同素材不同角色）按引用顺序分配卡缘纵向槽位：路径/标签/命中区
    // 分开，互不重叠；槽位随引用顺序稳定（视觉可预期）
    const groupCount = new Map<string, number>()
    for (const e of raw) {
      const key = `${e.sourceId}|${e.targetId}`
      groupCount.set(key, (groupCount.get(key) ?? 0) + 1)
    }
    const groupSeq = new Map<string, number>()
    return raw.map((e) => {
      const key = `${e.sourceId}|${e.targetId}`
      const slot = groupSeq.get(key) ?? 0
      groupSeq.set(key, slot + 1)
      const slotCount = groupCount.get(key) ?? 1
      return {
        ...e,
        slot,
        slotCount,
        d: referenceEdgePath(e.from, e.to, slot, slotCount),
        mid: referenceEdgeMidpoint(e.from, e.to, slot, slotCount),
      }
    })
  }, [nodes, selectedAssetIds])

  const edgesRef = useRef(edges)
  edgesRef.current = edges

  /** 手势期间的几何覆盖（nodeId → 直写中的几何）；结束/取消由调用方传 null 清除 */
  const overridesRef = useRef(new Map<string, EdgeGeom>())
  /** referenceId → 该边当前 DOM 元素（每次 edges 重渲后重建；手势期间无渲染，保持稳定） */
  const registryRef = useRef(new Map<string, EdgeElements>())

  useLayoutEffect(() => {
    if (!visible) return
    const reg = registryRef.current
    reg.clear()
    const svg = svgRef.current
    if (!svg) return
    for (const g of Array.from(svg.querySelectorAll<SVGGElement>('g[data-testid="reference-edge"]'))) {
      const key = g.getAttribute('data-reference-id')
      const line = g.querySelector<SVGPathElement>('.reference-edge-line')
      const hit = g.querySelector<SVGPathElement>('.reference-edge-hit')
      const label = g.querySelector<SVGTextElement>('.reference-edge-label')
      if (!key || !line || !hit || !label) continue
      reg.set(key, { line, hit, label })
    }
  }, [edges, visible])

  const paintEdge = (key: string, from: EdgeGeom, to: EdgeGeom, slot = 0, slotCount = 1) => {
    const reg = registryRef.current.get(key)
    if (!reg) return
    const d = referenceEdgePath(from, to, slot, slotCount)
    reg.line.setAttribute('d', d)
    reg.hit.setAttribute('d', d)
    const mid = referenceEdgeMidpoint(from, to, slot, slotCount)
    reg.label.setAttribute('x', mid.x.toFixed(1))
    reg.label.setAttribute('y', (mid.y - 9).toFixed(1))
  }

  // 手势同步口：只写受影响边的 path/label DOM，不触碰 React 渲染（P0-1 契约）。
  // 隐藏时退化为空操作（本层不渲染、注册表为空，paintEdge 自然无命中，这里显式置空
  // 更直白）。闭包只依赖恒定 ref 与模块级纯函数，memo 空依赖安全。
  const sync = useMemo<ReferenceEdgeSync>(
    () =>
      visible
        ? {
            refreshReferenceEdges: (nodeId, geom) => {
              if (geom) overridesRef.current.set(nodeId, geom)
              else overridesRef.current.delete(nodeId)
              for (const e of edgesRef.current) {
                if (e.sourceId !== nodeId && e.targetId !== nodeId) continue
                const from = overridesRef.current.get(e.sourceId) ?? e.from
                const to = overridesRef.current.get(e.targetId) ?? e.to
                paintEdge(e.referenceId, from, to, e.slot, e.slotCount)
              }
            },
          }
        : NOOP_SYNC,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible]
  )
  syncRef.current = sync

  if (!visible) return null

  return (
    <svg ref={svgRef} className="reference-edge-layer">
      <defs>
        <marker id="huabu-ref-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M 1 1 L 6.5 4 L 1 7" className="ref-arrow-normal" />
        </marker>
        <marker id="huabu-ref-arrow-active" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M 1 1 L 6.5 4 L 1 7" className="ref-arrow-active" />
        </marker>
      </defs>
      {edges.map((e) => (
        <g
          key={e.referenceId}
          data-testid="reference-edge"
          className={`reference-edge${e.hot ? ' ref-edge-active' : ''}`}
          data-reference-id={e.referenceId}
          data-source-node-id={e.sourceId}
          data-target-node-id={e.targetId}
          data-role={e.role}
        >
          <path
            className="reference-edge-line"
            d={e.d}
            markerEnd={e.hot ? 'url(#huabu-ref-arrow-active)' : 'url(#huabu-ref-arrow)'}
          />
          <path className="reference-edge-hit" d={e.d} />
          <text className="reference-edge-label" x={e.mid.x} y={e.mid.y - 9} textAnchor="middle">
            {e.label}
          </text>
        </g>
      ))}
    </svg>
  )
}
