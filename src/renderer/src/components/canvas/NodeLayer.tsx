import { useCanvasStore } from '../../store/canvasStore'
import { NodeFrame, type NodeGestureApi } from '../NodeFrame'

/**
 * 画布节点层：整个应用唯一的 nodes 数组订阅者（渲染层拆分）。
 *
 * 之前 nodes 由 CanvasWorkspace 主组件订阅，任何单节点变化（生成进度事件、
 * 拖拽提交、打标签…）都会重跑整个 workspace 函数体；现在收敛到这里：
 * - nodes 变化只重跑本组件，主组件函数体不再执行；
 * - NodeFrame 已 memo 且对 node 对象身份敏感，数组变化只有变更项真正重渲；
 * - api 恒定（useMemo 空依赖）；activeTag 仅用户点标签时变化，二者变化触发
 *   本层全量重渲可接受。
 *
 * 返回 fragment 不引入额外包裹层：变换层的子节点结构（卡片 + 框选矩形的
 * DOM 叠放顺序）与拆分前完全一致。
 */
/** 画布筛选条件（按素材属性分类：类型 / 状态 / 标签 / 素材库） */
export interface CanvasFilter {
  tag: string | null
  /** 素材大类型：image / video / audio / doc / code / other */
  kind: string | null
  /** 生成状态：done（有产物）/ pending（无产物）/ generating（任务在跑） */
  status: 'done' | 'pending' | 'generating' | null
  /** 所属素材库 id */
  libraryId: string | null
}

export const EMPTY_FILTER: CanvasFilter = { tag: null, kind: null, status: null, libraryId: null }

export function hasActiveFilter(f: CanvasFilter): boolean {
  return Boolean(f.tag || f.kind || f.status || f.libraryId)
}

export function NodeLayer({ api, filter }: { api: NodeGestureApi; filter: CanvasFilter }) {
  const nodes = useCanvasStore((s) => s.nodes)
  const jobStates = useCanvasStore((s) => s.jobStates)

  /** 素材是否满足全部筛选条件（AND 语义，与素材库/列表的收窄方式一致） */
  const matches = (node: (typeof nodes)[number]): boolean => {
    const d = node.data
    if (filter.tag && !(d.tags ?? []).includes(filter.tag)) return false
    if (filter.kind && d.kind !== filter.kind) return false
    if (filter.libraryId && d.libraryId !== filter.libraryId) return false
    if (filter.status) {
      const job = jobStates[node.id]
      const running = job?.status === 'queued' || job?.status === 'running'
      const hasArtifact = Boolean(d.storage && d.path)
      if (filter.status === 'generating' && !running) return false
      if (filter.status === 'done' && !hasArtifact) return false
      if (filter.status === 'pending' && (hasArtifact || running)) return false
    }
    return true
  }

  const active = hasActiveFilter(filter)
  return (
    <>
      {nodes.map((node) => (
        <NodeFrame key={node.id} node={node} api={api} dimmed={active && !matches(node)} />
      ))}
    </>
  )
}
