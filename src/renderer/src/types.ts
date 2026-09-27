/**
 * 画布数据模型（huabuai-proto-v2 最新版对齐）。
 *
 * 领域模型（原型 docs/backend-interface.md 第一节）：
 * - 工作区 = 本地目录 + 素材库 + 一块公用画布 + N 个会话；
 * - 画布上只有文件卡片（按图片/视频/音频/文档/代码/其他区分）——会话不再上画布，
 *   会话 = 一段对话历史（SessionMeta + ChatData），呈现在底部对话坞；
 * - 画布卡片 = 工作区文件的引用（引用而非副本）：删卡片 ≠ 删文件；
 * - 带 gen 字段的文件卡片同时是媒体生成的执行单元（生成是状态，不是独立卡片类型）；
 * - 会话里引用素材只传绝对路径（MessageAttachment），文件内容不进上下文。
 */
import type { ChatMessageBlock, ChatStopReason } from './chatBlocks'
import type { ChatCompactionDivider, ChatContextUsage, ChatHistoryImage } from '@shared/ipc'
import type { MediaRatio } from '@shared/media'

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
   * 生成卡片的产物回喂摘要（T11）：状态 + 提示词 + 参数 + 版本数。
   * 只有带 gen 状态的画布卡片才有；buildReferencePayload 把它附在引用行尾。
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
  /** 生成状态：提示词/参考/参数/进度/版本（媒体卡片的一种状态，非独立卡片类型） */
  gen?: AssetGen
}

export type GenerateStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed'

/** 生成参数：参数在节点面板调（chip 下拉），提示词写在卡片上 */
export interface GenerateParams {
  ratio: MediaRatio
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
  createdAt: string
}

/** 文件卡片上的生成状态 */
export interface AssetGen {
  /** 最近一次提交的提示词（回显进卡片输入框，可改一字再生成） */
  prompt: string
  /** 参考资产节点 id（垫图/首帧/风格参考；连线用） */
  refs: string[]
  params: GenerateParams
  status: GenerateStatus
  /** 0..1 */
  progress: number
  /** 进行中的任务 id（media:job 事件按它回填） */
  jobId?: string
  /** status=failed 时的可操作错误文本 */
  error?: string
  versions: GenerateVersion[]
  activeVersionId?: string
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
  /** 该节点删除前的「当前生成」身份，撤销时一并恢复 */
  wasActiveGenerate: boolean
}
