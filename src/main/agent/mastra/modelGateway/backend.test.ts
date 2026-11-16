import { afterEach, describe, expect, it } from 'vitest'
import { createModelGateway } from './index'
import type { ProviderRegistration } from '../../../models/manager'

/**
 * 网关的取消语义（A08）。
 *
 * 断点：`stream()` 只 `addEventListener('abort')`，对**传入时就已经取消**的 signal
 * 完全不处理——下游 `fetch` 照样发请求。表现是「任务已取消，但模型调用还在花钱、
 * 结果还会回写」。
 *
 * 这里用假的 fetch 观察传给它的 signal：修复前 `aborted` 是 false（请求照发），
 * 修复后必须是 true，并且流以 `error/aborted` + `finish/abort` 收尾。
 */

const registrations: ProviderRegistration[] = [
  {
    providerId: 'stub',
    payload: {
      name: 'Stub',
      baseUrl: 'https://stub.local/v1',
      api: 'openai-completions',
      apiKey: 'k',
      models: [
        {
          id: 'stub-1',
          name: 'Stub 1',
          reasoning: false,
          input: ['text'],
          contextWindow: 8000,
          maxTokens: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
      ]
    }
  }
]

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 假 fetch：记录收到的 signal，并在已取消时像真 fetch 一样拒绝 */
function stubFetch(): Array<AbortSignal | undefined> {
  const seen: Array<AbortSignal | undefined> = []
  globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    seen.push(init?.signal)
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return seen
}

const request = {
  runId: 'run-1',
  ref: { providerId: 'stub', modelId: 'stub-1' },
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]
}

describe('ModelGateway 取消语义', () => {
  it('传入时已取消的 signal：下游 fetch 立即看到 aborted，流以 abort 收尾', async () => {
    const seen = stubFetch()
    const gateway = createModelGateway({ registrations: () => registrations })
    const controller = new AbortController()
    controller.abort()

    const parts: Array<{ type: string; code?: string; reason?: string }> = []
    for await (const part of gateway.stream(request, controller.signal)) {
      parts.push(part as unknown as { type: string; code?: string; reason?: string })
    }

    // 关键断言：传给 fetch 的 signal 已经是取消态（修复前是 false → 请求照发）
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
    // 流也必须以「中止」而不是「正常结束」收尾，调用方才能区分
    expect(parts.some((part) => part.type === 'error' && part.code === 'aborted')).toBe(true)
    expect(parts.some((part) => part.type === 'finish' && part.reason === 'abort')).toBe(true)
  })

  it('未取消的 signal：正常发出请求（不误伤）', async () => {
    const seen = stubFetch()
    const gateway = createModelGateway({ registrations: () => registrations })
    const controller = new AbortController()
    const parts: Array<{ type: string }> = []
    for await (const part of gateway.stream(request, controller.signal)) {
      parts.push(part as unknown as { type: string })
    }
    expect(seen[0]?.aborted).toBe(false)
    expect(parts.some((part) => part.type === 'error')).toBe(false)
    expect(parts.some((part) => part.type === 'finish')).toBe(true)
  })
})
