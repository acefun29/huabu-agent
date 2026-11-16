/**
 * Mastra 侧 AgentRuntime 实现（Mastra 迁移计划 v1.2 §7.1/§11.3，Phase 1）。
 *
 * 覆盖：create / prompt / abort / dispose / disposeAll / history / contextUsage /
 * compact / steer / setModel / setThinking。**只有 fork 是显式未迁移失败**
 * （Phase 5 会话存储迁移）——早先的头注释把 compact/steer 也写成未迁移，与实现不符。
 * 会话 = Mastra Agent + Memory（LibSQL，.huabu/mastra.db）；模型只经自有
 * ModelGateway；事件经 deps.broadcast 映射为现有 ChatEvent（契约不变）。
 */

import { Agent } from '@mastra/core/agent'
import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'
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
import { mastraMemoryFor, registerOmBinding, unregisterOmBinding, withManualCompaction } from './memory'
import { applyStreamChunk, initialStreamState } from './streamReducer'
import { MEMORY_RESOURCE } from './storage'
import { TokenLimiterProcessor } from '@mastra/core/processors'
import { toMastraTools } from './tools'
import { toConversationMessages } from '../../superagent/conversation'
import { splitUserInjection } from '../injectionSplit'
import { renderAvailableSkillsBlock, scanSkills, selectInjectable } from '../skills'

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
  /** 工作区 skills.disabled 名单（settings:skills-set-disabled 写入）；这些技能不进新会话系统提示 */
  disabledSkills(): string[]
  /**
   * 内置技能根目录（`resources/skills`）。
   *
   * 由调用方注入而不是本模块直接 `resolveBuiltinSkillsRoots()`：那个函数用 electron 的
   * `app` 判断是否打包，一旦被本模块静态依赖，`mastra/runtime.ts` 就再也无法在 node
   * 单测里加载（实测会让全部无网络契约测试直接失败）。不传 = 没有内置技能。
   */
  builtinSkillRoots(): string[]
  /**
   * 项目记忆 + 当前任务（施工计划 v4）。返回一段追加到系统提示词末尾的文本。
   *
   * 由调用方注入而不是本模块直接读盘：`loop/run.ts` 要同时读 `studio.md` 与 journal，
   * 而 journal 实例属于工作区的 SuperAgentService，本模块不该知道它。不传 = 不注入。
   *
   * 实现方应保证：**读失败不能让会话建不起来**（记忆是增强项，聊天是主能力）。
   */
  workspaceContext?(dir: string): Promise<string>
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
  /**
   * 本会话的系统提示词（工作区约定 + `<available_skills>`）。
   * 建会话时算一次并固定：技能清单不会在会话中途变（Pi 侧也是 reload 才生效），
   * 每轮重扫目录既慢又会让提示词内容在同一条会话里漂移。
   */
  instructions: string
  run: AbortController | null
  /** 当前轮的 Agent 实例（steer 经 sendSignal 投递到运行中的 run） */
  agent: Agent | null
  lastUsage: ChatUsage | null
  /**
   * 已被 dispose / disposeAll 摘除（A6）。
   *
   * dispose 只发 abort 信号就同步把会话从表里删掉，不等在飞 run 收尾；runPrompt
   * 的闭包还持有这个对象，会继续按同一个 nodeId 广播 delta / tool / agent_end。
   * 同 nodeId 重建会话后（画布恢复、切回工作区），这些残留事件会串进新会话——
   * 表现为新对话里凭空多出上一轮的正文与工具卡。置位后旧 run 的广播全部静默。
   */
  disposed: boolean
}

const MASTRA_SESSION_PREFIX = 'mastra:'

/**
 * 拼本会话的系统提示词：工作区/引用约定 + `<available_skills>`。
 *
 * 技能清单在建会话时扫一次（与 Pi 侧 reload 语义一致）；`disabledSkills` 名单由
 * 设置页写入 workspace.json，被禁用的技能既不注入也不占 token。
 * builtinRoots 由 deps 注入（见 MastraRuntimeDeps.builtinSkillRoots 的说明）。
 */
function buildInstructions(workspaceDir: string, disabled: readonly string[], builtinRoots: readonly string[]): string {
  const base = buildAgentSystemPrompt(workspaceDir)
  const skillsBlock = renderAvailableSkillsBlock(
    selectInjectable(scanSkills({ workspaceDir, builtinRoots }).skills, new Set(disabled))
  )
  return skillsBlock ? `${base}\n\n${skillsBlock}` : base
}

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

  /**
   * 每轮现拼系统提示词：基础提示词 + 项目记忆 + 当前任务（施工计划 v4 §4.4）。
   *
   * 为什么每轮而不是建会话时算一次：用户在会话中途改 `studio.md`、建任务、收工，
   * 都要求「从下一次模型调用开始可见」。缓存到会话里就变成「重开会话才生效」。
   *
   * 代价是每轮多一次文件读 + journal 读（都是小文件），换来的是记忆永远不过期。
   */
  private async composeInstructions(session: MastraSession): Promise<string> {
    const context = await this.loadWorkspaceContext(session.workspaceDir)
    return context ? `${session.instructions}\n\n${context}` : session.instructions
  }

  /**
   * 项目记忆 + 当前任务（施工计划 v4 §4.4）。
   *
   * 读失败（journal 被占用、记忆文件权限异常）**不能让会话建不起来**：
   * 记忆是增强项，聊天本身是主能力。失败按「这轮没有记忆」处理并留一条 warn，
   * 而不是把错误抛给用户——这属于「能力可用性」，不是「质量判断」（§12）。
   */
  private async loadWorkspaceContext(dir: string): Promise<string> {
    const provider = this.deps.workspaceContext
    if (!provider) return ''
    try {
      return await provider(dir)
    } catch (error) {
      console.warn(`[mastra] 项目记忆装配失败，本轮按无记忆继续：${String(error)}`)
      return ''
    }
  }

  /** 会话模型是否声明图片输入（read_media/视频工具的视觉闸门，与 Pi 侧同一份目录数据） */
  sessionSupportsImages(nodeId: string): boolean | undefined {
    const session = this.sessions.get(nodeId)
    if (!session) return undefined
    return session.modelRef.model.input?.includes('image') ?? false
  }

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
    // cwd 守卫（A10）：Mastra 侧此前**完全忽略** req.cwd——渲染端传什么都静默落到
    // 工作区根，README 里承诺的「cwd 越出工作区一律拒绝」在这条路径上并不成立。
    // 越界必须拒绝；工作区内子目录也不支持（记忆库按工作区建，用子目录会另开一个
    // mastra.db），同样明确拒绝而不是悄悄改成工作区根。
    if (req.cwd) {
      const root = resolve(dir)
      const requested = resolve(req.cwd)
      if (requested !== root && !requested.startsWith(root + sep)) {
        return fail('cwd_rejected', `cwd 越出工作区：${req.cwd}`)
      }
      if (requested !== root) {
        return fail(
          'cwd_rejected',
          `Mastra 运行时的会话按工作区建（记忆库是工作区级的），不支持子目录 cwd：${req.cwd}`
        )
      }
    }
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

    // sessionFile：mastra:<threadId> 重绑本运行时会话；旧 JSONL 属 Pi 路径
    //
    // 旧 JSONL **不再硬失败**（批次 3 的前置）：agent.runtime 这个开关没有 UI 也没有
    // IPC 写入点（`setAgentRuntime` 全仓 0 调用），所以线上工作区实际上一直在跑 Pi，
    // 每个会话的 canvas.json meta 里都存着一条 `.huabu/sessions/*.jsonl`。一旦默认
    // 运行时翻到 Mastra，硬失败会让这些会话**连发都发不出去**。用户裁决本来就是
    // 「旧 JSONL 历史不救」，所以这里按新会话开线程，并由 create 返回的 mastra:
    // 句柄把 meta 里的旧引用覆盖掉（自愈）。历史回放同样按空历史处理，见 history()。
    let threadId = `node-${req.nodeId}`
    if (req.sessionFile) {
      if (req.sessionFile.startsWith(MASTRA_SESSION_PREFIX)) {
        threadId = req.sessionFile.slice(MASTRA_SESSION_PREFIX.length)
      } else {
        console.log(
          `[mastra-runtime] 忽略旧 JSONL 会话引用（nodeId=${req.nodeId}），按新线程 ${threadId} 开始：${req.sessionFile}`
        )
      }
    }

    const memory = await mastraMemoryFor(dir)
    const piTools = await this.deps.assembleTools(req.nodeId)
    // 系统提示词 = 工作区/引用约定 + 技能注入（B1 之外的另一处能力缺口：Mastra 侧
    // 原本完全不注入技能，而 blockout 这类内置技能的正文就是它的操作手册）。
    // **项目记忆与当前任务不在这里拼**：它们要每轮现取（见 prompt 里的 composeInstructions），
    // 否则用户在会话中途改了 studio.md，得重开会话才生效——违背 §4.4「从下一次模型调用开始可见」。
    const instructions = buildInstructions(dir, this.deps.disabledSkills(), this.deps.builtinSkillRoots())    // 初始档位按模型能力折叠（A1 透传之后才有值可折）；创建/重绑同一条路径
    const thinkingLevel = clampThinkingLevel(req.thinkingLevel ?? 'medium', thinkingLevelsOf(ref))
    this.sessions.set(req.nodeId, {
      nodeId: req.nodeId,
      threadId,
      workspaceDir: dir,
      modelRef: ref,
      contextWindow: ref.model.contextWindow ?? null,
      thinkingLevel,
      memory,
      manager,
      piTools,
      instructions,
      gateway: createModelGateway({ registrations: () => manager.registrations() }),
      run: null,
      agent: null,
      lastUsage: null,
      disposed: false,
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
      thinkingLevel,
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
    // runPrompt 的收尾在 finally 里（状态必被解绑），这里补 catch 只是不让异常
    // 变成未处理的 promise 拒绝（A2 的另一半）
    void this.runPrompt(session, req.text, controller).catch((error: unknown) => {
      console.error(`[mastra-runtime] runPrompt 异常 nodeId=${req.nodeId}：`, error)
    })
    return Promise.resolve(ok(undefined))
  }

  /** 流式主循环：Mastra chunks → ChatEvent（事件顺序对齐 Pi：agent_start → turn_start → delta/tool → message → turn_end → agent_end） */
  private async runPrompt(session: MastraSession, text: string, controller: AbortController): Promise<void> {
    const nodeId = session.nodeId
    const rawBroadcast = this.deps.broadcast
    // 会话被 dispose 之后旧 run 仍在跑：事件一律静默，否则会串进同 nodeId 的新会话（A6）
    const broadcast = (event: ChatEvent): void => {
      if (session.disposed) return
      rawBroadcast(event)
    }

    const textBlocks: string[] = []
    const thinkingBlocks: string[] = []
    const toolCalls: { toolCallId: string; toolName: string; args?: Record<string, unknown> }[] = []
    let usage: ChatUsage | null = null
    let finishReason: string | undefined
    let errorMessage: string | undefined
    let responseModel: string | undefined
    // 流式分片 → 事件/累积状态的映射抽在 streamReducer.ts（纯函数，有单测）
    let stream = initialStreamState()

    try {
      broadcast({ nodeId, type: 'agent_start' })
      broadcast({ nodeId, type: 'turn_start', turnIndex: 0 })
      const agent = new Agent({
        name: `huabu-${session.nodeId}`,
        id: session.nodeId,
        instructions: await this.composeInstructions(session),
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
      session.agent = agent
      const events = await agent.stream(text, {
        memory: { thread: session.threadId, resource: MEMORY_RESOURCE },
        abortSignal: controller.signal,
        // 思考档位经自有命名空间透传到网关（languageModel.reasoningOf 读取）
        providerOptions: { huabu: { thinkingLevel: session.thinkingLevel } },
      })
      for await (const chunk of events.fullStream) {
        const applied = applyStreamChunk(stream, chunk as never, nodeId)
        stream = applied.state
        for (const event of applied.events) broadcast(event)
      }
      // 循环结束后把累积状态摊回局部变量：收尾逻辑（finally）仍按这些变量生成快照
      textBlocks.push(...stream.textBlocks)
      thinkingBlocks.push(...stream.thinkingBlocks)
      toolCalls.push(...stream.toolCalls)
      usage = stream.usage
      finishReason = stream.finishReason
      errorMessage = stream.errorMessage
      responseModel = stream.responseModel
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    } finally {
      /*
       * 收尾整体放进 finally（A2）：此前 `void this.runPrompt()` 没有 catch，
       * 而收尾的四次 broadcast 与 session.run=null 都在 catch 之外——广播只要抛出一次
       * （窗口已销毁、webContents 不可用、渲染端异常序列化失败），promise 就变成
       * 未处理的拒绝，session.run 永远停在非 null，该会话之后每次 prompt 都回 busy，
       * 只能重启进程。这里再加一层内层 try：收尾本身失败也不能吃掉「解绑」这一步。
       */
      try {
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
        /*
         * 「跑了几个工具就停住」的现场记录。
         *
         * 这种情况在界面上表现为：一串工具行之后什么都没有。可能是模型空回复、
         * 也可能是被拦断，但从 UI 分不出来。日志里记下停止原因与规模，
         * 下次出现时能直接判断是模型行为还是运行时问题。
         */
        if (toolCalls.length > 0 && stream.textBlocks.length === 0) {
          console.warn(
            `[mastra] 本轮无文本输出：nodeId=${nodeId} 工具 ${toolCalls.length} 次 finish=${String(finishReason)} aborted=${controller.signal.aborted}${errorMessage ? ` error=${errorMessage}` : ''}`
          )
        }
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
      } catch (error) {
        console.error(`[mastra-runtime] 收尾广播失败 nodeId=${nodeId}：`, error)
      } finally {
        // 无论如何都要解绑：留着 session.run 就等于把该会话永久钉成 busy
        session.run = null
        session.agent = null
      }
    }
  }

  async abort(req: ChatNodeRequest): Promise<ChatResult> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    session.run?.abort()
    return ok(undefined)
  }

  /**
   * 全量释放（A3）：切工作区 / 退出时调用，返回释放的会话数。
   *
   * 为什么必须由运行时自己做：`host.disposeWorkspace` 只清 `host.sessions`（Pi 侧表），
   * 而 Mastra 侧还有两张表没人清——本类的 `sessions`（含 threadId 与在飞 run）与
   * `mastra/memory.ts` 的 OM `bindings`。切走后旧会话仍在：事件按旧 nodeId 继续广播、
   * OM 压缩仍按旧 threadId 反查旧 nodeId（A17 的"取最近会话"因此更错）。
   *
   * `workspaceDir` 省略 = 清全部（退出流程）。
   */
  disposeAll(workspaceDir?: string): number {
    let closed = 0
    for (const [nodeId, session] of [...this.sessions]) {
      if (workspaceDir && session.workspaceDir !== workspaceDir) continue
      // 先置位再 abort：在飞 run 的后续广播立即静默，不会串进同 nodeId 的新会话（A6）
      session.disposed = true
      session.run?.abort()
      unregisterOmBinding(session.workspaceDir, session.threadId)
      this.sessions.delete(nodeId)
      closed += 1
    }
    return closed
  }

  async dispose(req: ChatNodeRequest): Promise<ChatResult> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    // 先置位再 abort（A6）：见 MastraSession.disposed 的说明
    session.disposed = true
    session.run?.abort()
    unregisterOmBinding(session.workspaceDir, session.threadId)
    this.sessions.delete(req.nodeId)
    return ok(undefined)
  }

  async history(req: { nodeId: string; sessionFile: string }): Promise<ChatResult<ChatHistoryInfo>> {
    const dir = this.deps.currentDir()
    if (!dir) return fail('cwd_rejected', '尚未打开工作区')
    if (!req.sessionFile.startsWith(MASTRA_SESSION_PREFIX)) {
      // 旧 JSONL 引用：按「没有可回放的历史」处理，而不是报错（见 create 里的说明）。
      // 报错会让渲染端每次切回该会话都重试一次回放并刷一条 warn，而结果永远是空。
      return ok({ nodeId: req.nodeId, sessionFile: req.sessionFile, messages: [] })
    }
    const threadId = req.sessionFile.slice(MASTRA_SESSION_PREFIX.length)
    const memory = await mastraMemoryFor(dir)
    /*
     * 界面历史必须读**全量**（A11）：`recall` 默认按分页返回，而 Memory 的
     * `lastMessages: 50` 是**模型上下文**预算。此前这里不传 perPage，60 条消息的
     * 会话在重启后只能看到 50 条——早期消息还在库里，属于回放截断而非删除。
     * 两者语义不同：模型看最近 50 条 + OM 压缩；界面要能翻完整历史。
     */
    const recalled = await memory.recall({ threadId, resourceId: MEMORY_RESOURCE, perPage: false })
    /*
     * 结构化回放（B5）：此前这里只吐 `{role, text}`，把 thinking / 工具卡 / 图片
     * 连同「本轮注入段」的边界一起丢掉——画布恢复时整段对话退化成纯文本，
     * 用户看不到自己点过什么工具、Agent 想过什么。
     *
     * 现在复用专家对话那条同一份解析（`superagent/conversation.ts`）：它已经把
     * Mastra 落库的 text / reasoning / tool-invocation 转成与 chat:history 同构的块，
     * 两条链共用一套映射，不会各写一份而漂移。
     *
     * 仍做不到的两件（如实说明，不假装做到）：
     * - `inContext:false`：OM 把哪些消息挤出了模型上下文是它内部状态，这里拿不到；
     *   与其猜错、把在上下文里的消息淡化，不如不标。
     * - 压缩分隔条：OM 不把摘要回传给渲染端，没有可重建的 CompactionEntry。
     */
    const parsed = toConversationMessages(recalled.messages)
    const messages: ChatHistoryMessage[] = parsed.map((entry) => {
      if (entry.role === 'user') {
        // 四段注入文本被拼在用户正文尾部：按自产文本头拆开，UI 折叠展示，
        // 否则每轮重复的清单会把对话读成用户在反复粘贴同一段话
        const { body, contextPayload } = splitUserInjection(entry.text)
        return {
          role: 'user',
          text: body,
          ...(contextPayload ? { contextPayload } : {}),
        }
      }
      const blocks = entry.blocks ?? []
      return {
        role: 'model',
        text: entry.text,
        ...(blocks.length > 0 ? { blocks } : {}),
      }
    })
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
      // 标记为手动压缩（B9）：OM 钩子拿不到触发原因，靠这个集合把
      // compaction_* 事件的 reason 报成 'manual'，UI 才不会把手动 /compact 标成自动压缩
      const result = (await withManualCompaction(session.workspaceDir, session.threadId, () =>
        engine.observe!({
          threadId: session.threadId,
          resourceId: MEMORY_RESOURCE,
          force: true,
          trigger: 'manual',
        })
      )) as { observed?: boolean; reflected?: boolean } | undefined
      console.log(
        `[mastra-runtime] compact nodeId=${req.nodeId} thread=${session.threadId} ` +
          `observed=${result?.observed ?? false} reflected=${result?.reflected ?? false}`
      )
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `压缩失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 分叉会话：把源线程整条复制成一个新线程，返回新的 `mastra:` 句柄。
   *
   * 与 Pi 的语义对齐：渲染端拿到句柄后写进新会话的 meta，切换过去时走同一条
   * `history()` 结构化回放；新会话第一次发送时 `create({sessionFile})` 会绑到复制
   * 出来的线程上，继续往下聊不影响母会话。
   *
   * 关键点：**按 sessionFile 解析源线程，而不是按 req.nodeId 查内存会话**。
   * 应用重启后节点早已不在 `this.sessions` 里，但用户照样应该能分叉一条历史会话。
   */
  async fork(req: ChatForkRequest): Promise<ChatResult<ChatForkResult>> {
    const dir = this.deps.currentDir()
    if (!dir) return fail('cwd_rejected', '尚未打开工作区')
    if (!req.sessionFile.startsWith(MASTRA_SESSION_PREFIX)) {
      // 旧 JSONL 会话没有 Mastra 线程可复制。不硬造一个空线程冒充成功——那样用户
      // 会得到一条「看起来分叉了但历史是空的」会话，比直接说清楚更糟。
      return fail('unknown', '该会话没有 Mastra 记忆（旧 JSONL 会话无法分叉，请新建会话）')
    }
    const sourceThreadId = req.sessionFile.slice(MASTRA_SESSION_PREFIX.length)
    try {
      const memory = await mastraMemoryFor(dir)
      const newThreadId = `${sourceThreadId}-fork-${randomUUID().slice(0, 8)}`
      await memory.cloneThread({
        sourceThreadId,
        newThreadId,
        resourceId: MEMORY_RESOURCE
      })
      return ok({ nodeId: req.nodeId, sessionFile: `${MASTRA_SESSION_PREFIX}${newThreadId}` })
    } catch (error) {
      return fail('unknown', `分叉失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async setModel(req: ChatSetModelRequest): Promise<ChatResult<ChatSetModelResult>> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    const ref = session.manager.find(req.modelId)
    if (!ref) return fail('model_unavailable', `模型不可用：${req.modelId}`)
    session.modelRef = ref
    session.contextWindow = ref.model.contextWindow ?? null
    const levels = thinkingLevelsOf(ref)
    // 换到不支持当前档位的模型：折叠到就近可用档并回填，UI 不再显示非法档位（A12）
    const thinkingLevel = clampThinkingLevel(session.thinkingLevel, levels)
    session.thinkingLevel = thinkingLevel
    return ok({
      modelId: req.modelId,
      thinkingLevel,
      thinkingLevels: levels,
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

  /**
   * 运行中插话（计划 §5.2-7，Mastra 原生 signals）：
   * 有活跃 run → deliver（当前请求若无正文则中断重发，否则在 step 边界注入下一步）；
   * 空闲 → wake（起新一轮，与直接 prompt 等价但保留同一 thread）。
   * renderer 侧先收到 chat:event 的 delta 流，插话内容由模型在下一轮引用；
   * pending 提示（data-user-message-pending）属 Mastra 内部 chunk，暂不透传（契约冻结）。
   */
  async steer(req: ChatSteerRequest): Promise<ChatResult> {
    const session = this.sessions.get(req.nodeId)
    if (!session) return fail('session_missing', `节点 ${req.nodeId} 尚未创建会话`)
    if (!session.agent) return fail('unknown', 'steer 需要活跃会话实例（先 create 并等待一轮启动）')
    try {
      const result = await session.agent.sendSignal(
        { type: 'user', contents: req.text },
        {
          threadId: session.threadId,
          resourceId: MEMORY_RESOURCE,
          ifActive: { behavior: 'deliver' },
          ifIdle: { behavior: 'discard' },
        }
      )
      const accepted = await result.accepted
      const action = typeof accepted === 'object' && accepted && 'action' in accepted ? accepted.action : accepted
      if (action === 'discard' || action === 'blocked') {
        return fail('busy', `steer 未被接受（${String(action)}）；会话空闲时请直接发送消息`)
      }
      console.log(`[mastra-runtime] steer nodeId=${req.nodeId} action=${String(action)}`)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `steer 失败：${error instanceof Error ? error.message : String(error)}`)
    }
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

/**
 * 档位就近折叠（A12）：会话中途换模型后，原档位可能不被新模型支持。
 * 优先取「不高于原档位的最近可用档」，没有再向上找，都不行取列表首项；
 * 非推理模型（可用档位为空）回落到 medium 以保住 UI 语义。
 * Pi 侧一直由 pi 自己做这层 clamp，Mastra 侧此前直接把非法档位回填给 UI。
 */
function clampThinkingLevel(requested: string, supported: readonly string[]): string {
  if (supported.length === 0) return 'medium'
  if (supported.includes(requested)) return requested
  const all = THINKING_LEVELS.filter((level) => level !== 'off')
  const from = all.findIndex((level) => level === requested)
  if (from < 0) return supported.includes('medium') ? 'medium' : supported[0]
  for (let i = from; i >= 0; i -= 1) {
    if (supported.includes(all[i])) return all[i]
  }
  for (let i = from + 1; i < all.length; i += 1) {
    if (supported.includes(all[i])) return all[i]
  }
  return supported[0]
}

