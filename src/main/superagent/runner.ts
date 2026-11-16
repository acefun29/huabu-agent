/**
 * SuperAgent 运行器（架构图 to-be ② 的执行侧）：把「派单 → 专家 → 验收 → 版本」封装成
 * 一个与 IPC / Agent 工具都无关的模块，两处入口共用同一条链路。
 *
 * 为什么单独一层：IPC handler 与主 Agent 的 `delegate_tasks` 工具要跑的是同一套编排
 * （模型解析、工具装配、AbortController、事件广播），写在 handler 里就会逼工具去 import
 * ipc 模块。运行器持有每个工作区的 journal 服务与运行中任务表，两个入口只做载荷校验。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assembleMediaTools, laneOutputDir, type MediaAssemblyDeps } from '../agent/mediaToolAssembly'
import { createFileTools } from '../agent/fileTools'
import { toMastraTools } from '../agent/mastra/tools'
import { mastraMemoryFor } from '../agent/mastra/memory'
import { createModelGateway, type ModelRef } from '../agent/mastra/modelGateway'
import type { ChatModelManager } from '../models/manager'
import type { ToolDefinitionLike } from '../agent/mediaTools'
import type { ExpertLiveTranscript, SuperAgentTaskConversation, TaskEvent } from '../../shared/ipc'
import { applyExpertStreamEvent } from '../../shared/expertStream'
import { SuperAgentService } from './index'
import { projectBoard, type BoardTask } from './board'
import { projectVersions, type VersionSlots } from './versions'
import type { JournalEvent, WorkspaceJournal } from './journal'
import { createLlmExpertRunner, runTask } from './orchestrator'
import { taskInputFromJournal, type TaskIntent } from './dispatch'
import { listExperts, DEFAULT_EXPERT_ID, type ExpertDefinition } from './experts'
import { expertThreadId, startedAttempts, toConversationMessages } from './conversation'
import { MEMORY_RESOURCE } from '../agent/mastra/storage'

/** 媒体工具装配所需的最小依赖（真实 WorkspaceStore / MediaJobManager 结构兼容） */
export type SuperAgentMediaDeps = Pick<
  MediaAssemblyDeps,
  'store' | 'mediaManager' | 'mediaContext' | 'requestApproval'
> & { inboxRoot: () => string }

export interface SuperAgentRunnerDeps {
  currentDir: () => string | null
  /** 工作区默认对话模型（缺省时回退第一个已配置 provider 的首个模型） */
  defaultModelId: () => string | undefined
  /** 工作区模型管理器（模型目录 + 凭据） */
  modelManagerFor: (dir: string) => Promise<ChatModelManager | null>
  media: SuperAgentMediaDeps
  /** task:event 出口（渲染端未接时忽略） */
  broadcastTaskEvent: (event: TaskEvent) => void
}

/** 派单参数（IPC / 工具层校验后的形态） */
export interface SuperAgentStartRequest {
  scope: string
  prompt: string
  accept: string[]
  promptLayers?: { level: string; prompt: string }[]
  entities?: TaskIntent['entities']
  adjacent?: TaskIntent['adjacent']
  negative?: string[]
  lane?: string[]
  expert?: string
  /** shadow：只写 staging + journal，不切 active */
  shadow?: boolean
  /** 重派：被本任务顶替的旧 taskId（C14），见 SuperAgentRunTaskRequest.supersedes */
  supersedes?: string
}

export interface SuperAgentStartOutcome {
  taskId: string
  expert: string
  /** 预检阶段就被拒（缺参考）——执行不会发生 */
  rejected: string[]
  dropped: string[]
}

export type SuperAgentRunError =
  | { code: 'cwd_rejected'; message: string }
  | { code: 'model_unavailable'; message: string }
  /** 重派时找不到可重建的输入（任务不存在 / 缺 scope+prompt） */
  | { code: 'task_missing'; message: string }

interface WorkspaceRuntime {
  service: SuperAgentService
  running: Map<string, AbortController>
  /** 正在执行任务的流式快照（memory 落库前的实时内容；任务结束后清理） */
  live: Map<string, ExpertLiveTranscript>
  /**
   * 任务完成信号（taskId → settled promise）。
   * 主 Agent 的 delegate_tasks 要像 Mastra 原生 subagent 工具一样等子任务结束，
   * 这里保留一个不抛错的完成 promise；结果统一从 board 投影读取。
   */
  completions: Map<string, Promise<void>>
  /** 本进程是否已对本工作区的 journal 做过启动对账（C5） */
  reconciled: boolean
  /** 专家任务并发闸（C15）：按工作区独立，避免跨工作区互相排队 */
  gate: <T>(fn: () => Promise<T>) => Promise<T>
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** 取消后等终态事实落盘的上限：专家无视 abort 时不把调用方挂在这里 */
const CANCEL_SETTLE_TIMEOUT_MS = 5_000

/** 取消结果（A08）：调用方据此区分「已停下」「还在停」「没在跑」，不再用布尔混为一谈 */
export type CancelOutcome = 'stopped' | 'stopping' | 'not-running'

/**
 * 专家任务并发上限（C15）。
 *
 * 每个在跑任务是一条真实 LLM 流，且它们共享同一份 `mastra.db`（LibSQL 单文件）
 * 与同一套媒体配额；此前完全没有上限——`MAX_DELEGATE=20` 只是单次工具调用的条数，
 * 连续调用 delegate_tasks、或 UI 上连点派单就能把并发拉到任意高。
 * 4 是保守值：媒体提交侧自带 3 并发闸，专家侧再放开就没有意义的排队。
 */
const MAX_CONCURRENT_EXPERTS = 4

/** 「取槽 → 执行 → 还槽」的闸；排队中的任务停在 todo，不写 task.started */
function createSlotGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiters: Array<() => void> = []
  const handOff = (): void => {
    const next = waiters.shift()
    // 有人排队就把手上的槽直接交给它（active 不变），没人排队才真正归还
    if (next) next()
    else active -= 1
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      // 单线程语义：判满与入队之间没有 await，不会被插队
      await new Promise<void>((resolve) => waiters.push(resolve))
    } else {
      active += 1
    }
    try {
      return await fn()
    } finally {
      handOff()
    }
  }
}

/**
 * 专家工具面（按 `expert.tools` 能力集装配）。
 *
 * 独立成导出函数是为了能被测试盯住：A03 的成因就是这段装配藏在 `start()` 的闭包里，
 * 一句 `if (expert.tools === 'none') return {}` 挡在文件工具前面，文本专家永远拿不到
 * write，而验收又要求文件真实存在——整条文本交付链走不通，且没有任何测试会失败。
 *
 * 文件工具的 write 限定在任务 lane 内（C3）。
 */
export function buildExpertToolDefinitions(params: {
  expert: ExpertDefinition
  /** 任务写区（派单信封的 lane 前缀） */
  lane: readonly string[]
  currentDir: () => string
  supportsImages: () => boolean
  /** 媒体装配依赖；专家没有 `media` 能力时不会用到 */
  media: SuperAgentMediaDeps | null
  /** 媒体工具的节点标识（事件归属；缺省用任务 id，测试里不需要） */
  nodeId?: string
}): ToolDefinitionLike[] {
  const tools: ToolDefinitionLike[] = []
  if (params.expert.tools.includes('files')) {
    tools.push(
      ...createFileTools({
        currentDir: params.currentDir,
        allowedPrefixes: () => params.lane
      })
    )
  }
  if (params.expert.tools.includes('media') && params.media) {
    const laneDir = laneOutputDir(params.lane)
    const { mediaTools, readMediaTool, videoTools } = assembleMediaTools(params.nodeId ?? 'superagent', {
      ...params.media,
      // 专家产物必须落进自己的 lane（A02）：否则按默认库写到 assets/images，
      // 编排器的 isPathAllowed 判越界——已经付费生成，却交付不了
      ...(laneDir ? { outputDirFor: () => laneDir } : {}),
      sessionModelSupportsImages: () => params.supportsImages(),
      currentDir: params.currentDir
    })
    tools.push(...mediaTools, readMediaTool, ...videoTools)
  }
  return tools
}

export class SuperAgentRunner {
  private readonly deps: SuperAgentRunnerDeps
  private readonly runtimes = new Map<string, WorkspaceRuntime>()
  /** 每个工作区专家线程的常驻 memory 实例（Mastra Memory 本身按工作区单例） */
  constructor(deps: SuperAgentRunnerDeps) {
    this.deps = deps
  }

  private runtimeFor(dir: string): WorkspaceRuntime {
    const cached = this.runtimes.get(dir)
    if (cached) return cached
    mkdirSync(join(dir, '.huabu'), { recursive: true })
    const runtime: WorkspaceRuntime = {
      service: new SuperAgentService(dir),
      running: new Map(),
      live: new Map(),
      completions: new Map(),
      reconciled: false,
      gate: createSlotGate(MAX_CONCURRENT_EXPERTS)
    }
    this.runtimes.set(dir, runtime)
    return runtime
  }

  /** 任务板投影 + 版本槽 + 运行态（UI 每次事件后重拉，不做增量缓存） */
  async board(dir: string): Promise<{
    tasks: BoardTask[]
    versions: VersionSlots
    eventCount: number
    runningTaskIds: string[]
  }> {
    const runtime = this.runtimeFor(dir)
    // 首次读看板即对账一次（C5）：进程重启后 journal 里停在 active 的任务没人能收，
    // 否则任务板永久挂幽灵「执行中」。本进程正在跑的任务由 running 表排除。
    await this.reconcileOnce(runtime)
    const events = await runtime.service.events()
    return {
      tasks: await runtime.service.board(),
      versions: projectVersions(events),
      eventCount: events.length,
      runningTaskIds: [...runtime.running.keys()]
    }
  }

  /**
   * 每个工作区在本进程内只对账一次。
   * 对账本身是「补一条终态事实」，重放幂等；限一次只是省 IO，不是正确性要求。
   */
  private async reconcileOnce(runtime: WorkspaceRuntime): Promise<void> {
    if (runtime.reconciled) return
    runtime.reconciled = true
    const closed = await runtime.service.reconcile(new Set(runtime.running.keys()))
    if (closed.length === 0) return
    console.log(`[superagent] 启动对账：收口 ${closed.length} 条未收尾任务`)
    // 让渲染端立刻刷新，不必等用户下一次操作
    for (const taskId of closed) {
      this.deps.broadcastTaskEvent({
        type: 'task.status',
        taskId,
        status: 'blocked',
        attempts: 0,
        reason: '任务未收尾（进程重启后对账收口）'
      })
    }
  }

  async journal(dir: string): Promise<JournalEvent[]> {
    return this.runtimeFor(dir).service.events()
  }

  /**
   * 工作区 journal **实例**（不是事件副本）。
   *
   * 任务工具（`create_task` / `finish_task`）要往里追加事实，必须复用同一个实例：
   * 同一个 `.huabu/journal.jsonl` 上有两条写入链，追加顺序就没有保证了。
   */
  journalHandle(dir: string): WorkspaceJournal {
    return this.runtimeFor(dir).service.journal
  }

  /**
   * 某个任务的专家内部对话（只读）。
   *
   * 任务元数据从 journal 投影取（board 是唯一可读投影），消息从工作区 Mastra
   * memory 按线程回放。尝试次数以 `task.started` 为准：验收失败重试会换
   * `-r<attempt>` 线程，这里把每次尝试都带回去，UI 可分段查看。
   *
   * recall 在「线程还没有落库」时会抛错（任务刚派下、专家尚未产生消息）：
   * 该次尝试按空处理，不把「暂时没有」当成读取失败。
   */
  async conversation(dir: string, taskId: string): Promise<SuperAgentTaskConversation> {
    const runtime = this.runtimeFor(dir)
    const events = await runtime.service.events()
    const task = projectBoard(events).find((entry) => entry.taskId === taskId)
    if (!task) throw new Error(`任务不存在：${taskId}`)

    const expert = task.expert ?? DEFAULT_EXPERT_ID
    const memory = await mastraMemoryFor(dir)
    const attempts: SuperAgentTaskConversation['attempts'] = []
    for (const attempt of startedAttempts(events, taskId)) {
      const threadId = expertThreadId(expert, taskId, attempt)
      try {
        const recalled = await memory.recall({
          threadId,
          resourceId: MEMORY_RESOURCE,
          perPage: false
        })
        const messages = toConversationMessages(recalled.messages)
        if (messages.length > 0) attempts.push({ attempt, threadId, messages })
      } catch {
        // 线程尚未创建 / 已经不存在：本次尝试没有可回放的消息
      }
    }

    const live = runtime.live.get(taskId)
    const running = runtime.running.has(taskId)
    const liveNotPersisted =
      live !== undefined && !attempts.some((attempt) => attempt.attempt === live.attempt)

    return {
      taskId,
      expert,
      status: task.status,
      ...(task.scope ? { scope: task.scope } : {}),
      ...(task.prompt ? { prompt: task.prompt } : {}),
      ...(task.accept ? { accept: task.accept } : {}),
      ...(task.lastReason ? { lastReason: task.lastReason } : {}),
      attempts,
      // 任务还在跑时给实时快照；跑完后仅在 memory 尚未落该次尝试时兜底
      ...(live && (running || liveNotPersisted) ? { live } : {})
    }
  }

  /**
   * 取消运行中的任务；返回 false = 该任务不在跑（未受理/已完成/已取消）。
   *
   * 等到终态事实落盘再返回（C16）：此前一 abort 就回报，调用方（`cancel_task` 工具与
   * `superagent:cancel-task`）立刻宣称「已转为受阻」，而 journal 里还没有终态事件、
   * board 仍是 active —— 文案与看板自相矛盾，用户刷新一次又看到「执行中」。
   * 专家若无视 abort，最多等 CANCEL_SETTLE_TIMEOUT_MS 就放弃等待（不悬挂调用方）。
   */
  /**
   * 收口某个工作区的全部专家任务（A07）：切工作区时调用。
   *
   * 为什么必须取消而不是让它跑完：专家的工具依赖里，只有 `currentDir` 绑定在任务启动
   * 时的目录上，媒体配置 / 凭据 / MediaJobManager 仍是**全局**依赖，且按"当前工作区"
   * 现读。A 的任务在用户切到 B 之后继续执行，就会用 B 的配置和凭据去写 A 的 journal——
   * 既产生费用，又把产物记到错误的工作区。
   *
   * 先用一个统一的超时收口（不是每个任务各等 5 秒）：切工作区是用户可感知的操作，
   * 不能因为 N 个任务各等满超时把界面卡住 N×5 秒。
   *
   * @returns 被要求取消的任务数（0 = 该工作区没有在跑的任务）
   */
  async cancelWorkspace(dir: string, timeoutMs = CANCEL_SETTLE_TIMEOUT_MS): Promise<number> {
    const runtime = this.runtimes.get(dir)
    if (!runtime) return 0
    const ids = [...runtime.running.keys()]
    if (ids.length === 0) return 0
    const waits: Array<Promise<unknown>> = []
    for (const taskId of ids) {
      runtime.running.get(taskId)?.abort()
      const settled = runtime.completions.get(taskId)
      if (settled) waits.push(settled)
    }
    if (waits.length > 0) {
      await Promise.race([
        Promise.allSettled(waits),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs)
          ;(timer as unknown as { unref?: () => void }).unref?.()
        })
      ])
    }
    return ids.length
  }

  /**
   * 取消运行中的任务。
   *
   * 返回值必须区分「已经停下」与「还在停」（A08）：此前等 5 秒超时后同样返回 true，
   * 调用方据此对用户宣称「任务已停止、已进入 blocked」，实际可能仍在跑、终态还没落盘。
   * - `not-running`：本进程没有它的 controller（已完成 / 已取消 / 重启前派的单）
   * - `stopped`：终态事实已落盘（board 上已是终态）
   * - `stopping`：已发取消请求，但超时内没等到收口（模型/工具在不可中断的等待里）
   */
  async cancel(dir: string, taskId: string): Promise<CancelOutcome> {
    const runtime = this.runtimeFor(dir)
    const controller = runtime.running.get(taskId)
    if (!controller) return 'not-running'
    controller.abort()
    const settled = runtime.completions.get(taskId)
    if (!settled) return 'stopping'
    let timedOut = false
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, CANCEL_SETTLE_TIMEOUT_MS)
        // 不阻止进程退出（主进程里是 Node 定时器；渲染端类型下面没有 unref）
        ;(timer as unknown as { unref?: () => void }).unref?.()
      })
    ])
    return timedOut ? 'stopping' : 'stopped'
  }

  /**
   * 等待某个任务跑到终态（完成/验收失败/受阻/取消）。
   *
   * 与原生 SubAgent 工具语义一致：调用方阻塞到子任务结束，再读取最终状态；
   * 不是「受理即返回」的轮询。signal 中止时立即 resolve（调用方同时 cancel
   * 任务，等待链不悬挂）。任务不在本进程运行（进程重启/早已结束）时直接返回，
   * 由调用方从 board 读取当前投影。
   */
  async waitFor(dir: string, taskId: string, signal?: AbortSignal): Promise<void> {
    const pending = this.runtimeFor(dir).completions.get(taskId)
    if (!pending) return
    if (!signal) return pending
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void pending.then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
  }

  /**
   * 标记旧任务被新任务顶替（C14）。
   *
   * 重派此前只是「换个新 taskId 再派一次」：旧任务永远停在 attention/blocked，
   * 与替代它的新任务毫无关联，看板上是两条同 scope 的孤立行；如果旧任务还在跑，
   * 它还会继续占着专家并发槽。这里做两件事——中止仍在跑的旧任务、追加一条
   * `task.superseded` 事实把两者连起来。返回 false = 旧任务写不进 journal
   * （早已被清理或从未存在），重派本身仍应继续。
   */
  async supersede(dir: string, previousTaskId: string, nextTaskId: string): Promise<boolean> {
    const runtime = this.runtimeFor(dir)
    // 先中止再落事实：旧任务若还在跑，它会在中止后走自己的终态分支
    runtime.running.get(previousTaskId)?.abort()
    try {
      await runtime.service.append('task.superseded', previousTaskId, 'user', {
        reason: '已重派为新任务',
        supersededBy: nextTaskId
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * 重派一个已有任务（A10）：从 journal 重建**完整输入**再开新任务。
   *
   * 渲染端此前自己拼载荷（只有 scope/prompt/accept/expert），参考资产、邻接镜、
   * 负面约束、分层提示、自定义 lane 全丢——「重派」等于换了个任务重做。输入的唯一
   * 事实源是 journal 的 task.created.spec，所以重建放在主进程这侧。
   */
  async redispatch(
    dir: string,
    taskId: string
  ): Promise<{ ok: true; value: SuperAgentStartOutcome } | { ok: false; error: SuperAgentRunError }> {
    const runtime = this.runtimeFor(dir)
    const input = taskInputFromJournal(await runtime.service.events(), taskId)
    if (!input) {
      return { ok: false, error: { code: 'task_missing', message: `任务不存在或缺少可重建的输入：${taskId}` } }
    }
    return this.start(dir, { ...input, supersedes: taskId })
  }

  /** 用户直连专家改需求：只追加事实，不改任务状态（主 Agent 下一轮读 journal 感知） */
  async appendUserChange(
    dir: string,
    input: { taskId: string; prompt: string; accept?: string[] }
  ): Promise<JournalEvent> {
    return this.runtimeFor(dir).service.append('user.changed', input.taskId, 'user', {
      prompt: input.prompt,
      ...(input.accept && input.accept.length > 0 ? { accept: input.accept } : {})
    })
  }

  experts(): ExpertDefinition[] {
    return listExperts()
  }

  /**
   * 派单执行：立即返回 taskId（受理即返回），专家在后台跑，进度走 task:event。
   * 主 Agent 的 delegate_tasks 工具会接着调用 waitFor 等终态（对齐原生 subagent 语义）；
   * IPC/UI 入口则保持异步受理，不阻塞渲染端。
   * 模型不可用属于「受理失败」——专家没有模型就没法开工，这条必须同步返回而不是
   * 让任务卡在 active 等一个永远不会来的产物。
   */
  async start(
    dir: string,
    request: SuperAgentStartRequest
  ): Promise<{ ok: true; value: SuperAgentStartOutcome } | { ok: false; error: SuperAgentRunError }> {
    const model = await this.resolveExpertModel(dir)
    if (!model) {
      return {
        ok: false,
        error: {
          code: 'model_unavailable',
          message: '没有可用的对话模型：请先在设置里配置模型（专家 Agent 需要它来调用生成工具）'
        }
      }
    }

    const runtime = this.runtimeFor(dir)
    const intent: TaskIntent = {
      taskId: `task-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      scope: request.scope,
      prompt: request.prompt,
      accept: request.accept,
      ...(request.promptLayers?.length ? { promptLayers: request.promptLayers } : {}),
      ...(request.entities?.length ? { entities: request.entities } : {}),
      ...(request.adjacent?.length ? { adjacent: request.adjacent } : {}),
      ...(request.negative?.length ? { negative: request.negative } : {}),
      ...(request.lane?.length ? { lane: request.lane } : {}),
      ...(request.expert ? { expert: request.expert } : {})
    }

    // 重派：先把旧任务收口并关联，再开新任务（C14）。受理失败已在上面返回，
    // 走到这里说明新任务确定会开跑，superseded 关系才有意义。
    if (request.supersedes) {
      void this.supersede(dir, request.supersedes, intent.taskId)
    }

    const memory = await mastraMemoryFor(dir)
    const gateway = createModelGateway({ registrations: () => model.manager.registrations() })
    const supportsImages =
      model.manager.find(`${model.ref.providerId}/${model.ref.modelId}`)?.model.input.includes('image') ?? false
    /*
     * 任务级媒体上下文快照（A07）：`mediaContext()` 按"当前工作区"现算目录/配置/供应商。
     * 任务跑起来之后用户切到别的工作区，现算就会拿到**另一个工作区**的配置。这里在派单
     * 时取一份快照并让工具闭包一直用它——任务的依赖不随当前工作区漂移。
     * （切工作区时 runner 还会取消整个工作区的任务，见 cancelWorkspace；快照是第二道防线。）
     */
    const mediaSnapshot = this.deps.media.mediaContext()

    const controller = new AbortController()
    runtime.running.set(intent.taskId, controller)
    const runner = createLlmExpertRunner({
      gateway,
      modelRef: model.ref,
      memory,
      toolsForExpert: (expert, signal, context) => {
        const defs = buildExpertToolDefinitions({
          expert,
          lane: context.lane,
          currentDir: () => dir,
          supportsImages: () => supportsImages,
          // 用任务级快照，不用会随当前工作区漂移的现算版本（A07）
          media: { ...this.deps.media, mediaContext: () => mediaSnapshot }
        })
        if (defs.length === 0) return {}
        return toMastraTools(defs, {
          nodeId: `superagent-${intent.taskId}`,
          broadcast: () => undefined,
          signal
        })
      }
    })

    const completion = runTask({
      service: runtime.service,
      intent,
      expert: runner,
      options: {
        shadow: request.shadow === true,
        // 并发闸（C15）：超出上限的任务在 todo 上排队，取得槽位才写 task.started
        withSlot: runtime.gate,
        onTaskEvent: (event) => {
          // 先更新主进程快照再广播：用户中途打开详情时 conversation 能直接拿到
          // 已经流过的内容，不依赖「打开之后才收到的事件」。
          const live = applyExpertStreamEvent(runtime.live.get(intent.taskId), event)
          if (live) runtime.live.set(intent.taskId, live)
          this.deps.broadcastTaskEvent(event)
        },
        signal: controller.signal
      }
    })
    // 后台执行：失败也要落一条可读日志（journal 里已有事实，这里只是进程侧可观测性）
    // completions 保留一个不抛错的 settle promise，供 delegate_tasks（原生 subagent 语义）等待。
    const settled = completion.then(
      () => undefined,
      () => undefined
    )
    runtime.completions.set(intent.taskId, settled)
    void completion
      .catch((error: unknown) => {
        console.error(`[superagent] 任务 ${intent.taskId} 执行异常：`, error)
      })
      .finally(() => {
        runtime.running.delete(intent.taskId)
        // 保留 30s 供详情页与等待方读取；之后清掉，避免历史任务常驻内存。
        setTimeout(() => runtime.live.delete(intent.taskId), 30_000).unref?.()
        setTimeout(() => runtime.completions.delete(intent.taskId), 30_000).unref?.()
      })

    const expertId = request.expert?.trim() ? request.expert.trim() : DEFAULT_EXPERT_ID
    // 拼错的 expert id 不废单：编排层会回落到默认专家并把 expertFallbackFrom 写进 journal；
    // 这里返回请求里的 id 只是为了让调用方知道「派给了谁」的原始意图
    return {
      ok: true,
      value: {
        taskId: intent.taskId,
        expert: expertId,
        rejected: [],
        dropped: []
      }
    }
  }

  /** 解析专家对话模型：显式默认模型 → 首个已配置 provider 的首个模型 */
  private async resolveExpertModel(dir: string): Promise<{ manager: ChatModelManager; ref: ModelRef } | null> {
    const manager = await this.deps.modelManagerFor(dir)
    if (!manager) return null
    const explicit = this.deps.defaultModelId()
    if (explicit) {
      const hit = manager.find(explicit)
      return hit ? { manager, ref: { providerId: hit.provider.id, modelId: hit.model.id } } : null
    }
    const statuses = await manager.statuses()
    const configured = statuses.find((status) => status.configured)
    if (!configured) return null
    const provider = manager.providers().find((entry) => entry.id === configured.id)
    const model = provider?.models[0]
    if (!provider || !model) return null
    return { manager, ref: { providerId: provider.id, modelId: model.id } }
  }
}

export { ok as superAgentOk }
