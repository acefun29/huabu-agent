import { describe, expect, it } from 'vitest'
import { MEDIA_SRC_MARKER, mediaEvictionAnchor } from './contextEviction'

/**
 * 图片锚点文本的**字节契约**。
 *
 * 这条文案不是给人看的装饰：它会被写进历史消息（替代已淘汰的图片块），
 * 而压缩指令要求「逐条原样保留含完整路径的锚点」——锚点格式一变，压缩摘要的保留
 * 规则就对不上；前缀缓存也依赖它逐字节稳定（同一路径永远得到同一段文本）。
 *
 * 原先靠 `scripts/context-eviction-probe.cjs` 锁这段文本，那个探针随 pi 的淘汰
 * 逻辑一起删了（`evictAllImages` 只被它使用）。这里用 vitest 把契约留下。
 */
describe('图片淘汰锚点', () => {
  it('带路径时逐字节固定（含完整路径与 read_media 指引）', () => {
    expect(mediaEvictionAnchor('assets/scenes/s3/shot12.png')).toBe(
      '[图片已从上下文移除 · 文件：assets/scenes/s3/shot12.png · 画面未随历史保留。需要查看画面或将其用作图生图/图生视频参考时，必须用 read_media 读取该路径，或在生成参数中直接引用该路径。不要凭文件名猜测画面内容。]'
    )
  })

  it('路径缺失时用固定占位串，不留空档', () => {
    expect(mediaEvictionAnchor(null)).toBe(
      '[图片已从上下文移除 · 文件：路径未记录 · 画面未随历史保留。需要查看画面或将其用作图生图/图生视频参考时，必须用 read_media 读取该路径，或在生成参数中直接引用该路径。不要凭文件名猜测画面内容。]'
    )
  })

  it('同一路径每次产出完全相同的文本（前缀缓存友好）', () => {
    expect(mediaEvictionAnchor('a/b.png')).toBe(mediaEvictionAnchor('a/b.png'))
  })

  it('标记行前缀固定：工具结果与锚点提取靠它精确定位', () => {
    expect(MEDIA_SRC_MARKER).toBe('[huabu:media-src ')
  })
})
