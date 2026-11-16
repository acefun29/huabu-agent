import { describe, expect, it } from 'vitest'
import type { JournalEvent, JournalEventType } from '../superagent/journal'
import { activeTask, artifactOf, artifactsOfTask, projectWork } from './tasks'
import { currentArtifactId } from '../core/task'

/**
 * journal → Task / Artifact 的投影。
 *
 * 断言两件事：
 * 1. 四个状态在事件流里走对了；
 * 2. 非法事件被**如实记录**在 ignored 里，而不是静默丢弃或让整条投影崩掉。
 */

let seq = 0
function event(
  type: JournalEventType,
  taskId: string,
  payload: Record<string, unknown> = {},
  at = '2026-11-11T10:00:00.000Z'
): JournalEvent {
  seq += 1
  return { id: `e${seq}`, at, type, taskId, actor: 'main', payload, v: 1 }
}

const created = (id = 'V-02', at?: string): JournalEvent =>
  event(
    'work.created',
    id,
    { title: '主视觉 6 张', brief: '3 张产品正面 + 3 张场景融入', lane: 'assets/visual', kind: 'image' },
    at
  )

describe('projectWork：四态迁移', () => {
  it('created → todo，没有产物', () => {
    const state = projectWork([created()])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ id: 'V-02', status: 'todo', artifacts: [], lane: 'assets/visual' })
    expect(state.artifacts).toEqual([])
    expect(state.ignored).toEqual([])
  })

  it('created → started → 记录产物 → finished = done', () => {
    const state = projectWork([
      created(),
      event('work.started', 'V-02'),
      event('artifact.recorded', 'V-02', { path: 'assets/visual/s03.png', kind: 'image', mime: 'image/png', bytes: 2048 }),
      event('work.finished', 'V-02')
    ])
    expect(state.tasks[0]!.status).toBe('done')
    expect(state.tasks[0]!.artifacts).toHaveLength(1)
    expect(state.artifacts[0]).toMatchObject({ path: 'assets/visual/s03.png', kind: 'image', bytes: 2048 })
    expect(activeTask(state)).toBeUndefined()
  })

  it('没产出就 finished → 回到 todo（没做出来不算完成）', () => {
    const state = projectWork([created(), event('work.started', 'V-02'), event('work.finished', 'V-02')])
    expect(state.tasks[0]!.status).toBe('todo')
  })

  it('不满意再做一次：同任务累积两版，当前版是最后一条', () => {
    const state = projectWork([
      created(),
      event('work.started', 'V-02'),
      event('artifact.recorded', 'V-02', { path: 'assets/visual/v1.png', kind: 'image', mime: 'image/png', bytes: 100 }),
      event('artifact.recorded', 'V-02', { path: 'assets/visual/v2.png', kind: 'image', mime: 'image/png', bytes: 200 }),
      event('work.finished', 'V-02')
    ])
    const task = state.tasks[0]!
    expect(task.artifacts).toHaveLength(2)
    const versions = artifactsOfTask(state, task)
    expect(versions.map((artifact) => artifact.path)).toEqual(['assets/visual/v1.png', 'assets/visual/v2.png'])
    expect(artifactOf(state, task.artifacts[1])?.bytes).toBe(200)
  })

  it('dropped → 终态，不出现在活跃任务里', () => {
    const state = projectWork([created(), event('work.dropped', 'V-02')])
    expect(state.tasks[0]!.status).toBe('dropped')
    expect(activeTask(state)).toBeUndefined()
  })

  it('activeTask 找出 doing 的那一条', () => {
    const state = projectWork([created('A'), created('B'), event('work.started', 'B')])
    expect(activeTask(state)?.id).toBe('B')
  })

  it('有多个 doing 时取**最近开工**的那个（产物不能记到几天前的旧任务上）', () => {
    const state = projectWork([
      created('A'),
      event('work.started', 'A'),
      created('B'),
      event('work.started', 'B')
    ])
    expect(activeTask(state)?.id).toBe('B')
  })

  it('**同一路径再生成一次 = 新 Artifact**（§2 唯一不变量：产物不可变）', () => {
    const state = projectWork([
      created('V'),
      event('work.started', 'V'),
      event('artifact.recorded', 'V', { path: 'assets/visual/a.png', kind: 'image', mime: 'image/png', bytes: 1 }),
      event('artifact.recorded', 'V', { path: 'assets/visual/a.png', kind: 'image', mime: 'image/png', bytes: 2 })
    ])
    const task = state.tasks[0]!
    // 两个版本、两个不同 id、路径相同——不是"覆盖"，是"又产出了一版"
    expect(task.artifacts).toHaveLength(2)
    expect(new Set(task.artifacts).size).toBe(2)
    expect(state.artifacts.map((a) => a.path)).toEqual(['assets/visual/a.png', 'assets/visual/a.png'])
    expect(state.artifacts.map((a) => a.bytes)).toEqual([1, 2])
    // 当前版 = 最后产出的那个
    expect(currentArtifactId(task)).toBe(task.artifacts[1])
  })

  it('多任务保持创建顺序', () => {
    const state = projectWork([created('A'), created('B'), created('C')])
    expect(state.tasks.map((task) => task.id)).toEqual(['A', 'B', 'C'])
  })
})

describe('projectWork：非法事件如实记录', () => {
  it('对不存在任务的 started 进 ignored，不崩', () => {
    const state = projectWork([event('work.started', 'ghost')])
    expect(state.tasks).toEqual([])
    expect(state.ignored).toHaveLength(1)
    expect(state.ignored[0]!.reason).toContain('任务不存在')
  })

  it('对已 done 的任务再 start → ignored（终态不可重开）', () => {
    const state = projectWork([
      created(),
      event('work.started', 'V-02'),
      event('artifact.recorded', 'V-02', { path: 'a.png', kind: 'image', mime: 'image/png', bytes: 1 }),
      event('work.finished', 'V-02'),
      event('work.started', 'V-02')
    ])
    expect(state.tasks[0]!.status).toBe('done')
    expect(state.ignored).toHaveLength(1)
    expect(state.ignored[0]!.reason).toContain('终态')
  })

  it('距离 not doing 时记产物 → ignored', () => {
    const state = projectWork([
      created(),
      event('artifact.recorded', 'V-02', { path: 'a.png', kind: 'image', mime: 'image/png', bytes: 1 })
    ])
    expect(state.tasks[0]!.status).toBe('todo')
    expect(state.artifacts).toEqual([])
    expect(state.ignored[0]!.reason).toContain('doing')
  })

  it('未知任务类型 / 未知产物类型都进 ignored', () => {
    const unknownTask = projectWork([
      event('work.created', 'X', { title: 't', brief: 'b', lane: 'l', kind: 'hologram' })
    ])
    expect(unknownTask.tasks).toEqual([])
    expect(unknownTask.ignored[0]!.reason).toContain('未知任务类型')

    const unknownArtifact = projectWork([
      created(),
      event('work.started', 'V-02'),
      event('artifact.recorded', 'V-02', { path: 'a.bin', kind: 'hologram', bytes: 1 })
    ])
    expect(unknownArtifact.ignored[0]!.reason).toContain('未知产物类型')
  })

  it('同一任务重复创建 → 只保留第一条，重复的进 ignored', () => {
    const state = projectWork([created('V-02'), created('V-02')])
    expect(state.tasks).toHaveLength(1)
    expect(state.ignored[0]!.reason).toContain('重复创建')
  })

  it('旧模型的事件（task.created / validation.passed 等）被忽略而不是报错', () => {
    const state = projectWork([
      event('task.created', 'V-02', { prompt: 'x', accept: [] }),
      event('task.started', 'V-02')
    ])
    expect(state.tasks).toEqual([])
    expect(state.ignored).toEqual([])
  })
})
