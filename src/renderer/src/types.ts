/**
 * 画布数据模型（huabuai-proto-v2 最新版对齐）。
 *
 * 领域模型（原型 docs/backend-interface.md 第一节）：
 * - 工作区 = 本地目录 + 素材库 + 一块公用画布 + N 个会话；
 * - 画布上只有文件卡片（按图片/视频/音频/文档/代码/其他区分）——会话不再上画布，
 *   会话 = 一段对话历史（SessionMeta + ChatData），呈现在底部对话坞；
 * - 画布卡片 = 工作区文件的引用（引用而非副本）：删卡片 ≠ 删文件；
 * - 生成产物就是普通媒体卡片：生成历史（版本栈）存在卡片详情里，生成信息随
 *   版本的 inputs 定格快照持久化；引用链是生成事实的只读投影，由生成时自动
 *   形成（mediaReferenceGraph.getCardReferences），用户与 Agent 都不能手动连线；
 * - 会话里引用素材只传绝对路径（MessageAttachment），文件内容不进上下文。
 */
import type { ChatMessageBlock, ChatStopReason } from './chatBlocks'
import type { ChatCompactionDivider, ChatContextUsage, ChatHistoryImage } from '@shared/ipc'
import type { MediaRatio, MediaRefRole } from '@shared/media'

export type { ChatMessageBlock, ChatToolCallView } from './chatBlocks'

export type NodeType = 'asset'
export type AssetKind = 'image' | 'video' | 'audio' | 'doc' | 'code' | 'other'
/** 可生成的媒体大类（与主进程 MediaKind 对齐） */
export type MediaKind = 'image' | 'video' | 'audio'

/** kind 的中文标签（从 lib/media 归位到类型层，harness/prompt.ts 也用） */
export const KIND_LABEL: Record<AssetKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  doc: '文档',
  code: '代码',
  other: '文件'
}

/**
 * 消息携带的素材引用：给 Agent 的一律是文件绝对路径，Agent 按路径自行读取内容。
 * 载荷文本由 harness/prompt.ts 的 buildReferencePayload 生成并拼在消息文本末尾，
 * 此字段用于 UI 回显，两者同源（@backend(payload)）。
 */
export interface MessageAttachment {
  id: string
  name: string
  kind: AssetKind
  /** 文件绝对路径（统一 '/' 分隔符） */
  absPath: string
  /**
   * workspace-asset = 工作区素材（画布钉住的文件，位于工作目录内）；
   * temp-upload = 临时上传（直接拖入会话输入框，位于工作区之外的应用数据目录 inbox）。
   */
  origin: 'workspace-asset' | 'temp-upload'
  /**
   * 生成历史回喂摘要：激活版本的提示词/参数 + 血脉链（deriveLineage）。
   * 只有带生成历史（versions）的画布卡片才有；buildReferencePayload 把它附在引用行尾。
   */
  genSummary?: string
}

/**
 * 消息正文。content 是全部 text 块的拼接（列表摘要、fork 快照等用），
 * 渲染一律走 blocks（正文/思维链/工具卡片交错，顺序以定稿消息为准）。
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'model'
  content: string
  blocks?: ChatMessageBlock[]
  streaming?: boolean
  stopReason?: ChatStopReason
  errorMessage?: string
  /** 实际响应模型（provider/model），可能与请求的不同 */
  model?: string
  /** 本条消息引用的素材（只传绝对路径，不携带文件内容） */
  attachments?: MessageAttachment[]
  /**
   * 压缩分界分隔条（T2 流式本地合成 / T4 回放从 CompactionEntry 重建，两处同形）：
   * 有此字段时渲染为分隔线而非气泡。
   */
  compaction?: ChatCompactionDivider
  /** false = 该条已被压缩截断或不在当前分支，模型上下文里没有它（回放标记，UI 淡化） */
  inContext?: boolean
  /** 消息级图片缩略（回放：user 消息里的 image 块；原图不出主进程） */
  images?: ChatHistoryImage[]
  /** 本轮注入的上下文段（回放按自产文本头拆分，UI 折叠展示；正文在 content） */
  contextPayload?: string
}

/**
 * 会话：一段对话历史（会话级数据，与画布完全分离，呈现在底部对话坞）。
 * 新建/切换/删除会话都不动画布 —— 画布是工作区级、所有会话公用的编排视图。
 */
export interface SessionMeta {
  id: string
  title: string
  /** Pi 会话 JSONL 文件（工作区 .huabu/sessions/ 内）；尚未发问过的会话没有 */
  sessionFile?: string
  /** 会话绑定模型（provider/model），创建成功后写入 */
  modelId?: string
  /** 会话思考档位（THINKING_LEVELS 之一；未建会话时暂存，创建时随 create 请求生效） */
  thinkingLevel?: string
  /** fork 来源会话 id 与当时的标题快照（fork 只复制对话历史，画布公用不复制） */
  forkedFromId?: string
  forkedFromLabel?: string
  createdAt: string
}

/** 会话的对话历史与流式状态（内存态；持久化靠 .huabu/sessions/*.jsonl + canvas.json meta.sessions） */
export interface ChatData {
  title: string
  history: ChatMessage[]
  /** 本轮是否正在流式生成 */
  running?: boolean
  /** 最近一次上下文水位（context_usage 事件；tokens=null 表示压缩后待下一轮响应） */
  contextUsage?: ChatContextUsage
  /** 压缩进行中（compaction_start..compaction_end 之间；独立于 running 的状态机） */
  compacting?: boolean
}

/** 文件在磁盘上的位置。media = 工作区产物目录；ws = 工作区内任意文件 */
export type AssetStorage = 'media' | 'ws'

/** 素材库/工作目录内的文件条目（path 相对工作区根） */
export interface DirEntry {
  name: string
  kind: AssetKind
  path: string
  bytes?: number
}

/**
 * 素材库：名字 → 工作区内相对路径 的映射（工作区级共享；主进程侧定义见 shared/ipc.ts）。
 * builtin = assets/ 自动归档的合成库（只读不可删）；isPublic = 公共库（默认落库兜底）。
 */
export type { AssetLibrary as MaterialLibrary } from '@shared/ipc'

/**
 * 文件卡片：工作目录内真实文件的引用（引用而非副本）。
 * 生成完成前（待生成/生成中）卡片尚无文件，path 为空。
 */
export interface AssetData {
  name: string
  kind: AssetKind
  /** 文件位置形态；无文件（未生成）时缺省 */
  storage?: AssetStorage
  /** 相对 storage 根的 POSIX 路径 */
  path?: string
  /**
   * storage='media' 时，`path` 实际相对哪个目录（相对工作区根）。由任务事件
   * artifactDirRel 写入；缺省 = 默认产物根（老卡片）。解析引用必须走 shared/assets.ts
   * 的 assetAbsPath，不能直接把 path 当工作区相对路径拼。
   */
  pathRoot?: string
  /** 所属素材库（素材库 = 工作区内 名字→相对路径 的映射）；缺省 = 未归类 */
  libraryId?: string
  /**
   * 文件标签：小胶囊贴在画布元素上，只在卡片选中时显示与编辑。
   * 文件级元数据（真相在主进程 .huabu/tags.json），画布卡片与素材库条目同源。
   */
  tags?: string[]
  mime?: string
  bytes?: number
  meta?: string
  /** 由哪段会话产出（Agent 写回工作目录时标记；会话已不上画布，仅存引用关系） */
  fromChatId?: string
  /**
   * 生成历史（版本栈，新版本插头部）。产物即媒体卡：生成信息全部在版本里
   * （prompt/model/inputs 定格），没有独立的"生成卡片"形态。
   */
  versions?: GenerateVersion[]
  /** 当前展示的版本；切换版本时同步覆写 storage/path/... 指向该版文件 */
  activeVersionId?: string
  /** 在途生成任务绑定（transient：提交时写入、终态清除；重启后 reconcileJobs 对账） */
  pendingJob?: AssetPendingJob
  /**
   * legacy 引用链：迁移自旧结构 AssetGen.references 的手动链，只读展示，新代码不写。
   * 当前链条的权威来源是激活版本 inputs.refs，解析顺序见 getCardReferences。
   */
  references?: GenerateReference[]
  /** 更旧的 legacy 兼容视图（refs/refRoles），解析链最末级才读 */
  refs?: string[]
  refRoles?: Record<string, MediaRefRole>
}

/** 在途生成任务绑定：卡片上的最小持久化痕迹，运行态（进度/错误）在 jobRuntime 内存 */
export interface AssetPendingJob {
  jobId: string
  /** 提交时冻结的输入定格（任务成功时整体落进新版本 inputs） */
  inputs?: GenerateInputSnapshot
}

/**
 * 生成 Popover 的打开目标（直接生成入口，锚定卡片/划选/画布光标）。
 * 引用链由生成事实自动形成：这里只选"这次生成用哪些卡当参考"，
 * 角色由系统按当前模型能力派生，用户不指定。
 */
export interface GenComposerTarget {
  /** Popover 锚点（画布世界坐标；CanvasWorkspace 负责换算视口定位） */
  at: { x: number; y: number }
  /** 预选参考卡 id（"以此为参考生成"）；缺省 = 无 */
  refs?: string[]
  /** 再次生成的目标卡（就地加新版本，Popover 回填其激活版本输入）；缺省 = 生成新卡 */
  targetNodeId?: string
  kind?: MediaKind
}

/** 生成参数：在生成 Popover 调（chip 下拉），提交时随 GenerateInputSnapshot 定格 */
export interface GenerateParams {
  /**
   * 画面比例。可选：挂了首帧图的视频模型常常"比例随首帧"（官方 adaptive），
   * 留空 = 不向模型声明比例。老的 canvas.json 里没有这个字段的照读不误。
   */
  ratio?: MediaRatio
  /** 视频/音频时长（秒） */
  durationSeconds?: number
  /** 媒体模型（`provider:model` 复合串），空 = 按回退链解析 */
  model?: string
  /** 产物落库：手动指定素材库 id（优先级最高；缺省走设置里的默认链） */
  libraryId?: string
}

/** 一次生成的产物（写回工作目录的真实文件） */
export interface GenerateVersion {
  id: string
  storage: AssetStorage
  path: string
  /** 同 AssetData.pathRoot：产物落盘目录（相对工作区根），media 形态还原绝对路径必需 */
  pathRoot?: string
  name: string
  mime?: string
  bytes?: number
  thumbnail?: string
  /** 当时的提示词 */
  prompt: string
  model?: string
  /** 产出该版本的真实任务 id（media job；运行时按它去重/回溯） */
  jobId?: string
  /** 提交时的输入定格（参考快照/参数/模型，见 GenerateInputSnapshot）。老版本无此字段 = 无从比对，引用新鲜度读作 unknown */
  inputs?: GenerateInputSnapshot
  createdAt: string
}

/**
 * 一条引用链记录（引用边的模型）。链条是生成事实的只读投影：权威来源 =
 * 激活版本 inputs.refs（生成时自动写入）；data.references 仅承载迁移自旧结构
 * AssetGen.references 的手动链（legacy 展示）。读一律走 getCardReferences。
 */
export interface GenerateReference {
  id: string
  sourceNodeId: string
  role: MediaRefRole
  /** 在该卡参考序列中的位次（0 起） */
  order: number
}

/** 提交生成时一条参考素材的定格快照（GenerateInputSnapshot.refs 的元素） */
export interface GenerateRefSnapshot {
  referenceId: string
  /**
   * 来源卡片 id。Agent 引用画布外文件（临时上传等）时反查不到卡片 → 缺省：
   * 历史与文件落点保留在快照里，但链条不画。
   */
  sourceNodeId?: string
  role: MediaRefRole
  sourceName: string
  /** 来源是生成卡时被引用的版本 id：上游再生成（activeVersionId 变化）即可判 changed；只改提示词不算 */
  sourceVersionId?: string
  storage: AssetStorage
  path: string
  pathRoot?: string
  mime?: string
  bytes?: number
}

/** 提交生成的输入定格（版本级事实源）：历史回放、引用链派生、血脉推导都以它为准 */
export interface GenerateInputSnapshot {
  prompt: string
  params: GenerateParams
  provider: string
  model: string
  refs: GenerateRefSnapshot[]
  createdAt: number
}

/**
 * 画布节点：文件卡片的图钉（位置/尺寸/层级 + 文件引用数据）。
 * 画布是工作区级数据（随 .huabu/canvas.json 持久化），所有会话共用。
 */
export interface CanvasNode {
  id: string
  type: NodeType
  x: number
  y: number
  width: number
  height: number
  data: AssetData
  zIndex: number
}

/** 视口状态（随画布一起持久化） */
export interface ViewState {
  x: number
  y: number
  scale: number
}

/** 当前工作区（绑定真实目录；一个工作区一张公用画布） */
export interface Workspace {
  path: string
  name: string
}

/** 删除撤销缓冲：删除动作可通过 Toast 撤销（只针对画布引用卡片，文件不动） */
export interface UndoEntry {
  nodes: CanvasNode[]
  label: string
}
