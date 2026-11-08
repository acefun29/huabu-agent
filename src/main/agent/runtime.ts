/**
 * Agent 运行时抽象（Mastra 迁移计划 v1.2 §7.1）。
 *
 * IPC 只依赖本接口与 ChatEvent；Pi / Mastra 各自提供实现（strangler 双运行时）。
 * 事件出口不在接口里：host 层 emitter 统一转发，Mastra stream 在 Adapter 内映射为 ChatEvent。
 */
import type {
  ChatContextUsage,
  ChatCreateRequest,
  ChatCreateInfo,
  ChatForkRequest,
  ChatForkResult,
  ChatHistoryInfo,
  ChatNodeRequest,
  ChatPromptRequest,
  ChatResult,
  ChatRuntimeInfo,
  ChatSetModelRequest,
  ChatSetModelResult,
  ChatSetThinkingRequest,
  ChatSetThinkingResult,
  ChatSteerRequest
} from '../../shared/ipc'

export type AgentRuntimeKind = 'pi' | 'mastra'

/** workspace.json agent.runtime 解析：未识别值一律回落 pi（回滚友好，不静默落到新运行时） */
export function normalizeAgentRuntime(value: unknown): AgentRuntimeKind {
  return value === 'mastra' ? 'mastra' : 'pi'
}

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind
  runtime(): Promise<ChatResult<ChatRuntimeInfo>>
  create(req: ChatCreateRequest): Promise<ChatResult<ChatCreateInfo>>
  prompt(req: ChatPromptRequest): Promise<ChatResult>
  steer(req: ChatSteerRequest): Promise<ChatResult>
  abort(req: ChatNodeRequest): Promise<ChatResult>
  dispose(req: ChatNodeRequest): Promise<ChatResult>
  history(req: { nodeId: string; sessionFile: string }): Promise<ChatResult<ChatHistoryInfo>>
  contextUsage(req: ChatNodeRequest): Promise<ChatResult<ChatContextUsage>>
  compact(req: ChatNodeRequest): Promise<ChatResult>
  fork(req: ChatForkRequest): Promise<ChatResult<ChatForkResult>>
  setModel(req: ChatSetModelRequest): Promise<ChatResult<ChatSetModelResult>>
  setThinking(req: ChatSetThinkingRequest): Promise<ChatResult<ChatSetThinkingResult>>
}

/** flag 指向尚未就绪的运行时的占位实现：统一 host_not_ready 失败，绝不静默回落 */
export class UnavailableRuntime implements AgentRuntime {
  constructor(
    readonly kind: AgentRuntimeKind,
    private readonly reason: string
  ) {}

  private unavailable<T = undefined>(): Promise<ChatResult<T>> {
    return Promise.resolve({ ok: false, code: 'host_not_ready', error: this.reason })
  }

  runtime() { return this.unavailable<ChatRuntimeInfo>() }
  create() { return this.unavailable<ChatCreateInfo>() }
  prompt() { return this.unavailable() }
  steer() { return this.unavailable() }
  abort() { return this.unavailable() }
  dispose() { return this.unavailable() }
  history() { return this.unavailable<ChatHistoryInfo>() }
  contextUsage() { return this.unavailable<ChatContextUsage>() }
  compact() { return this.unavailable() }
  fork() { return this.unavailable<ChatForkResult>() }
  setModel() { return this.unavailable<ChatSetModelResult>() }
  setThinking() { return this.unavailable<ChatSetThinkingResult>() }
}