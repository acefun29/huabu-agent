/**
 * 自有 provider HTTP 层（Mastra 迁移计划 v1.2 §5.5/§7.7，尾约束 §16.4-17「Pi 不再是依赖」）。
 *
 * 直接对三种协议发请求并解析 SSE，零 pi 依赖：
 * - `openai-completions`  → POST {baseUrl}/chat/completions
 * - `openai-responses`    → POST {baseUrl}/responses
 * - `anthropic-messages`  → POST {baseUrl}/messages
 *
 * 职责边界（与计划 §7.7 一致）：鉴权头、供应商字段差异、SSE 解析、tool call 累积、
 * usage 归一化都在本层；上层（gateway）只认归一化的 ModelStreamPart。
 */

import type { GatewayContentPart, GatewayMessage, GatewayToolDef } from './types'

/** 供应商解析结果（目录 + 凭据 + 能力） */
export interface ProviderTarget {
  providerId: string
  baseUrl: string
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  apiKey?: string
  modelId: string
  /** 模型能力（目录声明） */
  input: Array<'text' | 'image'>
  maxTokens: number
  contextWindow: number
  compat?: Record<string, unknown>
}

export interface ProviderCallRequest {
  target: ProviderTarget
  system?: string
  messages: GatewayMessage[]
  tools?: GatewayToolDef[]
  maxOutputTokens?: number
  temperature?: number
  /** 思考档位（pi 语义的 minimal..max） */
  reasoning?: string
  signal: AbortSignal
  /** 鉴权风格覆盖：bearer = Authorization: Bearer（代理网关） */
  authStyle?: 'bearer' | 'default'
}

/** 供应商流式增量（未归一化的内部形态，gateway 再转 ModelStreamPart） */
export type ProviderDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'finish'; reason: 'stop' | 'toolUse' | 'length' | 'error' | 'aborted' }

/** 按协议分发 */
export async function* callProvider(req: ProviderCallRequest): AsyncIterable<ProviderDelta> {
  switch (req.target.api) {
    case 'openai-completions':
      yield* callOpenAICompletions(req)
      return
    case 'openai-responses':
      yield* callOpenAIResponses(req)
      return
    case 'anthropic-messages':
      yield* callAnthropicMessages(req)
      return
  }
}

/* ---------------------------------------------------------------- 公共工具 */

/** 鉴权头：anthropic 默认 x-api-key，其余 Bearer；authStyle=bearer 强制 Bearer */
function authHeaders(target: ProviderTarget, authStyle?: 'bearer' | 'default'): Record<string, string> {
  const key = target.apiKey
  if (!key) return {}
  if (authStyle === 'bearer') return { authorization: `Bearer ${key}` }
  if (target.api === 'anthropic-messages') return { 'x-api-key': key }
  return { authorization: `Bearer ${key}` }
}

/** 拼端点：baseUrl 可能已带 /v1，避免重复拼接 */
function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  // baseUrl 已含协议路径（.../v1、.../compatible-mode/v1、.../anthropic）时直接接
  if (/\/(v1|v1beta|openai)$/.test(base) || base.endsWith('/compatible-mode/v1')) {
    return `${base}/${path}`
  }
  return `${base}/v1/${path}`
}

/** SSE 行解析：逐帧产出 data 负载（[DONE] 由调用方处理） */
async function* readSse(response: Response): AsyncIterable<string> {
  if (!response.body) throw new Error('供应商响应无 body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 帧以空行分隔
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of frame.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).trim()
            if (data) yield data
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
    // 残留帧（无尾随空行）
    for (const line of buffer.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim()
        if (data) yield data
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** HTTP 错误 → 可读错误（保留供应商原始信息，便于用户定位 401/限流） */
async function assertOk(response: Response, label: string): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    const text = await response.text()
    detail = text.slice(0, 800)
  } catch {
    // 读 body 失败时忽略
  }
  throw new Error(`${label} ${response.status}: ${detail || response.statusText}`)
}

/** 图片 part → data URL（三种协议的图片上送形态都接受 data URL 或等价结构） */
function imageToDataUrl(part: Extract<GatewayContentPart, { type: 'image' }>): string {
  const data = part.data.startsWith('data:') ? part.data : `data:${part.mimeType};base64,${part.data}`
  return data
}

/** 思考档位 → OpenAI 系 reasoning_effort（minimal/low/medium/high 直传，xhigh/max 映射 high） */
function toReasoningEffort(level: string | undefined): string | undefined {
  if (!level || level === 'off') return undefined
  if (level === 'xhigh' || level === 'max') return 'high'
  return level
}

/* ------------------------------------------------ OpenAI Chat Completions */

interface OAToolCallAcc {
  id: string
  name: string
  argsText: string
}

async function* callOpenAICompletions(req: ProviderCallRequest): AsyncIterable<ProviderDelta> {
  const { target } = req
  const messages = toOpenAIMessages(req)
  const body: Record<string, unknown> = {
    model: target.modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (req.maxOutputTokens) body.max_tokens = Math.min(req.maxOutputTokens, target.maxTokens)
  if (req.temperature != null) body.temperature = req.temperature
  const effort = toReasoningEffort(req.reasoning)
  if (effort) body.reasoning_effort = effort
  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.inputSchema,
      },
    }))
  }

  const response = await fetch(endpoint(target.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...authHeaders(target, req.authStyle),
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  await assertOk(response, `${target.providerId} chat/completions`)

  /** SSE 里 tool call 参数分片累积，完成（finish_reason）后一次性产出 */
  const toolAcc = new Map<number, OAToolCallAcc>()
  let finishReason = 'stop'

  for await (const data of readSse(response)) {
    if (data === '[DONE]') break
    let chunk: {
      choices?: Array<{
        delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
        finish_reason?: string | null
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta?.content) yield { type: 'text', text: delta.content }
    if (delta?.reasoning_content) yield { type: 'thinking', text: delta.reasoning_content }
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0
      const acc = toolAcc.get(index) ?? { id: '', name: '', argsText: '' }
      if (call.id) acc.id = call.id
      if (call.function?.name) acc.name = call.function.name
      if (call.function?.arguments) acc.argsText += call.function.arguments
      toolAcc.set(index, acc)
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (chunk.usage) {
      yield {
        type: 'usage',
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      }
    }
  }

  for (const acc of toolAcc.values()) {
    if (!acc.name) continue
    yield {
      type: 'tool-call',
      toolCallId: acc.id || `call_${Math.random().toString(36).slice(2)}`,
      toolName: acc.name,
      args: parseArgs(acc.argsText),
    }
  }
  yield { type: 'finish', reason: mapFinishReason(finishReason, toolAcc.size > 0) }
}

/** 网关消息 → OpenAI chat 消息（assistant toolCall 走 tool_calls；tool 走 role=tool） */
function toOpenAIMessages(req: ProviderCallRequest): unknown[] {
  const out: unknown[] = []
  if (req.system) out.push({ role: 'system', content: req.system })
  for (const msg of req.messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content })
      continue
    }
    if (msg.role === 'user') {
      out.push({ role: 'user', content: toOpenAIContent(msg.content) })
      continue
    }
    if (msg.role === 'assistant') {
      const texts = msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)
      const calls = msg.content.filter((p) => p.type === 'tool-call')
      const entry: Record<string, unknown> = { role: 'assistant', content: texts.join('') || null }
      if (calls.length) {
        entry.tool_calls = calls.map((p) => {
          const c = p as { toolCallId: string; toolName: string; args: Record<string, unknown> }
          return {
            id: c.toolCallId,
            type: 'function',
            function: { name: c.toolName, arguments: JSON.stringify(c.args ?? {}) },
          }
        })
      }
      out.push(entry)
      continue
    }
    // tool 结果：OpenAI 规定 role=tool 只能纯文本——图片按协议约定搬到后续 user 消息
    const texts = msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)
    const images = msg.content.filter((p) => p.type === 'image')
    out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: texts.join('\n') || '(no tool output)' })
    if (images.length) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Attached image(s) from tool result:' },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: imageToDataUrl(img as Extract<GatewayContentPart, { type: 'image' }>) },
          })),
        ],
      })
    }
  }
  return out
}

function toOpenAIContent(parts: GatewayContentPart[]): unknown {
  const hasImage = parts.some((p) => p.type === 'image')
  if (!hasImage) return parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: imageToDataUrl(part) } }
  )
}

/* ------------------------------------------------------ OpenAI Responses */

async function* callOpenAIResponses(req: ProviderCallRequest): AsyncIterable<ProviderDelta> {
  const { target } = req
  const input: unknown[] = []
  for (const msg of req.messages) {
    if (msg.role === 'system') {
      input.push({ role: 'system', content: msg.content })
      continue
    }
    if (msg.role === 'user') {
      input.push({
        role: 'user',
        content: msg.content.map((part) =>
          part.type === 'text'
            ? { type: 'input_text', text: part.text }
            : { type: 'input_image', image_url: imageToDataUrl(part) }
        ),
      })
      continue
    }
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') input.push({ role: 'assistant', content: [{ type: 'output_text', text: part.text }] })
        else if (part.type === 'tool-call') {
          input.push({ type: 'function_call', call_id: part.toolCallId, name: part.toolName, arguments: JSON.stringify(part.args ?? {}) })
        }
      }
      continue
    }
    input.push({ type: 'function_call_output', call_id: msg.toolCallId, output: msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n') })
  }

  const body: Record<string, unknown> = {
    model: target.modelId,
    input,
    stream: true,
    ...(req.system ? { instructions: req.system } : {}),
    ...(req.maxOutputTokens ? { max_output_tokens: Math.min(req.maxOutputTokens, target.maxTokens) } : {}),
    ...(req.temperature != null ? { temperature: req.temperature } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.inputSchema,
          })),
        }
      : {}),
  }

  const response = await fetch(endpoint(target.baseUrl, 'responses'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...authHeaders(target, req.authStyle),
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  await assertOk(response, `${target.providerId} responses`)

  let finishReason = 'stop'
  const toolAcc = new Map<string, { name: string; argsText: string }>()
  for await (const data of readSse(response)) {
    if (data === '[DONE]') break
    let event: { type?: string; [key: string]: unknown }
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') yield { type: 'text', text: event.delta }
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof event.delta === 'string') yield { type: 'thinking', text: event.delta }
        break
      case 'response.output_item.added': {
        const item = event.item as { type?: string; call_id?: string; name?: string } | undefined
        if (item?.type === 'function_call' && item.call_id) {
          toolAcc.set(item.call_id, { name: item.name ?? '', argsText: '' })
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const callId = typeof event.call_id === 'string' ? event.call_id : typeof event.item_id === 'string' ? event.item_id : ''
        const acc = toolAcc.get(callId)
        if (acc && typeof event.delta === 'string') acc.argsText += event.delta
        break
      }
      case 'response.completed': {
        const resp = event.response as { usage?: { input_tokens?: number; output_tokens?: number }; status?: string } | undefined
        if (resp?.usage) {
          yield { type: 'usage', inputTokens: resp.usage.input_tokens ?? 0, outputTokens: resp.usage.output_tokens ?? 0 }
        }
        finishReason = 'stop'
        break
      }
      case 'response.failed':
      case 'error': {
        const err = event as { error?: { message?: string }; message?: string }
        throw new Error(`${target.providerId} responses: ${err.error?.message ?? err.message ?? 'stream error'}`)
      }
      default:
        break
    }
  }
  for (const [callId, acc] of toolAcc) {
    if (!acc.name) continue
    yield { type: 'tool-call', toolCallId: callId, toolName: acc.name, args: parseArgs(acc.argsText) }
    finishReason = 'toolUse'
  }
  yield { type: 'finish', reason: mapFinishReason(finishReason, toolAcc.size > 0) }
}

/* ------------------------------------------------------ Anthropic Messages */

async function* callAnthropicMessages(req: ProviderCallRequest): AsyncIterable<ProviderDelta> {
  const { target } = req
  const { system, messages } = toAnthropicPayload(req)
  const body: Record<string, unknown> = {
    model: target.modelId,
    max_tokens: req.maxOutputTokens ? Math.min(req.maxOutputTokens, target.maxTokens) : target.maxTokens,
    messages,
    stream: true,
  }
  if (req.system || system) body.system = [req.system, system].filter(Boolean).join('\n\n')
  if (req.temperature != null) body.temperature = req.temperature
  const effort = toReasoningEffort(req.reasoning)
  // Anthropic 用 thinking.budget_tokens；档位 → 预算（比例取自模型 maxTokens）
  if (effort) {
    const ratio = effort === 'minimal' ? 0.05 : effort === 'low' ? 0.1 : effort === 'medium' ? 0.2 : 0.4
    body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(target.maxTokens * ratio)) }
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.inputSchema,
    }))
  }

  const response = await fetch(endpoint(target.baseUrl, 'messages'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      ...authHeaders(target, req.authStyle),
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  await assertOk(response, `${target.providerId} messages`)

  let finishReason = 'stop'
  /** content block index → 累积中的 tool_use */
  const toolBlocks = new Map<number, { id: string; name: string; argsText: string }>()
  for await (const data of readSse(response)) {
    let event: { type?: string; [key: string]: unknown }
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    switch (event.type) {
      case 'message_start': {
        const usage = (event.message as { usage?: { input_tokens?: number } } | undefined)?.usage
        if (usage?.input_tokens) yield { type: 'usage', inputTokens: usage.input_tokens, outputTokens: 0 }
        break
      }
      case 'content_block_start': {
        const index = Number(event.index ?? 0)
        const block = event.content_block as { type?: string; id?: string; name?: string } | undefined
        if (block?.type === 'tool_use') {
          toolBlocks.set(index, { id: block.id ?? `toolu_${index}`, name: block.name ?? '', argsText: '' })
        }
        break
      }
      case 'content_block_delta': {
        const index = Number(event.index ?? 0)
        const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined
        if (delta?.type === 'text_delta' && delta.text) yield { type: 'text', text: delta.text }
        else if (delta?.type === 'thinking_delta' && delta.thinking) yield { type: 'thinking', text: delta.thinking }
        else if (delta?.type === 'input_json_delta') {
          const acc = toolBlocks.get(index)
          if (acc && delta.partial_json) acc.argsText += delta.partial_json
        }
        break
      }
      case 'content_block_stop': {
        const index = Number(event.index ?? 0)
        const acc = toolBlocks.get(index)
        if (acc?.name) {
          yield { type: 'tool-call', toolCallId: acc.id, toolName: acc.name, args: parseArgs(acc.argsText) }
          finishReason = 'toolUse'
        }
        break
      }
      case 'message_delta': {
        const delta = event.delta as { stop_reason?: string } | undefined
        if (delta?.stop_reason) finishReason = delta.stop_reason === 'tool_use' ? 'toolUse' : delta.stop_reason
        const usage = event.usage as { output_tokens?: number } | undefined
        if (usage?.output_tokens) yield { type: 'usage', inputTokens: 0, outputTokens: usage.output_tokens }
        break
      }
      case 'error': {
        const err = event.error as { message?: string; type?: string } | undefined
        throw new Error(`${target.providerId} messages: ${err?.message ?? 'stream error'}`)
      }
      default:
        break
    }
  }
  yield { type: 'finish', reason: mapFinishReason(finishReason, finishReason === 'toolUse') }
}

/** 网关消息 → Anthropic messages（tool_use / tool_result 块形态） */
function toAnthropicPayload(req: ProviderCallRequest): { system?: string; messages: unknown[] } {
  const systems: string[] = []
  const messages: unknown[] = []
  for (const msg of req.messages) {
    if (msg.role === 'system') {
      systems.push(msg.content)
      continue
    }
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: toAnthropicContent(msg.content) })
      continue
    }
    if (msg.role === 'assistant') {
      const content: unknown[] = []
      for (const part of msg.content) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text })
        else if (part.type === 'thinking') content.push({ type: 'thinking', thinking: part.text })
        else content.push({ type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.args ?? {} })
      }
      messages.push({ role: 'assistant', content })
      continue
    }
    // tool 结果：Anthropic 支持 tool_result 内嵌图片（content block 数组）
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          is_error: msg.isError === true,
          content: msg.content.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: part.mimeType,
                    data: part.data.startsWith('data:') ? part.data.slice(part.data.indexOf(',') + 1) : part.data,
                  },
                }
          ),
        },
      ],
    })
  }
  return { system: systems.length ? systems.join('\n\n') : undefined, messages }
}

function toAnthropicContent(parts: GatewayContentPart[]): unknown[] {
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mimeType,
            data: part.data.startsWith('data:') ? part.data.slice(part.data.indexOf(',') + 1) : part.data,
          },
        }
  )
}

/* -------------------------------------------------------------- 小工具 */

function parseArgs(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { __raw: text }
  }
}

function mapFinishReason(reason: string, hasToolCalls: boolean): 'stop' | 'toolUse' | 'length' | 'error' {
  if (hasToolCalls || reason === 'tool_use' || reason === 'tool_calls') return 'toolUse'
  if (reason === 'length' || reason === 'max_tokens') return 'length'
  if (reason === 'error' || reason === 'content_filter') return 'error'
  return 'stop'
}
