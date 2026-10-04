/**
 * IPC 通道契约（单一来源）
 *
 * 命名规范见 docs/ipc-contract.md：
 * - 请求类（渲染进程 invoke，主进程 handle）：`domain:action`
 * - 事件类（主进程 webContents.send，渲染进程订阅）：`domain:event`
 *
 * 主进程、preload、渲染进程都从这里取通道名，禁止在业务代码里写字面量。
 */

import type { MediaAccessMode, MediaKind, MediaProviderType, MediaRatio, ModelCapabilities } from './media'

export const IpcChannel = {
  /** 联通性自检：渲染进程 -> 主进程，返回 'pong' */
  AppPing: 'app:ping',
  /** 运行时版本信息：渲染进程 -> 主进程 */
  AppVersion: 'app:version',

  /* ------------------------------------------------------------------ */
  /* window 域（自绘标题栏：无边框窗口控制）                                 */
  /* ------------------------------------------------------------------ */

  /** 窗口控制（最小化/最大化还原/关闭）：渲染进程 -> 主进程 */
  WindowControl: 'window:control',
  /** 查询窗口当前状态（是否最大化）：渲染进程 -> 主进程 */
  WindowState: 'window:state',
  /** 事件类：主进程 -> 渲染进程，最大化状态变化时推送 */
  WindowStateChanged: 'window:state-changed',

  /** Agent 运行时状态与可用模型清单（含认证状态，不含任何密钥内容） */
  ChatRuntime: 'chat:runtime',
  /** 会话与画布节点绑定 */
  ChatCreate: 'chat:create',
  /** 发问，流式结果经 ChatEvent 推送 */
  ChatPrompt: 'chat:prompt',
  /** 生成中插话引导 */
  ChatSteer: 'chat:steer',
  /** 中止当前生成 */
  ChatAbort: 'chat:abort',
  /** 会话与画布节点解绑并释放资源 */
  ChatDispose: 'chat:dispose',
  /** 读取会话 JSONL 文件的历史消息（画布恢复时的展示用回放，不含密钥） */
  ChatHistory: 'chat:history',
  /** 查询会话当前上下文水位（getContextUsage 原样透传；tokens=null 如实传） */
  ChatContextUsage: 'chat:context-usage',
  /** 查询上下文占用分布（buildContextEntries 分桶估算；估算值非账单） */
  ChatContextBreakdown: 'chat:context-breakdown',
  /** 手动压缩上下文（SDK 语义：先 abort 当前操作且不续跑被打断的 turn；门控在渲染端） */
  ChatCompact: 'chat:compact',
  /** 原生文件级分叉：SessionManager.forkFrom 全量拷贝源会话 JSONL，返回新 sessionFile */
  ChatFork: 'chat:fork',
  /** 会话中途切换模型（session.setModel；返回换后模型与 clamp 出的实际思考档位） */
  ChatSetModel: 'chat:set-model',
  /** 会话中途设置思考档位（session.setThinkingLevel；返回 clamp 后实际档位） */
  ChatSetThinking: 'chat:set-thinking',
  /** 事件类：主进程 -> 渲染进程，承载流式增量、工具调用、定稿快照与错误 */
  ChatEvent: 'chat:event',

  /* ------------------------------------------------------------------ */
  /* workspace 域（M5 扩展：一个工作区一张画布）                             */
  /* ------------------------------------------------------------------ */

  /** 当前工作区与最近列表：渲染进程 -> 主进程 */
  WorkspaceState: 'workspace:state',
  /** 弹出系统目录选择框，选中即切换工作区 */
  WorkspaceOpenDialog: 'workspace:open-dialog',
  /** 按路径打开/切换工作区（最近列表用） */
  WorkspaceOpenPath: 'workspace:open-path',
  /** 画布快照落盘（.huabu/canvas.json，原子写） */
  WorkspaceCanvasSave: 'workspace:canvas-save',
  /** 读取画布快照；无画布文件时返回 null */
  WorkspaceCanvasLoad: 'workspace:canvas-load',
  /** 修改工作区默认聊天模型（workspace.json），仅影响新建会话 */
  WorkspaceSetDefaultModel: 'workspace:set-default-model',
  /** 列出工作区目录内的可导入文件（跳过 .huabu/.git/node_modules 等） */
  WorkspaceFiles: 'workspace:files',
  /** 读取工作区内文本文件（doc/code 上下文注入用，有扩展名白名单与大小上限） */
  WorkspaceReadFile: 'workspace:read-file',
  /** 写工作区内文本文件（md 笔记编辑保存/新建；白名单与上限同 read-file） */
  WorkspaceWriteFile: 'workspace:write-file',
  /** 在工作区根目录下新建子目录并切换为当前工作区（新工作区=新画布） */
  WorkspaceCreate: 'workspace:create',
  /** 在系统文件管理器中显示工作区内的文件（shell.showItemInFile） */
  WorkspaceReveal: 'workspace:reveal',
  /** 批量删除工作区：目录移入系统回收站并移出最近列表（当前打开的工作区拒绝删除） */
  WorkspaceDelete: 'workspace:delete',
  /** 通知类（渲染进程 send，fire-and-forget）：preload pathForFile 解析出的拖拽源路径登记，
   *  导入类 handler（media:import / asset:import-*）据 consumeSourcePath 校验「确经拖拽」 */
  WorkspaceSourcePathRegistered: 'workspace:source-path-registered',

  /* ------------------------------------------------------------------ */
  /* settings 域（M9 扩展：应用内配置模型与凭据）                           */
  /* ------------------------------------------------------------------ */

  /** 聊天 provider 清单与认证状态（不含任何密钥内容） */
  SettingsChatProviders: 'settings:chat-providers',
  /** 录入某 provider 的 API Key（safeStorage 加密落盘，按工作区隔离） */
  SettingsSetApiKey: 'settings:set-api-key',
  /** 删除某 provider 的已存凭据 */
  SettingsRemoveApiKey: 'settings:remove-api-key',
  /** provider 连通性自检：认证检查 + 最小请求 */
  SettingsTestProvider: 'settings:test-provider',

  /* ------------------------------------------------------------------ */
  /* settings 域（自定义模型与供应商，models.json 配置驱动）                */
  /* ------------------------------------------------------------------ */

  /** 新增自定义模型（挂在已有或自定义供应商下） */
  SettingsCustomAddModel: 'settings:custom-add-model',
  /** 新增自定义供应商（OpenAI 兼容 baseUrl） */
  SettingsCustomAddProvider: 'settings:custom-add-provider',
  /** 删除自定义供应商（连同其模型） */
  SettingsCustomRemoveProvider: 'settings:custom-remove-provider',
  /** 供应商模型管理清单（内置+自定义合并视图，含编辑/隐藏状态） */
  SettingsModelsList: 'settings:models-list',
  /** 编辑模型（自定义=改条目；内置=写 modelOverrides） */
  SettingsModelEdit: 'settings:model-edit',
  /** 删除模型（自定义=删条目；内置=隐藏，可在管理里恢复） */
  SettingsModelRemove: 'settings:model-remove',
  /** 恢复被隐藏的内置模型 */
  SettingsModelRestore: 'settings:model-restore',

  /* ------------------------------------------------------------------ */
  /* settings 域（媒体生成设置，M11）                                      */
  /* ------------------------------------------------------------------ */

  /** 媒体设置状态：确认闸门 + 各 provider 的 Key 来源 */
  SettingsMediaStatus: 'settings:media-status',
  /** 录入媒体网关 Key（加密存储，键 media:<providerId>） */
  SettingsMediaSetKey: 'settings:media-set-key',
  /** 删除媒体网关 Key */
  SettingsMediaRemoveKey: 'settings:media-remove-key',

  /* ------------------------------------------------------------------ */
  /* settings 域（Skills / MCP：真实接入）                                  */
  /* ------------------------------------------------------------------ */

  /** MCP 服务器清单 + 运行态（全局配置 userData/huabu-state/mcp.json；不依赖工作区） */
  SettingsMcpStatus: 'settings:mcp-status',
  /** 整表替换 MCP 服务器配置，落盘并同步连接池，返回最新运行态 */
  SettingsMcpSet: 'settings:mcp-set',
  /** 工作区技能清单（扫描 .huabu/skills/ 的 SKILL.md；需要当前工作区） */
  SettingsSkillsList: 'settings:skills-list',
  /** 设置被禁用技能名单（写 workspace.json skills.disabled；影响之后新建的会话） */
  SettingsSkillsSetDisabled: 'settings:skills-set-disabled',
  /** 事件类：MCP 服务器连接状态变化（设置页徽章实时更新） */
  McpStatusEvent: 'mcp:status',

  /* ------------------------------------------------------------------ */
  /* media 域（M11：媒体生成任务编排 / M12：导入）                          */
  /* ------------------------------------------------------------------ */

  /** 可用媒体 provider 与模型清单（含 mock；网关按 workspace.json 配置） */
  MediaProviders: 'media:providers',
  /** 提交生成任务；返回 jobId，进度经 media:job 事件推送 */
  MediaGenerate: 'media:generate',
  /** 取消任务 */
  MediaCancel: 'media:cancel',
  /** 近期任务清单（画布恢复时对账占位节点） */
  MediaJobs: 'media:jobs',
  /** 导入 OS 媒体文件：拷入 .huabu/media/ 并返回产物描述 */
  MediaImport: 'media:import',
  /** 事件类：任务状态变化推送（queued/running/progress/succeeded/failed/cancelled） */
  MediaJobEvent: 'media:job',

  /* ------------------------------------------------------------------ */
  /* media 域（M13：Agent 媒体生成工具的确认闸门）                          */
  /* ------------------------------------------------------------------ */

  /** 设置媒体工具确认策略（video 是否需确认） */
  MediaSetConfirmVideo: 'media:set-confirm-video',
  /** 设置 Agent 媒体访问模式（full = 直接执行；confirm = 变更前确认，写 workspace.json） */
  MediaSetAccessMode: 'media:set-access-mode',
  /** 事件类：变更前确认请求（Agent 生成工具提交前，渲染端弹确认卡） */
  MediaConfirmRequest: 'media:confirm-request',
  /** 确认卡回执：接受/拒绝（主进程据此放行或驳回挂起的生成工具调用） */
  MediaConfirmResolve: 'media:confirm-resolve',
  /** 事件类：确认已定局（用户操作 / 中止清理），渲染端据此撤卡（幂等） */
  MediaConfirmResolvedEvent: 'media:confirm-resolved',
  /** 整体更新媒体生成默认配置（provider/模型/输出目录/并发/默认比例时长，写 workspace.json） */
  MediaSetConfig: 'media:set-config',

  /* ------------------------------------------------------------------ */
  /* media 域：用户自建供应商 / 模型清单管理（写 workspace.json 覆盖层）      */
  /* ------------------------------------------------------------------ */

  /** 新增用户供应商（带首个模型；写 media.userProviders，与内置同 id = 覆盖模型子集） */
  MediaUserAddProvider: 'media:user-add-provider',
  /** 删除用户供应商（内置同名条目不受影响；已存 Key 不动） */
  MediaUserRemoveProvider: 'media:user-remove-provider',
  /** 给供应商添加模型（内置供应商经同名用户条目覆盖；用户供应商直接加） */
  MediaUserAddModel: 'media:user-add-model',
  /** 移除模型（用户模型从 userProviders 删；内置模型进 hiddenBuiltin 隐藏） */
  MediaUserRemoveModel: 'media:user-remove-model',
  /** 恢复被隐藏的内置模型（从 hiddenBuiltin 移出） */
  MediaUserRestoreModel: 'media:user-restore-model',
  /** 浏览供应商的全量模型目录（随应用打包的只读数据，返回条目带 enabled 标注） */
  MediaBrowseCatalog: 'media:browse-catalog',

  /* ------------------------------------------------------------------ */
  /* asset 域（新原型同步：素材归档 / 临时 inbox / 素材库映射）               */
  /* ------------------------------------------------------------------ */

  /** 通道一：OS 文件拖上画布 → 按 ASSET_CATEGORIES 归档到 <工作区>/assets/<分类>/，重名加时间戳 */
  AssetImportCanvas: 'asset:import-canvas',
  /** 通道二：OS 文件拖进会话输入框 → 复制到应用数据目录 inbox（工作区之外），只回绝对路径 */
  AssetImportTemp: 'asset:import-temp',
  /** 素材库清单：内置「素材归档（assets/）」+ workspace.json libraries 段的命名库（含各库文件列表） */
  AssetLibraries: 'asset:libraries',
  /** 新建素材库映射（素材库/<名>/，不复制文件） */
  AssetLibraryCreate: 'asset:library-create',
  /** 移除素材库映射（只删映射，文件不动） */
  AssetLibraryRemove: 'asset:library-remove',
  /** 把文件归入指定素材库：工作区内文件移动（画布卡/库条目拖拽），OS 外部文件复制（文件夹拖入） */
  AssetTransfer: 'asset:transfer',
  /** 删除素材文件（真删磁盘文件；标签索引同步清理，画布引用由渲染端一并移除） */
  AssetDelete: 'asset:delete',
  /** 重命名素材文件（同目录改名；重名自动加序号，标签索引键随迁） */
  AssetRename: 'asset:rename',
  /** 设置文件标签（文件级元数据，写 .huabu/tags.json 并广播 asset:changed） */
  AssetSetTags: 'asset:set-tags',
  /** 事件类：素材库目录变更广播（导入/建库/删库后；未来的本地索引挂在这条链路上） */
  AssetChanged: 'asset:changed'
} as const

export type IpcChannelValue = (typeof IpcChannel)[keyof typeof IpcChannel]

/** app:version 的返回结构 */
export interface AppVersionInfo {
  /** package.json 中的应用版本 */
  appVersion: string
  /** Electron 版本 */
  electron: string
  /** 主进程 Node 版本（需 >= 22.19 以满足 Pi 运行时要求） */
  node: string
  /** Chromium 版本 */
  chrome: string
  /** 是否为打包产物 */
  isPackaged: boolean
}

/** window:control 的载荷动作 */
export type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close'

/** window:state / window:state-changed 的载荷结构 */
export interface WindowStateInfo {
  /** 窗口当前是否处于最大化 */
  maximized: boolean
}

/* -------------------------------------------------------------------------- */
/* chat 域（M3）                                                                */
/*                                                                            */
/* 这里的类型是「桥接层自定义结构」，不是 Pi 的类型别名。主进程负责把           */
/* AgentSessionEvent 翻译成下列形状，渲染进程只认这些字段，永远不 import pi 包。 */
/* -------------------------------------------------------------------------- */

/**
 * 一轮生成的结束原因，取值与 Pi 的 StopReason 对齐（共 7 态）。
 *
 * UI 必须区分四组语义，不能只当「成功 / 失败」两态处理：
 * - `pending`：仍在流式中
 * - `stop` / `length` / `toolUse` / `deferred`：正常结束。
 *   其中 `toolUse` 表示「本条消息以工具调用收尾，后面还有 turn」，
 *   实测一次 prompt 会产生多个 turn（ls+read 并行 → write → 文本收尾 = 3 个 turn），
 *   把 toolUse 当异常会让工具调用链路在 UI 上直接报错。
 * - `aborted`：用户中止
 * - `error`：模型调用失败，配 errorMessage
 */
export type ChatStopReason =
  | 'pending'
  | 'stop'
  | 'length'
  | 'toolUse'
  | 'deferred'
  | 'aborted'
  | 'error'

/** 工具调用参数：只允许可结构化克隆的纯数据 */
export type ChatToolArgs = Record<string, string | number | boolean | null>

/** assistant 消息的内容块。一条消息可含多个块，且可有多个 toolCall（实测 ls 与 read 并行发起） */
export interface ChatContentBlock {
  type: 'text' | 'thinking' | 'toolCall'
  /** type=text 时的正文 */
  text?: string
  /** type=thinking 时的思维链正文 */
  thinking?: string
  /** type=toolCall 时的调用标识，与 tool_start / tool_end 事件的 toolCallId 一致 */
  toolCallId?: string
  toolName?: string
  args?: ChatToolArgs
}

/** token 用量。实测只在结束事件里有真值，流式过程中全为 0 */
export interface ChatUsage {
  input: number
  output: number
  reasoning: number
  totalTokens: number
}

/** 一条 assistant 消息的定稿快照，用于校正渲染端自己拼装的增量 */
export interface ChatAssistantSnapshot {
  /** 主进程在本次生成内分配的序号，渲染端按它定位气泡（Pi 的 assistant 消息没有稳定 id） */
  messageIndex: number
  content: ChatContentBlock[]
  provider: string
  model: string
  /** 实测响应模型名可能与请求的不同 */
  responseModel?: string
  stopReason: ChatStopReason
  errorMessage?: string
  usage?: ChatUsage
}

/**
 * chat:event 的载荷。
 *
 * 增量策略（见 docs/m3-spike.md 第 5.1 节）：流式期间只发 `delta`，
 * 不转发 Pi 每个事件都携带的 `partial` 全量快照，否则长回复会把 IPC 压垮；
 * 消息定稿时发一次 `message` 快照做校正，保证断流/丢包后 UI 仍与真实结果一致。
 */
export type ChatEvent =
  | { nodeId: string; type: 'agent_start' }
  | { nodeId: string; type: 'turn_start'; turnIndex: number }
  | {
      nodeId: string
      type: 'delta'
      messageIndex: number
      /** Pi 的子流索引：实测 0=thinking、1=text，渲染端按它分桶，不能混在一条流里追加 */
      contentIndex: number
      stream: 'text' | 'thinking'
      delta: string
    }
  | { nodeId: string; type: 'tool_start'; toolCallId: string; toolName: string; args: ChatToolArgs }
  | {
      nodeId: string
      type: 'tool_update'
      toolCallId: string
      toolName: string
      /** 工具执行中进度文本（onUpdate 的首个 text 块，主进程已截断），如「图片生成生成中（42%）」 */
      text: string
    }
  | {
      nodeId: string
      type: 'tool_end'
      toolCallId: string
      toolName: string
      isError: boolean
      /** 工具结果文本。实测 ls/read/write 的 result 形如 { content: [{ type:'text', text }] }，无 details */
      resultText: string
    }
  | { nodeId: string; type: 'message'; message: ChatAssistantSnapshot }
  | { nodeId: string; type: 'turn_end'; turnIndex: number }
  | {
      nodeId: string
      type: 'agent_end'
      stopReason: ChatStopReason
      errorMessage?: string
      usage?: ChatUsage
    }
  | {
      nodeId: string
      type: 'context_usage'
      /** 估算上下文 token；null = 压缩后尚未有新响应（UI 显示"—"，绝不显示假数字） */
      tokens: number | null
      contextWindow: number
      percent: number | null
    }
  | {
      nodeId: string
      type: 'compaction_start'
      reason: ChatCompactionReason
    }
  | {
      nodeId: string
      type: 'compaction_end'
      reason: ChatCompactionReason
      aborted: boolean
      errorMessage?: string
      /** 压缩成功时的结果摘要（主进程已截断）；aborted/失败时缺省 */
      summary?: string
      tokensBefore?: number
      estimatedTokensAfter?: number
    }
  /** 桥接层自身的故障（会话不存在、pi 加载失败等），与模型调用失败区分开 */
  | { nodeId: string; type: 'host_error'; code: ChatErrorCode; message: string }

/** 失败分类，渲染端据此给出可操作引导（去设置 / 重试 / 重新绑定会话） */
export type ChatErrorCode =
  /** Pi SDK 动态导入或初始化失败 */
  | 'host_not_ready'
  /** 没有任何可用凭据：引导用户配置 Key */
  | 'no_credentials'
  /** 指定的模型不可用 */
  | 'model_unavailable'
  /** nodeId 尚未 create 就调用了 prompt/abort/steer */
  | 'session_missing'
  /** nodeId 已经绑定会话，重复 create */
  | 'session_exists'
  /** 会话正在生成中；Pi 的 prompt() 在流式期间会抛错，所以主进程提前拦住 */
  | 'busy'
  /** cwd 越出允许的工作区根，主进程拒绝 */
  | 'cwd_rejected'
  /** 链路正常但模型调用失败（401、网络中断等） */
  | 'model_call_failed'
  | 'aborted'
  /** 会话 JSONL 超过加载上限（硬顶 64MB），主进程跳过加载以免被冻结 */
  | 'session_too_large'
  | 'unknown'

/** 统一的请求返回包装：不靠抛错传递业务失败，避免渲染端只能拿到一句字符串 */
export type ChatResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; code: ChatErrorCode; error: string }

/* -------------------------------------------------------------------------- */
/* chat 域（上下文可见性：水位 / 压缩 / 分布）                                     */
/* -------------------------------------------------------------------------- */

/**
 * 会话当前上下文水位（pi getContextUsage 的透传形态）。
 *
 * tokens=null 是真实语义：压缩发生后、下一次模型响应之前无法估算——UI 必须
 * 显示"—"并说明待更新，而不是拿 agent_end 的旧 usage 顶替（那反映的是压缩前）。
 * contextWindow=null 表示会话还没绑定模型（尚未发问），整个水位无从谈起。
 */
export interface ChatContextUsage {
  tokens: number | null
  contextWindow: number | null
  percent: number | null
}

/** 压缩触发原因（pi 三态：手动 / 到阈值 / 上下文溢出） */
export type ChatCompactionReason = 'manual' | 'threshold' | 'overflow'

/** 一次压缩的展示信息（分隔条与回放重建同形） */
export interface ChatCompactionDivider {
  summary: string
  /** 压缩前的估算上下文 token */
  tokensBefore?: number
  /** 压缩后的估算 token（pi 未必给出） */
  estimatedTokensAfter?: number
}

/**
 * 上下文分布明细的单个桶（估算，非账单）。
 *
 * 估算口径与 pi 一致：chars/4、图片块恒 1200 token/张；末次 assistant usage 作
 * 校准总量，桶合计与总量的差值全部进 unattributed（系统提示词/工具定义/估算误差）。
 */
export interface ChatContextBucket {
  key:
    | 'user'
    | 'assistant_text'
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'images'
    | 'compaction'
    | 'unattributed'
  tokens: number
  /** 占校准总量的比例（0..1；无校准总量时按桶合计为分母） */
  share: number
  /** key=images 时为图片张数 */
  images?: number
  /** key=compaction 时为最新一次压缩的摘要（已截断） */
  summary?: string
  /** 工具桶的按工具名细分（降序，前 5） */
  tools?: Array<{ name: string; tokens: number }>
}

/** chat:context-breakdown 返回：当前分支、压缩后视图的分桶估算 */
export interface ChatContextBreakdownInfo {
  buckets: ChatContextBucket[]
  /** 校准总量（末次 assistant usage + 尾随估算）；null = 尚无可校准的 usage */
  totalTokens: number | null
  contextWindow: number | null
}

/** 单个可选模型。认证字段只暴露「是否已配置 / 来源 / 环境变量名」，绝不含密钥内容 */
export interface ChatModelOption {
  /** `provider/model`，作为 chat:create 的 modelId */
  id: string
  provider: string
  model: string
  authConfigured: boolean
  /** 实测取值如 environment / stored */
  authSource?: string
  /** 凭据来源的可展示名，如 DEEPSEEK_API_KEY */
  authLabel?: string
  /** 推理模型（思考档位选择的前提） */
  reasoning: boolean
  /**
   * 该模型支持的思考档位（THINKING_LEVELS 顺序子集；空 = 非推理模型）。
   * 从目录 thinkingLevelMap 派生：显式映射为 null 的档位 = 不支持；无映射的推理模型 =
   * 全七档（pi 会按模型能力 clamp，会话建好以 chat:set-model 的返回为准）
   */
  thinkingLevels: string[]
}

/**
 * pi 思考档位的固定顺序与中文标签（唯一声明处；主进程派生、渲染端展示共用）。
 * 档位 → 各家上游参数的映射在 models/catalog/providers/*.ts 的 thinkingLevelMap
 * （2026-09-26 已逐家对官网核对：OpenAI none~high / GLM、Kimi K3、DeepSeek flash
 * low·high·max / DeepSeek pro、Anthropic 高位档 / Qwen enable_thinking+thinking_budget）。
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number]
export const THINKING_LEVEL_LABEL: Record<ThinkingLevelName, string> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高'
}

export interface ChatRuntimeInfo {
  /** Pi SDK 是否已成功加载并完成 ModelRuntime 初始化 */
  ready: boolean
  /** 未就绪时的原因，可直接展示 */
  error?: string
  models: ChatModelOption[]
  /** 无凭据时为空数组，渲染端据此显示引导错误条 */
  configuredProviders: string[]
}

export interface ChatCreateRequest {
  /** 画布节点 ID，会话与节点一对一绑定 */
  nodeId: string
  /** 会话工作目录。省略时主进程使用当前工作区；传入时必须位于当前工作区根之内 */
  cwd?: string
  /** `provider/model`。省略时按工作区默认模型，再退到第一个有凭据的可用模型 */
  modelId?: string
  /** 初始思考档位（THINKING_LEVELS 之一；pi 按模型能力 clamp） */
  thinkingLevel?: string
  /** 已有会话 JSONL 文件路径（画布恢复时重绑历史会话）。必须位于当前工作区 .huabu/sessions/ 内 */
  sessionFile?: string
}

export interface ChatCreateInfo {
  nodeId: string
  modelId: string
  /** clamp 后实际生效的思考档位（THINKING_LEVELS 之一） */
  thinkingLevel: string
  cwd: string
  sessionId?: string
  /** 会话 JSONL 落盘位置，便于排查 */
  sessionFile?: string
  /** 本会话实际启用的工具名 */
  activeTools: string[]
}

/** chat:set-model / chat:set-thinking 的请求与结果（会话中途切换模型与思考档位） */
export interface ChatSetModelRequest {
  nodeId: string
  /** `provider/model` */
  modelId: string
}
export interface ChatSetModelResult {
  modelId: string
  /** 换模型后 clamp 出的实际档位（pi 会把原档位折到新模型支持的范围） */
  thinkingLevel: string
  /** 新模型的可用档位（会话真相源，比目录派生更准） */
  thinkingLevels: string[]
}
export interface ChatSetThinkingRequest {
  nodeId: string
  /** THINKING_LEVELS 之一；非法值由 pi clamp */
  thinkingLevel: string
}
export interface ChatSetThinkingResult {
  /** clamp 后实际生效的档位 */
  thinkingLevel: string
}

export interface ChatPromptRequest {
  nodeId: string
  text: string
}

export interface ChatSteerRequest {
  nodeId: string
  text: string
}

export interface ChatNodeRequest {
  nodeId: string
}

/** 回放里的图片：缩略图（主进程已缩 ≤256px JPEG）或退化 chip（超出上限/缩略失败） */
export interface ChatHistoryImage {
  /** 缩略图 JPEG base64；无此字段时渲染为 label chip */
  thumbBase64?: string
  /** chip 文案（工具图片带配对 toolCall 参数里的源路径） */
  label?: string
}

/** 回放工具卡（与流式 ChatToolCallView 同构，status 只会是终态） */
export interface ChatHistoryToolCall {
  id: string
  name: string
  args: ChatToolArgs
  status: 'done' | 'error'
  /** 工具结果文本（沿用流式 8000 截断） */
  resultText?: string
  /** 结果里的图片缩略（toolResult 的 image 块） */
  images?: ChatHistoryImage[]
}

/** 回放消息的内容块，与流式 ChatMessageBlock 同构（渲染端零新组件） */
export type ChatHistoryBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCall: ChatHistoryToolCall }

/**
 * chat:history 返回的单条消息。
 *
 * 结构化回放（与模型实际持有的上下文对齐）：
 * - blocks 携带 text/thinking/toolCall，工具卡按 toolCallId 配对工具结果；
 * - inContext=false 表示该条已被压缩截断或不在当前分支——模型上下文里没有它，UI 淡化；
 * - entryKind='compaction' 是压缩分界分隔条（回放侧从 CompactionEntry 重建，
 *   与流式侧本地合成的分隔条同形）；
 * - contextPayload 是用户消息里逐轮注入的上下文段（按自产文本头拆分，UI 折叠展示）。
 */
export interface ChatHistoryMessage {
  role: 'user' | 'model'
  text: string
  stopReason?: ChatStopReason
  model?: string
  blocks?: ChatHistoryBlock[]
  /** 消息级图片缩略（user 消息里的 image 块） */
  images?: ChatHistoryImage[]
  entryKind?: 'compaction'
  compaction?: ChatCompactionDivider
  inContext?: boolean
  contextPayload?: string
}

export interface ChatHistoryInfo {
  nodeId: string
  sessionFile: string
  messages: ChatHistoryMessage[]
}

/** chat:fork 请求：源会话 JSONL（渲染端 SessionMeta 里持有的引用） */
export interface ChatForkRequest {
  nodeId: string
  sessionFile: string
}

/** chat:fork 返回：主进程 forkFrom 新建的独立 JSONL */
export interface ChatForkResult {
  nodeId: string
  /** 新会话文件（位于当前工作区 .huabu/sessions/ 内） */
  sessionFile: string
}

/* -------------------------------------------------------------------------- */
/* workspace 域（M5 扩展）                                                      */
/* -------------------------------------------------------------------------- */

export interface WorkspaceInfo {
  /** 工作区绝对路径（即 Agent 的 cwd） */
  path: string
  /** 展示名 = 目录名 */
  name: string
  /** 工作区内 .huabu/canvas.json 的绝对路径 */
  canvasFile: string
  /** 工作区内 .huabu/workspace.json 的绝对路径 */
  workspaceFile: string
  /** 工作区默认聊天模型（provider/model），新建会话继承 */
  defaultModel?: string
  /** 凭据存储文件（userData 下，按工作区哈希隔离），仅用于诊断展示 */
  credentialsHint: string
}

export interface WorkspaceSummary {
  path: string
  name: string
  lastOpenedAt: string
}

export interface WorkspaceStateInfo {
  /** null = 尚未打开任何工作区（显示选择页） */
  workspace: WorkspaceInfo | null
  recents: WorkspaceSummary[]
}

export interface WorkspaceOpenResult {
  /** 用户在系统对话框里点了取消 */
  cancelled?: boolean
  workspace?: WorkspaceInfo
  /** 打开新工作区时被释放的会话数（切换 dispose 的可观察证据） */
  disposedSessions: number
}

/** 批量删除工作区时的单条失败（路径非法/使用中/回收站失败等），不影响其余条目 */
export interface WorkspaceDeleteFailure {
  path: string
  error: string
}

export interface WorkspaceDeleteResult {
  /** 成功移入回收站（或目录本已消失、仅清理登记）的工作区 */
  removed: WorkspaceSummary[]
  /** 逐条失败明细 */
  failures: WorkspaceDeleteFailure[]
  /** 删除后的最新最近列表（渲染端直接 setState，免二次往返） */
  recents: WorkspaceSummary[]
}

/**
 * 画布快照。nodes 的 data 由渲染端定义、主进程按不透明 JSON 存取；
 * 主进程只校验外壳形状与 size 上限。
 *
 * version 2 新增 meta（v1 快照无此字段）：活动会话与视口随画布一起恢复。
 * version 3（新原型同步）：会话从画布移除、进底部对话坞 —— 会话清单存
 * meta.sessions（含 sessionFile 引用，历史仍在 .huabu/sessions/*.jsonl），
 * 画布节点只剩文件卡片（type = 'asset'）。加载 v1/v2 时由渲染端把 chat
 * 节点迁移成会话条目。
 */
export interface CanvasSnapshot {
  version: 1 | 2 | 3
  savedAt: string
  meta?: {
    activeChatId?: string | null
    /** v3：活动会话 id（v1/v2 叫 activeChatId，语义相同 —— 会话即对话历史） */
    activeSessionId?: string | null
    view?: { x: number; y: number; scale: number }
    /** v3：会话清单（对话坞的数据源；id 即 chat:create 的绑定键） */
    sessions?: CanvasSnapshotSession[]
  }
  nodes: Array<{
    id: string
    type: string
    x: number
    y: number
    width: number
    height: number
    zIndex: number
    data: unknown
  }>
}

/** 画布快照里的会话条目（v3）：只有元数据与 sessionFile 引用，不内嵌消息 */
export interface CanvasSnapshotSession {
  id: string
  title: string
  /** Pi 会话 JSONL 文件（工作区 .huabu/sessions/ 内）；尚未发问过的会话没有 */
  sessionFile?: string
  /** 会话绑定模型（provider/model），创建成功后写入 */
  modelId?: string
  /** 会话思考档位（THINKING_LEVELS 之一；中途切换后回填，重启随快照恢复） */
  thinkingLevel?: string
  /** fork 来源会话 id 与当时的标题快照（fork 只复制对话历史，画布公用不复制） */
  forkedFromId?: string
  forkedFromLabel?: string
  createdAt: string
}

/** workspace:files 返回的单个可导入文件 */
export interface WorkspaceFileInfo {
  /** 展示名（含扩展名） */
  name: string
  /** 相对工作区根的 POSIX 路径（导入卡片按它引用文件） */
  relPath: string
  /** 按文件本身类型区分：图片/视频/音频/文档/代码/其他 */
  kind: 'image' | 'video' | 'audio' | 'doc' | 'code' | 'other'
  bytes: number
  mtime: string
}

/** workspace:read-file 返回（文本上下文注入用） */
export interface WorkspaceReadFileResult {
  text: string
  bytes: number
  /** 超过大小上限被截断时为 true（截断点在 text 末尾） */
  truncated: boolean
}

/* -------------------------------------------------------------------------- */
/* settings 域（M9 扩展）                                                      */
/* -------------------------------------------------------------------------- */

/** 单个聊天 provider 的认证状态（无密钥内容） */
export interface ProviderAuthInfo {
  id: string
  name: string
  /** 是否已配置凭据（工作区存储或环境变量） */
  authConfigured: boolean
  /** 凭据来源：workspace-store / environment / none */
  authSource: string
  /** 可展示的来源名，如 HUABU_WORKSPACE_KEY 或 ANTHROPIC_API_KEY */
  authLabel?: string
  modelCount: number
  /** 生效协议（openai-completions 缺省）；设置页据此显示，用户才看得见自己选了什么 */
  api?: string
}

export interface SettingsProvidersInfo {
  providers: ProviderAuthInfo[]
  /** 凭据文件的落盘位置提示（诊断用） */
  credentialsHint: string
}

export interface ProviderTestResult {
  providerId: string
  /** 认证检查是否通过 */
  authOk: boolean
  /** 认证来源与类型 */
  authType?: string
  authSource?: string
  /** 最小请求是否成功（认证通过才尝试） */
  requestOk: boolean
  /** 可直接展示的结论或错误摘要 */
  message: string
}

export interface SettingsSetApiKeyRequest {
  providerId: string
  apiKey: string
}

/* -------------------------------------------------------------------------- */
/* settings 域（自定义模型与供应商）                                            */
/* -------------------------------------------------------------------------- */

export interface CustomModelInput {
  providerId: string
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input_modalities?: Array<'text' | 'image'>
  /** 模型级协议；缺省 = 跟随供应商。用于一个网关同时暴露多种端点形态的场合 */
  api?: string
}

export interface CustomProviderInput {
  providerId: string
  name?: string
  baseUrl: string
  api?: string
}

export interface MediaProviderStatus {
  id: string
  label: string
  /** 适配器类型（单一声明处见 shared/media.ts 的 MediaProviderType） */
  type: MediaProviderType
  /** 清单来源：builtin 内置目录 / user 用户自建（mock 无来源字段） */
  source?: 'builtin' | 'user'
  modelCount: number
  /** Key 来源：加密存储 / 环境变量 / 未配置 */
  keySource: 'workspace-store' | 'environment' | 'none'
}

export interface MediaSettingsStatus {
  confirmVideo: boolean
  /** Agent 媒体访问模式：full = 直接执行（现状）；confirm = 变更前确认（生成前弹确认卡） */
  accessMode: MediaAccessMode
  providers: MediaProviderStatus[]
  /** 生成默认值（workspace.json media 段），设置页据此回显 */
  config: {
    agentProvider: string
    agentModels: Partial<Record<'image' | 'video' | 'audio', string>>
    /** 产物输出目录（相对工作区根），缺省 .huabu/media */
    outputDir: string
    /** 并发任务上限（1..8） */
    concurrency: number
    /** 新建生成卡片的默认图片比例 */
    defaultRatio: MediaRatio
    /** 新建生成卡片的默认时长（秒） */
    defaultDuration: number
    /** 全局默认落库素材库 id（卡片未手动指定时兜底；空 = 公共库/工作目录） */
    defaultLibraryId?: string
    /** 按媒体大类的默认落库素材库 id（优先级高于全局默认） */
    kindLibraryDefaults?: Partial<Record<'image' | 'video' | 'audio', string>>
    /** 被用户隐藏的内置模型 id（设置页提供恢复入口） */
    hiddenBuiltin?: string[]
  }
}

/* -------------------------------------------------------------------------- */
/* settings 域：MCP / Skills（真实接入）                                        */
/* -------------------------------------------------------------------------- */

/** 全局 MCP 服务器配置条目（userData/huabu-state/mcp.json；格式对齐 Claude Desktop 的事实标准） */
export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  /** 附加环境变量（与 SDK 安全白名单合并，同名覆盖） */
  env?: Record<string, string>
  enabled: boolean
}

export type McpServerStatus = 'starting' | 'connected' | 'error' | 'disabled'

/** 配置 + 运行态的合并视图（设置页徽章数据源） */
export interface McpServerRuntimeInfo extends McpServerConfig {
  status: McpServerStatus
  /** connected 时已发现的工具数 */
  toolCount?: number
  /** 非 connected 状态下的最近错误摘要（含 server stderr 尾部） */
  error?: string
}

export interface SettingsMcpStatusResult {
  servers: McpServerRuntimeInfo[]
}

export interface SettingsMcpSetRequest {
  /** 整表替换：渲染端先在现有清单上增删改，再整体提交 */
  servers: McpServerConfig[]
}

/** 技能（SKILL.md，agentskills.io 规范）：用户级（~/.agents/skills 等）或工作区级（.huabu/skills/） */
export interface SkillInfo {
  name: string
  description: string
  /** 技能根目录（用户级为 ~ 缩写的绝对路径；工作区级为相对路径） */
  dir: string
  /** 来源目录：user = 用户级（跨工作区共享）；workspace = 当前工作区独有 */
  source: 'user' | 'workspace'
  /** false = 在 workspace.json skills.disabled 名单里（不进新会话系统提示） */
  enabled: boolean
  /** 校验失败原因（frontmatter 缺字段 / name 与目录不一致等；带值的条目不会注入会话） */
  invalid?: string
}

export interface SettingsSkillsListResult {
  skills: SkillInfo[]
}

export interface SettingsSkillsSetDisabledRequest {
  disabled: string[]
}

/* -------------------------------------------------------------------------- */
/* media 域：用户自建供应商 / 模型管理的载荷                                      */
/* -------------------------------------------------------------------------- */

/** media:user-add-provider 的载荷 */
export interface MediaUserProviderInput {
  /** 供应商 id（小写字母/数字/点/横线/下划线；与内置同名 = 覆盖该供应商的模型子集） */
  id: string
  /** 展示名（缺省 = id） */
  label?: string
  /** 适配器类型（必须是已注册的非 mock 类型） */
  type: MediaProviderType
  /** 网关基址（协议家族适配器用，如 OpenAI 兼容网关）；缺省 = 适配器官方默认 */
  baseUrl?: string
  /** 凭据回退环境变量名（可选；缺省按适配器约定） */
  authEnv?: string
  /** 首个模型（供应商至少要有一个模型才有存在意义） */
  firstModel: { id: string; kind: 'image' | 'video' | 'audio'; label?: string }
}

/** media:user-add-model 的载荷 */
export interface MediaUserModelInput {
  providerId: string
  /** 模型 id（发给网关的标识，如 'Kwai-Kolors/Kolors' 或 'gpt-image-1'） */
  id: string
  kind: 'image' | 'video' | 'audio'
  label?: string
  /** 能力元数据（浏览目录「添加」时透传；比例档位/时长档位驱动参数面板） */
  capabilities?: ModelCapabilities
  /** 一句人话的成本提示 */
  costHint?: string
}

/** media:set-config 的载荷：全部字段可选，仅提供的字段被更新 */
export interface MediaConfigPatch {
  agentProvider?: string
  agentModels?: Partial<Record<'image' | 'video' | 'audio', string>>
  /** 相对工作区根的产物输出目录；空串恢复默认 .huabu/media */
  outputDir?: string
  concurrency?: number
  defaultRatio?: MediaRatio
  defaultDuration?: number
  confirmVideo?: boolean
  /** 全局默认落库素材库 id；空串清除 */
  defaultLibraryId?: string
  /** 按媒体大类的默认落库素材库 id（提供即整体替换该映射） */
  kindLibraryDefaults?: Partial<Record<'image' | 'video' | 'audio', string>>
}

/** 供应商模型管理清单里的单个模型（内置+自定义合并视图） */
export interface ManagedModelInfo {
  id: string
  /** 生效显示名（含 modelOverrides 编辑后的名字） */
  name: string
  source: 'builtin' | 'custom'
  /** 用户删除（隐藏）的内置模型 */
  hidden: boolean
  /** 内置模型被编辑过（存在 modelOverride） */
  edited: boolean
  reasoning: boolean
  /** 支持的输入类型（含 image 即可在 UI 标「视觉」） */
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
}

export interface ModelEditInput {
  providerId: string
  modelId: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
}

/* -------------------------------------------------------------------------- */
/* media 域（M11/M12/M13）                                                     */
/* -------------------------------------------------------------------------- */

export type {
  MediaKind,
  MediaModelInfo,
  MediaProviderInfo,
  MediaProviderType,
  MediaGenerateRequest,
  MediaJobState,
  MediaArtifact,
  MediaJobStatus,
  MediaImportRequest,
  MediaImportResult,
  MediaCatalogBrowseItem,
  MediaAccessMode
} from './media'

/**
 * media:confirm-request 载荷（变更前确认模式）：Agent 生成工具提交前发给渲染端的
 * 确认卡内容——用户据此决定接受/拒绝，回执走 media:confirm-resolve。
 */
export interface MediaConfirmPayload {
  /** 本次确认的回执凭据（resolve 时原样带回） */
  requestId: string
  /** 发起生成的会话节点 id（确认卡显示来源） */
  nodeId: string
  kind: MediaKind
  prompt: string
  /** 将使用的供应商与模型（提交前解析结果；解析失败时不带） */
  provider?: string
  model?: string
  ratio?: MediaRatio
  durationSeconds?: number
  /** 参考图（垫图/首帧）数量 */
  refCount?: number
}

/** media:confirm-resolve 请求 */
export interface MediaConfirmResolveRequest {
  requestId: string
  accepted: boolean
}

/* -------------------------------------------------------------------------- */
/* asset 域（新原型同步：docs/backend-interface.md 的目录契约）                    */
/* -------------------------------------------------------------------------- */

/** asset:import-* 的单个输入文件（sourcePath 来自 preload 的 webUtils.getPathForFile） */
export interface AssetImportItem {
  /** OS 源文件绝对路径 */
  sourcePath: string
  /** 展示名（缺省取 sourcePath 的 basename） */
  name?: string
  mime?: string
}

export interface AssetImportRequest {
  files: AssetImportItem[]
}

/** 导入成功的单个文件 */
export interface ImportedAsset {
  name: string
  kind: 'image' | 'video' | 'audio' | 'doc' | 'code' | 'other'
  /** import-canvas：相对工作区根的 POSIX 路径；import-temp 无此字段（工作区之外） */
  relPath?: string
  /** 绝对路径（统一 '/' 分隔，消息载荷用） */
  absPath: string
  bytes: number
  mime?: string
}

export interface AssetImportResult {
  imported: ImportedAsset[]
  failed: Array<{ name: string; error: string }>
}

/** 素材库内的文件条目（relPath 相对工作区根） */
export interface AssetLibraryFile {
  name: string
  kind: 'image' | 'video' | 'audio' | 'doc' | 'code' | 'other'
  relPath: string
  /** 绝对路径（统一 '/' 分隔，消息载荷用） */
  absPath?: string
  bytes: number
  /** 文件标签（.huabu/tags.json 索引；素材库按标签搜索用） */
  tags?: string[]
}

/**
 * 素材库：名字 → 工作区内相对路径 的映射（工作区级共享，不用于隔离会话）。
 * builtin 的是合成条目（assets/ 自动归档），不可删除；公共库是默认落库兜底。
 */
export interface AssetLibrary {
  id: string
  name: string
  /** 工作区内相对路径（映射到的真实目录） */
  path: string
  isPublic?: boolean
  /** assets/ 自动归档的合成库：只读、不可删 */
  builtin?: boolean
  files: AssetLibraryFile[]
}

export interface AssetLibrariesInfo {
  /** 当前工作区绝对路径（未打开为 null；渲染端拼引用载荷/提示词用） */
  workspaceDir: string | null
  /** 临时收件箱绝对路径（import-temp 的落点，工作区之外） */
  inboxDir: string
  libraries: AssetLibrary[]
}

/**
 * asset:transfer 请求：拖拽归档的唯一后端口。
 * 移动（工作区内文件，改路径不复制）与复制（OS 外部文件）可在一次调用里并存。
 */
export interface AssetTransferRequest {
  /** 目标素材库 id；'builtin-assets' = 画布素材（按文件类型归入 assets/<分类>/ 子目录） */
  libraryId: string
  /** 移动的工作区内文件（相对工作区根的 POSIX 路径；画布卡片 / 素材库条目拖拽） */
  movePaths?: string[]
  /** 复制的 OS 外部文件（绝对路径；从电脑文件夹拖进素材库） */
  copyFiles?: AssetImportItem[]
}

/** 移动成功的单个条目（渲染端据此更新画布卡片引用与素材库面板） */
export interface AssetTransferMoved {
  /** 移动前的工作区相对路径（与请求 movePaths 一一对应，渲染端按它匹配卡片） */
  from: string
  /** 移动后的工作区相对路径 */
  to: string
  /** 实际落盘文件名（目标重名时带序号后缀，可能与源名不同） */
  name: string
  kind: ImportedAsset['kind']
}

export interface AssetTransferResult {
  moved: AssetTransferMoved[]
  copied: ImportedAsset[]
  failed: Array<{ name: string; error: string }>
}

/** asset:delete 请求：真删工作区内的文件（不可恢复，渲染端负责二次确认） */
export interface AssetDeleteRequest {
  /** 工作区相对路径（POSIX） */
  relPath: string
}

/** asset:rename 请求：同目录改名（newName 只取文件名段，不许携带路径分隔符） */
export interface AssetRenameRequest {
  relPath: string
  /** 新文件名（含扩展名；非法字符由主进程净化，重名自动加序号） */
  newName: string
}

/** asset:rename 结果：返回实际落盘的新名（重名加序号时与请求不同） */
export interface AssetRenameResult {
  /** 新的工作区相对路径（POSIX） */
  relPath: string
  /** 实际文件名 */
  name: string
}

