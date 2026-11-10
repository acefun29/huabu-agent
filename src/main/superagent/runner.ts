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
import { assembleMediaTools, type MediaAssemblyDeps } from '../agent/mediaToolAssembly'
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
import type { JournalEvent } from './journal'
import { createLlmExpertRunner, runTask } from './orchestrator'
import type { TaskIntent } from './dispatch'
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
  shadow?: boolean
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
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
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
      completions: new Map()
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
    const events = await runtime.service.events()
    return {
      tasks: await runtime.service.board(),
      versions: projectVersions(events),
      eventCount: events.length,
      runningTaskIds: [...runtime.running.keys()]
    }
  }

  async journal(dir: string): Promise<JournalEvent[]> {
    return this.runtimeFor(dir).service.events()
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

  /** 取消运行中的任务；返回 false = 该任务不在跑（未受理/已完成/已取消） */
  cancel(dir: string, taskId: string): boolean {
    const controller = this.runtimeFor(dir).running.get(taskId)
    if (!controller) return false
    controller.abort()
    return true
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

    const memory = await mastraMemoryFor(dir)
    const gateway = createModelGateway({ registrations: () => model.manager.registrations() })
    const supportsImages =
      model.manager.find(`${model.ref.providerId}/${model.ref.modelId}`)?.model.input.includes('image') ?? false

    const controller = new AbortController()
    runtime.running.set(intent.taskId, controller)
    const runner = createLlmExpertRunner({
      gateway,
      modelRef: model.ref,
      memory,
      toolsForExpert: (expert, signal) => {
        if (expert.tools === 'none') return {}
        const nodeId = `superagent-${intent.taskId}`
        const { mediaTools, readMediaTool, videoTools } = assembleMediaTools(nodeId, {
          ...this.deps.media,
          sessionModelSupportsImages: () => supportsImages,
          currentDir: () => dir
        })
        const piTools: ToolDefinitionLike[] = [...mediaTools, readMediaTool, ...videoTools]
        return toMastraTools(piTools, { nodeId, broadcast: () => undefined, signal })
      }
    })

    const completion = runTask({
      service: runtime.service,
      intent,
      expert: runner,
      options: {
        shadow: request.shadow === true,
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
