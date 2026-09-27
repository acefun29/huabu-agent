import { nativeImage } from 'electron'

/**
 * 回放图片的缩略管线（计划 T4）——本模块是历史回放里唯一允许 import electron 的地方。
 *
 * 约束（风险登记）：base64 图块经 IPC 的体积必须挡在主进程。原图块（JSONL 里的
 * base64）绝不进渲染进程；这里统一缩到 ≤256px 长边、JPEG 80，单张几 KB。
 * 解码失败（格式不支持 / 数据损坏）返回 null，调用方退化为 chip。
 */
export function makeHistoryThumbnail(data: string): string | null {
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    const longest = Math.max(width, height)
    const resized = longest > 256 ? image.resize(width >= height ? { width: 256 } : { height: 256 }) : image
    const jpeg = resized.toJPEG(80)
    return jpeg.length > 0 ? jpeg.toString('base64') : null
  } catch {
    return null
  }
}
