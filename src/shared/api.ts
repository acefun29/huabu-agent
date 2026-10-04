import type {
  AppVersionInfo,
  AssetImportRequest,
  AssetImportResult,
  AssetLibrariesInfo,
  AssetLibrary,
  AssetRenameResult,
  AssetTransferRequest,
  AssetTransferResult,
  ChatContextBreakdownInfo,
  ChatContextUsage,
  ChatCreateInfo,
  ChatCreateRequest,
  ChatEvent,
  ChatForkRequest,
  ChatForkResult,
  ChatHistoryInfo,
  ChatNodeRequest,
  ChatPromptRequest,
  ChatResult,
  ChatRuntimeInfo,
  ChatSetModelRequest,
  ChatSetModelResult,
  ChatSetThinkingRequest,
  ChatSetThinkingResult,
  ChatSteerRequest,
  CustomModelInput,
  CustomProviderInput,
  MediaAccessMode,
  MediaSettingsStatus,
  ManagedModelInfo,
  ModelEditInput,
  MediaConfirmPayload,
  MediaConfigPatch,
  MediaCatalogBrowseItem,
  MediaGenerateRequest,
  MediaImportRequest,
  MediaImportResult,
  MediaJobStatus,
  MediaProviderInfo,
  MediaUserModelInput,
  MediaUserProviderInput,
  ProviderTestResult,
  SettingsProvidersInfo,
  SettingsMcpSetRequest,
  SettingsMcpStatusResult,
  SettingsSkillsListResult,
  SettingsSkillsSetDisabledRequest,
  WorkspaceFileInfo,
  WorkspaceReadFileResult,
  WorkspaceInfo,
  WorkspaceOpenResult,
  WorkspaceDeleteResult,
  WorkspaceStateInfo,
  CanvasSnapshot,
  WindowStateInfo
} from './ipc'

/**
 * 渲染进程可用的全部能力（window.huabu）。
 *
 * 约束：渲染进程只能经由这里定义的接口与主进程通信，
 * 不允许出现第二个全局入口，也不允许直接 import 任何 electron / pi 包。
 * 所有 Agent 相关的类型都来自 src/shared/ipc.ts 里桥接层自定义的结构。
 */
export interface HuabuApi {
  /** 联通性自检，返回 'pong' */
  ping(): Promise<string>

  /** 运行时版本信息（Electron / Node / Chromium / 应用版本） */
  version(): Promise<AppVersionInfo>

  /**
   * 订阅主进程推送的事件，返回取消订阅函数。
   * 通道白名单见 preload 实现，未登记的通道订阅会直接抛错。
   */
  onEvent(channel: string, listener: (payload: unknown) => void): () => void

  /** 窗口控制能力（自绘标题栏）：无边框窗口的最小化/最大化/关闭 */
  window: WindowApi

  /** Agent 会话能力（M3，M9 扩展模型切换与历史回放） */
  chat: ChatApi

  /** 工作区能力（M5 扩展）：一个工作区一张画布 */
  workspace: WorkspaceApi

  /** 设置能力（M9 扩展）：provider 清单与凭据管理 */
  settings: SettingsApi

  /** 媒体能力（M11/M12）：生成任务编排、导入、播放 */
  media: MediaApi

  /** 素材能力（新原型同步）：分类归档、临时 inbox、素材库映射 */
  asset: AssetApi
}

/**
 * 窗口控制桥（自绘标题栏）。
 * frame:false 之后渲染进程接管最小化/最大化/关闭入口，动作经主进程执行。
 */
export interface WindowApi {
  /** 最小化窗口 */
  minimize(): Promise<void>

  /** 最大化 / 还原切换 */
  toggleMaximize(): Promise<void>

  /** 关闭窗口 */
  close(): Promise<void>

  /** 查询当前是否最大化 */
  isMaximized(): Promise<boolean>

  /** 订阅最大化状态变化，返回取消订阅函数 */
  onStateChange(listener: (state: WindowStateInfo) => void): () => void
}

/**
 * Agent 会话桥。
 *
 * 生命周期约定：一个画布节点对应一个会话，create 之后才能 prompt，
 * 节点关闭时必须 dispose（主进程会 abort + unsubscribe + 移出注册表）。
 * 业务失败一律通过 `ChatResult.ok === false` 表达，不靠抛异常。
 */
export interface ChatApi {
  /**
   * 查询运行时状态与可用模型。
   * 返回的认证信息只含「是否已配置 / 来源 / 环境变量名」，不含任何密钥内容。
   */
  runtime(): Promise<ChatResult<ChatRuntimeInfo>>

  /** 为画布节点创建会话；带 sessionFile 时重绑已有会话（画布恢复） */
  create(request: ChatCreateRequest): Promise<ChatResult<ChatCreateInfo>>

  /** 发问。流式结果不走返回值，而是经 chat:event 推送 */
  prompt(request: ChatPromptRequest): Promise<ChatResult>

  /** 生成中插话引导，不打断当前流 */
  steer(request: ChatSteerRequest): Promise<ChatResult>

  /** 中止当前生成；会话随后可继续使用 */
  abort(request: ChatNodeRequest): Promise<ChatResult>

  /** 解绑并释放会话 */
  dispose(request: ChatNodeRequest): Promise<ChatResult>

  /** 按会话文件回放历史消息（结构化：blocks/图片缩略/压缩分界/inContext 标记） */
  history(request: { nodeId: string; sessionFile: string }): Promise<ChatResult<ChatHistoryInfo>>

  /** 查询会话当前上下文水位（tokens=null 如实透传，UI 显示"—"） */
  contextUsage(request: ChatNodeRequest): Promise<ChatResult<ChatContextUsage>>

  /** 查询上下文占用分布（分桶估算；估算值非账单） */
  contextBreakdown(request: ChatNodeRequest): Promise<ChatResult<ChatContextBreakdownInfo>>

  /**
   * 手动压缩上下文。SDK 语义：先 abort 当前 agent 操作且不续跑被打断的 turn，
   * 所以渲染端必须在 running 时禁用入口；压缩进度经 compaction_start/end 事件推送。
   */
  compact(request: ChatNodeRequest): Promise<ChatResult>

  /** 原生文件级分叉：全量拷贝源 JSONL（含多模态与工具上下文），返回新 sessionFile */
  fork(request: ChatForkRequest): Promise<ChatResult<ChatForkResult>>

  /** 会话中途切换模型（返回换后模型与 clamp 出的实际思考档位） */
  setModel(request: ChatSetModelRequest): Promise<ChatResult<ChatSetModelResult>>

  /** 会话中途设置思考档位（返回 clamp 后实际生效档位） */
  setThinking(request: ChatSetThinkingRequest): Promise<ChatResult<ChatSetThinkingResult>>

  /**
   * 订阅指定节点的事件流，返回取消订阅函数。
   * 这是 onEvent 的类型化包装，内部仍走同一条白名单通道。
   */
  onChatEvent(nodeId: string, listener: (event: ChatEvent) => void): () => void
}

/** 工作区 API（M5 扩展） */
export interface WorkspaceApi {
  /** 当前工作区与最近列表 */
  state(): Promise<WorkspaceStateInfo>

  /** 弹出系统目录选择框，选中即切换（旧工作区会话被 dispose） */
  openDialog(): Promise<WorkspaceOpenResult>

  /** 按路径打开/切换工作区（最近列表点击） */
  openPath(path: string): Promise<ChatResult<{ workspace: WorkspaceInfo; disposedSessions: number }>>

  /** 在工作区根目录下新建子目录并切换（「新建工作区」） */
  create(name: string): Promise<ChatResult<{ workspace: WorkspaceInfo }>>

  /**
   * 批量删除工作区：目录移入系统回收站并移出最近列表。
   * 当前打开的工作区与最近列表外的路径由主进程拒绝；逐条失败不影响其余条目。
   */
  deleteWorkspaces(paths: string[]): Promise<ChatResult<WorkspaceDeleteResult>>

  /** 列出工作区内可导入文件（跳过 .huabu/.git/node_modules，按修改时间倒序） */
  files(): Promise<ChatResult<WorkspaceFileInfo[]>>

  /** 读取工作区内文本文件（doc/code 上下文注入用，有白名单与大小上限） */
  readFile(relPath: string): Promise<ChatResult<WorkspaceReadFileResult>>

  /** 写工作区内文本文件（md 笔记编辑保存/新建；白名单 .md/.txt，原子写） */
  writeFile(relPath: string, content: string): Promise<ChatResult<{ relPath: string; bytes: number }>>

  /** 在系统文件管理器中显示工作区内的文件 */
  reveal(relPath: string): Promise<ChatResult>

  /** 画布快照落盘（原子写） */
  saveCanvas(snapshot: CanvasSnapshot): Promise<ChatResult>

  /** 读取画布快照；从未保存过时返回 null */
  loadCanvas(): Promise<ChatResult<CanvasSnapshot | null>>

  /** 修改工作区默认聊天模型（只影响新建会话） */
  setDefaultModel(modelId: string | null): Promise<ChatResult<WorkspaceInfo>>
}

/** 设置 API（M9 扩展） */
export interface SettingsApi {
  /** 聊天 provider 清单与认证状态（不含密钥） */
  chatProviders(): Promise<ChatResult<SettingsProvidersInfo>>

  /** 录入 provider 的 API Key（safeStorage 加密落盘，按工作区隔离，无需重启） */
  setApiKey(providerId: string, apiKey: string): Promise<ChatResult>

  /** 删除 provider 的已存凭据 */
  removeApiKey(providerId: string): Promise<ChatResult>

  /** provider 连通性自检（认证检查 + 最小请求） */
  testProvider(providerId: string): Promise<ChatResult<ProviderTestResult>>

  /** 在某供应商下新增自定义模型（写入后重注册生效） */
  customAddModel(input: CustomModelInput): Promise<ChatResult>

  /** 新增自定义供应商（OpenAI 兼容 baseUrl） */
  customAddProvider(input: CustomProviderInput): Promise<ChatResult>

  /** 删除自定义供应商（连同其模型） */
  customRemoveProvider(providerId: string): Promise<ChatResult>

  /** 媒体设置状态（确认闸门 + provider Key 来源） */
  mediaStatus(): Promise<ChatResult<MediaSettingsStatus>>

  /** 录入媒体网关 Key（加密存储） */
  mediaSetKey(providerId: string, apiKey: string): Promise<ChatResult>

  /** 删除媒体网关 Key */
  mediaRemoveKey(providerId: string): Promise<ChatResult>

  /** 供应商模型管理清单（内置+自定义合并） */
  modelsList(providerId: string): Promise<ChatResult<ManagedModelInfo[]>>

  /** 编辑模型（自定义=改条目；内置=写 modelOverrides） */
  modelEdit(input: ModelEditInput): Promise<ChatResult>

  /** 删除模型（自定义=删条目；内置=隐藏，可恢复） */
  modelRemove(providerId: string, modelId: string): Promise<ChatResult>

  /** 恢复被隐藏的内置模型 */
  modelRestore(providerId: string, modelId: string): Promise<ChatResult>

  /** MCP 服务器清单 + 连接运行态（全局配置，不依赖工作区） */
  mcpStatus(): Promise<ChatResult<SettingsMcpStatusResult>>

  /** 整表替换 MCP 服务器配置（落盘 + 同步连接池），返回最新运行态 */
  mcpSet(request: SettingsMcpSetRequest): Promise<ChatResult<SettingsMcpStatusResult>>

  /** 工作区技能清单（扫描 .huabu/skills/；需要已打开工作区） */
  skillsList(): Promise<ChatResult<SettingsSkillsListResult>>

  /** 设置被禁用技能名单（写 workspace.json；影响之后新建的会话） */
  skillsSetDisabled(request: SettingsSkillsSetDisabledRequest): Promise<ChatResult>

  /** MCP 服务器连接状态变化事件（触发后应重新拉 mcpStatus 刷新徽章） */
  onMcpStatus(listener: () => void): () => void
}

/** 媒体 API（M11/M12） */
export interface MediaApi {
  /** 可用 provider 与模型清单 */
  providers(): Promise<ChatResult<MediaProviderInfo[]>>

  /** 提交生成任务；进度经 media:job 事件推送 */
  generate(request: MediaGenerateRequest): Promise<ChatResult<{ jobId: string }>>

  /** 取消任务 */
  cancel(jobId: string): Promise<ChatResult>

  /** 近期任务清单（画布恢复对账用） */
  jobs(): Promise<ChatResult<MediaJobStatus[]>>

  /** 导入 OS 媒体文件（拷入工作区产物目录） */
  import(request: MediaImportRequest): Promise<ChatResult<MediaImportResult>>

  /** 设置视频生成确认闸门 */
  setConfirmVideo(confirm: boolean): Promise<ChatResult>

  /** 更新媒体生成默认配置（provider/模型/输出目录/并发/默认比例时长，写 workspace.json） */
  setConfig(patch: MediaConfigPatch): Promise<ChatResult>

  /** 新增用户供应商（带首个模型；写 media.userProviders，立即生效） */
  userAddProvider(input: MediaUserProviderInput): Promise<ChatResult>

  /** 删除用户供应商（内置同名条目不受影响） */
  userRemoveProvider(providerId: string): Promise<ChatResult>

  /** 给供应商添加模型（内置供应商经同名用户条目覆盖） */
  userAddModel(input: MediaUserModelInput): Promise<ChatResult>

  /** 移除模型（用户模型删除；内置模型进隐藏清单） */
  userRemoveModel(providerId: string, modelId: string): Promise<ChatResult>

  /** 恢复被隐藏的内置模型 */
  userRestoreModel(providerId: string, modelId: string): Promise<ChatResult>

  /** 浏览该供应商的全量模型目录（设置页「浏览完整模型库」；无目录的供应商返回空数组） */
  browseCatalog(providerId: string): Promise<ChatResult<MediaCatalogBrowseItem[]>>

  /** 订阅任务状态事件，返回取消订阅函数 */
  onJobEvent(listener: (job: MediaJobStatus) => void): () => void

  /** 订阅变更前确认请求（Agent 生成工具提交前弹确认卡） */
  onConfirmRequest(listener: (payload: MediaConfirmPayload) => void): () => void

  /** 订阅确认定局（用户操作/中止清理），渲染端据此撤卡 */
  onConfirmResolved(listener: (payload: { requestId: string }) => void): () => void

  /** 确认卡回执：接受/拒绝 */
  resolveConfirm(requestId: string, accepted: boolean): Promise<ChatResult>

  /** 设置 Agent 媒体访问模式（full/confirm，写 workspace.json） */
  setAccessMode(mode: MediaAccessMode): Promise<ChatResult>

  /** File 对象反查磁盘路径（Electron 环境）；纯浏览器返回 undefined */
  pathForFile(file: File): string | undefined
}

/**
 * media:set-config 的载荷：全部字段可选，仅提供的字段被更新。
 * 定义在 shared/ipc.ts，这里按 api 层惯例再导出。
 */
export type { MediaConfigPatch } from './ipc'

/**
 * 素材 API（新原型同步，契约见原型 docs/backend-interface.md）。
 *
 * 两条导入通道的语义区别是契约核心：
 * - importCanvas：拖上画布 → 归档进工作区 assets/<分类>/（卡片 = 工作区文件的引用）；
 * - importTemp：拖进会话输入框 → 复制到应用数据目录 inbox（工作区之外），只回绝对路径。
 */
export interface AssetApi {
  /** OS 文件 → 工作区素材库（assets/<分类>/，重名加时间戳）；完成后主进程广播 asset:changed */
  importCanvas(request: AssetImportRequest): Promise<ChatResult<AssetImportResult>>

  /** OS 文件 → 临时 inbox（userData/inbox/<日期>/<uuid>-<名>），返回绝对路径 */
  importTemp(request: AssetImportRequest): Promise<ChatResult<AssetImportResult>>

  /** 素材库清单：内置 assets/ 归档库 + workspace.json 里的命名库（含各库文件列表） */
  libraries(): Promise<ChatResult<AssetLibrariesInfo>>

  /** 新建素材库映射（素材库/<名>/），返回创建后的条目 */
  createLibrary(name: string): Promise<ChatResult<AssetLibrary>>

  /** 移除素材库映射（只删映射，库内文件不动） */
  removeLibrary(id: string): Promise<ChatResult>

  /**
   * 拖拽归档：工作区内文件移动（画布卡/库条目拖到另一个库）、OS 外部文件复制
   * （电脑文件夹拖进库）到指定素材库；完成后主进程广播 asset:changed
   */
  transfer(request: AssetTransferRequest): Promise<ChatResult<AssetTransferResult>>

  /** 设置文件标签（文件级元数据 → .huabu/tags.json，广播 asset:changed；返回清洗后的标签） */
  setTags(relPath: string, tags: string[]): Promise<ChatResult<{ relPath: string; tags: string[] }>>

  /** 真删素材文件（破坏性，渲染端二次确认；广播 asset:changed） */
  deleteAsset(relPath: string): Promise<ChatResult>

  /** 同目录重命名（重名自动加序号，标签索引键随迁；返回实际落盘的新路径与文件名） */
  renameAsset(relPath: string, newName: string): Promise<ChatResult<AssetRenameResult>>

  /** 订阅素材库目录变更（导入/建库/删库后广播） */
  onChanged(listener: () => void): () => void
}