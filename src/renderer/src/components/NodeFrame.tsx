import { memo, useRef } from 'react'
import type { CanvasNode } from '../types'
import { AssetNode } from './AssetNode'

/**
 * 画布节点外壳（替代 react-rnd）：绝对定位 + translate3d 摆位，自研 pointer 拖拽与右下角 resize。
 *
 * 性能契约（性能优化方案 P0-1）：
 * - 交互进行中只直写本元素 style（0 次 React 渲染），结束时才 updateNode 提交；
 * - transform 永远只反映已提交的 node.x/y —— 手势中的实时位置由手势循环直写 DOM，
 *   React 因 memo bailout 不会触碰 style，两者互不踩踏；
 * - 手势逻辑不在这里：NodeFrame 是哑组件，全部交互经 NodeGestureApi 回到 CanvasWorkspace，
 *   api 是稳定引用，memo 只对 node 对象身份敏感。
 */

/** CanvasWorkspace 注入的手势接口（一次性创建，引用恒定） */
export interface NodeGestureApi {
  beginDrag: (node: CanvasNode, el: HTMLElement, e: React.MouseEvent) => void
  beginResize: (node: CanvasNode, el: HTMLElement, e: React.MouseEvent) => void
  /** 非 gen 卡片按下时取消生成卡片高亮（保持旧交互） */
  onCardMouseDown: (node: CanvasNode) => void
  /** 拖动/缩放结束后的假 click 由这里吃掉；返回 true = 已消费 */
  consumeSuppressedClick: () => boolean
}

export const NodeFrame = memo(function NodeFrame({
  node,
  api,
  dimmed
}: {
  node: CanvasNode
  api: NodeGestureApi
  /** 标签筛选：不带当前筛选标签的卡片降透明度（不隐藏，位置感保留） */
  dimmed?: boolean
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={frameRef}
      data-node-id={node.id}
      className="canvas-node absolute left-0 top-0"
      style={{
        width: node.width,
        height: node.height,
        zIndex: node.zIndex,
        transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
        // 视口剔除（P2-6 轻量档）：离屏卡片跳过渲染/布局，占位尺寸防滚动语义漂移
        contentVisibility: 'auto',
        containIntrinsicSize: `${node.width}px ${node.height}px`,
        ...(dimmed ? { opacity: 0.22 } : {}),
        transition: 'opacity 0.2s ease'
      }}
      onMouseDown={(e) => {
        api.onCardMouseDown(node)
        api.beginDrag(node, frameRef.current ?? e.currentTarget, e)
      }}
      onClickCapture={(e) => {
        if (!api.consumeSuppressedClick()) return
        e.stopPropagation()
        e.preventDefault()
      }}
    >
      <AssetNode node={node} />
      <div className="node-resize-handle" onMouseDown={(e) => api.beginResize(node, frameRef.current ?? e.currentTarget, e)} />
    </div>
  )
})
