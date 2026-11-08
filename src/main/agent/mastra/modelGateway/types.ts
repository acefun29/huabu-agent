/**
 * 自有模型网关契约（Mastra 迁移计划 v1.2 §7.7）。
 *
 * Mastra Agent 只认这一层：provider 解析、鉴权、重试、能力声明都在网关内，
 * Mastra 不感知供应商、不读 provider 配置、不持 Key。
 * 归一化的消息/流部件与 AI SDK 形状之间的适配在 modelGateway/ 内完成，
 * 不引入 Mastra 的 provider 包 / model router。
 */

/** 现有 `provider/model` 复合 id 的结构化形态 */
export interface ModelRef {
  providerId: string
  modelId: string
}

export interface ModelCapabilities {
  toolCall: boolean
  imageInput: boolean
  streaming: boolean
  maxContext?: number
}

export type GatewayContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; /** base64（不含 data: 前缀） */ data: string; mimeType: string }

export type GatewayAssistantPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }

export type GatewayMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: GatewayContentPart[] }
  | { role: 'assistant'; content: GatewayAssistantPart[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: GatewayContentPart[]; isError?: boolean }

export interface GatewayToolDef {
  name: string
  description?: string
  /** JSON Schema（对象形态） */
  inputSchema: Record<string, unknown>
}

export interface ModelRequest {
  /** 网关侧 abort/指标用的运行标识 */
  runId: string
  /** 本次调用使用的模型；网关按它取 provider 配置与凭据 */
  ref: ModelRef
  system?: string
  messages: GatewayMessage[]
  tools?: GatewayToolDef[]
  maxOutputTokens?: number
  temperature?: number
}

export type GatewayFinishReason = 'stop' | 'tool-calls' | 'length' | 'abort' | 'error' | 'other'

export type ModelStreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'finish'; reason: GatewayFinishReason }
  | { type: 'error'; code: string; message: string }

export interface ModelHandle {
  ref: ModelRef
  capabilities: ModelCapabilities
}

export interface ModelGateway {
  resolve(ref: ModelRef): Promise<ModelHandle>
  capabilities(ref: ModelRef): ModelCapabilities | Promise<ModelCapabilities>
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamPart>
  abort(runId: string): Promise<void>
}

/** 复合 id（`provider/model`）↔ ModelRef */
export function parseModelRef(qualifiedId: string): ModelRef | null {
  const slash = qualifiedId.indexOf('/')
  if (slash <= 0 || slash === qualifiedId.length - 1) return null
  return { providerId: qualifiedId.slice(0, slash), modelId: qualifiedId.slice(slash + 1) }
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`
}