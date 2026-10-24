import { Spline } from 'lucide-react'
import { LEGACY_ASSET_MIME } from '../../store/canvas/shared'

/**
 * 参考连接通道的唯一 MIME（契约与其他代理共用）：载荷 = 源节点 id 纯文本。
 * HTML5 dragover 阶段读不到 getData，通道判定一律走 e.dataTransfer.types；
 * 只有 drop 命中后才允许读载荷。
 */
export const MEDIA_REFERENCE_MIME = 'application/x-huabu-reference'

/**
 * 参考连接把手：按住可拖到生成卡片的角色槽位 / 整卡上，把它挂为参考素材；
 * 拖到空白画布 = 搭建生成链（落点由画布根处理）。
 *
 * 与旧回形针（ContextDragHandle）分工：回形针 = 附件语义（对话上下文/素材库归档），
 * 这个把手 = 引用连线语义（喂给别的生成卡片当垫图/首帧/参考）。两者 MIME 并存
 * （新通道 + 旧 LEGACY 通道都写），旧消费点（生成卡整卡 drop、对话坞）不断链。
 *
 * draggable 是 NodeFrame beginDrag 的豁免判据（target.closest('[draggable="true"]')），
 * 加上 mousedown/dragstart stopPropagation，确保不触发卡片移动与选中。
 * 把手放在卡片框内：NodeFrame 的 contentVisibility/paint containment 会裁掉出界部分。
 */
export function MediaConnectionHandle({
  nodeId,
  title,
  className = '',
}: {
  nodeId: string
  title: string
  /** 定位用：调用方负责放进卡片框内（如 left-2 top-1/2 或并入现有头部行） */
  className?: string
}) {
  return (
    <div
      draggable
      data-testid="media-connect-handle"
      data-source-node-id={nodeId}
      title={title}
      onDragStart={(e) => {
        e.stopPropagation()
        // 新通道：reference 语义，载荷 = 源 node.id；旧通道同写，既有 drop 消费点保持可用
        e.dataTransfer.setData(MEDIA_REFERENCE_MIME, nodeId)
        e.dataTransfer.setData(LEGACY_ASSET_MIME, nodeId)
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className={`cursor-grab rounded-full bg-(--glass) p-1.5 text-(--on-surface-variant) shadow-sm backdrop-blur transition-colors hover:bg-(--surface-card) hover:text-(--accent) ${className}`}
    >
      <Spline size={12} />
    </div>
  )
}
