/**
 * ModelGateway 的 pi-ai 后端：把网关归一化请求翻译成 pi-ai `stream()` 调用。
 *
 * 供应商来源只有 `ChatModelManager.registrations()`（目录 + overlay + credentials 的
 * 现有合并结果），网关不读 Mastra provider 配置、不持 Key——Key 只在 stream 时
 * 作为 options.apiKey 传入（明文只在主进程内存里过一遍）。
 * pi-ai 是 ESM-only 且被 electron-vite 外置，这里沿 host.ts 的动态 import 模式。
 */

import type { Context } from '@earendil-works/pi-ai'
import type {
  GatewayContentPart,
  ModelCapabilities,
  ModelHandle,
  ModelRef,
  ModelRequest,
  ModelStreamPart,
} from './types'
import { formatModelRef } from './types'
import type { ProviderRegistration } from '../../../models/manager'
import type { RegistrationModelInput } from '../../../models/types'

/** pi-ai 的类型只在构建期使用；运行时经动态 import 拿 compat.stream */
type PiStreamFn = (
  model: unknown,
  context: unknown,
  options?: Record<string, unknown>
) => AsyncIterable<PiEvent>

/** pi-ai compat 的 streamSimple（SimpleStreamOptions：多出 reasoning/toolChoice 等简单档位） */
type PiStreamSimpleFn = PiStreamFn

type PiEvent =
  | { type: 'start' }
  | { type: 'text_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'text_end' }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end' }
  | { type: 'toolcall_start' }
  | { type: 'toolcall_delta'; delta: string }
  | { type: 'toolcall_end'; toolCall: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse' | 'deferred'; message: { usage?: PiUsage } }
  | { type: 'error'; reason: 'aborted' | 'error'; error: { stopReason?: string; errorMessage?: string; usage?: PiUsage } }

interface PiUsage {
  input: number
  output: number
  totalTokens?: number
}

/** 历史重放的 assistant 消息占位用量（结构完整，数值为零） */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export interface PiGatewayOptions {
  /** 每次解析/流式调用时取最新注册表（含凭据解密），与 host.ts applyRegistrations 同源；resolveAuth 是异步的 */
  registrations(): readonly ProviderRegistration[] | Promise<readonly ProviderRegistration[]>
  /**
   * 供应商级鉴权风格覆盖：'bearer' = Authorization: Bearer（one-api/new-api 系代理网关），
   * 缺省 = pi-ai 默认（anthropic 走 x-api-key、openai 系走 Bearer）。
   * 目录/overlay 目前不表达这件事，由接线方按工作区配置传入（Phase 0 记录为待确认决策）。
   */
  authStyle?: Readonly<Record<string, 'bearer' | 'default'>>
}

interface ResolvedModel {
  providerId: string
  /** pi-ai Model 形状（构造自我们的目录数据，不含 Key） */
  model: Record<string, unknown>
  apiKey?: string
  capabilities: ModelCapabilities
}

export class PiModelGateway {
  private readonly options: PiGatewayOptions
  private readonly aborts = new Map<string, AbortController>()
  private piStream: PiStreamSimpleFn | null = null

  constructor(options: PiGatewayOptions) {
    this.options = options
  }

  private async findRegistration(ref: ModelRef): Promise<{ reg: ProviderRegistration; model: RegistrationModelInput } | undefined> {
    for (const reg of await this.options.registrations()) {
      if (reg.providerId !== ref.providerId) continue
      const model = reg.payload.models.find((m) => m.id === ref.modelId)
      if (model) return { reg, model }
    }
    return undefined
  }

  private async resolveModel(ref: ModelRef): Promise<ResolvedModel> {
    const hit = await this.findRegistration(ref)
    if (!hit) {
      throw new Error(`model gateway: 模型不在生效清单中：${formatModelRef(ref)}`)
    }
    const { reg, model } = hit
    // pi-ai Model：provider 字段由我们注入（pi 的 ModelRuntime 注册路径之外直接调 stream 时必填）。
    // compat 是按 api 的条件类型，目录侧已是同构数据，整体 as 一次避免条件类型体操。
    const piModel = {
      id: model.id,
      name: model.name,
      api: model.api ?? reg.payload.api,
      provider: reg.providerId,
      baseUrl: model.baseUrl ?? reg.payload.baseUrl,
      reasoning: model.reasoning,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(model.compat ? { compat: model.compat } : {}),
    } as Record<string, unknown>
    return {
      providerId: reg.providerId,
      model: piModel,
      apiKey: reg.payload.apiKey,
      capabilities: {
        // 现有目录没有模型级 toolCall 开关（pi 侧由 tools 白名单控制），聊天通道默认可工具
        toolCall: true,
        imageInput: model.input.includes('image'),
        streaming: true,
        maxContext: model.contextWindow,
      },
    }
  }

  async resolve(ref: ModelRef): Promise<ModelHandle> {
    return { ref, capabilities: (await this.resolveModel(ref)).capabilities }
  }

  async capabilities(ref: ModelRef): Promise<ModelCapabilities> {
    return (await this.resolveModel(ref)).capabilities
  }

  async abort(runId: string): Promise<void> {
    this.aborts.get(runId)?.abort()
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamPart> {
    const resolved = await this.resolveModel(req.ref)
    if (!this.piStream) {
      const compat = (await import('@earendil-works/pi-ai/compat')) as { streamSimple: PiStreamSimpleFn }
      this.piStream = compat.streamSimple
    }

    // 网关侧 abort 控制：外部 signal 与 gateway.abort(runId) 都能终止底层请求
    const controller = new AbortController()
    this.aborts.set(req.runId, controller)
    const forward = () => controller.abort()
    signal.addEventListener('abort', forward)
    try {
      const context = this.toContext(req, resolved)
      const bearer = this.options.authStyle?.[resolved.providerId] === 'bearer' && resolved.apiKey
      const events = this.piStream(resolved.model, context, {
        ...(bearer
          ? { headers: { authorization: `Bearer ${resolved.apiKey}` } }
          : resolved.apiKey
            ? { apiKey: resolved.apiKey }
            : {}),
        signal: controller.signal,
        // maxTokens clamp 到目录上限：Mastra 默认给 384k，clamp 保证不超模型声明上限
        ...(req.maxOutputTokens != null
          ? { maxTokens: Math.min(req.maxOutputTokens, maxOutputOf(resolved)) }
          : {}),
        ...(req.temperature != null ? { temperature: req.temperature } : {}),
        ...(req.reasoning ? { reasoning: req.reasoning } : {}),
      })
      for await (const ev of events) {
        for (const part of this.translate(ev)) {
          yield part
          if (part.type === 'finish') return
        }
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      yield {
        type: 'error',
        code: aborted ? 'aborted' : 'gateway_error',
        message: err instanceof Error ? err.message : String(err),
      }
      yield { type: 'finish', reason: aborted ? 'abort' : 'error' }
    } finally {
      signal.removeEventListener('abort', forward)
      this.aborts.delete(req.runId)
    }
  }

  /** GatewayMessage[] → pi-ai Context（system 合并成单条 systemPrompt） */
  private toContext(req: ModelRequest, resolved: ResolvedModel): Context {
    const systems: string[] = []
    const messages: unknown[] = []
    const timestamp = Date.now()
    const piModelApi = (resolved.model as { api?: string }).api ?? 'openai-completions'
    for (const msg of req.messages) {
      if (msg.role === 'system') {
        systems.push(msg.content)
        continue
      }
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: this.toPiContent(msg.content), timestamp })
        continue
      }
      if (msg.role === 'assistant') {
        // pi AssistantMessage 的必需字段要补全：历史消息缺 usage 时 convertMessages
        // 读 usage.totalTokens 会崩（streamSimple 路径实测）；网关重放的历史不带真实
        // 用量，用零值占位——真实用量只从当轮 done 事件取
        const content = msg.content.map((part) => {
          if (part.type === 'text') return { type: 'text', text: part.text }
          if (part.type === 'thinking') return { type: 'thinking', thinking: part.text }
          return {
            type: 'toolCall',
            id: part.toolCallId,
            name: part.toolName,
            arguments: part.args,
          }
        })
        messages.push({
          role: 'assistant',
          api: piModelApi,
          provider: resolved.providerId,
          model: resolved.model.id,
          content,
          usage: ZERO_USAGE,
          // 带 toolCall 的 assistant 轮必须标 toolUse：pi 据此配对后续 toolResult
          // （图片搬运、消息转换都依赖这个状态；实测 stop 会导致 toolResult 图像被丢弃）
          stopReason: content.some((part) => (part as { type?: string }).type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp,
        })
        continue
      }
      messages.push({
        role: 'toolResult',
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        content: this.toPiContent(msg.content),
        isError: msg.isError ?? false,
        timestamp,
      })
    }
    return {
      ...(systems.length ? { systemPrompt: systems.join('\n\n') } : {}),
      ...(req.system ? { systemPrompt: [req.system, ...systems].join('\n\n') } : {}),
      messages,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description ?? '',
              // pi 的 parameters 是 TypeBox TSchema；TypeBox 产物即 JSON Schema 对象，
              // 网关归一化的 JSON Schema 直接可喂（运行时按 JSON Schema 序列化进请求体）
              parameters: t.inputSchema as never,
            })),
          }
        : {}),
    } as Context
  }

  private toPiContent(parts: GatewayContentPart[]): unknown[] {
    return parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', data: p.data, mimeType: p.mimeType }))
  }

  private translate(ev: PiEvent): ModelStreamPart[] {
    switch (ev.type) {
      case 'text_delta':
        return [{ type: 'text-delta', text: ev.delta }]
      case 'thinking_delta':
        return [{ type: 'thinking-delta', text: ev.delta }]
      case 'toolcall_end':
        return [
          {
            type: 'tool-call',
            toolCallId: ev.toolCall.id,
            toolName: ev.toolCall.name,
            args: ev.toolCall.arguments ?? {},
          },
        ]
      case 'done': {
        const parts: ModelStreamPart[] = []
        const usage = ev.message.usage
        if (usage) parts.push({ type: 'usage', inputTokens: usage.input, outputTokens: usage.output })
        parts.push({
          type: 'finish',
          reason: ev.reason === 'toolUse' ? 'tool-calls' : ev.reason === 'deferred' ? 'other' : ev.reason,
        })
        return parts
      }
      case 'error':
        return [
          {
            type: 'error',
            code: ev.reason === 'aborted' ? 'aborted' : 'provider_error',
            message: ev.error.errorMessage ?? `pi-ai: ${ev.reason}`,
          },
          { type: 'finish', reason: ev.reason === 'aborted' ? 'abort' : 'error' },
        ]
      default:
        return []
    }
  }
}

/** 模型目录的输出上限（缺省兜底 32k） */
function maxOutputOf(resolved: ResolvedModel): number {
  const max = (resolved.model as { maxTokens?: number }).maxTokens
  return typeof max === 'number' && max > 0 ? max : 32_768
}

