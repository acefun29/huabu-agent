/**
 * chat 域 IPC（M3 + M9 扩展；Mastra 迁移 v1.2：经 AgentRuntime 路由）。
 *
 * 覆盖通道：chat:runtime / chat:create / chat:prompt / chat:steer / chat:abort /
 * chat:dispose / chat:history / chat:context-usage /
 * chat:compact / chat:fork / chat:set-model / chat:set-thinking。
 * 流式增量经 shared.ts 的 broadcastChatEvent（AgentHost onUpdate）以 chat:event 推送。
 * 运行时选择：workspace.json agent.runtime（pi | mastra）；会话在 create 时绑定运行时，
 * 中途改 flag 只影响新建会话（与 defaultModel 同款语义），dispose 解绑。
 * chat:dispose 成功后经 media.ts 的 settleApprovalsForNode 把该节点的挂起确认按拒绝 settle。
 */
import { ipcMain } from './ipcMainBridge'
import { broadcastChatEvent } from './shared'
import { assembleBlockoutTool } from '../agent/blockoutTools'
import { assembleNoteTool } from '../agent/noteTool'
import { assembleMediaTools } from '../agent/mediaToolAssembly'
import { MastraAgentRuntime } from '../agent/mastra/runtime'
import { PiAgentRuntime } from '../agent/piRuntime'
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
import { settleApprovalsForNode } from './media'

export function registerChatIpc(ctx: IpcContext): void {
  const store = ctx.store
  const host = ctx.host
  const currentDir = ctx.currentDir
  const mediaManager = ctx.mediaManager
  const mediaContext = ctx.mediaContext
  const requestMediaApproval = ctx.requestMediaApproval
  const mcpManager = ctx.mcpManager

  const piRuntime = new PiAgentRuntime(host, {
    currentDir,
    defaultModel: () => store.currentWorkspace?.defaultModel,
    disabledSkills: () => store.skillsDisabled(),
    assembleTools: async (nodeId) => {
      // M13 + T7 + 视频理解 M2/M3：会话注入媒体生成工具、read_media 与视频两工具
      // （装配见 agent/mediaToolAssembly.ts）。submit = 提交 + 等待终态：工具 execute
      // 阻塞到成功/失败/取消，期间经 onUpdate 推进度，失败信息原样进工具结果
      // （Agent 据此引导用户配置），不再有"提交即成功"的假反馈
      const { mediaTools, readMediaTool, videoTools } = assembleMediaTools(nodeId, {
        store,
        mediaManager,
        requestApproval: requestMediaApproval,
        sessionModelSupportsImages: (nid) => host.sessionModelSupportsImages(nid),
        currentDir,
        mediaContext,
        inboxRoot
      })
      // MCP：全局启用的服务器工具（mcp_<server>_<tool>）。未就绪/失败的服务器被跳过
      // （迁移 Phase 1 移除，见计划 v1.2 §11.3）
      const mcpTools = await mcpManager.assembleTools()
      // blockout 粗模/运镜引擎工具：customTools 即进 tools 白名单（host.create 组装），
      // 默认惰性——创建后被 host 摘除，Agent 读 blockout-shot 技能时再激活（P2）
      const blockoutTool = assembleBlockoutTool({ currentDir })
      // 文本卡创建工具：文本上画布的唯一通道（write 落盘的文本不上画布，见 noteTool 头注）
      const noteTool = assembleNoteTool({ currentDir })
      return [...mediaTools, readMediaTool, ...videoTools, ...mcpTools, blockoutTool, noteTool]
    }
  })
  // Mastra 运行时（迁移 Phase 1）：会话/记忆走 LibSQL（.huabu/mastra.db），模型只经
  // 自有 ModelGateway；compact/fork/steer 为显式未迁移失败（见 mastra/runtime.ts）
  const mastraRuntime = new MastraAgentRuntime({
    broadcast: broadcastChatEvent,
    currentDir,
    defaultModel: () => store.currentWorkspace?.defaultModel,
    managerForWorkspace: (dir) => host.chatManagerFor(dir),
    runtimeInfo: (dir) => host.runtime(dir),
    // 工具装配（Phase 3 迁移面）：复用与 Pi 侧同一批组装函数——媒体三件套 + read_media
    // + 视频两工具 + create_note。差异：不装 MCP（计划 §11.3 迁移期移除）与 blockout
    // （惰性激活是 pi 会话机制）。vision 已通（toModelOutput content/media）：按会话
    // 模型目录 input 声明判定（与 Pi 侧同一份数据），模型不支持时工具内自动降级元数据
    assembleTools: async (nodeId) => {
      const { mediaTools, readMediaTool, videoTools } = assembleMediaTools(nodeId, {
        store,
        mediaManager,
        requestApproval: requestMediaApproval,
        sessionModelSupportsImages: (nid) => mastraRuntime.sessionSupportsImages(nid),
        currentDir,
        mediaContext,
        inboxRoot
      })
      const noteTool = assembleNoteTool({ currentDir })
      return [...mediaTools, readMediaTool, ...videoTools, noteTool]
    }
  })

  const sessionRuntimes = new Map<string, AgentRuntime>()
  const runtimeFor = (): AgentRuntime => (store.agentRuntime() === 'mastra' ? mastraRuntime : piRuntime)
  const runtimeOf = (nodeId: string): AgentRuntime => sessionRuntimes.get(nodeId) ?? runtimeFor()

  ipcMain.handle(IpcChannel.ChatRuntime, () => runtimeFor().runtime())

  ipcMain.handle(IpcChannel.ChatCreate, async (_event, payload: unknown) => {
    const request = payload as Partial<ChatCreateRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:create 需要 nodeId')
    const createRequest: ChatCreateRequest = { nodeId: request.nodeId }
    if (isNonEmptyString(request.cwd)) createRequest.cwd = request.cwd
    if (isNonEmptyString(request.modelId)) createRequest.modelId = request.modelId
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
