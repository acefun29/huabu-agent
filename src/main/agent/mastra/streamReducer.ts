/**
 * Mastra 流式分片 → `ChatEvent` 的纯映射（运行时心脏，抽出来才能单测）。
 *
 * 这一段此前内联在 `runtime.ts` 的 `runPrompt` 里，**没有任何测试**：它决定 UI 上
 * 逐字增量、思考块、工具卡、用量与错误怎么显示，而 Mastra 的 `fullStream` 分片形状
 * 属于第三方契约，升级时会悄悄变（字段改名、payload 挪层）。抽成纯函数后，形状变了
 * 测试会先红，而不是等用户发现「思考块不显示了」。
 *
 * 纯函数边界：输入 `(状态, 分片)`，输出 `(新状态, 要广播的事件)`。不碰会话、不碰 IO，
 * 广播由调用方按 `session.disposed` 过滤（A6）。
 */

import type { ChatContentBlock, ChatEvent, ChatUsage } from '../../../shared/ipc'
import type { AdaptedToolOutput } from './tools'

/** 一轮对话的累积状态（收尾时据此生成定稿快照） */
export interface StreamState {
  textBlocks: string[]
  thinkingBlocks: string[]
  toolCalls: Array<{ toolCallId: string; toolName: string; args?: Record<string, unknown> }>
  usage: ChatUsage | null
  finishReason?: string
  errorMessage?: string
  responseModel?: string
}

export function initialStreamState(): StreamState {
  return { textBlocks: [], thinkingBlocks: [], toolCalls: [], usage: null }
}

/** 分片里的 payload（Mastra 各 type 的 payload 形状不同，这里按需收窄） */
type Chunk = {
  type?: string
  payload?: Record<string, unknown> & {
    text?: unknown
    toolCallId?: unknown
    toolName?: unknown
    args?: unknown
    result?: unknown
    isError?: unknown
    output?: { usage?: Record<string, unknown> }
    stepResult?: { reason?: string }
    error?: unknown
    modelId?: unknown
  }
}

/**
 * 应用一个分片。未知 type 原样返回（Mastra 会持续加新分片类型，不认识的不该报错）。
 *
 * 事件顺序与 Pi 侧一致：agent_start / turn_start 由调用方在 stream 前发，这里只负责
 * delta 与工具事件；`message` / `agent_end` 也在调用方的 finally 里统一发。
 */
export function applyStreamChunk(
  state: StreamState,
  chunk: Chunk,
  nodeId: string
): { state: StreamState; events: ChatEvent[] } {
  const payload = chunk.payload ?? {}
  switch (chunk.type) {
    case 'text-delta': {
      const text = typeof payload.text === 'string' ? payload.text : ''
      return {
        state: { ...state, textBlocks: [...state.textBlocks, text] },
        events: [{ nodeId, type: 'delta', messageIndex: 0, contentIndex: 1, stream: 'text', delta: text }]
      }
    }
    case 'reasoning-delta': {
      const text = typeof payload.text === 'string' ? payload.text : ''
      return {
        state: { ...state, thinkingBlocks: [...state.thinkingBlocks, text] },
        events: [{ nodeId, type: 'delta', messageIndex: 0, contentIndex: 0, stream: 'thinking', delta: text }]
      }
    }
    case 'tool-call': {
      const toolCallId = String(payload.toolCallId ?? '')
      const toolName = String(payload.toolName ?? '')
      const args = asToolArgs(payload.args)
      return {
        state: { ...state, toolCalls: [...state.toolCalls, { toolCallId, toolName }] },
        events: [{ nodeId, type: 'tool_start', toolCallId, toolName, args }]
      }
    }
    case 'tool-result': {
      // tools.ts 适配后的输出形状：{text, isError?, images?, details?}
      const out = payload.result as AdaptedToolOutput | undefined
      return {
        state,
        events: [
          {
            nodeId,
            type: 'tool_end',
            toolCallId: String(payload.toolCallId ?? ''),
            toolName: String(payload.toolName ?? ''),
            // 两处都要看：工具自报的 isError（tools.ts 已透传）与分片自带的 isError
            isError: out?.isError === true || payload.isError === true,
            resultText: typeof out?.text === 'string' ? truncate(out.text) : summarizeResult(out),
            ...(out?.details !== undefined ? { details: safeJson(out.details, 1200) } : {})
          }
        ]
      }
    }
    case 'response-metadata': {
      const modelId = payload.modelId
      if (typeof modelId !== 'string' || !modelId) return { state, events: [] }
      return { state: { ...state, responseModel: modelId }, events: [] }
    }
    case 'finish': {
      const u = payload.output?.usage ?? {}
      const input = num(u.inputTokens)
      const output = num(u.outputTokens)
      return {
        state: {
          ...state,
          usage: {
            input,
            output,
            reasoning: num(u.reasoningTokens),
            totalTokens: num(u.totalTokens) || input + output
          },
          ...(payload.stepResult?.reason ? { finishReason: payload.stepResult.reason } : {})
        },
        events: []
      }
    }
    case 'error': {
      const message = String(payload.error ?? 'unknown error')
      return { state: { ...state, errorMessage: message }, events: [] }
    }
    default:
      return { state, events: [] }
  }
}

/**
 * 收尾定稿快照的内容块（与 Pi 的 `message` 事件同构）。
 *
 * 顺序固定 thinking → text → toolCall：渲染端按这个顺序渲染同一条助手消息。
 * 没有任何内容时返回空数组，调用方据此跳过 `message` 事件。
 */
export function finalizeContent(state: StreamState): ChatContentBlock[] {
  const content: ChatContentBlock[] = []
  if (state.thinkingBlocks.length) content.push({ type: 'thinking', thinking: state.thinkingBlocks.join('') })
  if (state.textBlocks.length) content.push({ type: 'text', text: state.textBlocks.join('') })
  for (const call of state.toolCalls) {
    content.push({ type: 'toolCall', toolCallId: call.toolCallId, toolName: call.toolName })
  }
  return content
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 只放可结构化克隆的纯数据（ChatToolArgs 契约） */
export function asToolArgs(args: unknown): Record<string, string | number | boolean | null> {
  if (!args || typeof args !== 'object') return {}
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    }
  }
  return out
}

/** 工具结果摘要：文本部分拼接，大对象 JSON 化后截断（不把大负载丢给渲染端） */
export function summarizeResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return truncate(result)
  if (typeof result === 'object') {
    const text = extractText(result)
    if (text) return truncate(text)
    try {
      return truncate(JSON.stringify(result))
    } catch {
      return ''
    }
  }
  return truncate(String(result))
}

export function truncate(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** details 序列化（钉卡契约的最小保证：可 JSON 化 + 截断；环引用等异常降级为字符串） */
export function safeJson(value: unknown, max: number): string | undefined {
  try {
    return truncate(JSON.stringify(value), max)
  } catch {
    return truncate(String(value), max)
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object') return ''
  const record = content as Record<string, unknown>
  const parts = record.parts ?? record.content
  if (Array.isArray(parts)) {
    return parts
      .map((part) =>
        part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''
      )
      .join('')
  }
  if (typeof record.text === 'string') return record.text
  return ''
}
