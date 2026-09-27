/**
 * media 域共享类型（M11/M12）。
 *
 * 与 chat 域同一约定：这些是桥接层自定义结构，渲染端只认这些字段，
 * 不 import 任何 provider/网关 SDK 类型；主进程对各家 API 只做防腐层。
 */

/** 媒体大类。生成与导入共用 */
export type MediaKind = 'image' | 'video' | 'audio'

/**
 * Agent 媒体访问模式（workspace.json media.accessMode）：
 * - 'full'    完全访问：生成直接执行（视频仍受 confirmVideo 对话闸门约束，即现状）；
 * - 'confirm' 变更前确认：generate_image/video/audio 提交前先弹确认卡（模型/提示词/比例等），
 *             用户接受才执行、拒绝则不提交；该模式下视频的对话式闸门被确认卡取代。
 */
export type MediaAccessMode = 'full' | 'confirm'

/**
 * 媒体域默认值与比例的**唯一声明处**。
 *
 * 此前 'fal' / '16:9' / 5s / 并发 3 散在 ipc.ts、canvasStore、SettingsPanel 五处，
 * 改一处忘其余；主进程与渲染端一律从这里取。
 */
export const MEDIA_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const
export type MediaRatio = (typeof MEDIA_RATIOS)[number]
export const DEFAULT_MEDIA_PROVIDER = 'fal'
export const DEFAULT_MEDIA_RATIO: MediaRatio = '16:9'
/** 新建生成卡片 / Agent 工具的默认时长（秒） */
export const DEFAULT_MEDIA_DURATION_S = 5
/** 并发上限缺省值；workspace.json media.concurrency 可覆盖（1..8） */
export const DEFAULT_MEDIA_CONCURRENCY = 3

/**
 * 比例 → 标准像素（1K 档）。这是唯一的换算点：调用方只传语义化的 ratio，
 * 各适配器在自家协议约束上再调整（火山放大到像素下限、百炼 clamp 边长）。
 */
export function ratioToPixels(ratio: MediaRatio): { width: number; height: number } {
  switch (ratio) {
    case '1:1':
      return { width: 1024, height: 1024 }
    case '3:4':
      return { width: 864, height: 1152 }
    case '4:3':
      return { width: 1152, height: 864 }
    case '9:16':
      return { width: 720, height: 1280 }
    case '16:9':
      return { width: 1280, height: 720 }
  }
}

/**
 * 适配器类型 union 的**唯一声明处**（built-in catalog 架构）。
 *
 * workspace/store.ts 与 shared/ipc.ts 一律从这里引用，不再各自手写 union；
 * 每个类型必须在 src/main/media/adapters/registry.ts 里注册了工厂（catalog:check 校验），
 * 不允许出现「声明了类型却没有实现」的幽灵条目。
 */
export type MediaProviderType = 'gateway-fal' | 'gateway-dashscope' | 'gateway-volcark' | 'gateway-openai-compat'

/** 模型能力元数据：驱动渲染端参数面板（能力驱动化渐进迁移，见 catalog 设计 §3.2） */
export interface ModelCapabilities {
  ratios?: MediaRatio[]
  /** 可选时长档位（秒） */
  durations?: number[]
  /** 垫图/首帧数量上限 */
  maxRefImages?: number
  /** TTS 音色清单 */
  voices?: { id: string; label: string }[]
  /** 供应商特有参数的声明式描述，渲染端按此动态生成表单 */
  extraParams?: {
    key: string
    label: string
    type: 'select' | 'number' | 'text'
    options?: string[]
    default?: unknown
  }[]
}

/** 单个可生成的媒体模型（来自 provider 配置/内置目录，数据驱动：新增模型=加一行数据） */
export interface MediaModelInfo {
  /** 稳定模型 id（内置目录形态为 `provider/模型名`，如 `fal/veo3.1`）；跨进程引用用 `provider:模型id` 复合串（见 mediaResolve.toModelRef） */
  id: string
  kind: MediaKind
  /** 展示名 */
  label?: string
  /** 所属 provider id */
  provider: string
  /** 能力元数据（内置目录来源才有；可选字段，存量零破坏） */
  capabilities?: ModelCapabilities
  /** 生命周期：beta 仅标记；deprecated 不出现在新建入口 */
  status?: 'stable' | 'beta' | 'deprecated'
  /** 一句人话的成本提示，展示在参数面板 */
  costHint?: string
}

export interface MediaProviderInfo {
  id: string
  label: string
  type: MediaProviderType
  /** 清单来源：builtin 内置目录 / user 用户自建（设置页据此决定能否删除/改模型清单） */
  source?: 'builtin' | 'user'
  /** 是否已可提交（网关 = 凭据已录入或环境变量存在；mock 适配器已于 42db3cf 移除） */
  configured: boolean
  /** 凭据来源提示（workspace-store / environment / none），不含密钥内容 */
  authHint?: string
  models: MediaModelInfo[]
}

/** 提交一个媒体生成任务 */
export interface MediaGenerateRequest {
  /** 承载生成占位的画布节点 id（完成后把产物写回该节点） */
  nodeId?: string
  provider: string
  model: string
  kind: MediaKind
  prompt: string
  /**
   * 画面比例（语义参数，推荐）。像素换算在编排层统一完成（ratioToPixels），
   * 适配器只做自家协议的约束调整。与 width/height 同时给时 width/height 优先。
   */
  ratio?: MediaRatio
  /** 图片尺寸（像素，高级覆盖项；一般传 ratio 即可） */
  width?: number
  height?: number
  /** 视频/音频时长（秒，可选）；模型声明了时长档位时就近归档到合法档 */
  durationSeconds?: number
  /** 来源会话节点 id（M13：Agent 工具发起时标记产物归属） */
  sourceChatId?: string
  /**
   * 参考文件（垫图/首帧），POSIX 相对路径：优先按媒体产物目录解析（画布卡片语义），
   * 找不到再按工作区根解析（Agent 工具语义）；越出工作区的路径一律丢弃。
   * 网关 provider 会把首个图片参考转为 data URI 附到请求里。
   */
  refPaths?: string[]
  /**
   * 产物落库目录（相对工作区根的 POSIX 路径，如 素材库/海报产出）。
   * 缺省 = 媒体产物目录（.huabu/media 或 media.outputDir 配置）；
   * 指定后产物落进素材库目录，卡片以 storage=ws 引用（协议经 huabu-media://ws 服务）。
   */
  outputDir?: string
  /**
   * 期望的产物文件主名（不含扩展名；扩展名按产物实际格式定）。Agent 工具用它在生成时
   * 给素材命名（如沿用参考图的文件名前缀）。非法字符被净化、同名产物自动加序号；
   * 缺省 = jobId（随机 id 命名，即历史行为）。
   */
  name?: string
}

export type MediaJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 已落盘产物描述。渲染端用 `huabu-media://media/<相对路径>` 播放 */
export interface MediaArtifact {
  /** 相对当前工作区 `.huabu/media/` 的路径（POSIX 风格，跨平台稳定） */
  relPath: string
  name: string
  mime: string
  bytes: number
  durationSeconds?: number
  width?: number
  height?: number
}

/** 一条媒体任务的完整状态（media:job 事件与 media:jobs 查询共用） */
export interface MediaJobStatus {
  jobId: string
  provider: string
  model: string
  kind: MediaKind
  prompt: string
  state: MediaJobState
  /** 0..1，running 态才有意义 */
  progress: number
  /** 可展示的进度/错误信息 */
  message?: string
  artifact?: MediaArtifact
  /** 失败原因（可操作，不含密钥） */
  error?: string
  createdAt: string
  updatedAt: string
  nodeId?: string
  sourceChatId?: string
  /** 本任务的落库目录（相对工作区根；缺省 = 媒体产物目录）。渲染端据此决定卡片引用的 storage */
  outputDir?: string
  /**
   * 实际落盘目录（相对工作区根，POSIX）：落库时 = outputDir，否则 = 当时的媒体产物目录。
   * 卡片的 `path` 是相对这个根的，引用契约要还原绝对路径必须有它——`media.outputDir`
   * 是可以随时改的设置，事后按"当前配置"去拼老产物就会拼错。
   */
  artifactDirRel?: string
  /**
   * 协商后的实际生成参数（clamp/归档之后的值）。Agent 工具结果与画布卡片以这里为准，
   * 避免"Agent 声明 1:1、卡片按默认 16:9"的错位
   */
  params?: {
    ratio?: MediaRatio
    width?: number
    height?: number
    durationSeconds?: number
  }
}

/** media:import 请求：把操作系统里的媒体文件收编进工作区 */
export interface MediaImportRequest {
  /** 文件在磁盘上的绝对路径（preload 经 webUtils.getPathForFile 取得）；剪贴板通道可省略 */
  sourcePath?: string
  /** 文件名（拖拽时来自 File 对象） */
  name?: string
  kind?: MediaKind
  /** 剪贴板图片走这个：渲染端读出的 base64（无路径文件时的兜底通道） */
  base64?: string
  mime?: string
}

export interface MediaImportResult {
  artifact: MediaArtifact
}

/**
 * media:browse-catalog 返回的单条：设置页「浏览完整模型库」的展示形态。
 *
 * 数据来自随应用打包的全量浏览目录（main/media/catalog/data/*.ts，脚本自动生成），
 * 与生效清单分离——enabled 由主进程按当前生效清单标注，点「添加」才写入 workspace.json。
 */
export interface MediaCatalogBrowseItem {
  /** 发给网关的标识（predict 协议即 endpoint，如 'veo-4-text-to-video'） */
  id: string
  kind: MediaKind
  label: string
  /** 上游提供方名（Google / OpenAI / Kling…），列表展示用 */
  provider?: string
  capabilities?: ModelCapabilities
  /** 除 prompt 外的额外必填参数；非空时生成可能失败（提交链路只带 prompt/比例/时长/参考图） */
  needsExtra?: string[]
  /** 已在生效清单中（内置精选或用户已添加） */
  enabled: boolean
}
