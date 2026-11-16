import { describe, expect, it } from 'vitest'
import { MEDIA_ROOT_REL } from '../../shared/assets'
import {
  EmptyArtifactError,
  OutsideLaneError,
  artifactPathOf,
  kindFromMime,
  produceFromMedia,
  type MediaDetailsLike
} from './produce'

/**
 * produce 层的四条职责，逐条断言：
 * 路径换算、lane 校验、坏产物拒绝、附图透传。
 *
 * 这里**不测**"产物好不好"——那不属于架构（计划 §12）。
 */

const meta = { artifactId: 'a1', createdAt: '2026-11-11T10:00:00.000Z' }
const image = { data: 'BASE64', mimeType: 'image/png' }

function details(overrides: Partial<MediaDetailsLike> = {}): MediaDetailsLike {
  return {
    artifact: { relPath: 's03.png', name: 's03', mime: 'image/png', bytes: 2048 },
    ...overrides
  }
}

describe('artifactPathOf', () => {
  it('无落盘目录时，产物路径就是 relPath', () => {
    expect(artifactPathOf(details())).toBe('s03.png')
  })

  it('有 artifactDirRel 时拼在前面（历史产物的实际落盘目录）', () => {
    expect(artifactPathOf(details({ artifactDirRel: 'assets/visual' }))).toBe('assets/visual/s03.png')
  })

  it('outputDir 优先于 artifactDirRel（提交时指定的落库目录更权威）', () => {
    expect(
      artifactPathOf(details({ outputDir: 'assets/visual', artifactDirRel: MEDIA_ROOT_REL }))
    ).toBe('assets/visual/s03.png')
  })

  it('反斜杠归一、去掉多余分隔符', () => {
    expect(artifactPathOf(details({ artifactDirRel: '\\assets\\visual\\' }))).toBe('assets/visual/s03.png')
  })

  it('没有产物路径 → 抛错（不能返回一条没有文件的记录）', () => {
    expect(() => artifactPathOf({ artifact: {} })).toThrow(EmptyArtifactError)
    expect(() => artifactPathOf({})).toThrow(EmptyArtifactError)
  })

  it('路径不合法（越界）→ 抛错', () => {
    expect(() => artifactPathOf(details({ artifactDirRel: '../outside' }))).toThrow(EmptyArtifactError)
  })
})

describe('kindFromMime', () => {
  it('按 mime 前缀归类', () => {
    expect(kindFromMime('image/png')).toBe('image')
    expect(kindFromMime('video/mp4')).toBe('video')
    expect(kindFromMime('audio/wav')).toBe('audio')
    expect(kindFromMime('text/markdown')).toBe('text')
  })

  it('未知 mime 不猜成图片（避免下游按图渲染坏文件）', () => {
    expect(kindFromMime(undefined)).toBe('text')
    expect(kindFromMime('application/octet-stream')).toBe('text')
  })
})

describe('produceFromMedia', () => {
  it('正常产物：转成 Artifact，字段齐备', () => {
    const { artifact } = produceFromMedia(
      details({ artifactDirRel: 'assets/visual', params: { ratio: '16:9' } }),
      { ...meta, taskId: 'V-02' }
    )
    expect(artifact).toMatchObject({
      id: 'a1',
      path: 'assets/visual/s03.png',
      kind: 'image',
      mime: 'image/png',
      bytes: 2048,
      params: { ratio: '16:9' },
      taskId: 'V-02'
    })
  })

  it('附图透传（模型能直接看图）', () => {
    const result = produceFromMedia(details(), meta, image)
    expect(result.image).toEqual(image)
  })

  it('不给图时没有 image 字段', () => {
    expect(produceFromMedia(details(), meta).image).toBeUndefined()
  })

  it('越出 lane → 抛 OutsideLaneError，不产物', () => {
    expect(() => produceFromMedia(details({ artifactDirRel: 'story' }), { ...meta, lane: 'assets/visual' })).toThrow(
      OutsideLaneError
    )
  })

  it('lane 内（含同目录子路径）通过', () => {
    expect(() =>
      produceFromMedia(details({ artifactDirRel: 'assets/visual/s03' }), { ...meta, lane: 'assets/visual' })
    ).not.toThrow()
  })

  it('0 字节 → 抛错（宁可生成失败，也不留坏产物）', () => {
    expect(() =>
      produceFromMedia(details({ artifact: { relPath: 's03.png', mime: 'image/png', bytes: 0 } }), meta)
    ).toThrow(EmptyArtifactError)
  })

  it('缺字节数 → 抛错', () => {
    expect(() => produceFromMedia(details({ artifact: { relPath: 's03.png', mime: 'image/png' } }), meta)).toThrow(
      EmptyArtifactError
    )
  })

  it('不校验 lane 时（手工/导入产物）越界路径也放行', () => {
    expect(() => produceFromMedia(details({ artifactDirRel: 'story' }), meta)).not.toThrow()
  })
})
