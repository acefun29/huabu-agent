import { WorkspaceModels } from './agent/workspaceModels'
import { SafeStorageCredentialStore } from './agent/credentials'
import { getCredentialsFile } from './workspace/stateDir'
import { WorkspaceStore } from './workspace/store'
import { McpManager } from './mcp/manager'
import {
  broadcastAssetChanged,
  broadcastProjectChangedEvent,
  broadcastMediaJob,
  broadcastMcpStatus,
  broadcastTaskEvent,
  type IpcContext
} from './ipc/shared'
import { registerWindowAppIpc } from './ipc/windowApp'
import { registerWorkspaceIpc } from './ipc/workspace'
import { registerAssetIpc } from './ipc/asset'
import { registerMediaIpc, createMediaRuntime, requestMediaApproval } from './ipc/media'
import { registerChatIpc, disposeChatSessions } from './ipc/chat'
import { registerProjectIpc } from './ipc/project'
import { registerSuperAgentIpc } from './ipc/superagent'
import { registerSettingsIpc } from './ipc/settings'
import { SuperAgentRunner } from './superagent/runner'
import { inboxRoot } from './assets/manager'

/**
 * 注册全部 IPC handler（瘦编排器：各域 handler 分模块注册，见 src/main/ipc/ 目录）。
 *
 * 通道清单见 docs/ipc-contract.md。M1 落地 app 域，M3 落地 chat 域，
 * M5 扩展落地 workspace 域，M9 扩展落地 settings 域。
 *
 * 安全约定：渲染进程发来的载荷一律按「不可信输入」处理，先做形状校验再交给服务层。
 * 事件广播前检查 webContents 是否已销毁，否则关窗瞬间会抛错。
 */

let workspaceStore: WorkspaceStore | null = null
let mcpManagerSingleton: McpManager | null = null

export function getWorkspaceStore(): WorkspaceStore | null {
  return workspaceStore
}

/** 退出流程（will-quit）用：全量关停 MCP 子进程 */
export function getMcpManager(): McpManager | null {
  return mcpManagerSingleton
}

/**
 * 退出流程用：收口全部会话运行时（A3）。
 * Pi 侧由 `AgentHost.disposeAllSync` 处理，Mastra 侧的两张表由这里处理，
 * 两者都要调——只调前者会漏掉 `MastraAgentRuntime.sessions` 与 OM bindings。
 */
export { disposeChatSessions }

export function registerIpcHandlers(): void {
  const store = new WorkspaceStore()
  workspaceStore = store
  // 冷启动恢复上次工作区（打包态冒烟抓出的缺失：此前恢复只发生在 dev 长驻进程里）
  if (store.bootstrap()) {
    console.log(`[workspace] 冷启动已恢复上次工作区：${store.currentDir}`)
  }

  // 工作区模型目录/凭据服务：与 pi 解耦（设置页的模型清单、Key 录入不再依赖 pi 加载成功）。
  // 凭据工厂在这里注入——safeStorage 属 electron，不能让服务模块自己 import。
  const models = new WorkspaceModels({
    createCredentials: async (dir) => SafeStorageCredentialStore.forWorkspace(getCredentialsFile(dir))
  })


  /** 当前工作区目录（可能为 null：选择页状态下不该有会话） */
  const currentDir = (): string | null => store.currentDir

  // media 域运行时（mediaManager/mediaContext）：chat 域的 assembleMediaTools 与
  // media 域 handler 共同消费。原实现在 handler 注册中途创建，拆分后统一提前到这里，
  // 仍在 registerIpcHandlers 同步段内完成（首个 invoke 到来之前必然就绪）。
  const { mediaManager, mediaContext } = createMediaRuntime({
    store,
    models,
    currentDir,
    broadcastAssetChanged,
    broadcastMediaJob
  })

  // MCP 桥接池（全局配置，跨工作区共享）：启动即 sync 预热，状态变化推 mcp:status
  const mcpManager = new McpManager(broadcastMcpStatus)
  mcpManagerSingleton = mcpManager
  mcpManager.sync()

  // SuperAgent 运行器：IPC 域与 Agent 派单工具共用（模型解析/工具装配/取消都在这层）
  const superAgent = new SuperAgentRunner({
    currentDir,
    defaultModelId: () => store.currentWorkspace?.defaultModel,
    // SuperAgent 的专家模型解析走 WorkspaceModels（与 pi 解耦）
    modelManagerFor: (dir) => models.managerFor(dir),
    media: { store, mediaManager, mediaContext, requestApproval: requestMediaApproval, inboxRoot },
    broadcastTaskEvent
  })

  const ctx: IpcContext = {
    store,
    models,
    currentDir,
    broadcastAssetChanged,
    broadcastProjectChanged: broadcastProjectChangedEvent,
    broadcastTaskEvent,
    superAgent,
    mediaManager,
    mediaContext,
    requestMediaApproval,
    mcpManager
  }

  registerWindowAppIpc(ctx)
  registerWorkspaceIpc(ctx)
  registerAssetIpc(ctx)
  registerMediaIpc(ctx)
  registerChatIpc(ctx)
  registerProjectIpc(ctx)
  registerSuperAgentIpc(ctx)
  registerSettingsIpc(ctx)
}
