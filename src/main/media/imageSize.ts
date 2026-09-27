import { readFileSync } from 'fs'

/**
 * 图片像素尺寸轻量解析（阶段 A2）。
 *
 * 只认 PNG / JPEG 两种产物容器（当前全部图片网关的落盘产物都在其中），
 * 解析不出时返回 undefined，调用方按"无尺寸"处理，绝不因此失败。
 * 不引入图片处理依赖：产物展示有 <img>，这里的尺寸只用于 Agent 结果回传与卡片元数据。
 */

export function imageSizeOf(file: string): { width: number; height: number } | undefined {
  try {
    const buf = readFileSync(file)
    if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      // PNG：IHDR 固定在 16..24 偏移，大端
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG：逐段找 SOF0..SOF15（D8/D9 除外），段内第 5 字节起为高度/宽度
      let offset = 2
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = buf[offset + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2
          continue
        }
        const size = buf.readUInt16BE(offset + 2)
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) }
        }
        offset += 2 + size
      }
    }
  } catch {
    /* 产物刚落盘被占用等场景：按无尺寸处理 */
  }
  return undefined
}
