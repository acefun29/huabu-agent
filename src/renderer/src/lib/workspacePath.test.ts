import { describe, expect, it } from 'vitest'
import { nodeRelPath } from './workspacePath'

describe('nodeRelPath', () => {
  it('media 形态：拼上 pathRoot', () => {
    expect(nodeRelPath({ storage: 'media', path: 'a.png', pathRoot: 'assets/visual' })).toBe(
      'assets/visual/a.png'
    )
  })

  it('media 形态缺 pathRoot 时回落到产物根', () => {
    expect(nodeRelPath({ storage: 'media', path: 'a.png' })).toBe('.huabu/media/a.png')
  })

  it('pathRoot 末尾斜杠不产生双斜杠', () => {
    expect(nodeRelPath({ storage: 'media', path: 'a.png', pathRoot: 'assets/visual/' })).toBe(
      'assets/visual/a.png'
    )
  })

  it('ws 形态：path 已是工作区相对路径', () => {
    expect(nodeRelPath({ storage: 'ws', path: 'story/a.md' })).toBe('story/a.md')
  })

  it('缺 path → null', () => {
    expect(nodeRelPath(null)).toBeNull()
    expect(nodeRelPath(undefined)).toBeNull()
    expect(nodeRelPath({})).toBeNull()
    expect(nodeRelPath({ storage: 'media' })).toBeNull()
  })
})
