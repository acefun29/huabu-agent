import { readFile } from 'fs/promises'
import type { MediaKind, MediaRefRole } from '../../../shared/media'
import type { ProviderMediaRef } from '../provider'

/**
 * 网关适配器共用的参考素材装载工具。
 *
 * 本地文件 → base64 data URI 是各家「image_url/image/video_url 类参数吃公网 URL 或 base64」
 * 形态里唯一离线可用的官方支持形态；单文件体积上限按家、按素材大类声明在 registry 的
 * refCaps 里，这里只按传入的上限执行。
 *
 * 用 fs/promises 异步读取：参考素材可达几十 MB，同步 readFileSync 会把主进程卡住
 * 「读盘 + base64 编码」整段时间，await 让出事件循环不阻塞别的任务。
 */

/** 单条素材的跳过原因（回传给调用方，让「没传上去」变成可见事实而不是凭空消失） */
export type RefSkipReason = 'not-image' | 'empty' | 'too-large' | 'read-failed' | 'over-count'

/** 缺省单文件体积闸（未在该家 refCaps 里声明大类的兜底值） */
const DEFAULT_MAX_REF_BYTES = 12 * 1024 * 1024

/**
 * 取素材原始字节：本地文件直读；带 URL 的（用户填的公网地址、上传通道换来的临时引用）
 * 先取回来 —— multipart 通道（openai-compat）只吃文件字段，不会把 URL 原样写进 body。
 * 超上限或取不到返回 undefined，调用方按"这条没进请求"处理（编排层已做过一遍体积校验，
 * 这里是适配器侧的兜底）。
 */
export async function readRefBytes(ref: ProviderMediaRef, maxBytes?: number): Promise<Buffer | undefined> {
  try {
    if (ref.absPath) {
      const bytes = await readFile(ref.absPath)
      if (bytes.byteLength === 0 || (maxBytes && bytes.byteLength > maxBytes)) return undefined
      return bytes
    }
    if (ref.url && /^https?:/i.test(ref.url)) {
      const response = await fetch(ref.url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) return undefined
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength === 0 || (maxBytes && buffer.byteLength > maxBytes)) return undefined
      return buffer
    }
  } catch {
    return undefined
  }
  return undefined
}

/** 装好投递形态的参考素材：role + 可直接写进 body 的 url（data URI 或公网/临时引用） */
export interface PreparedRef {
  role: MediaRefRole
  mediaType: MediaKind
  url: string
}

/**
 * 把编排层校验过的参考素材装成各家协议能直接写进 body 的形态：
 * - 带 `url` 的（公网地址、上传通道换来的 oss:// 与 mm_file://）原样透传；
 * - 本地文件按该家的单文件上限转 data URI，超限/空文件/读失败逐条回传原因。
 *
 * 上限按**素材大类**给（同一家网关里图片可 base64、视频只收 URL 这类差别已在
 * registry 的 refCaps 里声明，不在这里重复）。
 */
export async function prepareRefs(
  refs: readonly ProviderMediaRef[],
  maxBytesByKind: Partial<Record<MediaKind, number>>
): Promise<{ items: PreparedRef[]; skipped: { role: MediaRefRole; reason: RefSkipReason }[] }> {
  const items: PreparedRef[] = []
  const skipped: { role: MediaRefRole; reason: RefSkipReason }[] = []
  for (const ref of refs) {
    if (ref.url) {
      items.push({ role: ref.role, mediaType: ref.mediaType, url: ref.url })
      continue
    }
    if (!ref.absPath) {
      skipped.push({ role: ref.role, reason: 'read-failed' })
      continue
    }
    const maxBytes = maxBytesByKind[ref.mediaType] ?? DEFAULT_MAX_REF_BYTES
    try {
      const bytes = await readFile(ref.absPath)
      if (bytes.byteLength === 0) {
        skipped.push({ role: ref.role, reason: 'empty' })
        continue
      }
      if (bytes.byteLength > maxBytes) {
        skipped.push({ role: ref.role, reason: 'too-large' })
        continue
      }
      items.push({ role: ref.role, mediaType: ref.mediaType, url: `data:${ref.mime};base64,${bytes.toString('base64')}` })
    } catch {
      skipped.push({ role: ref.role, reason: 'read-failed' })
    }
  }
  return { items, skipped }
}
