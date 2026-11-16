import { afterEach, describe, expect, it } from 'vitest'
import { createModelGateway } from './index'
import type { ProviderRegistration } from '../../../models/manager'
import type { ModelStreamPart } from './types'

/**
 * 协议契约测试（A06）。
 *
 * 网关是自写的三套协议适配（completions / responses / anthropic），此前只有本地 stub
 * 跑通 completions 一条路径。这里用**假 fetch** 精确断言发出去的请求体与解出来的分片，
 * 覆盖文档里两个已复现的具体缺陷：
 *   1. Responses 的参数分片用 `item_id` 定位、累积表却按 `call_id` 建 → 工具参数丢成 `{}`；
 *   2. 目录 compat（`supportsReasoningEffort` / `thinkingFormat` / `forceAdaptiveThinking`）
 *      没被消费 → 该发的形态字段不发、不该发的照发。
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

interface Captured {
  url: string
  body: Record<string, unknown>
}

/** 假 fetch：记录请求体，并按给定 SSE 帧回放 */
function stubSse(frames: unknown[], capture: Captured[]): void {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    capture.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}

function registration(
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages',
  compat?: Record<string, unknown>
): ProviderRegistration[] {
  return [
    {
      providerId: 'stub',
      payload: {
        name: 'Stub',
        baseUrl: 'https://stub.local/v1',
        api,
        apiKey: 'k',
        models: [
          {
            id: 'm1',
            name: 'M1',
            reasoning: true,
            input: ['text'],
            contextWindow: 32000,
            maxTokens: 4000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...(compat ? { compat } : {})
          }
        ]
      }
    }
  ]
}

async function collect(
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages',
  frames: unknown[],
  options: { compat?: Record<string, unknown>; reasoning?: string } = {}
): Promise<{ parts: ModelStreamPart[]; captured: Captured[] }> {
  const captured: Captured[] = []
  stubSse(frames, captured)
  const gateway = createModelGateway({ registrations: () => registration(api, options.compat) })
  const parts: ModelStreamPart[] = []
  const controller = new AbortController()
  for await (const part of gateway.stream(
    {
      runId: 'run-1',
      ref: { providerId: 'stub', modelId: 'm1' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ...(options.reasoning ? { reasoning: options.reasoning } : {})
    },
    controller.signal
  )) {
    parts.push(part)
  }
  return { parts, captured }
}

describe('Responses：参数分片的 item_id / call_id 别名（A06-1）', () => {
  it('output_item.added 给 call_id，参数增量只带 item_id → 参数仍完整', async () => {
    const { parts } = await collect('openai-responses', [
      // 关键：added 里 call_id 与 id 不同；后续 delta 只带 item_id
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_item', call_id: 'call_123', name: 'write_file' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_item', delta: '{"path":"a.md",' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_item', delta: '"content":"hi"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } }
    ])
    const call = parts.find((part) => part.type === 'tool-call')
    expect(call).toMatchObject({ type: 'tool-call' })
    if (call?.type === 'tool-call') {
      // 修复前这里是 {}（分片全丢）
      expect(call.args).toEqual({ path: 'a.md', content: 'hi' })
      expect(call.toolCallId).toBe('call_123')
      expect(call.toolName).toBe('write_file')
    }
  })

  it('只在 done 里给完整 arguments 时兜底', async () => {
    const { parts } = await collect('openai-responses', [
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc2', call_id: 'call_2', name: 'ls' } },
      { type: 'response.function_call_arguments.done', item_id: 'fc2', arguments: '{"path":""}' },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }
    ])
    const call = parts.find((part) => part.type === 'tool-call')
    if (call?.type === 'tool-call') expect(call.args).toEqual({ path: '' })
  })
})

describe('Completions：目录 compat 真正生效（A06-2）', () => {
  const empty = [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]

  it('supportsReasoningEffort=false → 不发 reasoning_effort', async () => {
    const { captured } = await collect('openai-completions', empty, {
      compat: { thinkingFormat: 'openai', supportsReasoningEffort: false },
      reasoning: 'high'
    })
    expect(captured[0]?.body.reasoning_effort).toBeUndefined()
  })

  it('thinkingFormat=qwen → 发 enable_thinking（而不是只发 reasoning_effort）', async () => {
    const { captured } = await collect('openai-completions', empty, {
      compat: { thinkingFormat: 'qwen', supportsReasoningEffort: true },
      reasoning: 'medium'
    })
    expect(captured[0]?.body.enable_thinking).toBe(true)
    expect(captured[0]?.body.reasoning_effort).toBe('medium')
  })

  it('thinkingFormat=zai → 发 thinking.type=enabled，effort 受 supportsReasoningEffort 控制', async () => {
    const on = await collect('openai-completions', empty, {
      compat: { thinkingFormat: 'zai', supportsReasoningEffort: false },
      reasoning: 'high'
    })
    expect(on.captured[0]?.body.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(on.captured[0]?.body.reasoning_effort).toBeUndefined()
  })

  it('thinkingFormat=deepseek → thinking {type:enabled} + reasoning_effort', async () => {
    const { captured } = await collect('openai-completions', empty, {
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
      reasoning: 'low'
    })
    expect(captured[0]?.body.thinking).toEqual({ type: 'enabled' })
    expect(captured[0]?.body.reasoning_effort).toBe('low')
  })

  it('未指定档位：qwen 显式 enable_thinking=false，openai 不发任何思考字段', async () => {
    const qwen = await collect('openai-completions', empty, { compat: { thinkingFormat: 'qwen' } })
    expect(qwen.captured[0]?.body.enable_thinking).toBe(false)
    const openai = await collect('openai-completions', empty, { compat: { thinkingFormat: 'openai', supportsReasoningEffort: true } })
    expect(openai.captured[0]?.body.reasoning_effort).toBeUndefined()
    expect(openai.captured[0]?.body.enable_thinking).toBeUndefined()
  })

  it('thinkingTokenBudgetField → 发顶层 thinking_budget，并给回答留出配额（V02）', async () => {
    const { captured } = await collect('openai-completions', empty, {
      compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false, thinkingTokenBudgetField: 'thinking_budget' },
      reasoning: 'medium'
    })
    // medium = 8192；没有显式输出上限时 ceiling = 模型 maxTokens(4000) → 可留出 2976
    expect(captured[0]?.body.thinking_budget).toBe(2976)
  })

  it('thinkingTokenBudgetField：显式输出上限更小时按「至少留 1024 回答」收窄', async () => {
    const captured: Captured[] = []
    stubSse(empty, captured)
    const gateway = createModelGateway({
      registrations: () => registration('openai-completions', { thinkingTokenBudgetField: 'thinking_budget' })
    })
    const controller = new AbortController()
    for await (const _part of gateway.stream(
      { runId: 'run-1', ref: { providerId: 'stub', modelId: 'm1' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxOutputTokens: 2000, reasoning: 'medium' },
      controller.signal
    )) {
      /* 只关心请求体 */
    }
    expect(captured[0]?.body.thinking_budget).toBe(976) // 2000 - 1024
  })

  it('maxTokensField=max_completion_tokens → 用该字段而不是 max_tokens', async () => {
    const captured: Captured[] = []
    stubSse(empty, captured)
    const gateway = createModelGateway({
      registrations: () => registration('openai-completions', { maxTokensField: 'max_completion_tokens' })
    })
    const controller = new AbortController()
    for await (const _part of gateway.stream(
      { runId: 'run-1', ref: { providerId: 'stub', modelId: 'm1' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxOutputTokens: 512 },
      controller.signal
    )) {
      /* 只关心请求体 */
    }
    expect(captured[0]?.body.max_completion_tokens).toBe(512)
    expect(captured[0]?.body.max_tokens).toBeUndefined()
  })

  it('requiresReasoningContentOnAssistantMessages → 历史 assistant 补 reasoning_content（空串亦可）', async () => {
    const captured: Captured[] = []
    stubSse(empty, captured)
    const gateway = createModelGateway({
      registrations: () => registration('openai-completions', { requiresReasoningContentOnAssistantMessages: true })
    })
    const controller = new AbortController()
    for await (const _part of gateway.stream(
      {
        runId: 'run-1',
        ref: { providerId: 'stub', modelId: 'm1' },
        messages: [
          { role: 'user', content: [{ type: 'text', text: '写作' }] },
          { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
          { role: 'user', content: [{ type: 'text', text: '继续' }] }
        ]
      },
      controller.signal
    )) {
      /* 只关心请求体 */
    }
    const messages = captured[0]?.body.messages as Array<Record<string, unknown>>
    const assistant = messages.find((msg) => msg.role === 'assistant')
    // 修复前没有这个字段 → DeepSeek 这类供应商判非法
    expect(assistant?.reasoning_content).toBe('')
  })
})

describe('Anthropic：adaptive thinking 形态（A06-2）', () => {
  const empty = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' }
  ]

  it('forceAdaptiveThinking=true → thinking {type:adaptive} + output_config.effort', async () => {
    const { captured } = await collect('anthropic-messages', empty, {
      compat: { forceAdaptiveThinking: true },
      reasoning: 'high'
    })
    expect(captured[0]?.body.thinking).toEqual({ type: 'adaptive' })
    expect(captured[0]?.body.output_config).toEqual({ effort: 'high' })
  })

  it('默认走 budget_tokens 形态', async () => {
    const { captured } = await collect('anthropic-messages', empty, { reasoning: 'medium' })
    expect(captured[0]?.body.thinking).toMatchObject({ type: 'enabled' })
    expect((captured[0]?.body.thinking as { budget_tokens?: number }).budget_tokens).toBeGreaterThanOrEqual(1024)
    expect(captured[0]?.body.output_config).toBeUndefined()
  })
})
