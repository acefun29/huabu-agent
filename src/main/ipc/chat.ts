/**
 * chat 域 IPC（M3 + M9 扩展；Mastra 迁移 v1.2：经 AgentRuntime 路由）。
 *
 * 覆盖通道：chat:runtime / chat:create / chat:prompt / chat:steer / chat:abort /
 * chat:dispose / chat:history / chat:context-usage /
 * chat:compact / chat:fork / chat:set-model / chat:set-thinking。
 * 流式增量经 shared.ts 的 broadcastChatEvent（AgentHost onUpdate）以 chat:event 推送。
 * 运行时选择：workspace.json agent.runtime（pi | mastra）；会话在 create 时绑定运行时，
 * 中途改 flag 只影响新建会话（与 defaultModel 同款语义），dispose 解绑。
 * chat:dispose 成功后经 mediaApproval 的 settleApprovalsForNode 把该节点的挂起确认按拒绝 settle。
 */
import { randomUUID } from 'node:crypto'
import { ipcMain } from './ipcMainBridge'
import { broadcastChatEvent, broadcastAssetChanged, broadcastWorkChanged } from './shared'
import { assembleBlockoutTool, resolveBuiltinSkillsRoots } from '../agent/blockoutTools'
import { assembleNoteTool } from '../agent/noteTool'
import { assembleFacetTools } from '../agent/facetTools'
import { assembleTaskTools } from '../tools/taskTools'
import { buildWorkspaceContext, loadWorkState, taskToolDeps } from '../loop/run'
import { withArtifactRecording } from '../loop/record'
import {
  bindSessionTask,
  clearSessionTasksForWorkspace,
  sessionTaskId,
  taskForSession,
  unbindSessionTask
} from '../loop/sessionTask'
import { assembleMediaTools, laneOutputDir } from '../agent/mediaToolAssembly'
import { createFileTools } from '../agent/fileTools'
import { MastraAgentRuntime } from '../agent/mastra/runtime'
import type { AgentRuntime } from '../agent/runtime'
import { inboxRoot } from '../assets/manager'
import {
  IpcChannel,
  type ChatCreateRequest,
  type ChatPromptRequest,
  type ChatSteerRequest
} from '../../shared/ipc'
import type { IpcContext } from './shared'
import { asNodeRequest, invalidPayload, isNonEmptyString } from './shared'
import { settleApprovalsForNode } from './mediaApproval'

/**
 * 全量释放本进程持有的会话运行时（切工作区 / 退出时调用），返回释放数量。
 *
 * 为什么要单独一个出口（A3）：`host.disposeWorkspace` 只清 `host.sessions`，而
 * 会话绑定还有三张表分散各处——本文件的 `sessionRuntimes`（节点 → 运行时）、
 * `MastraAgentRuntime.sessions`（含 threadId 与在飞 run）、`mastra/memory.ts` 的
 * OM bindings。不过滤工作区的话，切走后旧节点仍在表里、旧会话仍在广播。
 *
 * 在 registerChatIpc 时装配；未注册时是空操作（例如单测直接调本模块）。
 */
let disposeAllSessions: ((workspaceDir?: string) => number) | null = null

export function disposeChatSessions(workspaceDir?: string): number {
  return disposeAllSessions?.(workspaceDir) ?? 0
}

export function registerChatIpc(ctx: IpcContext): void {
  const store = ctx.store
  const currentDir = ctx.currentDir
  const mediaManager = ctx.mediaManager
  const mediaContext = ctx.mediaContext
  const requestMediaApproval = ctx.requestMediaApproval

  // 唯一运行时：会话/记忆走 LibSQL（.huabu/mastra.db），模型只经自有网关。
  // 会话、fork、compact、steer 全部已实装。
  const mastraRuntime = new MastraAgentRuntime({
    broadcast: broadcastChatEvent,
    currentDir,
    defaultModel: () => store.currentWorkspace?.defaultModel,
    // 模型清单与凭据统一从 WorkspaceModels 取：运行时只消费模型服务，
    // 不经过会话装配，避免运行器故障时模型下拉与 Key 录入一起失效。
    managerForWorkspace: (dir) => ctx.models.managerFor(dir),
    runtimeInfo: (dir) => ctx.models.runtimeInfo(dir),
    // 技能注入的禁用名单（Mastra 侧此前完全不注入技能，见 agent/skills.ts 的文件头）
    disabledSkills: () => store.skillsDisabled(),
    // 内置技能根（resources/skills）：electron 相关的路径解析留在主进程这侧，
    // mastra/runtime.ts 保持可在 node 单测里加载
    builtinSkillRoots: () => resolveBuiltinSkillsRoots(),
    /*
     * 项目记忆 + 当前任务注入系统提示词（施工计划 v4）。记忆与任务事实都在工作区的
     * journal / `.huabu/memory/studio.md` 里，读盘细节留在 loop/run.ts。
     * 这里的 catch 是**能力可用性**：记忆读不出来也要能聊天（§12）。
     */
    workspaceContext: async (dir, nodeId) => {
      try {
        return await buildWorkspaceContext({
          dir,
          journal: () => ctx.superAgent.journalHandle(dir),
          nodeId
        })
      } catch (error) {
        console.warn(`[chat] 项目记忆装配失败，按无记忆继续：${String(error)}`)
        return ''
      }
    },
    // 工具装配：文件三件套 + blockout + 媒体三件套 + read_media
    // + 视频两工具 + create_note + 分级 + 任务四件套。
    // vision 已通（toModelOutput content/media）：按会话模型目录 input 声明判定
    // （与 Pi 侧同一份数据），模型不支持时工具内自动降级元数据
    assembleTools: async (nodeId, workspaceDir) => {
      /*
       * 工作区来自 runtime create 已捕获的那一份（不是现读 currentDir）：
       * 会话装配与真正打开的工作区之间没有竞态窗口，切工作区后旧会话的
       * 迟到回执只会写回自己的事实源。
       */
      const sessionDir = workspaceDir
      const sessionCurrentDir = () => sessionDir
      const sessionJournal = () => ctx.superAgent.journalHandle(sessionDir)
      const { mediaTools, readMediaTool, videoTools } = assembleMediaTools(nodeId, {
        store,
        mediaManager,
        requestApproval: requestMediaApproval,
        sessionModelSupportsImages: (nid) => mastraRuntime.sessionSupportsImages(nid),
        currentDir: sessionCurrentDir,
        isWorkspaceActive: (dir) => ctx.currentDir() === dir,
        mediaContext,
        inboxRoot,
        /*
         * 媒体落盘跟随**本会话正在做的任务**（提交边界现取，不缓存）：
         * 有同类任务时生成直接落进 lane，记账才追得上——否则默认库路径在写区外，
         * 生成成功也不会成为任务产物。没有任务（手动/闲聊生成）沿用默认落库链。
         */
        outputDirFor: async (kind) => {
          const task = taskForSession(await loadWorkState(sessionJournal()), nodeId, sessionDir)
          // 只认同类任务：文本任务里顺手生成的参考图仍走默认库，不该记成文本任务的版本
          return task && task.kind === kind ? laneOutputDir([task.lane]) : undefined
        }
      })
      const noteTool = assembleNoteTool({ currentDir: sessionCurrentDir, notifyAssetsChanged: broadcastAssetChanged })
      const facetTools = assembleFacetTools({
        currentDir: sessionCurrentDir,
        schemas: () => store.facetSchemas(),
        activeSchemaId: () => store.facetSchemaId(),
        saveSchema: (schema, activate) => store.saveFacetSchema(schema, activate),
        deleteSchema: (id) => store.deleteFacetSchema(id),
        notifyChanged: broadcastAssetChanged
      })
      /*
       * 旧派单工具（`delegate_tasks` / `cancel_task` / 旧 `list_tasks`）**不再交给模型**（施工计划第 6 步）。
       * 专家编排与旧任务板保持可读：`superagent:*` 通道还在，旧 journal 事件照旧投影，
       * 只是模型这一侧只剩新任务模型的四件套——否则两套任务系统同时在手，
       * 模型会挑一套用，而旧那套已经没有 UI 承接。
       *
       * 顺带修掉一个隐患：旧 `list_tasks` 与新的同名，两条都在时后者静默覆盖前者。
       */
      /*
       * 任务四件套（施工计划 v4）：模型和「任务」原子的全部接触面。
       * journal 惰性取当前工作区的**同一个实例**（runner.journalHandle）——任务事实写进
       * 既有 journal.jsonl，不另起一套日志。
       */
      const taskTools = assembleTaskTools(
        taskToolDeps({
          currentDir: sessionCurrentDir,
          journal: sessionJournal,
          newTaskId: () => `task-${randomUUID().slice(0, 8)}`,
          onAppend: broadcastWorkChanged,
          // 任务归属是「工作区 + 会话」级的：开工/继续把任务绑到本会话，收工/放弃解绑
          onTaskStarted: (taskId) => bindSessionTask(nodeId, sessionDir, taskId),
          onTaskClosed: (taskId) => unbindSessionTask(nodeId, taskId)
        })
      )
      // blockout 粗模/运镜引擎：Pi 侧靠「read 命中技能目录 → 增量激活」做惰性注册，
      // Mastra 侧没有对应的运行时工具开关（tools 在 Agent 构造时传入，而 Agent 每轮
      // 重建），因此这里**常驻**。取舍：常驻只多占工具列表一行的 token，而 blockout
      // 的入口本来就要先读 blockout-shot 技能正文才会被正确调用；惰性机制省下的那点
      // 收益不值得在 Mastra 侧再造一套工具热改。
      const blockoutTool = assembleBlockoutTool({ currentDir: sessionCurrentDir, notifyAssetsChanged: broadcastAssetChanged })
      // 文件三件套（全量去 pi 的前提）：Pi 侧由 pi 的内置 ls/read/write 提供，Mastra 侧
      // 原本**完全没有**——而 shared/prompt.ts 一直在教模型「文本用 read」「中间文件用
      // write」，渲染端的「写的媒体文件自动上画布」也挂在 write 的工具事件上。
      // 守卫在 fileTools.ts 里（工作区相对路径 + realpath 防符号链接逃逸 + 读写上限）。
      const fileTools = createFileTools({ currentDir: sessionCurrentDir })
      const tools = [
        ...fileTools,
        blockoutTool,
        ...mediaTools,
        readMediaTool,
        ...videoTools,
        noteTool,
        ...facetTools,
        ...taskTools
      ]
      /*
       * 产物记账（施工计划 v4）：工具说它产出了文件，系统就把这条事实记到正在做的任务上。
       * 没有这一层，任务永远无法变成 done——「完成 = 有产物」里的「有产物」得有人写。
       * 只包 execute，工具对模型的行为完全不变。
       */
      return withArtifactRecording(tools, {
        journal: sessionJournal,
        // 归属跟着会话走：调用开始时取本会话在本工作区的绑定任务，不回退全局
        taskId: () => sessionTaskId(nodeId, sessionDir),
        // 记账成功即广播：长轮次里产物一落盘，工作项与角标就该刷新，
        // 不能等 finish_task 才有动静（那时可能已经过去几十秒）。
        onRecorded: () => broadcastWorkChanged()
      })
    }
  })

  const sessionRuntimes = new Map<string, AgentRuntime>()
  const runtimeFor = (): AgentRuntime => mastraRuntime
  const runtimeOf = (nodeId: string): AgentRuntime => sessionRuntimes.get(nodeId) ?? runtimeFor()

  // 切工作区 / 退出时的统一收口（A3）：绑定表整表清（切走后旧 nodeId 不会复用），
  // Mastra 会话按工作区过滤释放（保住可能已在新工作区建好的会话）
  disposeAllSessions = (workspaceDir?: string) => {
    sessionRuntimes.clear()
    // 会话生命周期与任务绑定一起收口：只清该工作区的绑定，别的窗口不受影响
    clearSessionTasksForWorkspace(workspaceDir)
    return mastraRuntime.disposeAll(workspaceDir)
  }

  ipcMain.handle(IpcChannel.ChatRuntime, () => runtimeFor().runtime())

  ipcMain.handle(IpcChannel.ChatCreate, async (_event, payload: unknown) => {
    const request = payload as Partial<ChatCreateRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:create 需要 nodeId')
    const createRequest: ChatCreateRequest = { nodeId: request.nodeId }
    if (isNonEmptyString(request.cwd)) createRequest.cwd = request.cwd
    if (isNonEmptyString(request.modelId)) createRequest.modelId = request.modelId
    // 初始思考档位：契约里有（ChatCreateRequest.thinkingLevel），渲染端也一直随 create 传。
    // 这里漏透传的话运行时只能拿默认值，用户选的 high/max 永远不生效（A1）
    if (isNonEmptyString(request.thinkingLevel)) createRequest.thinkingLevel = request.thinkingLevel
    if (isNonEmptyString(request.sessionFile)) createRequest.sessionFile = request.sessionFile
    const runtime = runtimeFor()
    const result = await runtime.create(createRequest)
    if (result.ok) sessionRuntimes.set(createRequest.nodeId, runtime)
    return result
  })

  ipcMain.handle(IpcChannel.ChatPrompt, (_event, payload: unknown) => {
    const request = payload as Partial<ChatPromptRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:prompt 需要 nodeId')
    if (!isNonEmptyString(request.text)) return invalidPayload('chat:prompt 需要 text')

    const promptRequest: ChatPromptRequest = { nodeId: request.nodeId, text: request.text }
    return runtimeOf(promptRequest.nodeId).prompt(promptRequest)
  })

  ipcMain.handle(IpcChannel.ChatSteer, (_event, payload: unknown) => {
    const request = payload as Partial<ChatSteerRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:steer 需要 nodeId')
    if (!isNonEmptyString(request.text)) return invalidPayload('chat:steer 需要 text')
    return runtimeOf(request.nodeId).steer({ nodeId: request.nodeId, text: request.text })
  })

  ipcMain.handle(IpcChannel.ChatAbort, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:abort 需要 nodeId')
    return runtimeOf(request.nodeId).abort(request)
  })

  ipcMain.handle(IpcChannel.ChatDispose, async (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:dispose 需要 nodeId')
    const result = await runtimeOf(request.nodeId).dispose(request)
    // dispose 成功后该会话不会再有回执：挂起的确认请求按拒绝 settle，防孤儿挂起
    if (result.ok) {
      sessionRuntimes.delete(request.nodeId)
      unbindSessionTask(request.nodeId)
      settleApprovalsForNode(request.nodeId)
    }
    return result
  })

  ipcMain.handle(IpcChannel.ChatHistory, (_event, payload: unknown) => {
    // 画布恢复时按文件回放历史；节点可能尚未 create。路由顺序（计划 v1.2 §7.3）：
    // 已绑定会话 → 按绑定；mastra: 前缀 → Mastra 运行时（前缀即路由键，
    // flag 切回 pi 后旧 Mastra 会话的历史仍可回放）；其余 → 当前 flag
    const request = payload as { nodeId?: unknown; sessionFile?: unknown } | null
    if (!isNonEmptyString(request?.sessionFile)) return invalidPayload('chat:history 需要 sessionFile')
    const nodeId = isNonEmptyString(request.nodeId) ? request.nodeId : ''
    const runtime =
      (nodeId ? sessionRuntimes.get(nodeId) : undefined) ??
      (request.sessionFile.startsWith('mastra:') ? mastraRuntime : runtimeFor())
    return runtime.history({ nodeId, sessionFile: request.sessionFile })
  })

  ipcMain.handle(IpcChannel.ChatContextUsage, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:context-usage 需要 nodeId')
    return runtimeOf(request.nodeId).contextUsage(request)
  })


  ipcMain.handle(IpcChannel.ChatCompact, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:compact 需要 nodeId')
    return runtimeOf(request.nodeId).compact(request)
  })

  ipcMain.handle(IpcChannel.ChatFork, (_event, payload: unknown) => {
    const request = payload as { nodeId?: unknown; sessionFile?: unknown } | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:fork 需要 nodeId')
    if (!isNonEmptyString(request.sessionFile)) return invalidPayload('chat:fork 需要 sessionFile')
    return runtimeOf(request.nodeId).fork({ nodeId: request.nodeId, sessionFile: request.sessionFile })
  })

  ipcMain.handle(IpcChannel.ChatSetModel, async (_event, payload: unknown) => {
    const request = payload as { nodeId?: unknown; modelId?: unknown } | null
    if (!isNonEmptyString(request?.nodeId) || !isNonEmptyString(request?.modelId)) {
      return invalidPayload('chat:set-model 需要 nodeId 与 modelId')
    }
    return runtimeOf(request.nodeId).setModel({ nodeId: request.nodeId, modelId: request.modelId })
  })

  ipcMain.handle(IpcChannel.ChatSetThinking, (_event, payload: unknown) => {
    const request = payload as { nodeId?: unknown; thinkingLevel?: unknown } | null
    if (!isNonEmptyString(request?.nodeId) || !isNonEmptyString(request?.thinkingLevel)) {
      return invalidPayload('chat:set-thinking 需要 nodeId 与 thinkingLevel')
    }
    return runtimeOf(request.nodeId).setThinking({ nodeId: request.nodeId, thinkingLevel: request.thinkingLevel })
  })
}
