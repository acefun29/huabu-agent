/**
 * ModelGateway 实现（Mastra 迁移计划 v1.2 §5.5/§7.7）。
 *
 * **零 pi 依赖**（尾约束 §16.4-17）：模型调用经 `providers.ts` 的自有 HTTP 层直达
 * 三种协议端点；供应商来源只有 `ChatModelManager.registrations()`（目录 + overlay +
 * credentials 的现有合并结果）；Key 只在 stream 时过内存，不进日志/事件。
 */

import type {
  ModelCapabilities,
  ModelHandle,
  ModelRef,
  ModelRequest,
  ModelStreamPart,
} from './types'
import { formatModelRef } from './types'
import { callProvider, type ProviderTarget } from './providers'
import type { ProviderRegistration } from '../../../models/manager'
import type { RegistrationModelInput } from '../../../models/types'

export interface GatewayOptions {
  /** 每次解析/流式调用时取最新注册表（含凭据解密），与 host.ts applyRegistrations 同源 */
  registrations(): readonly ProviderRegistration[] | Promise<readonly ProviderRegistration[]>
  /**
   * 供应商级鉴权风格覆盖：'bearer' = Authorization: Bearer（one-api/new-api 系代理网关）。
   * 缺省：anthropic 走 x-api-key、openai 系走 Bearer。
   */
  authStyle?: Readonly<Record<string, 'bearer' | 'default'>>
}

interface ResolvedTarget {
  target: ProviderTarget
  capabilities: ModelCapabilities
}

export class ModelGatewayImpl {
  private readonly options: GatewayOptions
  /** runId → 取消函数（abort 与外部 signal 双路） */
  private readonly aborts = new Map<string, () => void>()

  constructor(options: GatewayOptions) {
    this.options = options
  }

  private async resolveTarget(ref: ModelRef): Promise<ResolvedTarget> {
    for (const reg of await this.options.registrations()) {
      if (reg.providerId !== ref.providerId) continue
      const model: RegistrationModelInput | undefined = reg.payload.models.find((m) => m.id === ref.modelId)
      if (!model) continue
      const api = (model.api ?? reg.payload.api) as ProviderTarget['api']
      return {
        target: {
          providerId: reg.providerId,
          baseUrl: model.baseUrl ?? reg.payload.baseUrl,
          api,
          ...(reg.payload.apiKey ? { apiKey: reg.payload.apiKey } : {}),
          modelId: model.id,
          input: model.input,
          maxTokens: model.maxTokens,
          contextWindow: model.contextWindow,
          ...(model.compat ? { compat: model.compat as Record<string, unknown> } : {}),
        },
        capabilities: {
          // 目录没有模型级 toolCall 开关（由工具白名单控制），聊天通道默认可工具
          toolCall: true,
          imageInput: model.input.includes('image'),
          streaming: true,
          maxContext: model.contextWindow,
        },
      }
    }
    throw new Error(`model gateway: 模型不在生效清单中：${formatModelRef(ref)}`)
  }

  async resolve(ref: ModelRef): Promise<ModelHandle> {
    const { capabilities } = await this.resolveTarget(ref)
    return { ref, capabilities }
  }

  async capabilities(ref: ModelRef): Promise<ModelCapabilities> {
    return (await this.resolveTarget(ref)).capabilities
  }

  async abort(runId: string): Promise<void> {
    this.aborts.get(runId)?.()
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamPart> {
    const { target } = await this.resolveTarget(req.ref)

    // 网关侧 abort 控制：外部 signal 与 gateway.abort(runId) 都能终止底层 fetch
    const controller = new AbortController()
    this.aborts.set(req.runId, () => controller.abort())
    const forward = () => controller.abort()
    signal.addEventListener('abort', forward)
    /*
     * 同步检查已取消的 signal（A08）：`addEventListener` 只覆盖「之后才取消」，
     * 传入时就已经 abort 的 signal 永远等不到事件——下游 fetch 会照常发出请求，
     * 于是「已取消的任务」还是会花钱、还是会回写结果。
     */
    if (signal.aborted) controller.abort()

    try {
      const system = [req.system, ...systemMessagesOf(req)].filter(Boolean).join(String.fromCharCode(10, 10))
      for await (const delta of callProvider({
        target,
        ...(system ? { system } : {}),
        messages: req.messages.filter((msg) => msg.role !== 'system'),
        ...(req.tools?.length ? { tools: req.tools } : {}),
        ...(req.maxOutputTokens != null ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(req.temperature != null ? { temperature: req.temperature } : {}),
        ...(req.reasoning ? { reasoning: req.reasoning } : {}),
        signal: controller.signal,
        ...(this.options.authStyle?.[target.providerId]
          ? { authStyle: this.options.authStyle[target.providerId] }
          : {}),
      })) {
        switch (delta.type) {
          case 'text':
            yield { type: 'text-delta', text: delta.text }
            break
          case 'thinking':
            yield { type: 'thinking-delta', text: delta.text }
            break
          case 'tool-call':
            yield {
              type: 'tool-call',
              toolCallId: delta.toolCallId,
              toolName: delta.toolName,
              args: delta.args,
            }
            break
          case 'usage':
            yield { type: 'usage', inputTokens: delta.inputTokens, outputTokens: delta.outputTokens }
            break
          case 'finish':
            yield {
              type: 'finish',
              reason:
                delta.reason === 'toolUse'
                  ? 'tool-calls'
                  : delta.reason === 'length'
                    ? 'length'
                    : delta.reason === 'error'
                      ? 'error'
                      : 'stop',
            }
            return
        }
      }
    } catch (error) {
      const aborted = controller.signal.aborted
      yield {
        type: 'error',
        code: aborted ? 'aborted' : 'provider_error',
        message: error instanceof Error ? error.message : String(error),
      }
      yield { type: 'finish', reason: aborted ? 'abort' : 'error' }
    } finally {
      signal.removeEventListener('abort', forward)
      this.aborts.delete(req.runId)
    }
  }
}

/** messages 里的 system 角色内容（各协议都有独立的 system 通道，需提前抽出） */
function systemMessagesOf(req: ModelRequest): string[] {
  const out: string[] = []
  for (const msg of req.messages) {
    if (msg.role === 'system') out.push(msg.content)
  }
  return out
}
