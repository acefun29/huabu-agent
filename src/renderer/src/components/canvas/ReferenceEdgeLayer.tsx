import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { REF_ROLE_LABEL } from '@shared/media'
import type { MediaRefRole } from '@shared/media'
import { useCanvasStore } from '../../store/canvasStore'
import { getGenerateReferences } from '../../lib/mediaReferenceGraph'
import type { CanvasNode } from '../../types'

/**
 * 参考连线层（引用链可视化）：把每张生成卡 references 的来源卡连成有向曲线。
 *
 * 职责边界：
 * - 纯派生、不持久化：连线只是 gen.references（或 legacy refs/refRoles 兼容视图）
 *   的投影，随 nodes/selection/activeGenerate 派生重算，不存任何 edges 字段；
 * - 无来源不画虚假边：来源卡已删除的失效引用由卡片内输入区 UI 呈现，这里跳过；
 * - 性能契约与画布手势对齐（P0-1）：拖动/resize 期间 store 不提交，本层经
 *   refreshReferenceEdges(nodeId, geom) 直写受影响 path 的 d 与 label 位置
 *   （算法唯一出口 = 纯几何函数 referenceEdgePath；路径缓存于注册表，不逐 mousemove
 *   扫 DOM、不触发 React 渲染）；手势结束/取消传 geom=null 回归已提交坐标。
 *
 * 命中与选择：SVG 根 pointer-events:none，不拦画布平移/框选/滚轮；每条边只有透明
 * 宽描边（.reference-edge-hit，pointer-events:stroke）可点选。选中的边通过
 * edge-remove 按钮按 referenceId 精准移除（同源另一角色互不影响）。Delete 键刻意
 * 不绑边删除，避免与「删除选中卡片」的全局键位冲突；Esc / 点击空白取消选边。
 * legacy 引用（无真实 caps 懒派生的角色）在此只作展示，不会写回数据。
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
 * slot 在两卡相对的卡缘上纵向散开（count=1 时取中点），路径/标签/命中区互不重叠，
 * 每条都能单独点中；手势同步（paintEdge）传同一组 slot/slotCount，几何口径一致。
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

/** 纯几何：t=0.5 中点（角色 label 与移除按钮的落点） */
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
  /** 悬停/选中时显示：源名-目标名-角色 */
  label: string
  from: EdgeGeom
  to: EdgeGeom
  /** 同源同目标边组内的位次与组大小（卡缘纵向散开用，0 起） */
  slot: number
  slotCount: number
  /** 端点被选中/激活 → 直接关系高亮 */
  hot: boolean
  d: string
  mid: { x: number; y: number }
}

interface EdgeElements {
  line: SVGPathElement
  hit: SVGPathElement
  label: SVGTextElement
  remove: SVGGElement
}

const geomOf = (n: CanvasNode): EdgeGeom => ({ x: n.x, y: n.y, width: n.width, height: n.height })

export function ReferenceEdgeLayer({ syncRef }: { syncRef: RefObject<ReferenceEdgeSync | null> }) {
  // 引用链是 nodes 的派生：这里是有意的第二个 nodes 订阅者（NodeLayer 之外），
  // 单节点变化只重渲本层；主组件保持不订阅 nodes（CanvasWorkspace 性能契约）。
  const nodes = useCanvasStore((s) => s.nodes)
  const selectedAssetIds = useCanvasStore((s) => s.selectedAssetIds)
  const activeGenerateId = useCanvasStore((s) => s.activeGenerateId)
  const svgRef = useRef<SVGSVGElement>(null)
  /** 选中的边（本地视觉态，不进 store）：edge-remove / Esc 的作用对象 */
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const edges = useMemo<DerivedEdge[]>(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const selected = new Set(selectedAssetIds)
    const raw: Omit<DerivedEdge, 'slot' | 'slotCount' | 'd' | 'mid'>[] = []
    for (const target of nodes) {
      if (!target.data.gen) continue
      for (const ref of getGenerateReferences(target, nodes)) {
        const source = byId.get(ref.sourceNodeId)
        if (!source) continue
        const hot =
          selected.has(source.id) || selected.has(target.id) || activeGenerateId === source.id || activeGenerateId === target.id
        raw.push({
          referenceId: ref.id,
          sourceId: source.id,
          targetId: target.id,
          role: ref.role,
          label: `${source.data.name}-${target.data.name}-${REF_ROLE_LABEL[ref.role]}`,
          from: geomOf(source),
          to: geomOf(target),
          hot,
        })
      }
    }
    // 同源同目标的边（同素材不同角色）按引用顺序分配卡缘纵向槽位：路径/标签/命中区
    // 分开，每条可单独点中；槽位随引用顺序稳定（重排引用会跟随重排，视觉可预期）
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
  }, [nodes, selectedAssetIds, activeGenerateId])

  const edgesRef = useRef(edges)
  edgesRef.current = edges

  /** 手势期间的几何覆盖（nodeId → 直写中的几何）；结束/取消由调用方传 null 清除 */
  const overridesRef = useRef(new Map<string, EdgeGeom>())
  /** referenceId → 该边当前 DOM 元素（每次 edges 重渲后重建；手势期间无渲染，保持稳定） */
  const registryRef = useRef(new Map<string, EdgeElements>())

  useLayoutEffect(() => {
    const reg = registryRef.current
    reg.clear()
    const svg = svgRef.current
    if (!svg) return
    for (const g of Array.from(svg.querySelectorAll<SVGGElement>('g[data-testid="reference-edge"]'))) {
      const key = g.getAttribute('data-reference-id')
      const line = g.querySelector<SVGPathElement>('.reference-edge-line')
      const hit = g.querySelector<SVGPathElement>('.reference-edge-hit')
      const label = g.querySelector<SVGTextElement>('.reference-edge-label')
      const remove = g.querySelector<SVGGElement>('.reference-edge-remove')
      if (!key || !line || !hit || !label || !remove) continue
      reg.set(key, { line, hit, label, remove })
    }
  }, [edges])

  const paintEdge = (key: string, from: EdgeGeom, to: EdgeGeom, slot = 0, slotCount = 1) => {
    const reg = registryRef.current.get(key)
    if (!reg) return
    const d = referenceEdgePath(from, to, slot, slotCount)
    reg.line.setAttribute('d', d)
    reg.hit.setAttribute('d', d)
    const mid = referenceEdgeMidpoint(from, to, slot, slotCount)
    reg.label.setAttribute('x', mid.x.toFixed(1))
    reg.label.setAttribute('y', (mid.y - 9).toFixed(1))
    reg.remove.setAttribute('transform', `translate(${mid.x.toFixed(1)} ${mid.y.toFixed(1)})`)
  }

  // 手势同步口：只写受影响边的 path/label DOM，不触碰 React 渲染（P0-1 契约）。
  // 闭包只依赖恒定 ref 与模块级纯函数，memo 空依赖安全；同对多边保留各自的散开槽位。
  const sync = useMemo<ReferenceEdgeSync>(
    () => ({
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
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  syncRef.current = sync

  // 选中的边消失（引用被移除/卡片删除/工作区切换）时静默清空选择态
  useEffect(() => {
    if (selectedId && !edges.some((e) => e.referenceId === selectedId)) setSelectedId(null)
  }, [edges, selectedId])

  // Esc / 点击空白取消选边（mousedown 用捕获阶段：边的 onMouseDown stopPropagation 只挡冒泡，
  // 这里照常收到，但 target 在边内则不清除 —— 保证点另一条边可以换选）
  useEffect(() => {
    if (!selectedId) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-testid="reference-edge"]')) setSelectedId(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [selectedId])

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
          className={`reference-edge${e.hot ? ' ref-edge-active' : ''}${
            selectedId === e.referenceId ? ' ref-edge-selected' : ''
          }`}
          data-reference-id={e.referenceId}
          data-source-node-id={e.sourceId}
          data-target-node-id={e.targetId}
          data-role={e.role}
          onMouseDown={(ev) => {
            // 选边不触发画布框选/平移，也不改卡片选中集（Delete 键因此删不到卡片）
            ev.stopPropagation()
            setSelectedId(e.referenceId)
          }}
        >
          <path
            className="reference-edge-line"
            d={e.d}
            markerEnd={e.hot || selectedId === e.referenceId ? 'url(#huabu-ref-arrow-active)' : 'url(#huabu-ref-arrow)'}
          />
          <path className="reference-edge-hit" d={e.d} />
          <text className="reference-edge-label" x={e.mid.x} y={e.mid.y - 9} textAnchor="middle">
            {e.label}
          </text>
          <g
            className="reference-edge-remove"
            data-testid="edge-remove"
            data-reference-id={e.referenceId}
            transform={`translate(${e.mid.x} ${e.mid.y})`}
            onMouseDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.stopPropagation()
              // 按 referenceId 精准移除：同源不同角色的 referenceId 不同，不会误删
              useCanvasStore.getState().removeGenerateRef(e.targetId, e.referenceId)
              setSelectedId(null)
            }}
          >
            <circle r="8" />
            <path d="M -3 -3 L 3 3 M 3 -3 L -3 3" />
          </g>
        </g>
      ))}
    </svg>
  )
}
