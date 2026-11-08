/**
 * Pi 侧 AgentRuntime 实现（strangler 的回滚路径，保留到迁移 Phase 6）。
 *
 * 只做 AgentHost 委托与工作区级上下文收敛；会话工具装配经 deps.assembleTools 注入
 * （装配逻辑仍在 IPC 层，Phase 3 工具迁移时收进 Mastra 侧）。
 */
import type { AgentHost } from './host'
import type { ToolDefinitionLike } from './mediaTools'
import type { AgentRuntime } from './runtime'
import { resolveSessionFile } from './workspace'
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

export interface PiRuntimeDeps {
  currentDir(): string | null
  defaultModel(): string | undefined
  disabledSkills(): string[]
  assembleTools(nodeId: string): Promise<ToolDefinitionLike[]>
}

export class PiAgentRuntime implements AgentRuntime {
  readonly kind = 'pi' as const

  constructor(
    private readonly host: AgentHost,
    private readonly deps: PiRuntimeDeps
  ) {}

  runtime(): Promise<ChatResult<ChatRuntimeInfo>> {
    const dir = this.deps.currentDir()
    if (!dir) {
      return Promise.resolve({
        ok: true,
        value: { ready: false, error: '尚未打开工作区', models: [], configuredProviders: [] }
      })
    }
    return this.host.runtime(dir)
  }

  async create(req: ChatCreateRequest): Promise<ChatResult<ChatCreateInfo>> {
    const customTools = await this.deps.assembleTools(req.nodeId)
    return this.host.create(req, {
      currentDir: this.deps.currentDir(),
      defaultModel: this.deps.defaultModel(),
      customTools,
      disabledSkills: this.deps.disabledSkills()
    })
  }

  prompt(req: ChatPromptRequest): Promise<ChatResult> {
    return this.host.prompt(req)
  }

  steer(req: ChatSteerRequest): Promise<ChatResult> {
    return this.host.steer(req)
  }

  abort(req: ChatNodeRequest): Promise<ChatResult> {
    return this.host.abort(req)
  }

  dispose(req: ChatNodeRequest): Promise<ChatResult> {
    return this.host.dispose(req)
  }

  async history(req: { nodeId: string; sessionFile: string }): Promise<ChatResult<ChatHistoryInfo>> {
    const dir = this.deps.currentDir()
    if (!dir) return { ok: false, code: 'unknown', error: 'IPC 载荷不合法：尚未打开工作区' }
    // 路径合法性校验：必须位于当前工作区 .huabu/sessions/ 内（渲染端不可信输入）
    const resolved = resolveSessionFile(req.sessionFile, dir)
    if (!resolved.ok) return { ok: false, code: 'cwd_rejected', error: resolved.error }
    return this.host.readSessionHistory(resolved.sessionFile, req.nodeId)
  }

  async contextUsage(req: ChatNodeRequest): Promise<ChatResult<ChatContextUsage>> {
    return this.host.contextUsage(req.nodeId)
  }

  compact(req: ChatNodeRequest): Promise<ChatResult> {
    return this.host.compact(req)
  }

  fork(req: ChatForkRequest): Promise<ChatResult<ChatForkResult>> {
    return this.host.forkSession(req, this.deps.currentDir())
  }

  setModel(req: ChatSetModelRequest): Promise<ChatResult<ChatSetModelResult>> {
    return this.host.setModel(req)
  }

  async setThinking(req: ChatSetThinkingRequest): Promise<ChatResult<ChatSetThinkingResult>> {
    return this.host.setThinking(req)
  }
}