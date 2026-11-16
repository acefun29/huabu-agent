import { describe, expect, it } from 'vitest'
import type { WorkArtifactView, WorkTaskView } from '@shared/ipc'
import { buildWorkGroups, textArtifacts, visualArtifacts } from './workModel'

function task(over: Partial<WorkTaskView> & { id: string }): WorkTaskView {
  return {
    title: '任务',
    brief: '说明',
    lane: 'assets/visual',
    kind: 'image',
    status: 'todo',
    artifacts: [],
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
    ...over
  }
}

function artifact(over: Partial<WorkArtifactView> & { id: string; path: string }): WorkArtifactView {
  return {
    kind: 'image',
    mime: 'image/png',
    bytes: 100,
    createdAt: '2026-11-12T00:00:00.000Z',
    ...over
  }
}

describe('buildWorkGroups', () => {
  it('只保留 doing / todo，已完成和已放弃被丢掉', () => {
    const groups = buildWorkGroups({
      tasks: [
        task({ id: 'V-01', status: 'done' }),
        task({ id: 'V-02', status: 'doing' }),
        task({ id: 'V-03', status: 'todo' }),
        task({ id: 'V-04', status: 'dropped' })
      ],
      artifacts: [],
      ignored: []
    })
    expect(groups.doing.map((item) => item.id)).toEqual(['V-02'])
    expect(groups.todo.map((item) => item.id)).toEqual(['V-03'])
  })

  it('产物按任务里的顺序解析出来', () => {
    const groups = buildWorkGroups({
      tasks: [task({ id: 'V-02', status: 'doing', artifacts: ['a1', 'a2', 'missing'] })],
      artifacts: [
        artifact({ id: 'a2', path: 'assets/visual/2.png' }),
        artifact({ id: 'a1', path: 'assets/visual/1.png' })
      ],
      ignored: []
    })
    expect(groups.doing[0]!.artifacts.map((a) => a.path)).toEqual([
      'assets/visual/1.png',
      'assets/visual/2.png'
    ])
  })

  it('空投影 / null 都得到空分组', () => {
    expect(buildWorkGroups(null)).toEqual({ doing: [], todo: [] })
    expect(buildWorkGroups({ tasks: [], artifacts: [], ignored: [] })).toEqual({
      doing: [],
      todo: []
    })
  })
})

describe('visualArtifacts / textArtifacts', () => {
  it('按 kind 分开图与文本', () => {
    const groups = buildWorkGroups({
      tasks: [task({ id: 'V-01', status: 'doing', artifacts: ['i1', 't1'] })],
      artifacts: [
        artifact({ id: 'i1', path: 'assets/visual/a.png', kind: 'image' }),
        artifact({ id: 't1', path: 'story/a.md', kind: 'text', mime: 'text/markdown' })
      ],
      ignored: []
    })
    const item = groups.doing[0]!
    expect(visualArtifacts(item).map((a) => a.path)).toEqual(['assets/visual/a.png'])
    expect(textArtifacts(item).map((a) => a.path)).toEqual(['story/a.md'])
  })
})
