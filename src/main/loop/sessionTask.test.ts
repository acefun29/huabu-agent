import { beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../core/task'
import type { WorkState } from '../store/tasks'
import {
  bindSessionTask,
  resetSessionTasks,
  sessionTaskId,
  taskForSession,
  unbindSessionTask
} from './sessionTask'

/**
 * 会话 ↔ 任务绑定：一次交付的归属必须是会话级的。
 *
 * 全局「最近开工的 doing」在多会话并行时会把 A 的产物记到 B 刚开的任务上，
 * A 自己没产物、收工退回待办。这里钉住三件事：绑定优先、失效回退、解绑不误伤。
 */
function task(id: string, status: Task['status']): Task {
  return {
    id,
    title: id,
    brief: 'b',
    lane: 'assets/documents',
    kind: 'text',
    status,
    artifacts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function state(...tasks: Task[]): WorkState {
  return { tasks, artifacts: [], ignored: [] }
}

beforeEach(() => resetSessionTasks())

describe('taskForSession', () => {
  it('绑定优先：B 后开工不会把 A 的任务顶掉', () => {
    bindSessionTask('node-a', 'T-A')
    const both = state(task('T-A', 'doing'), task('T-B', 'doing'))
    expect(taskForSession(both, 'node-a')?.id).toBe('T-A')
    // 未绑定的会话没有归属：不能借用别人的 doing（否则产物会记错人）
    expect(taskForSession(both, 'node-b')).toBeUndefined()
  })

  it('绑定已失效（任务收工）→ 不借用其他 doing，未归属', () => {
    bindSessionTask('node-a', 'T-A')
    const mixed = state(task('T-A', 'done'), task('T-B', 'doing'))
    expect(taskForSession(mixed, 'node-a')).toBeUndefined()
  })

  it('没有任何 doing → undefined，不乱选', () => {
    bindSessionTask('node-a', 'T-A')
    expect(taskForSession(state(task('T-A', 'todo')), 'node-a')).toBeUndefined()
  })
})

describe('解绑', () => {
  it('带 taskId 解绑：不影响同一会话后来绑上的新任务', () => {
    bindSessionTask('node-a', 'T-A')
    bindSessionTask('node-a', 'T-B')
    unbindSessionTask('node-a', 'T-A')
    expect(sessionTaskId('node-a')).toBe('T-B')
    unbindSessionTask('node-a', 'T-B')
    expect(sessionTaskId('node-a')).toBeUndefined()
  })

  it('不带 taskId 解绑：清掉该会话的绑定', () => {
    bindSessionTask('node-a', 'T-A')
    unbindSessionTask('node-a')
    expect(sessionTaskId('node-a')).toBeUndefined()
  })
})
