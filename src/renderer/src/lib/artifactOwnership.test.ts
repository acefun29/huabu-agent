import { describe, expect, it } from 'vitest'
import type { WorkArtifactView, WorkTaskView } from '@shared/ipc'
import { buildOwnership } from './artifactOwnership'

function task(id: string, artifacts: string[]): WorkTaskView {
  return {
    id,
    title: `${id} 的任务`,
    brief: '',
    lane: 'assets/visual',
    kind: 'image',
    status: 'done',
    artifacts,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z'
  }
}

function artifact(id: string, path: string): WorkArtifactView {
  return {
    id,
    path,
    kind: 'image',
    mime: 'image/png',
    bytes: 1,
    createdAt: '2026-11-12T00:00:00.000Z'
  }
}

describe('buildOwnership', () => {
  it('路径映射到任务与版本序号', () => {
    const owners = buildOwnership(
      [task('V-02', ['a1', 'a2'])],
      [artifact('a1', 'assets/visual/1.png'), artifact('a2', 'assets/visual/2.png')]
    )
    expect(owners.get('assets/visual/1.png')).toMatchObject({ taskId: 'V-02', index: 1 })
    expect(owners.get('assets/visual/2.png')).toMatchObject({ taskId: 'V-02', index: 2 })
  })

  it('没有任务归属的产物不进映射（素材卡不该有角标）', () => {
    const owners = buildOwnership([task('V-02', ['a1'])], [artifact('a1', 'assets/visual/1.png')])
    expect(owners.has('assets/visual/other.png')).toBe(false)
    expect(owners.size).toBe(1)
  })

  it('任务里引用了不存在的产物 id 时跳过，不抛错', () => {
    const owners = buildOwnership([task('V-02', ['ghost', 'a1'])], [artifact('a1', 'assets/visual/1.png')])
    expect(owners.size).toBe(1)
    expect(owners.get('assets/visual/1.png')?.index).toBe(2)
  })

  it('同一路径被两个任务写过时，后写的任务胜出', () => {
    const owners = buildOwnership(
      [task('V-01', ['a1']), task('V-02', ['a2'])],
      [artifact('a1', 'story/ep.md'), artifact('a2', 'story/ep.md')]
    )
    expect(owners.get('story/ep.md')?.taskId).toBe('V-02')
  })

  it('空输入不抛错', () => {
    expect(buildOwnership([], []).size).toBe(0)
  })
})
