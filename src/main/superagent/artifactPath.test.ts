import { describe, expect, it } from 'vitest'
import { observedArtifactOf, preferObservedArtifact } from './artifactPath'

/**
 * 产物路径以工具回执为准（A02 后半句）。
 *
 * 这里的取舍：媒体工具的 `details.artifactPath` 是它自己算出来的工作区相对路径，
 * 比模型在回执 JSON 里抄一遍可靠得多；但**只有媒体工具**放这个字段，别的工具
 * （write/read/blockout）不能误当交付物。
 */
describe('observedArtifactOf', () => {
  it('取 details.artifactPath 与实测尺寸', () => {
    const observed = observedArtifactOf({
      content: [{ type: 'text', text: '已生成' }],
      details: {
        submitted: true,
        artifactPath: 'scenes/s3/out.png',
        artifact: { relPath: 'out.png', kind: 'image', width: 1920, height: 1080, durationSeconds: 5 }
      }
    })
    expect(observed).toEqual({ path: 'scenes/s3/out.png', kind: 'image', width: 1920, height: 1080, durationS: 5 })
  })

  it('反斜杠归一成 POSIX', () => {
    expect(observedArtifactOf({ details: { artifactPath: 'scenes\\s3\\a.png' } })?.path).toBe('scenes/s3/a.png')
  })

  it('没有 artifactPath（write/read/blockout 等）→ null，不把中间文件当交付物', () => {
    expect(observedArtifactOf({ details: { path: 'scenes/s3/note.md', bytes: 12 } })).toBeNull()
    expect(observedArtifactOf({ content: [{ type: 'text', text: 'ok' }] })).toBeNull()
    expect(observedArtifactOf(null)).toBeNull()
    expect(observedArtifactOf('str')).toBeNull()
  })

  it('忽略非法 kind 与非数字尺寸', () => {
    const observed = observedArtifactOf({
      details: { artifactPath: 'a.png', artifact: { kind: 'weird', width: 'big', height: 10 } }
    })
    expect(observed).toEqual({ path: 'a.png', height: 10 })
  })
})

describe('preferObservedArtifact', () => {
  // 泛型约束要求 path 可选，这里用一个带额外字段的候选产物形状（真实调用方就是 ArtifactCandidate）
  const receipt = { path: 'scenes/s3/claimed.png', artifactId: 'a1' } as { path?: string; width?: number; height?: number }

  it('工具给了不同路径 → 覆盖，并留下回执路径作为证据', () => {
    const result = preferObservedArtifact(receipt, { path: 'scenes/s3/real.png', width: 800, height: 600 })
    expect(result.artifact.path).toBe('scenes/s3/real.png')
    expect(result.artifact.width).toBe(800)
    expect(result.receiptPath).toBe('scenes/s3/claimed.png')
    expect(result.overridden).toBe(true)
  })

  it('路径一致 → 不产生证据噪音，但实测尺寸仍然覆盖', () => {
    const result = preferObservedArtifact(
      { path: 'scenes/s3/real.png', width: 1, height: 1 },
      { path: 'scenes/s3/real.png', width: 1024, height: 1024 }
    )
    expect(result.receiptPath).toBeUndefined()
    expect(result.overridden).toBe(false)
    expect(result.artifact.width).toBe(1024)
  })

  it('回执没声明路径 → 直接用工具路径（不报「无法验收」）', () => {
    const result = preferObservedArtifact<{ path?: string }>({}, { path: 'scenes/s3/real.png' })
    expect(result.artifact.path).toBe('scenes/s3/real.png')
    expect(result.overridden).toBe(true)
    expect(result.receiptPath).toBeUndefined()
  })

  it('没有观测值 → 原样返回（纯文本专家不受影响）', () => {
    const result = preferObservedArtifact(receipt, null)
    expect(result.artifact).toBe(receipt)
    expect(result.overridden).toBe(false)
  })
})
