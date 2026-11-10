/**
 * HuabuApi 的**唯一实现**（preload 与 Web 桥共用）。
 *
 * 传输层经 `ApiRuntime` 注入：
 * - preload：invoke = ipcRenderer.invoke，subscribe = 原生事件通道
 * - Web 桥：invoke = POST /invoke，subscribe = WebSocket
 *
 * 这样「方法名 / 参数形状 / channel 绑定」只写一次，两边永不漂移。
 */
import type { HuabuApi } from '../shared/api'
import type {
  ChatEvent,
  MediaConfirmPayload,
  MediaJobStatus,
  ProjectSnapshotRequest,
  WindowStateInfo,
} from '../shared/ipc'
import { IpcChannel } from '../shared/ipc'

export interface ApiRuntime {
  /** 对应 ipcRenderer.invoke(channel, payload)；泛型仅为类型推导，实现无需关心 */
  invoke: <T = unknown>(channel: string, payload?: unknown) => Promise<T>
  /** 对应事件订阅；返回取消函数 */
  subscribe: (channel: string, listener: (payload: unknown) => void) => () => void
  /** 拖拽文件的真实路径解析（Web 端不支持，返回 null） */
  pathForFile?: (file: File) => string | null
}

export function createHuabuApi(runtime: ApiRuntime): HuabuApi {
  const { invoke, subscribe } = runtime

  const api: HuabuApi = {
    ping: () => invoke(IpcChannel.AppPing) as Promise<string>,

    version: () => invoke(IpcChannel.AppVersion),

    onEvent: (channel, listener) => subscribe(channel, listener),

    window: {
      minimize: () => invoke(IpcChannel.WindowControl, 'minimize' as const).then(() => undefined),

      toggleMaximize: () =>
        invoke(IpcChannel.WindowControl, 'toggle-maximize' as const).then(() => undefined),

      close: () => invoke(IpcChannel.WindowControl, 'close' as const).then(() => undefined),

      isMaximized: async () => {
        const state = (await invoke(IpcChannel.WindowState)) as WindowStateInfo
        return state.maximized
      },

      onStateChange: (listener) =>
        subscribe(IpcChannel.WindowStateChanged, (payload) => listener(payload as WindowStateInfo))
    },

    chat: {
      runtime: () => invoke(IpcChannel.ChatRuntime),

      create: (request) => invoke(IpcChannel.ChatCreate, request),

      prompt: (request) => invoke(IpcChannel.ChatPrompt, request),

      steer: (request) => invoke(IpcChannel.ChatSteer, request),

      abort: (request) => invoke(IpcChannel.ChatAbort, request),

      dispose: (request) => invoke(IpcChannel.ChatDispose, request),

      history: (request) => invoke(IpcChannel.ChatHistory, request),

      contextUsage: (request) => invoke(IpcChannel.ChatContextUsage, request),


      compact: (request) => invoke(IpcChannel.ChatCompact, request),

      fork: (request) => invoke(IpcChannel.ChatFork, request),

      setModel: (request) => invoke(IpcChannel.ChatSetModel, request),

      setThinking: (request) => invoke(IpcChannel.ChatSetThinking, request),

      onChatEvent: (nodeId, listener) => {
        // 在工厂层就按 nodeId 过滤：组件里不必再判一次，也杜绝跨节点串字
        return subscribe(IpcChannel.ChatEvent, (payload) => {
          const event = payload as ChatEvent
          if (event && event.nodeId === nodeId) listener(event)
        })
      }
    },

    workspace: {
      state: () => invoke(IpcChannel.WorkspaceState),

      openDialog: () => invoke(IpcChannel.WorkspaceOpenDialog),

      openPath: (path) => invoke(IpcChannel.WorkspaceOpenPath, { path }),

      create: (name) => invoke(IpcChannel.WorkspaceCreate, { name }),

      deleteWorkspaces: (paths) => invoke(IpcChannel.WorkspaceDelete, { paths }),

      files: () => invoke(IpcChannel.WorkspaceFiles),

      readFile: (relPath) => invoke(IpcChannel.WorkspaceReadFile, { relPath }),

      writeFile: (relPath, content) => invoke(IpcChannel.WorkspaceWriteFile, { relPath, content }),

      reveal: (relPath) => invoke(IpcChannel.WorkspaceReveal, { relPath }),

      saveCanvas: (snapshot) => invoke(IpcChannel.WorkspaceCanvasSave, snapshot),

      loadCanvas: () => invoke(IpcChannel.WorkspaceCanvasLoad),

      setDefaultModel: (modelId) => invoke(IpcChannel.WorkspaceSetDefaultModel, { modelId })
    },

    /** 项目结构（原型 index-projects.html）：层级 / 节点 / 状态 / 提示词继承 */
    project: {
      snapshot: (request?: ProjectSnapshotRequest) =>
        invoke(IpcChannel.ProjectSnapshot, request ?? {}),
      create: (request: { name: string; kind?: string; id?: string }) =>
        invoke(IpcChannel.ProjectCreate, request),
      activate: (projectId: string) => invoke(IpcChannel.ProjectActivate, { projectId }),
      delete: (projectId: string) => invoke(IpcChannel.ProjectDelete, { projectId }),
      update: (projectId: string, patch: Record<string, unknown>) =>
        invoke(IpcChannel.ProjectUpdate, { projectId, patch }),
      addNode: (projectId: string, node: Record<string, unknown>) =>
        invoke(IpcChannel.ProjectAddNode, { projectId, node }),
      patchNode: (projectId: string, nodeId: string, patch: Record<string, unknown>) =>
        invoke(IpcChannel.ProjectPatchNode, { projectId, nodeId, patch }),
      removeNode: (projectId: string, nodeId: string) =>
        invoke(IpcChannel.ProjectRemoveNode, { projectId, nodeId }),
      reorder: (projectId: string, parentId: string | null, orderedIds: string[]) =>
        invoke(IpcChannel.ProjectReorder, { projectId, parentId, orderedIds }),
      /** 结构变更订阅（返回取消函数） */
      onChanged: (listener: () => void) => subscribe(IpcChannel.ProjectChanged, () => listener())
    },

    settings: {
      chatProviders: () => invoke(IpcChannel.SettingsChatProviders),

      setApiKey: (providerId, apiKey) =>
        invoke(IpcChannel.SettingsSetApiKey, { providerId, apiKey }),

      removeApiKey: (providerId) => invoke(IpcChannel.SettingsRemoveApiKey, { providerId }),

      testProvider: (providerId) => invoke(IpcChannel.SettingsTestProvider, { providerId }),

      customAddModel: (input) => invoke(IpcChannel.SettingsCustomAddModel, input),

      customAddProvider: (input) => invoke(IpcChannel.SettingsCustomAddProvider, input),

      customRemoveProvider: (providerId) =>
        invoke(IpcChannel.SettingsCustomRemoveProvider, { providerId }),

      mediaStatus: () => invoke(IpcChannel.SettingsMediaStatus),

      mediaSetKey: (providerId, apiKey) =>
        invoke(IpcChannel.SettingsMediaSetKey, { providerId, apiKey }),

      mediaRemoveKey: (providerId) => invoke(IpcChannel.SettingsMediaRemoveKey, { providerId }),

      modelsList: (providerId) => invoke(IpcChannel.SettingsModelsList, { providerId }),

      modelEdit: (input) => invoke(IpcChannel.SettingsModelEdit, input),

      modelRemove: (providerId, modelId) =>
        invoke(IpcChannel.SettingsModelRemove, { providerId, modelId }),

      modelRestore: (providerId, modelId) =>
        invoke(IpcChannel.SettingsModelRestore, { providerId, modelId }),

      mcpStatus: () => invoke(IpcChannel.SettingsMcpStatus),

      mcpSet: (request) => invoke(IpcChannel.SettingsMcpSet, request),

      skillsList: () => invoke(IpcChannel.SettingsSkillsList),

      skillsSetDisabled: (request) => invoke(IpcChannel.SettingsSkillsSetDisabled, request),

      onMcpStatus: (listener) => subscribe(IpcChannel.McpStatusEvent, () => listener())
    },

    media: {
      providers: () => invoke(IpcChannel.MediaProviders),

      generate: (request) => invoke(IpcChannel.MediaGenerate, request),

      cancel: (jobId) => invoke(IpcChannel.MediaCancel, { jobId }),

      jobs: () => invoke(IpcChannel.MediaJobs),

      import: (request) => invoke(IpcChannel.MediaImport, request),

      setConfirmVideo: (confirm) => invoke(IpcChannel.MediaSetConfirmVideo, { confirm }),

      setConfig: (patch) => invoke(IpcChannel.MediaSetConfig, patch),

      userAddProvider: (input) => invoke(IpcChannel.MediaUserAddProvider, input),

      userRemoveProvider: (providerId) =>
        invoke(IpcChannel.MediaUserRemoveProvider, { providerId }),

      userAddModel: (input) => invoke(IpcChannel.MediaUserAddModel, input),

      userRemoveModel: (providerId, modelId) =>
        invoke(IpcChannel.MediaUserRemoveModel, { providerId, modelId }),

      userRestoreModel: (providerId, modelId) =>
        invoke(IpcChannel.MediaUserRestoreModel, { providerId, modelId }),

      browseCatalog: (providerId) => invoke(IpcChannel.MediaBrowseCatalog, { providerId }),

      adapterKinds: () => invoke(IpcChannel.MediaAdapterKinds),

      onJobEvent: (listener) =>
        subscribe(IpcChannel.MediaJobEvent, (payload) => listener(payload as MediaJobStatus)),

      onConfirmRequest: (listener) =>
        subscribe(IpcChannel.MediaConfirmRequest, (payload) => listener(payload as MediaConfirmPayload)),

      onConfirmResolved: (listener) =>
        subscribe(IpcChannel.MediaConfirmResolvedEvent, (payload) => listener(payload as { requestId: string })),

      resolveConfirm: (requestId, accepted) =>
        invoke(IpcChannel.MediaConfirmResolve, { requestId, accepted }),

      setAccessMode: (mode) => invoke(IpcChannel.MediaSetAccessMode, { mode }),

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
        // 纯浏览器环境无真实路径（runtime.pathForFile 缺省返回 null）
        return runtime.pathForFile?.(file) ?? undefined
      }
    },

    asset: {
      importCanvas: (request) => invoke(IpcChannel.AssetImportCanvas, request),

      importTemp: (request) => invoke(IpcChannel.AssetImportTemp, request),

      libraries: () => invoke(IpcChannel.AssetLibraries),

      createLibrary: (name) => invoke(IpcChannel.AssetLibraryCreate, { name }),

      removeLibrary: (id) => invoke(IpcChannel.AssetLibraryRemove, { id }),

      transfer: (request) => invoke(IpcChannel.AssetTransfer, request),

      setTags: (relPath, tags) => invoke(IpcChannel.AssetSetTags, { relPath, tags }),

      setFacet: (relPath, facet) => invoke(IpcChannel.AssetSetFacet, { relPath, facet }),

      setFacets: (entries) => invoke(IpcChannel.AssetSetFacetsBulk, { entries }),

      setFacetSchema: (schemaId) => invoke(IpcChannel.AssetSetFacetSchema, { schemaId }),

      saveFacetSchema: (schema, activate) => invoke(IpcChannel.AssetSaveFacetSchema, { schema, activate }),

      deleteFacetSchema: (schemaId) => invoke(IpcChannel.AssetDeleteFacetSchema, { schemaId }),

      deleteAsset: (relPath) => invoke(IpcChannel.AssetDelete, { relPath }),

      renameAsset: (relPath, newName) => invoke(IpcChannel.AssetRename, { relPath, newName }),

      onChanged: (listener) => subscribe(IpcChannel.AssetChanged, () => listener())
    }
  }

  return api
}
