import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { HuabuApi } from '../shared/api'
import type { ChatEvent, MediaConfirmPayload, MediaJobStatus, WindowStateInfo } from '../shared/ipc'
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

const api: HuabuApi = {
  ping: () => ipcRenderer.invoke(IpcChannel.AppPing) as Promise<string>,

  version: () => ipcRenderer.invoke(IpcChannel.AppVersion),

  onEvent: (channel, listener) => subscribeRaw(channel, listener),

  window: {
    minimize: () => ipcRenderer.invoke(IpcChannel.WindowControl, 'minimize' as const).then(() => undefined),

    toggleMaximize: () =>
      ipcRenderer.invoke(IpcChannel.WindowControl, 'toggle-maximize' as const).then(() => undefined),

    close: () => ipcRenderer.invoke(IpcChannel.WindowControl, 'close' as const).then(() => undefined),

    isMaximized: async () => {
      const state = (await ipcRenderer.invoke(IpcChannel.WindowState)) as WindowStateInfo
      return state.maximized
    },

    onStateChange: (listener) =>
      subscribeRaw(IpcChannel.WindowStateChanged, (payload) => listener(payload as WindowStateInfo))
  },

  chat: {
    runtime: () => ipcRenderer.invoke(IpcChannel.ChatRuntime),

    create: (request) => ipcRenderer.invoke(IpcChannel.ChatCreate, request),

    prompt: (request) => ipcRenderer.invoke(IpcChannel.ChatPrompt, request),

    steer: (request) => ipcRenderer.invoke(IpcChannel.ChatSteer, request),

    abort: (request) => ipcRenderer.invoke(IpcChannel.ChatAbort, request),

    dispose: (request) => ipcRenderer.invoke(IpcChannel.ChatDispose, request),

    history: (request) => ipcRenderer.invoke(IpcChannel.ChatHistory, request),

    contextUsage: (request) => ipcRenderer.invoke(IpcChannel.ChatContextUsage, request),

    contextBreakdown: (request) => ipcRenderer.invoke(IpcChannel.ChatContextBreakdown, request),

    compact: (request) => ipcRenderer.invoke(IpcChannel.ChatCompact, request),

    fork: (request) => ipcRenderer.invoke(IpcChannel.ChatFork, request),

    setModel: (request) => ipcRenderer.invoke(IpcChannel.ChatSetModel, request),

    setThinking: (request) => ipcRenderer.invoke(IpcChannel.ChatSetThinking, request),

    onChatEvent: (nodeId, listener) => {
      ensureChatBridge()
      // 在桥接层就按 nodeId 过滤，组件里不必再判一次，也杜绝了跨节点串字的可能
      const wrapped: ChatListener = (event) => {
        if (event && event.nodeId === nodeId) listener(event)
      }
      chatListeners.add(wrapped)
      return () => {
        chatListeners.delete(wrapped)
      }
    }
  },

  workspace: {
    state: () => ipcRenderer.invoke(IpcChannel.WorkspaceState),

    openDialog: () => ipcRenderer.invoke(IpcChannel.WorkspaceOpenDialog),

    openPath: (path) => ipcRenderer.invoke(IpcChannel.WorkspaceOpenPath, { path }),

    create: (name) => ipcRenderer.invoke(IpcChannel.WorkspaceCreate, { name }),

    files: () => ipcRenderer.invoke(IpcChannel.WorkspaceFiles),

    readFile: (relPath) => ipcRenderer.invoke(IpcChannel.WorkspaceReadFile, { relPath }),

    writeFile: (relPath, content) => ipcRenderer.invoke(IpcChannel.WorkspaceWriteFile, { relPath, content }),

    reveal: (relPath) => ipcRenderer.invoke(IpcChannel.WorkspaceReveal, { relPath }),

    saveCanvas: (snapshot) => ipcRenderer.invoke(IpcChannel.WorkspaceCanvasSave, snapshot),

    loadCanvas: () => ipcRenderer.invoke(IpcChannel.WorkspaceCanvasLoad),

    setDefaultModel: (modelId) => ipcRenderer.invoke(IpcChannel.WorkspaceSetDefaultModel, { modelId })
  },

  settings: {
    chatProviders: () => ipcRenderer.invoke(IpcChannel.SettingsChatProviders),

    setApiKey: (providerId, apiKey) =>
      ipcRenderer.invoke(IpcChannel.SettingsSetApiKey, { providerId, apiKey }),

    removeApiKey: (providerId) => ipcRenderer.invoke(IpcChannel.SettingsRemoveApiKey, { providerId }),

    testProvider: (providerId) => ipcRenderer.invoke(IpcChannel.SettingsTestProvider, { providerId }),

    customAddModel: (input) => ipcRenderer.invoke(IpcChannel.SettingsCustomAddModel, input),

    customAddProvider: (input) => ipcRenderer.invoke(IpcChannel.SettingsCustomAddProvider, input),

    customRemoveProvider: (providerId) =>
      ipcRenderer.invoke(IpcChannel.SettingsCustomRemoveProvider, { providerId }),

    mediaStatus: () => ipcRenderer.invoke(IpcChannel.SettingsMediaStatus),

    mediaSetKey: (providerId, apiKey) =>
      ipcRenderer.invoke(IpcChannel.SettingsMediaSetKey, { providerId, apiKey }),

    mediaRemoveKey: (providerId) => ipcRenderer.invoke(IpcChannel.SettingsMediaRemoveKey, { providerId }),

    modelsList: (providerId) => ipcRenderer.invoke(IpcChannel.SettingsModelsList, { providerId }),

    modelEdit: (input) => ipcRenderer.invoke(IpcChannel.SettingsModelEdit, input),

    modelRemove: (providerId, modelId) =>
      ipcRenderer.invoke(IpcChannel.SettingsModelRemove, { providerId, modelId }),

    modelRestore: (providerId, modelId) =>
      ipcRenderer.invoke(IpcChannel.SettingsModelRestore, { providerId, modelId }),

    mcpStatus: () => ipcRenderer.invoke(IpcChannel.SettingsMcpStatus),

    mcpSet: (request) => ipcRenderer.invoke(IpcChannel.SettingsMcpSet, request),

    skillsList: () => ipcRenderer.invoke(IpcChannel.SettingsSkillsList),

    skillsSetDisabled: (request) => ipcRenderer.invoke(IpcChannel.SettingsSkillsSetDisabled, request),

    onMcpStatus: (listener) => subscribeRaw(IpcChannel.McpStatusEvent, () => listener())
  },

  media: {
    providers: () => ipcRenderer.invoke(IpcChannel.MediaProviders),

    generate: (request) => ipcRenderer.invoke(IpcChannel.MediaGenerate, request),

    cancel: (jobId) => ipcRenderer.invoke(IpcChannel.MediaCancel, { jobId }),

    jobs: () => ipcRenderer.invoke(IpcChannel.MediaJobs),

    import: (request) => ipcRenderer.invoke(IpcChannel.MediaImport, request),

    setConfirmVideo: (confirm) => ipcRenderer.invoke(IpcChannel.MediaSetConfirmVideo, { confirm }),

    setConfig: (patch) => ipcRenderer.invoke(IpcChannel.MediaSetConfig, patch),

    userAddProvider: (input) => ipcRenderer.invoke(IpcChannel.MediaUserAddProvider, input),

    userRemoveProvider: (providerId) =>
      ipcRenderer.invoke(IpcChannel.MediaUserRemoveProvider, { providerId }),

    userAddModel: (input) => ipcRenderer.invoke(IpcChannel.MediaUserAddModel, input),

    userRemoveModel: (providerId, modelId) =>
      ipcRenderer.invoke(IpcChannel.MediaUserRemoveModel, { providerId, modelId }),

    userRestoreModel: (providerId, modelId) =>
      ipcRenderer.invoke(IpcChannel.MediaUserRestoreModel, { providerId, modelId }),

    browseCatalog: (providerId) => ipcRenderer.invoke(IpcChannel.MediaBrowseCatalog, { providerId }),

    onJobEvent: (listener) =>
      subscribeRaw(IpcChannel.MediaJobEvent, (payload) => listener(payload as MediaJobStatus)),

    onConfirmRequest: (listener) =>
      subscribeRaw(IpcChannel.MediaConfirmRequest, (payload) => listener(payload as MediaConfirmPayload)),

    onConfirmResolved: (listener) =>
      subscribeRaw(IpcChannel.MediaConfirmResolvedEvent, (payload) => listener(payload as { requestId: string })),

    resolveConfirm: (requestId, accepted) =>
      ipcRenderer.invoke(IpcChannel.MediaConfirmResolve, { requestId, accepted }),

    setAccessMode: (mode) => ipcRenderer.invoke(IpcChannel.MediaSetAccessMode, { mode }),

    /**
     * 拖拽/文件选择进来的 File 对象反查磁盘路径（webUtils），让主进程直接拷贝，
     * 不必把媒体字节整个搬过 IPC。纯浏览器环境（无 Electron）返回 undefined。
     *
     * 安全约束：这里是渲染端拿到「File → 真路径」的唯一出口。解析成功即 fire-and-forget
     * send 登记给主进程（workspace:source-path-registered），导入类 handler 用
     * consumeSourcePath 校验「确经拖拽」——否则被攻破的渲染端可伪造任意路径让主进程复制。
     * 同一渲染进程的 send 先于后续 invoke 到达（IPC 消息保序），登记不会晚于导入校验。
     */
    pathForFile: (file: File): string | undefined => {
      try {
        const path = webUtils.getPathForFile(file)
        if (path) {
          ipcRenderer.send(IpcChannel.WorkspaceSourcePathRegistered, path)
        }
        return path
      } catch {
        return undefined
      }
    }
  },

  asset: {
    importCanvas: (request) => ipcRenderer.invoke(IpcChannel.AssetImportCanvas, request),

    importTemp: (request) => ipcRenderer.invoke(IpcChannel.AssetImportTemp, request),

    libraries: () => ipcRenderer.invoke(IpcChannel.AssetLibraries),

    createLibrary: (name) => ipcRenderer.invoke(IpcChannel.AssetLibraryCreate, { name }),

    removeLibrary: (id) => ipcRenderer.invoke(IpcChannel.AssetLibraryRemove, { id }),

    transfer: (request) => ipcRenderer.invoke(IpcChannel.AssetTransfer, request),

    setTags: (relPath, tags) => ipcRenderer.invoke(IpcChannel.AssetSetTags, { relPath, tags }),

    deleteAsset: (relPath) => ipcRenderer.invoke(IpcChannel.AssetDelete, { relPath }),

    renameAsset: (relPath, newName) => ipcRenderer.invoke(IpcChannel.AssetRename, { relPath, newName }),

    onChanged: (listener) => subscribeRaw(IpcChannel.AssetChanged, () => listener())
  }
}

contextBridge.exposeInMainWorld('huabu', api)
