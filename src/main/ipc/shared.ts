/**
 * IPC 各域共享的载荷校验助手、结果包装、跨窗口广播与依赖上下文。
 *
 * 自 src/main/ipc.ts 拆出（实现原样搬移）：
 * - 校验/包装助手：isNonEmptyString / asNodeRequest / invalidPayload / ok / describe / guardSync / guardAsync
 * - 广播：chat:event（AgentHost 的 onUpdate 回调）、asset:changed、media:job
 * - IpcContext：编排器（src/main/ipc.ts）组装后注入各域注册函数的依赖上下文
 *
 * 安全约定：渲染进程发来的载荷一律按「不可信输入」处理，先做形状校验再交给服务层。
 * 事件广播前检查 webContents 是否已销毁，否则关窗瞬间会抛错。
 */
import { BrowserWindow } from 'electron'
import type { AgentHost } from '../agent/host'
import type { WorkspaceStore } from '../workspace/store'
import type { MediaJobManager } from '../media/manager'
import type { MediaApprovalInfo } from '../agent/mediaTools'
import type { McpManager } from '../mcp/manager'
import type { MediaContextReturnType } from './media'
import {
  IpcChannel,
  type ChatEvent,
  type ChatNodeRequest,
  type ChatResult,
  type MediaJobStatus
} from '../../shared/ipc'

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

/** chat:event 广播：作为 AgentHost 的 onUpdate 回调传入（见 src/main/ipc.ts 编排器） */
export function broadcastChatEvent(event: ChatEvent): void {
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

/** 素材目录变更广播（import/建库/删库后渲染端刷新素材库面板与目录约定） */
export function broadcastAssetChanged(): void {
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

export function broadcastMediaJob(job: MediaJobStatus): void {
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
  host: AgentHost
  currentDir: () => string | null
  broadcastAssetChanged: () => void
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
