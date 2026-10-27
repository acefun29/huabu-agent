/**
 * Agent 侧消息载荷的生成规则（真实实现版，对应原型 src/harness/prompt.ts）。
 *
 * - @backend(payload)：用户消息发出前，把 buildReferencePayload 的产物拼在该条消息
 *   文本末尾一并发给模型（canvasStore.sendMessage）。
 */
import { KIND_LABEL, type MessageAttachment } from '../types'
import { REFERENCE_PAYLOAD_HEADER_PREFIX, REFERENCE_PAYLOAD_HEADER_SUFFIX } from '@shared/injection'

const ORIGIN_LABEL: Record<MessageAttachment['origin'], string> = {
  'workspace-asset': '工作区素材',
  'temp-upload': '临时上传'
}

/**
 * 用户消息里引用素材的载荷格式：每条一个绝对路径，不携带文件内容。
 * 绝对路径是契约的核心 —— Agent 不依赖当前目录、无需拼接即可访问。
 * 带生成历史的卡片附 genSummary：激活版本的提示词/参数 + 血脉链（递归祖先），
 * Agent 借此知道这张图的来龙去脉与引用链条（"基于刚生成的这张图换个风格"
 * 类指令靠它成立）。
 */
export function buildReferencePayload(attachments: MessageAttachment[]): string {
  if (attachments.length === 0) return ''
  const lines = attachments.map(
    (a) => `- [${KIND_LABEL[a.kind]} · ${ORIGIN_LABEL[a.origin]}] ${a.absPath}${a.genSummary ? `（${a.genSummary}）` : ''}`
  )
  return [
    // 头部常量在 @shared/injection：主进程回放拆分按它切「正文/本轮上下文」，改头必须改那里
    `${REFERENCE_PAYLOAD_HEADER_PREFIX}${attachments.length}${REFERENCE_PAYLOAD_HEADER_SUFFIX}（仅传入绝对路径，文件内容不随消息携带，请按路径自行读取）`,
    ...lines
  ].join('\n')
}
