import { describe, expect, it } from 'vitest'
import {
  TaskTransitionError,
  createTask,
  currentArtifactId,
  dropTask,
  finishTask,
  isTerminal,
  isWithinLane,
  recordArtifact,
  startTask,
  type Task,
  type TaskInput
} from './task'

/**
 * Task 四个状态的完整迁移。
 *
 * 这里刻意覆盖「非法迁移要抛错」——不是防御，是接口边界：
 * 终态不可重开、产物只能记在 doing 上，这些是定义，不是可选项。
 */

const meta = { id: 'V-02', createdAt: '2026-11-11T10:00:00.000Z' }
const T1 = '2026-11-11T10:01:00.000Z'
const T2 = '2026-11-11T10:02:00.000Z'

function input(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    title: '主视觉 6 张',
    brief: '3 张产品正面 + 3 张场景融入',
    lane: 'assets/visual',
    kind: 'image',
    ...overrides
  }
}

function newTask(overrides: Partial<TaskInput> = {}): Task {
  return createTask(input(overrides), meta)
}

describe('createTask', () => {
  it('建出来就是 todo，且没有产物', () => {
    const task = newTask()
    expect(task).toMatchObject({ id: 'V-02', status: 'todo', artifacts: [], lane: 'assets/visual' })
    expect(task.createdAt).toBe(task.updatedAt)
  })

  it('title / brief / lane 为空都拒绝', () => {
    expect(() => newTask({ title: '  ' })).toThrow(TaskTransitionError)
    expect(() => newTask({ brief: '' })).toThrow(TaskTransitionError)
    expect(() => newTask({ lane: '/' })).toThrow(TaskTransitionError)
  })

  it('lane 归一化（反斜杠、首尾分隔符）', () => {
    expect(newTask({ lane: '\\assets\\visual\\' }).lane).toBe('assets/visual')
  })
})

describe('startTask', () => {
  it('todo → doing', () => {
    expect(startTask(newTask(), T1).status).toBe('doing')
  })

  it('已在 doing 幂等（不刷新 updatedAt）', () => {
    const doing = startTask(newTask(), T1)
    expect(startTask(doing, T2)).toBe(doing)
  })

  it('终态不可重开', () => {
    const done = finishTask(recordArtifact(startTask(newTask(), T1), 'a1', T1), T2)
    expect(() => startTask(done, T2)).toThrow(TaskTransitionError)
    expect(() => startTask(dropTask(newTask(), T1), T2)).toThrow(TaskTransitionError)
  })
})

describe('recordArtifact', () => {
  it('按顺序追加，最后一个是当前版', () => {
    const doing = startTask(newTask(), T1)
    const one = recordArtifact(doing, 'a1', T1)
    const two = recordArtifact(one, 'a2', T2)
    expect(two.artifacts).toEqual(['a1', 'a2'])
    expect(currentArtifactId(two)).toBe('a2')
    expect(currentArtifactId(doing)).toBeUndefined()
  })

  it('只允许记在 doing 上（产物必须归属正在执行的任务）', () => {
    expect(() => recordArtifact(newTask(), 'a1', T1)).toThrow(/只有 doing/)
  })

  it('产物 id 不能为空', () => {
    expect(() => recordArtifact(startTask(newTask(), T1), '  ', T1)).toThrow(TaskTransitionError)
  })

  it('不改原对象', () => {
    const doing = startTask(newTask(), T1)
    recordArtifact(doing, 'a1', T1)
    expect(doing.artifacts).toEqual([])
  })
})

describe('finishTask', () => {
  it('有产物 → done', () => {
    const finished = finishTask(recordArtifact(startTask(newTask(), T1), 'a1', T1), T2)
    expect(finished.status).toBe('done')
    expect(isTerminal(finished.status)).toBe(true)
  })

  it('无产物 → 回到 todo（没做出来不算完成，重启后也不会被当成在途）', () => {
    expect(finishTask(startTask(newTask(), T1), T2).status).toBe('todo')
  })

  it('todo 上不能收工；已放弃的不能收工', () => {
    expect(() => finishTask(newTask(), T1)).toThrow(TaskTransitionError)
    expect(() => finishTask(dropTask(newTask(), T1), T2)).toThrow(TaskTransitionError)
  })

  it('已 done 幂等', () => {
    const done = finishTask(recordArtifact(startTask(newTask(), T1), 'a1', T1), T2)
    expect(finishTask(done, T2)).toBe(done)
  })
})

describe('dropTask', () => {
  it('任意非终态 → dropped', () => {
    expect(dropTask(newTask(), T1).status).toBe('dropped')
    expect(dropTask(startTask(newTask(), T1), T2).status).toBe('dropped')
  })

  it('已 dropped 幂等；已完成不可放弃（要撤只能新建任务）', () => {
    const dropped = dropTask(newTask(), T1)
    expect(dropTask(dropped, T2)).toBe(dropped)
    const done = finishTask(recordArtifact(startTask(newTask(), T1), 'a1', T1), T2)
    expect(() => dropTask(done, T2)).toThrow(TaskTransitionError)
  })
})

describe('完整生命周期', () => {
  it('todo → doing → 产出失败回到 todo → 重来 → done', () => {
    let task = newTask()
    task = startTask(task, T1)
    task = finishTask(task, T2) // 这一轮没产出
    expect(task.status).toBe('todo')

    task = startTask(task, T2)
    task = recordArtifact(task, 'a1', T2)
    task = finishTask(task, T2)
    expect(task.status).toBe('done')
    expect(task.artifacts).toEqual(['a1'])
  })

  it('不满意就再做一次：同一任务累积多个版本，旧的保留', () => {
    let task = startTask(newTask(), T1)
    task = recordArtifact(task, 'a1', T1)
    task = recordArtifact(task, 'a2', T2)
    task = finishTask(task, T2)
    expect(task.artifacts).toEqual(['a1', 'a2'])
    expect(currentArtifactId(task)).toBe('a2')
  })
})

describe('isWithinLane', () => {
  it('同目录与前缀子目录都算在内', () => {
    expect(isWithinLane('assets/visual', 'assets/visual/s03.png')).toBe(true)
    expect(isWithinLane('assets/visual', 'assets/visual')).toBe(true)
  })

  it('按路径段对齐：不会把 assets/ab 当成 assets/a 的子路径', () => {
    expect(isWithinLane('assets/a', 'assets/ab/x.png')).toBe(false)
  })

  it('跨目录与越界都拒', () => {
    expect(isWithinLane('assets/visual', 'story/ep01.md')).toBe(false)
    expect(isWithinLane('assets/visual', '../etc/passwd')).toBe(false)
  })
})
