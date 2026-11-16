import { describe, expect, it } from 'vitest'
import {
  applyStreamChunk,
  asToolArgs,
  finalizeContent,
  initialStreamState,
  safeJson,
  summarizeResult,
  truncate,
  type StreamState
} from './streamReducer'
import type { ChatEvent } from '../../../shared/ipc'

/**
 * 流式分片 → ChatEvent 的映射（运行时心脏）。
 *
 * 这段原先内联在 runPrompt 里、零测试。它依赖 Mastra `fullStream` 的分片形状（第三方
 * 契约），升级时可能悄悄变：字段改名、payload 挪层、usage 换键。这里逐条钉住我们
 * **实际消费**的字段，形状一变测试先红，而不是等用户发现「思考块没了」「工具卡不转圈」。
 */

const N = 'node-1'

function feed(chunks: Array<{ type: string; payload?: Record<string, unknown> }>): {
  state: StreamState
  events: ChatEvent[]
} {
  let state = initialStreamState()
  const events: ChatEvent[] = []
  for (const chunk of chunks) {
    const applied = applyStreamChunk(state, chunk, N)
    state = applied.state
    events.push(...applied.events)
  }
  return { state, events }
}

describe('文本与思考增量', () => {
  it('text-delta 累积成 textBlocks，并按 delta 事件广播', () => {
    const { state, events } = feed([
      { type: 'text-delta', payload: { text: '你' } },
      { type: 'text-delta', payload: { text: '好' } }
    ])
    expect(state.textBlocks).toEqual(['你', '好'])
    expect(events).toEqual([
      { nodeId: N, type: 'delta', messageIndex: 0, contentIndex: 1, stream: 'text', delta: '你' },
      { nodeId: N, type: 'delta', messageIndex: 0, contentIndex: 1, stream: 'text', delta: '好' }
    ])
    expect(finalizeContent(state)).toEqual([{ type: 'text', text: '你好' }])
  })

  it('reasoning-delta 走 thinking 通道（contentIndex 0，排在正文前）', () => {
    const { state, events } = feed([
      { type: 'reasoning-delta', payload: { text: '先想' } },
      { type: 'text-delta', payload: { text: '再说' } }
    ])
    expect(events[0]).toMatchObject({ stream: 'thinking', contentIndex: 0, delta: '先想' })
    // 定稿顺序固定：thinking → text
    expect(finalizeContent(state).map((block) => block.type)).toEqual(['thinking', 'text'])
  })

  it('空 text 分片不丢帧（仍累积空串），但不会把 payload 缺失当成错误', () => {
    const { state, events } = feed([{ type: 'text-delta' }])
    expect(state.textBlocks).toEqual([''])
    expect(events[0]).toMatchObject({ delta: '' })
  })
})

describe('工具事件', () => {
  it('tool-call 广播 tool_start 并记入 toolCalls（定稿快照里是 toolCall 块）', () => {
    const { state, events } = feed([
      {
        type: 'tool-call',
        payload: { toolCallId: 'c1', toolName: 'generate_image', args: { prompt: '夜巷', ratio: '16:9', n: 2, ok: true, nil: null } }
      }
    ])
    // args 只留可结构化克隆的纯量（嵌套对象丢弃）
    expect(events[0]).toEqual({
      nodeId: N,
      type: 'tool_start',
      toolCallId: 'c1',
      toolName: 'generate_image',
      args: { prompt: '夜巷', ratio: '16:9', n: 2, ok: true, nil: null }
    })
    expect(state.toolCalls).toEqual([{ toolCallId: 'c1', toolName: 'generate_image' }])
    expect(finalizeContent(state)).toEqual([{ type: 'toolCall', toolCallId: 'c1', toolName: 'generate_image' }])
  })

  it('tool-result 带 isError 与 details，文本优先取 out.text', () => {
    const { events } = feed([
      {
        type: 'tool-result',
        payload: {
          toolCallId: 'c1',
          toolName: 'write',
          result: { text: '路径越界', isError: true, details: { bytes: 0 } }
        }
      }
    ])
    expect(events[0]).toMatchObject({
      type: 'tool_end',
      toolCallId: 'c1',
      toolName: 'write',
      isError: true,
      resultText: '路径越界'
    })
    // details 是序列化后的字符串（钉卡契约）
    expect((events[0] as { details?: string }).details).toBe('{"bytes":0}')
  })

  it('分片自带 isError 也能识别（工具没走适配层的情况）', () => {
    const { events } = feed([
      { type: 'tool-result', payload: { toolCallId: 'c2', toolName: 'x', isError: true } }
    ])
    expect(events[0]).toMatchObject({ type: 'tool_end', isError: true })
  })

  it('result 是对象但没有 text 时按摘要给（不把大负载丢给渲染端）', () => {
    const { events } = feed([
      {
        type: 'tool-result',
        payload: { toolCallId: 'c3', toolName: 'read', result: { parts: [{ text: '文件内容' }] } }
      }
    ])
    expect((events[0] as { resultText?: string }).resultText).toBe('文件内容')
  })
})

describe('用量、模型与错误', () => {
  it('finish 取 output.usage，totalTokens 缺失时用 input+output 兜底', () => {
    const a = feed([{ type: 'finish', payload: { output: { usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 } } } }])
    expect(a.state.usage).toEqual({ input: 10, output: 5, reasoning: 2, totalTokens: 15 })

    const b = feed([{ type: 'finish', payload: { output: { usage: { inputTokens: 3, outputTokens: 4, totalTokens: 99 } } } }])
    expect(b.state.usage).toMatchObject({ totalTokens: 99 })

    // usage 缺字段时补 0，不能让 undefined 进事件载荷
    const c = feed([{ type: 'finish', payload: { output: {} } }])
    expect(c.state.usage).toEqual({ input: 0, output: 0, reasoning: 0, totalTokens: 0 })
  })

  it('finish 带 stepResult.reason 时记录结束原因', () => {
    const { state } = feed([{ type: 'finish', payload: { output: { usage: {} }, stepResult: { reason: 'stop' } } }])
    expect(state.finishReason).toBe('stop')
  })

  it('response-metadata 记录模型名；空值忽略', () => {
    expect(feed([{ type: 'response-metadata', payload: { modelId: 'gpt-x' } }]).state.responseModel).toBe('gpt-x')
    expect(feed([{ type: 'response-metadata', payload: { modelId: '' } }]).state.responseModel).toBeUndefined()
  })

  it('error 分片记下错误消息，且不产生事件（由收尾统一处理）', () => {
    const { state, events } = feed([{ type: 'error', payload: { error: '供应商 500' } }])
    expect(state.errorMessage).toBe('供应商 500')
    expect(events).toEqual([])
    expect(feed([{ type: 'error', payload: {} }]).state.errorMessage).toBe('unknown error')
  })
})

describe('未知分片与收尾', () => {
  it('不认识的分片类型原样返回（Mastra 会持续加新类型，不该报错）', () => {
    const state = initialStreamState()
    const applied = applyStreamChunk(state, { type: 'brand-new-chunk', payload: { x: 1 } }, N)
    expect(applied.state).toBe(state)
    expect(applied.events).toEqual([])
  })

  it('没有任何内容时 finalizeContent 返回空数组（调用方据此跳过 message 事件）', () => {
    expect(finalizeContent(initialStreamState())).toEqual([])
  })

  it('多轮工具 + 文本混合的定稿顺序：thinking → text → 每个 toolCall', () => {
    const { state } = feed([
      { type: 'reasoning-delta', payload: { text: '想' } },
      { type: 'text-delta', payload: { text: '说' } },
      { type: 'tool-call', payload: { toolCallId: 'c1', toolName: 'a' } },
      { type: 'tool-call', payload: { toolCallId: 'c2', toolName: 'b' } }
    ])
    expect(finalizeContent(state).map((b) => (b.type === 'toolCall' ? b.toolCallId : b.type))).toEqual([
      'thinking',
      'text',
      'c1',
      'c2'
    ])
  })
})

describe('辅助函数', () => {
  it('asToolArgs 只留纯量，嵌套对象/数组/undefined 丢弃', () => {
    expect(asToolArgs({ a: 'x', b: 1, c: false, d: null, e: { nested: 1 }, f: [1], g: undefined })).toEqual({
      a: 'x',
      b: 1,
      c: false,
      d: null
    })
    expect(asToolArgs(null)).toEqual({})
    expect(asToolArgs('str')).toEqual({})
  })

  it('truncate 超长加省略号；summarizeResult 对环引用不抛错', () => {
    expect(truncate('abc', 2)).toBe('ab…')
    expect(truncate('ab', 2)).toBe('ab')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => summarizeResult(cyclic)).not.toThrow()
    expect(summarizeResult(null)).toBe('')
    expect(summarizeResult(42)).toBe('42')
  })

  it('safeJson 对环引用降级为字符串而不是抛错', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(safeJson({ ok: 1 }, 100)).toBe('{"ok":1}')
    expect(safeJson(cyclic, 100)).toBe('[object Object]')
  })
})
