/**
 * 专家流式事件 → 实时对话块（主进程快照与渲染端续写共用一份纯函数）。
 *
 * 为什么需要它：Mastra memory 是逐轮落库的，专家第一轮还在跑时直接 recall 只能
 * 拿到空数组。主进程把 agent.stream 的 text/reasoning/tool 事件转成 task.expert_*
 * 事件，这里按事件顺序拼成与 chat:history 同构的消息块，UI 才能在运行中看到内容。
 */

import type {
  ChatHistoryBlock,
  ChatHistoryToolCall,
  ExpertLiveTranscript,
  TaskEvent
} from './ipc'

/** 合并一段文本/思考；同类块连续追加，遇到工具卡再起新块 */
function appendText(
  blocks: ChatHistoryBlock[],
  channel: 'text' | 'thinking',
  text: string
): ChatHistoryBlock[] {
  if (!text) return blocks
  const kind = channel === 'thinking' ? 'thinking' : 'text'
  const last = blocks[blocks.length - 1]
  if (last?.kind === kind) {
    return [...blocks.slice(0, -1), { kind, text: last.text + text }]
  }
  return [...blocks, { kind, text }]
}

function upsertTool(
  blocks: ChatHistoryBlock[],
  toolCall: ChatHistoryToolCall
): ChatHistoryBlock[] {
  const index = blocks.findIndex(
    (block) => block.kind === 'tool' && block.toolCall.id === toolCall.id
  )
  if (index === -1) return [...blocks, { kind: 'tool', toolCall }]
  const existing = blocks[index]
  if (!existing || existing.kind !== 'tool') return [...blocks, { kind: 'tool', toolCall }]
  const next = [...blocks]
  next[index] = {
    kind: 'tool',
    toolCall: { ...existing.toolCall, ...toolCall }
  }
  return next
}

/**
 * 应用一条事件；调用方应只在 event.taskId 命中时调用。
 * 返回 undefined 表示「还没有开始/无法归属」，不改变当前快照。
 */
export function applyExpertStreamEvent(
  current: ExpertLiveTranscript | undefined,
  event: TaskEvent
): ExpertLiveTranscript | undefined {
  switch (event.type) {
    case 'task.expert_start':
      return { attempt: event.attempt, blocks: [] }
    case 'task.expert_delta': {
      if (!current || current.attempt !== event.attempt) return current
      return { ...current, blocks: appendText(current.blocks, event.channel, event.text) }
    }
    case 'task.expert_tool_start': {
      if (!current || current.attempt !== event.attempt) return current
      return {
        ...current,
        blocks: upsertTool(current.blocks, {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          status: 'running'
        })
      }
    }
    case 'task.expert_tool_end': {
      if (!current || current.attempt !== event.attempt) return current
      const existing = current.blocks.find(
        (block) => block.kind === 'tool' && block.toolCall.id === event.toolCallId
      )
      return {
        ...current,
        blocks: upsertTool(current.blocks, {
          id: event.toolCallId,
          name: event.toolName,
          args: existing?.kind === 'tool' ? existing.toolCall.args : {},
          status: event.isError ? 'error' : 'done',
          ...(event.resultText ? { resultText: event.resultText } : {})
        })
      }
    }
    case 'task.expert_error': {
      if (!current || current.attempt !== event.attempt) return current
      return { ...current, blocks: appendText(current.blocks, 'text', `⚠️ ${event.message}`) }
    }
    default:
      return current
  }
}

/** 快照体量（用于「快照 vs 已收到的增量」择新：取文本更完整的一方） */
export function expertLiveSize(live: ExpertLiveTranscript | undefined): number {
  if (!live) return 0
  return live.blocks.reduce(
    (sum, block) => sum + (block.kind === 'tool' ? 1 : block.text.length),
    0
  )
}
