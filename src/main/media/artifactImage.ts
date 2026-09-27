import { existsSync } from 'fs'
import { nativeImage } from 'electron'
import { resolve, sep } from 'path'

/**
 * 图片文件 → Agent 可消费的图片块（阶段 B3/M13 多模态回传，T7 read_media 共用）。
 *
 * 用 Electron nativeImage 在主进程完成解码/缩放/编码：生成产物动辄 1024px+，
 * 原样塞进上下文会撑爆 token 预算，统一缩到 maxEdge 内再转 JPEG（照片类压缩率好）。
 *
 * 本文件不管"哪些路径允许读"：那套规则是纯函数、在 shared/assets.ts（能被
 * `pnpm asset-path:check` 断言），调用方先把绝对路径解析出来再交给这里。
 * 唯一留在下面的越界检查是"最后一道兜底"，不替代调用方的解析。
 */

export function readImageFileAsBase64(
  absPath: string,
  maxEdge = 1024
): { data: string; mimeType: string; width: number; height: number } | undefined {
  if (!absPath || !existsSync(absPath)) return undefined
  let image = nativeImage.createFromPath(absPath)
  if (image.isEmpty()) return undefined
  const { width, height } = image.getSize()
  const edge = Math.max(width, height)
  if (edge > maxEdge) {
    const scale = maxEdge / edge
    image = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
  }
  // 生成图多为照片类内容：JPEG q82 兼顾体积与还原；PNG 带透明时 nativeImage 会丢 alpha，
  // 媒体网关产物不需要透明度，可接受
  const jpeg = image.toJPEG(82)
  if (jpeg.length === 0) return undefined
  return { data: jpeg.toString('base64'), mimeType: 'image/jpeg', width, height }
}

/**
 * M13 语义保持不变：只允许解析到媒体产物目录之内（防 Agent 侧伪造相对路径越界读文件）。
 * read_media 走的是另一条更宽的路（工作区 + 产物 + inbox），由 shared/assets.ts 的解析器把关。
 */
export function readArtifactAsBase64(
  relPath: string,
  mediaDirAbs: string,
  maxEdge = 1024
): { data: string; mimeType: string } | undefined {
  const root = resolve(mediaDirAbs)
  const target = resolve(root, relPath.replace(/\\/g, '/'))
  if (!target.startsWith(root + sep) && target !== root) return undefined
  return readImageFileAsBase64(target, maxEdge)
}
