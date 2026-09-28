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
export function NodeLayer({ api, activeTag }: { api: NodeGestureApi; activeTag: string | null }) {
  const nodes = useCanvasStore((s) => s.nodes)
  return (
    <>
      {nodes.map((node) => (
        <NodeFrame
          key={node.id}
          node={node}
          api={api}
          dimmed={Boolean(activeTag && !(node.data.tags ?? []).includes(activeTag))}
        />
      ))}
    </>
  )
}
