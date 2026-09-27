/**
 * 会话消息块模型（从旧 types.ts 平移；渲染端与主进程桥接层共用的形状）。
 */
import type { ChatHistoryImage, ChatToolArgs } from '@shared/ipc'

export type { ChatStopReason } from '@shared/ipc'

/**
 * 一次工具调用的 UI 视图。
 *
 * 状态迁移：`tool_start` 建卡（running）→（`tool_update` 刷新进度文本）→ `tool_end` 收尾
 * （done / error）。长任务（bash / 媒体生成）在 running 期间会收到进度文本。
 */
export interface ChatToolCallView {
  /** Pi 的 toolCallId，事件与定稿快照四处一致，是配对的唯一键 */
  id: string
  name: string
  args: ChatToolArgs
  status: 'running' | 'done' | 'error'
  /** 工具返回的可展示文本，已在主进程截断 */
  resultText?: string
  /** 执行中的进度文本（tool_update 事件；如「图片生成生成中（42%）」），收尾后清除 */
  progressText?: string
  /** 结果图片缩略（仅回放：toolResult 的 image 块经主进程缩略后回填；原图不出主进程） */
  images?: ChatHistoryImage[]
}

/**
 * 消息内的有序内容块。
 *
 * 为什么不是一个 content 字符串 + 一个 toolCalls 数组：模型的真实输出是交错的
 * （说一句话 → 调工具 → 再说一句话）。块顺序以 Pi 定稿消息的 content 数组为准。
 */
export type ChatMessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCall: ChatToolCallView }
