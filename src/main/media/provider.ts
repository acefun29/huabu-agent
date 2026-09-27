import type { MediaKind, MediaModelInfo, MediaProviderType, MediaRatio } from '../../shared/media'

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

/** 提交时传给 provider 的规范化输入 */
export interface ProviderSubmitInput {
  prompt: string
  /** 画面比例（语义值，与 width/height 并存：像素派生自它，协议吃比例枚举的适配器用它） */
  ratio?: MediaRatio
  width?: number
  height?: number
  durationSeconds?: number
  /** 参考文件（垫图/首帧）绝对路径。mock 忽略；fal 把首个图片参考转 data URI 附到请求 */
  refFiles?: string[]
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

/** 常见 mime 推断 */
export function mimeForKind(kind: MediaKind, ext?: string): string {
  const byExt: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac'
  }
  if (ext && byExt[ext.toLowerCase()]) return byExt[ext.toLowerCase()]
  switch (kind) {
    case 'image':
      return 'image/png'
    case 'video':
      return 'video/mp4'
    case 'audio':
      return 'audio/wav'
  }
}

export function extForUrl(url: string, kind: MediaKind): string {
  const match = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url)
  if (match) return `.${match[1].toLowerCase()}`
  return kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.wav'
}
