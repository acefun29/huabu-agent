import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { createHuabuApi } from '../shared/apiFactory'
import type { ChatEvent } from '../shared/ipc'
import { IpcChannel } from '../shared/ipc'

/**
 * 渲染进程唯一的原生能力入口。
 *
 * 安全约束：contextIsolation 开启、nodeIntegration 关闭，
 * 渲染进程拿不到 ipcRenderer / require，只能通过 window.huabu 调用这里显式暴露的方法。
 */

/**
 * 允许渲染进程订阅的事件通道白名单。
 * 新增事件通道时必须在此登记，否则订阅直接抛错（docs/ipc-contract.md 硬性约束 2）。
 */
const EVENT_CHANNEL_ALLOWLIST: readonly string[] = [
  IpcChannel.ChatEvent,
  IpcChannel.MediaJobEvent,
  IpcChannel.MediaConfirmRequest,
  IpcChannel.MediaConfirmResolvedEvent,
  IpcChannel.McpStatusEvent,
  IpcChannel.AssetChanged,
  IpcChannel.WindowStateChanged
]

function assertChannelAllowed(channel: string): void {
  if (!EVENT_CHANNEL_ALLOWLIST.includes(channel)) {
    throw new Error(`[huabu] 未登记的事件通道，禁止订阅: ${channel}`)
  }
}

/** 订阅一条事件通道，返回取消订阅函数 */
function subscribeRaw(channel: string, handler: (payload: unknown) => void): () => void {
  assertChannelAllowed(channel)
  const listener = (_event: IpcRendererEvent, payload: unknown): void => {
    handler(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/* -------------------------------------------------------------------------- */
/* chat:event 多路复用                                                          */
/*                                                                            */
/* 每个会话节点都要订阅事件流。若给每个节点各挂一个 ipcRenderer.on，             */
/* 节点数超过 10 个就会触发 EventEmitter 的 MaxListenersExceededWarning，        */
/* 而且每份载荷会被重复反序列化 N 次。这里对 chat:event 只保留一个底层监听器，    */
/* 由订阅者集合按 nodeId 自行分发。                                              */
/* -------------------------------------------------------------------------- */

type ChatListener = (event: ChatEvent) => void

const chatListeners = new Set<ChatListener>()
let chatBridgeInstalled = false

function ensureChatBridge(): void {
  if (chatBridgeInstalled) return
  chatBridgeInstalled = true
  subscribeRaw(IpcChannel.ChatEvent, (payload) => {
    const event = payload as ChatEvent
    for (const listener of chatListeners) {
      try {
        listener(event)
      } catch (error) {
        // 单个节点的监听器抛错不能影响其他节点，否则一个坏节点会让所有会话停止刷新
        console.error('[huabu] chat:event 监听器执行失败', error)
      }
    }
  })
}


const api = createHuabuApi({
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  /**
   * chat:event 走单监听器 + 本地多路分发：节点多时避免 N 个 ipcRenderer 监听器
   * 触发 MaxListenersExceededWarning，也避免同一载荷被重复反序列化 N 次。
   * 其余通道一对一订阅即可。
   */
  subscribe: (channel, listener) => {
    if (channel !== IpcChannel.ChatEvent) return subscribeRaw(channel, listener)
    ensureChatBridge()
    const wrapped = listener as ChatListener
    chatListeners.add(wrapped)
    return () => chatListeners.delete(wrapped)
  },
  pathForFile: (file) => {
    const path = webUtils.getPathForFile(file)
    // 解析成功即登记给主进程（导入 handler 用 consumeSourcePath 校验「确经拖拽」）
    if (path) ipcRenderer.send(IpcChannel.WorkspaceSourcePathRegistered, path)
    return path
  }
})

contextBridge.exposeInMainWorld('huabu', api)
