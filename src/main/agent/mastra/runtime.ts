/**
 * Mastra 侧 AgentRuntime 实现（Mastra 迁移计划 v1.2 §7.1/§11.3，Phase 1）。
 *
 * 覆盖：create / prompt / abort / dispose / history / contextUsage / setModel /
 * setThinking；compact（Phase 2）、fork（Phase 5）、steer（signals，遗留项）为显式
 * 未迁移失败，绝不静默降级。会话 = Mastra Agent + Memory（LibSQL，.huabu/mastra.db）；
 * 模型只经自有 ModelGateway；事件经 deps.broadcast 映射为现有 ChatEvent（契约不变）。
 */

import { Agent } from '@mastra/core/agent'
import type { Memory } from '@mastra/memory'
import type { ChatModelManager, ModelRef } from '../../models/manager'
import { buildAgentSystemPrompt } from '../../../shared/prompt'
import { THINKING_LEVELS, type ChatErrorCode, type ChatEvent, type ChatHistoryInfo, type ChatHistoryMessage } from '../../../shared/ipc'
import type {
  ChatContextUsage,
  ChatCreateInfo,
  ChatCreateRequest,
  ChatForkRequest,
  ChatForkResult,
  ChatContentBlock,
  ChatNodeRequest,
  ChatPromptRequest,
  ChatResult,
  ChatRuntimeInfo,
  ChatSetModelRequest,
  ChatSetModelResult,
  ChatSetThinkingRequest,
  ChatSetThinkingResult,
  ChatSteerRequest,
  ChatUsage,
} from '../../../shared/ipc'
import type { AgentRuntime } from '../runtime'
import type { ToolDefinitionLike } from '../mediaTools'
import { aiSdkLanguageModel, createModelGateway } from './modelGateway'
import type { ModelGateway } from './modelGateway'
import { mastraMemoryFor, registerOmBinding, unregisterOmBinding } from './memory'
import { MEMORY_RESOURCE } from './storage'
import { TokenLimiterProcessor } from '@mastra/core/processors'
import { toMastraTools, type AdaptedToolOutput } from './tools'

export interface MastraRuntimeDeps {
  broadcast(event: ChatEvent): void
  currentDir(): string | null
  defaultModel(): string | undefined
  /** 目录 + overlay + 凭据的唯一来源（与 Pi 侧同一个 ChatModelManager 逻辑同源） */
  managerForWorkspace(dir: string): Promise<ChatModelManager | null>
  /** 运行时信息（模型列表/已配置 provider）：与 Pi 侧同一份目录数据 */
  runtimeInfo(dir: string): Promise<ChatResult<ChatRuntimeInfo>>
  /** 工具装配（Phase 3 迁移面）：read_media / generate_* / 视频两工具 / create_note 等框架无关工具 */
  assembleTools(nodeId: string): Promise<ToolDefinitionLike[]>
}

interface MastraSession {
  nodeId: string
  threadId: string
  workspaceDir: string
  modelRef: ModelRef
  contextWindow: number | null
  thinkingLevel: string
  memory: Memory
  gateway: ModelGateway
  manager: ChatModelManager
  piTools: ToolDefinitionLike[]
  run: AbortController | null
  lastUsage: ChatUsage | null
}

const MASTRA_SESSION_PREFIX = 'mastra:'

function ok<T = undefined>(value: T): ChatResult<T> {
  return { ok: true, value }
}

function fail<T = undefined>(code: ChatErrorCode, error: string): ChatResult<T> {
  return { ok: false, code, error }
}

function formatRef(ref: ModelRef): string {
  return `${ref.provider.id}/${ref.model.id}`
}

/** Mastra finish reason → ChatStopReason（pi 语义） */
function toStopReason(reason: string | undefined, aborted: boolean): 'stop' | 'toolUse' | 'length' | 'aborted' | 'error' {
  if (aborted) return 'aborted'
  if (reason === 'tool-calls') return 'toolUse'
  if (reason === 'length') return 'length'
  if (reason === 'stop') return 'stop'
  return 'error'
}

export class MastraAgentRuntime implements AgentRuntime {
  readonly kind = 'mastra' as const
  private readonly sessions = new Map<string, MastraSession>()

  constructor(private readonly deps: MastraRuntimeDeps) {}

  runtime(): Promise<ChatResult<ChatRuntimeInfo>> {
    const dir = this.deps.currentDir()
    if (!dir) {
      return Promise.resolve(
        ok({ ready: false, error: '尚未打开工作区', models: [], configuredProviders: [] })
      )
    }
    return this.deps.runtimeInfo(dir)
  }

  async create(req: ChatCreateRequest): Promise<ChatResult<ChatCreateInfo>> {
    const dir = this.deps.currentDir()
    if (!dir) return fail('cwd_rejected', '尚未打开工作区')
    if (this.sessions.has(req.nodeId)) return fail('session_exists', `节点 ${req.nodeId} 已绑定会话`)

    const manager = await this.deps.managerForWorkspace(dir)
    if (!manager) return fail('host_not_ready', '模型目录未就绪')

    // 模型解析：显式指定必须命中；缺省走 默认模型 → 第一个已配置 provider 的首个模型
    const explicit = req.modelId ?? this.deps.defaultModel()
    let ref = explicit ? manager.find(explicit) : undefined
    if (!ref && !req.modelId) {
      const statuses = await manager.statuses()
      const configured = statuses.find((s) => s.configured)
      if (configured) {
        const provider = manager.providers().find((p) => p.id === configured.id)
        const model = provider?.models[0]
        if (provider && model) ref = { provider, model }
      }
    }
    if (!ref) {
      return fail('model_unavailable', explicit ? `模型不可用：${explicit}` : '没有已配置凭据的模型')
    }

    if (req.thinkingLevel && (!(THINKING_LEVELS as readonly string[]).includes(req.thinkingLevel) || req.thinkingLevel === 'off')) {
      return fail('unknown', 'thinkingLevel 非法：' + req.thinkingLevel)
    }

    // sessionFile：mastra:<threadId> 重绑本运行时会话；旧 JSONL 属 Pi 路径（Phase 5 迁移）
    let threadId = `node-${req.nodeId}`
    if (req.sessionFile) {
      if (!req.sessionFile.startsWith(MASTRA_SESSION_PREFIX)) {
        return fail('unknown', '旧 JSONL 会话请切回 agent.runtime=pi（Phase 5 迁移）')
      }
      threadId = req.sessionFile.slice(MASTRA_SESSION_PREFIX.length)
    }

    const memory = await mastraMemoryFor(dir)
    const piTools = await this.deps.assembleTools(req.nodeId)
    this.sessions.set(req.nodeId, {
      nodeId: req.nodeId,
      threadId,
      workspaceDir: dir,
      modelRef: ref,
      contextWindow: ref.model.contextWindow ?? null,
      thinkingLevel: req.thinkingLevel ?? 'medium',
      memory,
      manager,
      piTools,
      gateway: createModelGateway({ registrations: () => manager.registrations() }),
      run: null,
      lastUsage: null,
    })

    const qualified = formatRef(ref)
    // OM 后台模型与压缩事件按线程反查：登记本会话（setModel 后 modelRef 动态生效）
    registerOmBinding(dir, threadId, {
      nodeId: req.nodeId,
      broadcast: this.deps.broadcast,
      modelRef: () => this.sessions.get(req.nodeId)?.modelRef ?? ref,
      gateway: this.sessions.get(req.nodeId)?.gateway ?? createModelGateway({ registrations: () => manager.registrations() }),
    })
    console.log(`[mastra-runtime] create nodeId=${req.nodeId} thread=${threadId} model=${qualified}`)
    return ok({
      nodeId: req.nodeId,
      modelId: qualified,
      thinkingLevel: req.thinkingLevel ?? 'medium',
      cwd: dir,
      sessionId: threadId,
      sessionFile: `${MASTRA_SESSION_PREFIX}${threadId}`,
      activeTools: piTools.map((tool) => tool.name),
    })
  }

  prompt(req: ChatPromptRequest): Promise<ChatResult> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return Promise.resolve(fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`))
    if (session.run) return Promise.resolve(fail('busy', '会话正在生成中'))

    const controller = new AbortController()
    session.run = controller
    void this.runPrompt(session, req.text, controller)
    return Promise.resolve(ok(undefined))
  }

  /** 流式主循环：Mastra chunks → ChatEvent（事件顺序对齐 Pi：agent_start → turn_start → delta/tool → message → turn_end → agent_end） */
  private async runPrompt(session: MastraSession, text: string, controller: AbortController): Promise<void> {
    const { nodeId, broadcast } = { nodeId: session.nodeId, broadcast: this.deps.broadcast }
    broadcast({ nodeId, type: 'agent_start' })
    broadcast({ nodeId, type: 'turn_start', turnIndex: 0 })

    const textBlocks: string[] = []
    const thinkingBlocks: string[] = []
    const toolCalls: { toolCallId: string; toolName: string; args?: Record<string, unknown> }[] = []
    let usage: ChatUsage | null = null
    let finishReason: string | undefined
    let errorMessage: string | undefined
    let responseModel: string | undefined

    try {
      const agent = new Agent({
        name: `huabu-${session.nodeId}`,
        id: session.nodeId,
        instructions: buildAgentSystemPrompt(session.workspaceDir),
        model: aiSdkLanguageModel(session.gateway, {
          providerId: session.modelRef.provider.id,
          modelId: session.modelRef.model.id,
        }),
        memory: session.memory,
        // 每轮重包装：onUpdate 桥的 signal 要挂当轮 controller（abort 会话即取消工具等待）
        ...(session.piTools.length
          ? { tools: toMastraTools(session.piTools, { nodeId: session.nodeId, broadcast, signal: controller.signal }) }
          : {}),
        // Phase 2 上下文预算（计划 §8.2）：历史超 contextWindow 60% 时 memory-only 修剪；
        // working memory 与当轮 system 不受影响（processor 语义保证 pin 段不丢）
        ...(session.contextWindow
          ? {
              inputProcessors: [
                new TokenLimiterProcessor({ limit: Math.floor(session.contextWindow * 0.6) }),
              ],
            }
          : {}),
      })
      const events = await agent.stream(text, {
        memory: { thread: session.threadId, resource: MEMORY_RESOURCE },
        abortSignal: controller.signal,
        // 思考档位经自有命名空间透传到网关（languageModel.reasoningOf 读取）
        providerOptions: { huabu: { thinkingLevel: session.thinkingLevel } },
      })
      for await (const chunk of events.fullStream) {
        switch (chunk.type) {
          case 'text-delta':
            textBlocks.push(chunk.payload.text)
            broadcast({ nodeId, type: 'delta', messageIndex: 0, contentIndex: 1, stream: 'text', delta: chunk.payload.text })
            break
          case 'reasoning-delta':
            thinkingBlocks.push(chunk.payload.text)
            broadcast({ nodeId, type: 'delta', messageIndex: 0, contentIndex: 0, stream: 'thinking', delta: chunk.payload.text })
            break
          case 'tool-call':
            toolCalls.push({ toolCallId: chunk.payload.toolCallId, toolName: chunk.payload.toolName })
            broadcast({
              nodeId,
              type: 'tool_start',
              toolCallId: chunk.payload.toolCallId,
              toolName: chunk.payload.toolName,
              args: asToolArgs(chunk.payload.args),
            })
            break
          case 'tool-result': {
            // tools.ts 适配后的输出形状：{text, isError?, images?, details?}
            const out = chunk.payload.result as AdaptedToolOutput | undefined
            broadcast({
              nodeId,
              type: 'tool_end',
              toolCallId: chunk.payload.toolCallId,
              toolName: chunk.payload.toolName,
              isError: out?.isError === true || chunk.payload.isError === true,
              resultText: typeof out?.text === 'string' ? truncate(out.text) : summarizeResult(out),
              ...(out?.details !== undefined ? { details: safeJson(out.details, 1200) } : {}),
            })
            break
          }
          case 'response-metadata': {
            const mid = (chunk.payload as Record<string, unknown>).modelId
            if (typeof mid === 'string' && mid) responseModel = mid
            break
          }
          case 'finish': {
            const u = chunk.payload.output.usage
            usage = {
              input: u.inputTokens ?? 0,
              output: u.outputTokens ?? 0,
              reasoning: u.reasoningTokens ?? 0,
              totalTokens: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            }
            finishReason = chunk.payload.stepResult?.reason
            break
          }
          case 'error':
            errorMessage = String((chunk.payload as { error?: unknown }).error ?? 'unknown error')
            break
          default:
            break
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    // 消息定稿快照（断流校正用，对齐 pi 的 message 事件）
    const content: ChatContentBlock[] = []
    if (thinkingBlocks.length) content.push({ type: 'thinking', thinking: thinkingBlocks.join('') })
    if (textBlocks.length) content.push({ type: 'text', text: textBlocks.join('') })
    for (const call of toolCalls) {
      content.push({ type: 'toolCall', toolCallId: call.toolCallId, toolName: call.toolName })
    }
    if (content.length) {
      broadcast({
        nodeId,
        type: 'message',
        message: {
          messageIndex: 0,
          content,
          provider: session.modelRef.provider.id,
          model: session.modelRef.model.id,
          ...(responseModel ? { responseModel } : {}),
          stopReason: toStopReason(finishReason, controller.signal.aborted),
          ...(errorMessage ? { errorMessage } : {}),
          ...(usage ? { usage } : {}),
        },
      })
    }

    session.lastUsage = usage
    broadcast({ nodeId, type: 'turn_end', turnIndex: 0 })
    broadcast({
      nodeId,
      type: 'agent_end',
      stopReason: errorMessage && !controller.signal.aborted ? 'error' : toStopReason(finishReason, controller.signal.aborted),
      ...(errorMessage && !controller.signal.aborted ? { errorMessage } : {}),
      ...(usage ? { usage } : {}),
    })
    if (session.contextWindow) {
      broadcast({
        nodeId,
        type: 'context_usage',
        tokens: usage?.input ?? null,
        contextWindow: session.contextWindow,
        percent: usage ? Math.round((usage.input / session.contextWindow) * 100) : null,
      })
    }
    session.run = null
  }

  async abort(req: ChatNodeRequest): Promise<ChatResult> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    session.run?.abort()
    return ok(undefined)
  }

  async dispose(req: ChatNodeRequest): Promise<ChatResult> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    session.run?.abort()
    unregisterOmBinding(session.workspaceDir, session.threadId)
    this.sessions.delete(req.nodeId)
    return ok(undefined)
  }

  async history(req: { nodeId: string; sessionFile: string }): Promise<ChatResult<ChatHistoryInfo>> {
    const dir = this.deps.currentDir()
    if (!dir) return fail('cwd_rejected', '尚未打开工作区')
    if (!req.sessionFile.startsWith(MASTRA_SESSION_PREFIX)) {
      return fail('unknown', '旧 JSONL 会话请切回 agent.runtime=pi（Phase 5 迁移）')
    }
    const threadId = req.sessionFile.slice(MASTRA_SESSION_PREFIX.length)
    const memory = await mastraMemoryFor(dir)
    const recalled = await memory.recall({ threadId, resourceId: MEMORY_RESOURCE })
    const messages: ChatHistoryMessage[] = recalled.messages.map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      text: extractText(m.content),
    }))
    return ok({ nodeId: req.nodeId, sessionFile: req.sessionFile, messages })
  }

  async contextUsage(req: ChatNodeRequest): Promise<ChatResult<ChatContextUsage>> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    return ok({
      tokens: session.lastUsage?.input ?? null,
      contextWindow: session.contextWindow,
      percent: session.lastUsage && session.contextWindow
        ? Math.round((session.lastUsage.input / session.contextWindow) * 100)
        : null,
    })
  }

  /** 手动压缩入口（计划 §7.3）：强制跑一轮 observational memory，事件经 OM 钩子广播 */
  async compact(req: ChatNodeRequest): Promise<ChatResult> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    try {
      const engine = await (session.memory as unknown as { omEngine: Promise<{ observe?: (opts: unknown) => Promise<unknown> } | null> }).omEngine
      if (!engine?.observe) return fail('unknown', 'observational memory 引擎不可用（检查 memory 配置）')
      const result = (await engine.observe({
        threadId: session.threadId,
        resourceId: MEMORY_RESOURCE,
        force: true,
        trigger: 'manual',
      })) as { observed?: boolean; reflected?: boolean } | undefined
      console.log(
        `[mastra-runtime] compact nodeId=${req.nodeId} thread=${session.threadId} ` +
          `observed=${result?.observed ?? false} reflected=${result?.reflected ?? false}`
      )
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `压缩失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  fork(_req: ChatForkRequest): Promise<ChatResult<ChatForkResult>> {
    return Promise.resolve(fail('unknown', 'fork 尚未迁移（Phase 5：会话存储迁移）'))
  }

  async setModel(req: ChatSetModelRequest): Promise<ChatResult<ChatSetModelResult>> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    const ref = session.manager.find(req.modelId)
    if (!ref) return fail('model_unavailable', `模型不可用：${req.modelId}`)
    session.modelRef = ref
    session.contextWindow = ref.model.contextWindow ?? null
    return ok({
      modelId: req.modelId,
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: thinkingLevelsOf(ref),
    })
  }

  async setThinking(req: ChatSetThinkingRequest): Promise<ChatResult<ChatSetThinkingResult>> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    if (!(THINKING_LEVELS as readonly string[]).includes(req.thinkingLevel) || req.thinkingLevel === 'off') {
      return fail('unknown', 'thinkingLevel 非法：' + req.thinkingLevel)
    }
    session.thinkingLevel = req.thinkingLevel
    return ok({ thinkingLevel: req.thinkingLevel })
  }

  steer(_req: ChatSteerRequest): Promise<ChatResult> {
    return Promise.resolve(fail('unknown', 'steer 尚未迁移（Mastra signals 对接为 Phase 1 遗留项）'))
  }
}

/** 模型可用思考档位（ipc 注释口径：目录映射的非 null 档位；无映射 = 全六档，不含 off） */
function thinkingLevelsOf(ref: ModelRef): string[] {
  const map = ref.model.thinkingLevelMap as Record<string, string | null> | undefined
  const all = THINKING_LEVELS.filter((level) => level !== 'off')
  if (!map) return [...all]
  const supported = new Set(
    Object.entries(map)
      .filter(([, value]) => value !== null)
      .map(([level]) => level)
  )
  return all.filter((level) => supported.has(level))
}

/** 只放可结构化克隆的纯数据（ChatToolArgs 契约） */
function asToolArgs(args: unknown): Record<string, string | number | boolean | null> {
  if (!args || typeof args !== 'object') return {}
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    }
  }
  return out
}

/** 工具结果摘要：文本部分拼接，大对象 JSON 化后截断（不把大负载丢给渲染端） */
function summarizeResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return truncate(result)
  if (typeof result === 'object') {
    const text = extractText(result)
    if (text) return truncate(text)
    try {
      return truncate(JSON.stringify(result))
    } catch {
      return ''
    }
  }
  return truncate(String(result))
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** details 序列化（钉卡契约的最小保证：可 JSON 化 + 截断；环引用等异常降级为字符串） */
function safeJson(value: unknown, max: number): string | undefined {
  try {
    return truncate(JSON.stringify(value), max)
  } catch {
    return truncate(String(value), max)
  }
}

/** MastraDBMessage.content（{ format, parts: [{type:'text', text}] }，见 agent.ts 的落库构造）与工具结果的文本抽取 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object') return ''
  const record = content as Record<string, unknown>
  const parts = record.parts ?? record.content
  if (Array.isArray(parts)) {
    return parts
      .map((part) =>
        part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''
      )
      .join('')
  }
  if (typeof record.text === 'string') return record.text
  return ''
}
