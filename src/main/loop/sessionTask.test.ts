import { beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../core/task'
import type { WorkState } from '../store/tasks'
import {
  bindSessionTask,
  clearSessionTasksForWorkspace,
  resetSessionTasks,
  sessionTaskId,
  taskForSession,
  unbindSessionTask
} from './sessionTask'

/**
 * 会话 ↔ 任务绑定：一次交付的归属是「工作区 + 会话」级的。
 *
 * 全局「最近开工的 doing」在多会话并行时会把 A 的产物记到 B 刚开的任务上；
 * 只按 nodeId 绑定又会在两个工作区之间泄漏（同名会话复用同一条绑定）。
 * 这里钉住：绑定优先、跨工作区隔离、失效不回退、解绑不误伤。
 */
const WS_A = '/ws/a'
const WS_B = '/ws/b'

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
    bindSessionTask('node-a', WS_A, 'T-A')
    const both = state(task('T-A', 'doing'), task('T-B', 'doing'))
    expect(taskForSession(both, 'node-a', WS_A)?.id).toBe('T-A')
    // 未绑定的会话没有归属：不能借用别人的 doing（否则产物会记错人）
    expect(taskForSession(both, 'node-b', WS_A)).toBeUndefined()
  })

  it('绑定已失效（任务收工）→ 未归属，不借用其他 doing', () => {
    bindSessionTask('node-a', WS_A, 'T-A')
    const mixed = state(task('T-A', 'done'), task('T-B', 'doing'))
    expect(taskForSession(mixed, 'node-a', WS_A)).toBeUndefined()
  })

  it('没有任何 doing → undefined，不乱选', () => {
    bindSessionTask('node-a', WS_A, 'T-A')
    expect(taskForSession(state(task('T-A', 'todo')), 'node-a', WS_A)).toBeUndefined()
  })

  it('跨工作区隔离：同一个会话 id 在别的工作区不算绑定', () => {
    bindSessionTask('node-a', WS_A, 'T-A')
    const both = state(task('T-A', 'doing'))
    expect(taskForSession(both, 'node-a', WS_A)?.id).toBe('T-A')
    // 工作区 B 里即使有同 id 的任务，也不能继承 A 的绑定
    expect(taskForSession(both, 'node-a', WS_B)).toBeUndefined()
    expect(sessionTaskId('node-a', WS_B)).toBeUndefined()
  })
})

describe('生命周期', () => {
  it('切工作区只清该工作区的绑定，别的窗口不受影响', () => {
    bindSessionTask('node-a', WS_A, 'T-A')
    bindSessionTask('node-b', WS_B, 'T-B')
    clearSessionTasksForWorkspace(WS_A)
    expect(sessionTaskId('node-a', WS_A)).toBeUndefined()
    expect(sessionTaskId('node-b', WS_B)).toBe('T-B')
  })

  it('不传工作区（进程退出）→ 全清', () => {
    bindSessionTask('node-a', WS_A, 'T-A')
    bindSessionTask('node-b', WS_B, 'T-B')
    clearSessionTasksForWorkspace()
    expect(sessionTaskId('node-a', WS_A)).toBeUndefined()
    expect(sessionTaskId('node-b', WS_B)).toBeUndefined()
  })

  it('带 taskId 解绑：不影响同一会话后来绑上的新任务', () => {
    bindSessionTask('node-a', WS_A, 'T-A')
    bindSessionTask('node-a', WS_A, 'T-B')
    unbindSessionTask('node-a', 'T-A')
    expect(sessionTaskId('node-a', WS_A)).toBe('T-B')
    unbindSessionTask('node-a', 'T-B')
    expect(sessionTaskId('node-a', WS_A)).toBeUndefined()
  })

  it('不带 taskId 解绑：清掉该会话的绑定', () => {
    bindSessionTask('node-a', WS_A, 'T-A')
    unbindSessionTask('node-a')
    expect(sessionTaskId('node-a', WS_A)).toBeUndefined()
  })
})
