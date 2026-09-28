import { AgentHost } from './agent/host'
import { WorkspaceStore } from './workspace/store'
import {
  broadcastAssetChanged,
  broadcastChatEvent,
  broadcastMediaJob,
  type IpcContext
} from './ipc/shared'
import { registerWindowAppIpc } from './ipc/windowApp'
import { registerWorkspaceIpc } from './ipc/workspace'
import { registerAssetIpc } from './ipc/asset'
import { registerMediaIpc, createMediaRuntime, requestMediaApproval } from './ipc/media'
import { registerChatIpc } from './ipc/chat'
import { registerSettingsIpc } from './ipc/settings'

/**
 * 注册全部 IPC handler（瘦编排器：各域 handler 分模块注册，见 src/main/ipc/ 目录）。
 *
 * 通道清单见 docs/ipc-contract.md。M1 落地 app 域，M3 落地 chat 域，
 * M5 扩展落地 workspace 域，M9 扩展落地 settings 域。
 *
 * 安全约定：渲染进程发来的载荷一律按「不可信输入」处理，先做形状校验再交给服务层。
 * 事件广播前检查 webContents 是否已销毁，否则关窗瞬间会抛错。
 */

let agentHost: AgentHost | null = null
let workspaceStore: WorkspaceStore | null = null

/** 供主进程其它模块（如退出流程、媒体协议）访问；未注册时为 null */
export function getAgentHost(): AgentHost | null {
  return agentHost
}

export function getWorkspaceStore(): WorkspaceStore | null {
  return workspaceStore
}

export function registerIpcHandlers(): void {
  const store = new WorkspaceStore()
  workspaceStore = store
  // 冷启动恢复上次工作区（打包态冒烟抓出的缺失：此前恢复只发生在 dev 长驻进程里）
  if (store.bootstrap()) {
    console.log(`[workspace] 冷启动已恢复上次工作区：${store.currentDir}`)
  }

  const host = new AgentHost(broadcastChatEvent)
  agentHost = host

  // 预热：pi 是动态导入，放到窗口创建前 await 会拖慢启动。
  // chat:runtime / chat:create 内部各自 await init()，天然幂等。
  void host.init()

  /** 当前工作区目录（可能为 null：选择页状态下不该有会话） */
  const currentDir = (): string | null => store.currentDir

  // media 域运行时（mediaManager/mediaContext）：chat 域的 assembleMediaTools 与
  // media 域 handler 共同消费。原实现在 handler 注册中途创建，拆分后统一提前到这里，
  // 仍在 registerIpcHandlers 同步段内完成（首个 invoke 到来之前必然就绪）。
  const { mediaManager, mediaContext } = createMediaRuntime({
    store,
    host,
    currentDir,
    broadcastAssetChanged,
    broadcastMediaJob
  })

  const ctx: IpcContext = {
    store,
    host,
    currentDir,
    broadcastAssetChanged,
    mediaManager,
    mediaContext,
    requestMediaApproval
  }

  registerWindowAppIpc(ctx)
  registerWorkspaceIpc(ctx)
  registerAssetIpc(ctx)
  registerMediaIpc(ctx)
  registerChatIpc(ctx)
  registerSettingsIpc(ctx)
}
