/**
 * IPC 各域共享的载荷校验助手、结果包装、跨窗口广播与依赖上下文。
 *
 * 自 src/main/ipc.ts 拆出（实现原样搬移）：
 * - 校验/包装助手：isNonEmptyString / asNodeRequest / invalidPayload / ok / describe / guardSync / guardAsync
 * - 广播：chat:event（运行时 onUpdate 回调）、asset:changed、media:job
 * - IpcContext：编排器（src/main/ipc.ts）组装后注入各域注册函数的依赖上下文
 *
 * 安全约定：渲染进程发来的载荷一律按「不可信输入」处理，先做形状校验再交给服务层。
 * 事件广播前检查 webContents 是否已销毁，否则关窗瞬间会抛错。
 */
import { BrowserWindow } from 'electron'
import { forwardEvent } from '../webBridge/server'
import type { WorkspaceModels } from '../agent/workspaceModels'
import type { WorkspaceStore } from '../workspace/store'
import type { MediaJobManager } from '../media/manager'
import type { MediaApprovalInfo } from '../agent/mediaTools'
import type { McpManager } from '../mcp/manager'
import type { MediaContextReturnType } from './media'
import type { SuperAgentRunner } from '../superagent/runner'
import { 
  IpcChannel,
  type ChatEvent,
  type ChatNodeRequest,
  type ChatResult,
  type MediaJobStatus
, type TaskEvent } from '../../shared/ipc'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 把 invoke 传来的未知载荷收敛成 ChatNodeRequest，形状不对就返回 null */
function asNodeRequest(payload: unknown): ChatNodeRequest | null {
  const nodeId = (payload as { nodeId?: unknown } | null)?.nodeId
  return isNonEmptyString(nodeId) ? { nodeId } : null
}

function invalidPayload<T>(what: string): ChatResult<T> {
  return { ok: false, code: 'unknown', error: `IPC 载荷不合法：${what}` }
}

function ok(): ChatResult {
  return { ok: true, value: undefined }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 400 ? `${message.slice(0, 400)}…` : message
}

/** 把服务层抛出的同步异常（目录不可写、画布超限等）收敛成 ChatResult，不外泄堆栈 */
function guardSync<T>(fn: () => T): ChatResult<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'unknown', error: message.length > 500 ? `${message.slice(0, 500)}…` : message }
  }
}

/** guardSync 的异步版（await 服务层 Promise）：素材导入/清单/归档异步化后的 handler 复用，
 * 失败结果形态（500 字截断、code:'unknown'）与 guardSync 逐字一致 */
async function guardAsync<T>(fn: () => Promise<T>): Promise<ChatResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'unknown', error: message.length > 500 ? `${message.slice(0, 500)}…` : message }
  }
}

/** chat:event 广播：作为运行时与 webBridge 的事件出口（见 src/main/ipc.ts 编排器） */
export function broadcastChatEvent(event: ChatEvent): void {
  // Web 桥：同一事件转给浏览器（未启用时零开销）
  forwardEvent(IpcChannel.ChatEvent, event)
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents
    if (contents.isDestroyed()) continue
    try {
      contents.send(IpcChannel.ChatEvent, event)
    } catch (error) {
      // 广播失败不能打断事件链，否则一个坏窗口会让所有会话都收不到后续增量
      console.error(`[ipc] chat:event 广播失败：${String(error)}`)
    }
  }
}

/** task:event 广播：SuperAgent 任务/验收进度（计划 §9.7 新增可选事件，渲染端未接时忽略） */
export function broadcastTaskEvent(event: TaskEvent): void {
  forwardEvent(IpcChannel.TaskEvent, event)
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents
    if (contents.isDestroyed()) continue
    try {
      contents.send(IpcChannel.TaskEvent, event)
    } catch (error) {
      console.error(`[ipc] task:event 广播失败：${String(error)}`)
    }
  }
}

/** project:changed 广播：项目结构变更后渲染端刷新（层级/状态/进度） */
export function broadcastProjectChangedEvent(): void {
  forwardEvent(IpcChannel.ProjectChanged, { at: Date.now() })
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents
    if (contents.isDestroyed()) continue
    try {
      contents.send(IpcChannel.ProjectChanged, { at: Date.now() })
    } catch (error) {
      console.error(`[ipc] project:changed 广播失败：${String(error)}`)
    }
  }
}

/** 素材目录变更广播（import/建库/删库后渲染端刷新素材库面板与目录约定） */
export function broadcastAssetChanged(): void {
  forwardEvent(IpcChannel.AssetChanged, { at: Date.now() })
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents
    if (contents.isDestroyed()) continue
    try {
      contents.send(IpcChannel.AssetChanged, { at: new Date().toISOString() })
    } catch (error) {
      console.error(`[ipc] asset:changed 广播失败：${String(error)}`)
    }
  }
}

/**
 * work:changed 广播：任务事实（work.* / artifact.recorded）追加后通知渲染端重拉投影。
 *
 * 只送一个"变了"的信号，不送内容——投影由 `superagent:work-state` 统一算，
 * 避免事件里再维护一份形状（那样迟早和投影漂开）。
 */
export function broadcastWorkChanged(): void {
  forwardEvent(IpcChannel.WorkChanged, { at: Date.now() })
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents
    if (contents.isDestroyed()) continue
    try {
      contents.send(IpcChannel.WorkChanged, { at: new Date().toISOString() })
    } catch (error) {
      console.error(`[ipc] work:changed 广播失败：${String(error)}`)
    }
  }
}

export function broadcastMediaJob(job: MediaJobStatus): void {
  // Web 桥：同一事件转给浏览器（未启用时零开销）
  forwardEvent(IpcChannel.MediaJobEvent, job)
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents
    if (contents.isDestroyed()) continue
    try {
      contents.send(IpcChannel.MediaJobEvent, job)
    } catch (error) {
      console.error(`[ipc] media:job 广播失败：${String(error)}`)
    }
  }
}

/** MCP 服务器状态变化广播（连接中/已连接/失败），设置页徽章实时更新 */
export function broadcastMcpStatus(): void {
  forwardEvent('mcp:status', { at: Date.now() })
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents
    if (contents.isDestroyed()) continue
    try {
      contents.send(IpcChannel.McpStatusEvent, { at: new Date().toISOString() })
    } catch (error) {
      console.error(`[ipc] mcp:status 广播失败：${String(error)}`)
    }
  }
}

/**
 * 编排器注入各域注册函数的依赖上下文：store/host 为全局单例，
 * media 域运行时（mediaManager/mediaContext）与确认闸门在各域注册前创建。
 */
export interface IpcContext {
  store: WorkspaceStore
  /**
   * 工作区模型目录/凭据服务（**不依赖 pi**）。
   * Mastra 运行时的模型清单与凭据走这里，而不是 host——host 那条路径要先成功加载 pi，
   * 一旦 pi 出问题，模型下拉与 Key 录入会跟着一起失效。
   */
  models: WorkspaceModels
  currentDir: () => string | null
  broadcastAssetChanged: () => void
  /** 项目结构变更广播（project:changed）：渲染端刷新层级视图 */
  broadcastProjectChanged: () => void
  /** SuperAgent 任务事件广播（task:event）：token 状态推送 */
  broadcastTaskEvent: (event: TaskEvent) => void
  /** SuperAgent 运行器（IPC 与 Agent 派单工具共用同一条编排链） */
  superAgent: SuperAgentRunner
  mediaManager: MediaJobManager
  mediaContext: () => MediaContextReturnType
  requestMediaApproval: (
    kind: 'image' | 'video' | 'audio',
    info: MediaApprovalInfo,
    nodeId: string,
    signal: AbortSignal | undefined
  ) => Promise<boolean>
  /** MCP 桥接池（全局单例；chat: create 装配工具，settings 域管理配置） */
  mcpManager: McpManager
}

export {
  isNonEmptyString,
  asNodeRequest,
  invalidPayload,
  ok,
  describe,
  guardSync,
  guardAsync
}
