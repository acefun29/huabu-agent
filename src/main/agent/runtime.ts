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

/**
 * 默认运行时。**Pi 运行时已删除**（`piRuntime.ts` / `host.ts` / `agent/workspace.ts`），
 * 现在只剩 Mastra 一个实现，本常量恒为 `'mastra'`。
 *
 * 保留它是因为 `workspace.json` 里可能残留历史字段 `agent.runtime`：读盘清洗要能
 * 认出 `'pi'` 这个已退役的值而不崩（`normalizeAgentRuntime`），但它**不再有任何
 * 分派作用**——`chat.ts` 只构造一个运行时。
 *
 * 移除 Pi 之前攒齐的三个前提（记录在此，防止将来有人以为可以随手回退）：
 * 1. **能力对齐**：Pi 的内置 `ls`/`read`/`write`、技能注入、blockout 工具在 Mastra 侧
 *    各有等价实现（`agent/fileTools.ts`、`agent/skills.ts`）；
 * 2. **旧会话不炸**：`mastra/runtime.ts` 的 create/history 对 JSONL 句柄优雅降级
 *    （按新线程开、历史给空），并由返回的 `mastra:` 句柄覆盖渲染端 meta 自愈；
 * 3. **链路真跑通**：`mastra/runtimeStub.test.ts` 用本地 OpenAI 兼容 stub 跑完整轮
 *    「文本增量 → 工具桥 → 定稿 → 分叉」，不依赖任何真实凭据。
 */
export const DEFAULT_AGENT_RUNTIME: AgentRuntimeKind = 'mastra'

/** 读取历史上可能存在的 `agent.runtime`：未识别值一律回落默认（不留半截脏值） */
export function normalizeAgentRuntime(value: unknown): AgentRuntimeKind {
  return value === 'mastra' || value === 'pi' ? value : DEFAULT_AGENT_RUNTIME
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