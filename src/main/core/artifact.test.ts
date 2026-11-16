import { describe, expect, it } from 'vitest'
import {
  InvalidArtifactPathError,
  artifactDir,
  createArtifact,
  normalizeArtifactPath,
  type ArtifactInput
} from './artifact'

/**
 * Artifact 是纯模块：不需要 Mastra、不需要模型、不需要文件系统。
 * 这里只断言两件本质的事：**路径必须落在工作区内**、**产物不可变**。
 */

const meta = { id: 'a1', createdAt: '2026-11-11T10:00:00.000Z' }

function input(overrides: Partial<ArtifactInput> = {}): ArtifactInput {
  return { path: 'assets/visual/s03.png', kind: 'image', mime: 'image/png', bytes: 2048, ...overrides }
}

describe('normalizeArtifactPath', () => {
  it('保留正常的相对路径', () => {
    expect(normalizeArtifactPath('assets/visual/s03.png')).toBe('assets/visual/s03.png')
  })

  it('反斜杠归一成 POSIX', () => {
    expect(normalizeArtifactPath('assets\\visual\\s03.png')).toBe('assets/visual/s03.png')
  })

  it('折叠重复分隔符、去掉首尾分隔符与 . 段', () => {
    expect(normalizeArtifactPath('./story//ep01.md/')).toBe('story/ep01.md')
  })

  it('拒绝绝对路径、盘符与 UNC', () => {
    expect(normalizeArtifactPath('/etc/passwd')).toBeNull()
    expect(normalizeArtifactPath('C:\\Windows\\x.png')).toBeNull()
    expect(normalizeArtifactPath('\\\\server\\share\\x.png')).toBeNull()
  })

  it('拒绝越界（.. 在任何位置）', () => {
    expect(normalizeArtifactPath('../outside.png')).toBeNull()
    expect(normalizeArtifactPath('assets/../../etc/passwd')).toBeNull()
    expect(normalizeArtifactPath('assets/..')).toBeNull()
  })

  it('拒绝空串与只有分隔符', () => {
    expect(normalizeArtifactPath('')).toBeNull()
    expect(normalizeArtifactPath('   ')).toBeNull()
    expect(normalizeArtifactPath('/')).toBeNull()
  })
})

describe('createArtifact', () => {
  it('构造产物并保留参数', () => {
    const artifact = createArtifact(input({ params: { ratio: '16:9', durationS: 5 }, taskId: 'V-02' }), meta)
    expect(artifact).toMatchObject({
      id: 'a1',
      path: 'assets/visual/s03.png',
      kind: 'image',
      mime: 'image/png',
      bytes: 2048,
      params: { ratio: '16:9', durationS: 5 },
      taskId: 'V-02',
      createdAt: '2026-11-11T10:00:00.000Z'
    })
  })

  it('路径非法直接抛错（不留下指向非法路径的记录）', () => {
    expect(() => createArtifact(input({ path: '../escape.png' }), meta)).toThrow(InvalidArtifactPathError)
    expect(() => createArtifact(input({ path: '/abs.png' }), meta)).toThrow(InvalidArtifactPathError)
  })

  it('字节数非法抛错', () => {
    expect(() => createArtifact(input({ bytes: -1 }), meta)).toThrow(/字节数/)
    expect(() => createArtifact(input({ bytes: Number.NaN }), meta)).toThrow(/字节数/)
  })

  it('params 是拷贝：改外部对象不影响产物', () => {
    const params: Record<string, unknown> = { ratio: '1:1' }
    const artifact = createArtifact(input({ params }), meta)
    params.ratio = '16:9'
    expect(artifact.params).toEqual({ ratio: '1:1' })
  })

  it('同一路径两次产出 = 两个独立产物（不可变，不覆盖）', () => {
    const first = createArtifact(input(), { id: 'a1', createdAt: '2026-11-11T10:00:00.000Z' })
    const second = createArtifact(input(), { id: 'a2', createdAt: '2026-11-11T10:05:00.000Z' })
    expect(first.id).not.toBe(second.id)
    expect(first.path).toBe(second.path)
    expect(first.createdAt).not.toBe(second.createdAt)
  })
})

describe('artifactDir', () => {
  it('返回所在目录；顶层文件返回空串', () => {
    expect(artifactDir(createArtifact(input(), meta))).toBe('assets/visual')
    expect(artifactDir(createArtifact(input({ path: 'top.md', kind: 'text', mime: 'text/markdown' }), meta))).toBe('')
  })
})
