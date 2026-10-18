import type { MediaKind, MediaModelInfo, MediaProviderType, MediaRatio, MediaRefRole } from '../../shared/media'
import { MEDIA_EXT_KIND_MIME, extOfPath } from '../../shared/media'

/**
 * MediaProvider 契约层（M11）。
 *
 * 主进程内统一的媒体生成能力，屏蔽各家 API 差异。与 AgentHost 对 pi 的处理同构：
 * 对具体 SDK/REST 只做防腐层，渲染进程永不感知 provider 类型。
 *
 * 适配器实现全部住在 ../adapters/ 下并自注册到 registry（新增供应商类型 = 新增一个
 * 文件 + barrel 里一行 import，不触碰 ipc.ts）；模型清单来自 ../media/catalog 的内置
 * 目录与 workspace.json 用户覆盖层合并（mergeCatalog），「加模型」是纯数据改动。
 */

/**
 * 已解析、可直接装进各家协议 body 的参考素材。
 *
 * **只带路径/URL 与字节数，绝不带 base64**：这条结构会随 JobRecord 长期驻留在内存里
 * （账本保留最近 50 条终态任务），编码必须在 adapter.submit 内部即时做、即时释放。
 */
export interface ProviderMediaRef {
  role: MediaRefRole
  /** 素材大类（由扩展名判定，已校验与 role 匹配） */
  mediaType: MediaKind
  mime: string
  /** 原始字节数（编排层 stat 得到，适配器据此自决 data URI 还是 multipart） */
  bytes: number
  /** 本地文件绝对路径（已校验存在/越界/类型/配额）；与 url 互斥 */
  absPath?: string
  /** 公网 URL，或上传通道换来的临时引用（oss://… / mm_file://…），原样透传 */
  url?: string
}

/** 提交时传给 provider 的规范化输入 */
export interface ProviderSubmitInput {
  prompt: string
  /** 画面比例（语义值，与 width/height 并存：像素派生自它，协议吃比例枚举的适配器用它） */
  ratio?: MediaRatio
  width?: number
  height?: number
  /** 视频/音频时长（秒） */
  durationSeconds?: number
  /** 音色 id（音频通道；编排层已按 capabilities.voices 校验过，缺省 = 适配器默认） */
  voice?: string
  /**
   * 带角色的参考素材（编排层已完成类型校验、配额截断与投递形态判定）。
   * 适配器读参考素材的唯一入口，见 {@link submitRefs}。
   */
  refs?: ProviderMediaRef[]
  /** 经 capabilities.extraParams 白名单校验过的供应商特有参数（未声明的键不会到这里） */
  extra?: Record<string, string | number | boolean>
}

/**
 * 适配器读取参考素材的唯一入口：原样透传编排层校验过的素材。
 * 角色、大类、体积、投递形态都在闸门定过，适配器只做协议映射 ——
 * 需要按大类挑字段（图/视频/音频）的自己 `filter((r) => r.mediaType === …)`。
 */
export function submitRefs(input: ProviderSubmitInput): ProviderMediaRef[] {
  return input.refs ?? []
}

/**
 * 附加参数取值：适配器只挑自家协议真认识的键（调用点显式写 key），
 * 没被任何调用点挑走的键永远不会进请求体。编排层已按 capabilities.extraParams
 * 白名单校验过，这里不再判合法性，只按类型取用。
 */
export function extraOf(input: ProviderSubmitInput, key: string): string | number | boolean | undefined {
  return input.extra?.[key]
}

/** 一次轮询的结果。gateway 返回 URL（由编排层下载），mock 直接给本地文件 */
export interface ProviderPollResult {
  status: 'running' | 'succeeded' | 'failed'
  progress?: number
  message?: string
  resultUrl?: string
  resultFile?: string
  fileExt?: string
  mime?: string
  durationSeconds?: number
}

export interface MediaProviderAdapter {
  readonly id: string
  readonly type: MediaProviderType
  readonly label: string
  readonly models: MediaModelInfo[]
  /** 凭据是否就绪（同步保守判断，mock 恒 true；网关只在提交时强校验） */
  isConfigured(): boolean
  /**
   * 凭据是否真实就绪（异步：查加密存储/环境变量）。清单链路（media:providers、
   * 设置页绿点）一律用这个，isConfigured 只做提交前的同步快判。
   */
  isReady?(): Promise<boolean>
  /** 凭据来源提示（不含密钥） */
  authHint(): string
  submit(model: string, input: ProviderSubmitInput): Promise<string>
  poll(model: string, jobId: string): Promise<ProviderPollResult>
  cancel?(jobId: string): Promise<void>
}

/** 常见 mime 推断（扩展名表在 shared/media 的 MEDIA_EXT_KIND_MIME，全仓唯一一份） */
export function mimeForKind(kind: MediaKind, ext?: string): string {
  const byExt = ext ? MEDIA_EXT_KIND_MIME[ext.toLowerCase()]?.mime : undefined
  return byExt ?? (kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav')
}

export function extForUrl(url: string, kind: MediaKind): string {
  return extOfPath(url) || (kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.wav')
}
