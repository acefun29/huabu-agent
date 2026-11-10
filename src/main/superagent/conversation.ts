/**
 * 专家内部对话回放（任务板点开的详情）。
 *
 * 专家会话落在工作区 `.huabu/mastra.db`（Mastra Memory），与主会话隔离：
 * threadId 由编排层按 `expert-<expertId>-<taskId>` 派生，验收重试换 `-r<attempt>`
 * 后缀。本模块只做两件事：
 * - 从 journal 的 `task.started` 事件还原「跑过哪几次尝试」；
 * - 把 Mastra 落库的消息（text / reasoning / tool-invocation）转成与 chat:history
 *   同构的块，渲染端复用已有的消息块组件，不再写第二套解析。
 *
 * 只读：这里不追加 Journal、不修改线程，UI 打开详情不会产生协作事实。
 */

import type {
  ChatHistoryBlock,
  ChatHistoryToolCall,
  ChatToolArgs,
  SuperAgentConversationMessage
} from '../../shared/ipc'
import type { JournalEvent } from './journal'

/** recall 返回消息的最小可读形态（避免把 Mastra 内部类型带到公开契约里） */
export interface StoredExpertMessage {
  role?: unknown
  content?: unknown
  createdAt?: unknown
}

/** 专家线程 id：与 orchestrator 的派生规则保持一致（重试换新线程） */
export function expertThreadId(expertId: string, taskId: string, attempt: number): string {
  const base = `expert-${expertId}-${taskId}`
  return attempt <= 1 ? base : `${base}-r${attempt}`
}

/**
 * journal 里该任务跑过的尝试次数（升序去重）。
 * 以 `task.started` 为准而不是 board.attempts：后者只统计验收失败，
 * 专家执行异常/取消时 board.attempts 可能是 0，但线程已经存在。
 */
export function startedAttempts(events: readonly JournalEvent[], taskId: string): number[] {
  const attempts: number[] = []
  for (const event of events) {
    if (event.type !== 'task.started' || event.taskId !== taskId) continue
    const raw = Number((event.payload as { attempt?: unknown }).attempt)
    let attempt = Number.isInteger(raw) && raw > 0 ? raw : 0
    if (attempt === 0) {
      // 旧事件没有 attempt：取最小的未用序号，避免重复事件把序号顶到实际次数之外
      attempt = 1
      while (attempts.includes(attempt)) attempt += 1
    }
    if (!attempts.includes(attempt)) attempts.push(attempt)
  }
  return attempts.sort((a, b) => a - b).slice(0, 20)
}

/** Mastra 消息 → 可传输的历史消息（忽略 system/signal 与空消息） */
export function toConversationMessages(
  messages: readonly StoredExpertMessage[]
): SuperAgentConversationMessage[] {
  const out: SuperAgentConversationMessage[] = []
  for (const message of messages) {
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'model' : null
    if (!role) continue
    const blocks = messageBlocks(message.content)
    if (blocks.length === 0) continue
    const text = blocks
      .filter((block): block is Extract<ChatHistoryBlock, { kind: 'text' }> => block.kind === 'text')
      .map((block) => block.text)
      .join('')
    const at = messageTime(message.createdAt)
    out.push({
      role,
      text,
      blocks,
      ...(at ? { at } : {})
    })
  }
  return out
}

/** content = { format, parts: [...] }（MastraDBMessage）；兼容纯字符串/纯 parts 数组 */
function messageBlocks(content: unknown): ChatHistoryBlock[] {
  if (typeof content === 'string') return content.trim() ? [{ kind: 'text', text: content }] : []
  if (!content || typeof content !== 'object') return []
  const record = content as Record<string, unknown>
  const parts = Array.isArray(record.parts) ? record.parts : Array.isArray(content) ? content : null
  if (!parts) {
    return typeof record.text === 'string' && record.text.trim() ? [{ kind: 'text', text: record.text }] : []
  }

  const blocks: ChatHistoryBlock[] = []
  for (const raw of parts) {
    if (!raw || typeof raw !== 'object') continue
    const part = raw as Record<string, unknown>
    if (part.type === 'text') {
      if (typeof part.text === 'string' && part.text.trim()) blocks.push({ kind: 'text', text: part.text })
      continue
    }
    if (part.type === 'reasoning') {
      // Mastra 的 reasoning 块正文在 `reasoning`；少数供应商写到 `text`
      const text =
        typeof part.reasoning === 'string'
          ? part.reasoning
          : typeof part.text === 'string'
            ? part.text
            : ''
      if (text.trim()) blocks.push({ kind: 'thinking', text })
      continue
    }
    if (part.type === 'tool-invocation') {
      const toolCall = toToolCall(part.toolInvocation)
      if (toolCall) blocks.push({ kind: 'tool', toolCall })
      continue
    }
    if (part.type === 'error') {
      const error = part.error as { message?: unknown } | undefined
      const text = typeof error?.message === 'string' ? error.message : '专家执行出错'
      blocks.push({ kind: 'text', text: `⚠️ ${text}` })
    }
  }
  return blocks
}

/** tool-invocation part → 回放工具卡（参数只保留可 JSON 化的浅层值） */
function toToolCall(raw: unknown): ChatHistoryToolCall | null {
  if (!raw || typeof raw !== 'object') return null
  const invocation = raw as Record<string, unknown>
  const id = typeof invocation.toolCallId === 'string' ? invocation.toolCallId : ''
  const name = typeof invocation.toolName === 'string' ? invocation.toolName : 'tool'
  if (!id && !name) return null
  const isError =
    invocation.isError === true ||
    invocation.state === 'output-error' ||
    invocation.state === 'output-denied'
  const resultText =
    toToolResultText(invocation.result) ||
    (isError && typeof invocation.errorText === 'string'
      ? truncate(invocation.errorText, 8000)
      : '')
  return {
    id: id || name,
    name,
    args: toToolArgs(invocation.args),
    status: isError ? 'error' : 'done',
    ...(resultText ? { resultText } : {})
  }
}

/** 工具参数：ChatToolArgs 只允许标量；对象/数组降级为截断后的 JSON 字符串 */
export function toToolArgs(raw: unknown): ChatToolArgs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const args: ChatToolArgs = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') args[key] = truncate(value, 4000)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) args[key] = value
    else {
      try {
        const json = JSON.stringify(value)
        if (json) args[key] = truncate(json, 4000)
      } catch {
        // 环引用等不可序列化值：跳过，不影响其它参数
      }
    }
  }
  return args
}

/** 工具结果文本：优先 text 字段，其次 JSON；与流式侧一样截断展示 */
export function toToolResultText(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return truncate(result, 8000)
  if (typeof result === 'object') {
    const record = result as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.trim()) return truncate(record.text, 8000)
    if (record.details && typeof record.details === 'object') {
      const details = record.details as Record<string, unknown>
      if (typeof details.text === 'string' && details.text.trim()) return truncate(details.text, 8000)
    }
    try {
      return truncate(JSON.stringify(result), 8000)
    } catch {
      return ''
    }
  }
  return truncate(String(result), 8000)
}

function messageTime(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  if (typeof value === 'string') {
    const at = Date.parse(value)
    return Number.isNaN(at) ? undefined : new Date(at).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return undefined
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
