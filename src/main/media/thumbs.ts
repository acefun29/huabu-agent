import { createHash } from 'crypto'
import { mkdir, rename, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { nativeImage } from 'electron'

/**
 * 缩略图管线（性能优化方案 P1-5）。
 *
 * 卡片只有 240~320px 宽，却在解码全分辨率图片（fal 产物可达 2K+）：一张 4K 图解码后
 * ~33MB 位图。这里在主进程生成并缓存 ~512px 缩略图，卡片经 huabu-media://thumb/ 取小图，
 * 查看器才用原图。
 *
 * - 生成：nativeImage.createThumbnailFromPath（Windows 走系统缩略图缓存，零新增依赖；
 *   整图解码不发生在本进程主线程的热路径上）；
 * - 缓存：<工作区>/.huabu/thumbs/<size>/<sha1(path+mtime+size)>.png —— 内容身份含
 *   mtime+size，源文件被覆盖后自动失效重生成；
 * - 失败（格式不支持 / 系统缩略图不可用）：返回 null，协议层回退原图。
 */

/** stat 结果的内存 TTL 缓存：热图反复请求不必每次碰磁盘（越界/不存在也缓存为 null） */
const statCache = new Map<string, { mtimeMs: number; size: number } | null>()
const statPending = new Map<string, Promise<{ mtimeMs: number; size: number } | null>>()
const STAT_TTL_MS = 30_000
const statAt = new Map<string, number>()

async function statCached(absPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  const cached = statCache.get(absPath)
  if (cached !== undefined && Date.now() - (statAt.get(absPath) ?? 0) < STAT_TTL_MS) return cached
  const pending = statPending.get(absPath)
  if (pending) return pending
  const task = (async () => {
    let result: { mtimeMs: number; size: number } | null = null
    try {
      const st = await stat(absPath)
      if (st.isFile()) result = { mtimeMs: Math.round(st.mtimeMs), size: st.size }
    } catch {
      result = null
    }
    statCache.set(absPath, result)
    statAt.set(absPath, Date.now())
    statPending.delete(absPath)
    return result
  })()
  statPending.set(absPath, task)
  return task
}

/** 生成（或命中缓存）缩略图；返回缓存文件绝对路径，失败返回 null（调用方回退原图） */
export async function ensureThumbnail(
  absPath: string,
  size: number,
  thumbsDir: string
): Promise<string | null> {
  const st = await statCached(absPath)
  if (!st) return null
  const key = createHash('sha1')
    .update(`${absPath}:${st.mtimeMs}:${st.size}:${size}`)
    .digest('hex')
  const outPath = join(thumbsDir, String(size), `${key}.png`)

  const hit = await statCached(outPath)
  if (hit) return outPath

  try {
    const image = await nativeImage.createThumbnailFromPath(absPath, { width: size, height: size })
    if (image.isEmpty()) return null
    const buffer = image.toPNG()
    await mkdir(dirname(outPath), { recursive: true })
    // 原子写：同目录 tmp + rename（并发请求同一张图时最终只有一个赢家，输家的 rename 失败无所谓）
    const tmpPath = join(dirname(outPath), `.${Date.now()}-${process.pid}.tmp`)
    await writeFile(tmpPath, buffer)
    try {
      await rename(tmpPath, outPath)
    } catch {
      // Windows 上目标已存在时 rename 可能失败：直接放弃（命中已有文件即可）
      const existing = await statCached(outPath)
      if (!existing) throw new Error('缩略图落盘失败')
    }
    statCache.set(outPath, { mtimeMs: Date.now(), size: buffer.length })
    statAt.set(outPath, Date.now())
    return outPath
  } catch {
    return null
  }
}
