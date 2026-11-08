/**
 * ModelGateway → AI SDK LanguageModelV2 适配（计划 §7.7 约束 8）。
 *
 * Mastra Agent 吃 AI SDK provider 规范的模型对象（vendored core 同时支持 v2/v3/v4，
 * 这里实现 v2——@ai-sdk/provider@2 规范，类型从 @ai-sdk/provider-v5 别名导入，纯类型依赖）。
 * Mastra 只看到这个 handle：provider 名带 huabu-gateway 前缀，供应商解析/鉴权全部留在网关内。
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from '@ai-sdk/provider-v5'
import type { GatewayMessage, ModelGateway, ModelRef, ModelStreamPart } from './types'

/** 计数器兜底：usage 缺失时给 0 并让 UI 显示 `—` 的职责在上层 */
function toV2Usage(inputTokens?: number, outputTokens?: number): LanguageModelV2Usage {
  const input = inputTokens ?? 0
  const output = outputTokens ?? 0
  return { inputTokens: input, outputTokens: output, totalTokens: input + output }
}

/** V2 prompt → 网关归一化消息 */
function toGatewayMessages(prompt: LanguageModelV2CallOptions['prompt']): GatewayMessage[] {
  const out: GatewayMessage[] = []
  for (const msg of prompt) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content })
      continue
    }
    if (msg.role === 'user') {
      out.push({
        role: 'user',
        content: msg.content.map((part) => {
          if (part.type === 'text') return { type: 'text' as const, text: part.text }
          // 文件 part：图片走 image；其余（音频等）降级为文本占位（资产 bytes 只经 read_media）
          if (part.type === 'file' && part.mediaType.startsWith('image/')) {
            return {
              type: 'image' as const,
              data: typeof part.data === 'string' ? part.data : Buffer.from(part.data as Uint8Array).toString('base64'),
              mimeType: part.mediaType,
            }
          }
          return {
            type: 'text' as const,
            text: `[unsupported part: ${part.type}${part.type === 'file' ? ` (${part.mediaType})` : ''}]`,
          }
        }),
      })
      continue
    }
    if (msg.role === 'assistant') {
      const assistantParts: GatewayMessage[] = []
      const content = msg.content
        .map((part) => {
          if (part.type === 'text') return { type: 'text' as const, text: part.text }
          if (part.type === 'reasoning') return { type: 'thinking' as const, text: part.text }
          if (part.type === 'tool-call') {
            return {
              type: 'tool-call' as const,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: safeParseArgs(part.input, part.toolCallId),
            }
          }
          // assistant 消息里内嵌的 tool-result：拆成独立的 tool 消息（pi-ai 的形状）
          if (part.type === 'tool-result') {
            assistantParts.push(toToolMessage(part))
          }
          return null
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
      out.push({ role: 'assistant', content })
      out.push(...assistantParts)
      continue
    }
    // role === 'tool'
    for (const part of msg.content) {
      if (part.type === 'tool-result') out.push(toToolMessage(part))
    }
  }
  return out
}

function toToolMessage(part: { toolCallId: string; toolName: string; output: unknown; isError?: boolean }): GatewayMessage {
  let text: string
  if (typeof part.output === 'string') {
    text = part.output
  } else if (
    part.output &&
    typeof part.output === 'object' &&
    'type' in part.output &&
    (part.output as { type: string }).type === 'json'
  ) {
    text = JSON.stringify((part.output as unknown as { value?: unknown }).value ?? null)
  } else {
    text = JSON.stringify(part.output ?? null)
  }
  return {
    role: 'tool',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    content: [{ type: 'text', text }],
    isError: part.isError,
  }
}

function safeParseArgs(input: unknown, toolCallId: string): Record<string, unknown> {
  if (typeof input !== 'string') {
    return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  }
  try {
    const parsed: unknown = JSON.parse(input || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new Error(`工具调用参数不是合法 JSON（toolCallId=${toolCallId}）`)
  }
}

/**
 * 把网关包装成 Mastra Agent 可用的 LanguageModelV2。
 * doStream/doGenerate 都经 `gateway.stream`，保证两条路径行为一致、指标同源。
 */
export function aiSdkLanguageModel(gateway: ModelGateway, ref: ModelRef): LanguageModelV2 {
  let seq = 0
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`

  function buildRequest(options: LanguageModelV2CallOptions) {
    const tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[] = []
    for (const tool of options.tools ?? []) {
      if (tool.type === 'function') {
        tools.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })
      }
    }
    return {
      runId: `lm-${Date.now().toString(36)}-${(seq += 1)}`,
      ref,
      messages: toGatewayMessages(options.prompt),
      ...(tools.length ? { tools } : {}),
      ...(options.maxOutputTokens != null ? { maxOutputTokens: options.maxOutputTokens } : {}),
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
    }
  }

  async function* run(options: LanguageModelV2CallOptions, signal: AbortSignal): AsyncIterable<ModelStreamPart> {
    yield* gateway.stream(buildRequest(options), signal)
  }

  return {
    specificationVersion: 'v2',
    provider: `huabu-gateway(${ref.providerId})`,
    modelId: ref.modelId,
    // 网关通道不接受 URL 文件 part（资产只传引用，bytes 经 read_media 工具）
    supportedUrls: {},

    async doStream(options) {
      const abortController = new AbortController()
      if (options.abortSignal) {
        if (options.abortSignal.aborted) abortController.abort()
        else options.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        async start(controller) {
          let openText: string | null = null
          let openReasoning: string | null = null
          let usage = toV2Usage()
          let finishReason: Extract<LanguageModelV2StreamPart, { type: 'finish' }>['finishReason'] = 'unknown'
          const closeOpen = () => {
            if (openText !== null) {
              controller.enqueue({ type: 'text-end', id: openText })
              openText = null
            }
            if (openReasoning !== null) {
              controller.enqueue({ type: 'reasoning-end', id: openReasoning })
              openReasoning = null
            }
          }
          controller.enqueue({ type: 'stream-start', warnings: [] })
          try {
            for await (const part of run(options, abortController.signal)) {
              switch (part.type) {
                case 'text-delta':
                  if (openText === null) {
                    openText = nextId('text')
                    controller.enqueue({ type: 'text-start', id: openText })
                  }
                  controller.enqueue({ type: 'text-delta', id: openText, delta: part.text })
                  break
                case 'thinking-delta':
                  if (openReasoning === null) {
                    openReasoning = nextId('reasoning')
                    controller.enqueue({ type: 'reasoning-start', id: openReasoning })
                  }
                  controller.enqueue({ type: 'reasoning-delta', id: openReasoning, delta: part.text })
                  break
                case 'tool-call':
                  closeOpen()
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: JSON.stringify(part.args ?? {}),
                  })
                  break
                case 'usage':
                  usage = toV2Usage(part.inputTokens, part.outputTokens)
                  break
                case 'finish':
                  closeOpen()
                  finishReason =
                    part.reason === 'tool-calls'
                      ? 'tool-calls'
                      : part.reason === 'length'
                        ? 'length'
                        : part.reason === 'stop'
                          ? 'stop'
                          : part.reason === 'abort'
                            ? 'other'
                            : 'error'
                  controller.enqueue({ type: 'finish', usage, finishReason })
                  break
                case 'error':
                  controller.enqueue({ type: 'error', error: new Error(`${part.code}: ${part.message}`) })
                  break
              }
            }
          } catch (err) {
            controller.enqueue({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) })
            controller.enqueue({ type: 'finish', usage, finishReason: 'error' })
          } finally {
            controller.close()
          }
        },
      })
      return { stream }
    },

    async doGenerate(options) {
      const abortController = new AbortController()
      if (options.abortSignal) {
        if (options.abortSignal.aborted) abortController.abort()
        else options.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
      const content: LanguageModelV2Content[] = []
      let text = ''
      let reasoning = ''
      let usage = toV2Usage()
      let finishReason: Extract<LanguageModelV2StreamPart, { type: 'finish' }>['finishReason'] = 'unknown'
      for await (const part of run(options, abortController.signal)) {
        switch (part.type) {
          case 'text-delta':
            text += part.text
            break
          case 'thinking-delta':
            reasoning += part.text
            break
          case 'tool-call':
            content.push({
              type: 'tool-call',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: JSON.stringify(part.args ?? {}),
            })
            break
          case 'usage':
            usage = toV2Usage(part.inputTokens, part.outputTokens)
            break
          case 'finish':
            finishReason =
              part.reason === 'tool-calls'
                ? 'tool-calls'
                : part.reason === 'length'
                  ? 'length'
                  : part.reason === 'stop'
                    ? 'stop'
                    : part.reason === 'abort'
                      ? 'other'
                      : 'error'
            break
          case 'error':
            throw new Error(`${part.code}: ${part.message}`)
        }
      }
      if (reasoning) content.unshift({ type: 'reasoning', text: reasoning })
      if (text) content.unshift({ type: 'text', text })
      return { content, finishReason, usage, warnings: [] }
    },
  } satisfies LanguageModelV2
}
