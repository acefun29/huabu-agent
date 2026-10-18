import type { MediaKind } from '../../../shared/media'

/**
 * 媒体参考素材的上传通道（临时引用换取）。
 *
 * 有些网关的参考视频/音频**根本没有 base64 形态**（百炼的 reference_video/reference_audio
 * 只收公网 URL 或 `oss://` 临时引用），本地文件必须先上传换一个带有效期的引用再提交。
 * 这一层就是干这件事：把「本地文件」换成「可以直接写进请求体的引用字符串」，并缓存
 * 换好的引用（同一素材重复生成不必反复上传）。
 *
 * 与适配器 registry 的分工：`refCaps.byKind[k].uploadChannel` 声明**这家这类素材走哪个通道**，
 * 这里实现**通道本身**。通道属于网关协议家族，不属于模型能力。
 *
 * 必须保持 electron-free（只准 node 内建 + 全局 fetch/FormData/Blob）。
 */

/** 一次上传的输入 */
export interface UploadTarget {
  /** 本地文件绝对路径 */
  absPath: string
  /** 落到远端时用的文件名（网关多数字段对文件名有字符要求） */
  fileName: string
  mime: string
  mediaType: MediaKind
  /** 目标模型（临时存储按模型授权：百炼 getPolicy 就要带 model） */
  model: string
  /** 该家网关的 API Key */
  key: string
  /** 该家网关的 base URL（用户在设置页改过域名时必须跟着走） */
  baseUrl?: string
}

/** 上传结果：可直接写进请求体的引用 + 有效期 */
export interface UploadTicket {
  /** `oss://…` / `mm_file://…` 这类引用串（不是 http URL，形状由各家协议决定） */
  ref: string
  /** 引用过期时刻（epoch ms）；0 = 未知有效期（不进缓存） */
  expiresAt: number
}

export interface UploadChannel {
  id: string
  /**
   * 官方承诺的临时存储有效期（毫秒）。缓存取它的 90% 作安全边际 —— 宁可在到期前
   * 重传一次，也不要把一个已经失效的引用递进请求体（网关那边只会回一句看不懂的 400）。
   */
  ttlMs: number
  /** 单文件上限（字节）：超了直接拒，不让网关报错 */
  maxBytes: number
  upload(target: UploadTarget): Promise<UploadTicket>
}

const channels = new Map<string, UploadChannel>()

/** 通道自注册（各家文件末尾调用，与适配器 registerAdapter 同构） */
export function registerChannel(channel: UploadChannel): void {
  channels.set(channel.id, channel)
}

export function channelFor(id: string): UploadChannel | undefined {
  return channels.get(id)
}
