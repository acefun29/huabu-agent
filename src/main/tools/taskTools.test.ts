import { describe, expect, it } from 'vitest'
import { createTask } from '../core/task'
import type { TaskToolDeps } from './taskTools'
import { assembleTaskTools } from './taskTools'
import type { WorkEventType, WorkState } from '../store/tasks'
import { projectWork } from '../store/tasks'
import type { JournalEvent, JournalEventType } from '../superagent/journal'

/**
 * 任务工具：模型和「任务」原子的全部接触面。
 *
 * 断言三件事：
 * 1. 三个动作走通（开 / 收 / 看）；
 * 2. 非法参数**在写 journal 之前**就被拦下（事实源不能被脏数据污染）；
 * 3. 收工时没产出的任务回到待办，而不是假装完成。
 */

let seq = 0
function event(type: JournalEventType, taskId: string, payload: Record<string, unknown> = {}): JournalEvent {
  seq += 1
  return { id: `e${seq}`, at: `2026-11-11T10:00:${String(seq).padStart(2, '0')}.000Z`, type, taskId, actor: 'main', payload, v: 1 }
}

/** 内存版依赖：append 直接进数组，load 现场投影 —— 与真实链路同构 */
function fakeDeps(): { deps: TaskToolDeps; events: JournalEvent[] } {
  const events: JournalEvent[] = []
  const deps: TaskToolDeps = {
    currentDir: () => '/ws',
    newTaskId: () => 'task-auto-1',
    load: async () => projectWork(events) as WorkState,
    append: async (type: WorkEventType, taskId: string, payload?: Record<string, unknown>) => {
      events.push({ ...event(type, taskId, payload ?? {}) })
    }
  }
  return { deps, events }
}

function toolOf(deps: TaskToolDeps, name: string) {
  const tool = assembleTaskTools(deps).find((entry) => entry.name === name)
  if (!tool) throw new Error(`没有工具 ${name}`)
  return tool
}

async function run(deps: TaskToolDeps, name: string, params: unknown = {}) {
  const result = await toolOf(deps, name).execute('call-1', params, undefined, undefined, {})
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  return { text, details: (result.details ?? {}) as Record<string, unknown>, isError: result.isError === true }
}

describe('create_task', () => {
  it('开任务 → 两条事实（created + started），返回 taskId', async () => {
    const { deps, events } = fakeDeps()
    const result = await run(deps, 'create_task', {
      title: '主视觉 6 张',
      brief: '3 张产品正面 + 3 张场景融入',
      lane: 'assets/visual',
      kind: 'image'
    })
    expect(result.isError).toBe(false)
    expect(result.details.taskId).toBe('task-auto-1')
    expect(events.map((entry) => entry.type)).toEqual(['work.created', 'work.started'])
    expect(result.text).toContain('已开工')
  })

  it('可以指定任务号（V-02 这种）', async () => {
    const { deps, events } = fakeDeps()
    const result = await run(deps, 'create_task', {
      title: 't',
      brief: 'b',
      lane: 'story',
      kind: 'text',
      id: 'V-02'
    })
    expect(result.details.taskId).toBe('V-02')
    expect(events[0]!.taskId).toBe('V-02')
  })

  it('brief 为空 → 拒绝，且没写任何事实', async () => {
    const { deps, events } = fakeDeps()
    const result = await run(deps, 'create_task', { title: 't', brief: '  ', lane: 'story', kind: 'text' })
    expect(result.isError).toBe(true)
    expect(events).toEqual([])
  })

  it('未知 kind → 拒绝，且没写任何事实', async () => {
    const { deps, events } = fakeDeps()
    const result = await run(deps, 'create_task', { title: 't', brief: 'b', lane: 'story', kind: 'hologram' })
    expect(result.isError).toBe(true)
    expect(events).toEqual([])
  })

  it('任务号重复 → 拒绝，不写事实', async () => {
    const { deps, events } = fakeDeps()
    await run(deps, 'create_task', { title: 't', brief: 'b', lane: 'story', kind: 'text', id: 'V-02' })
    const before = events.length
    const again = await run(deps, 'create_task', { title: 't2', brief: 'b2', lane: 'story', kind: 'text', id: 'V-02' })
    expect(again.isError).toBe(true)
    expect(events).toHaveLength(before)
  })
})

describe('finish_task', () => {
  it('有产物 → done，并报告版本数', async () => {
    const { deps, events } = fakeDeps()
    await run(deps, 'create_task', { title: 't', brief: 'b', lane: 'assets/visual', kind: 'image', id: 'V-02' })
    events.push(event('artifact.recorded', 'V-02', { path: 'assets/visual/a.png', kind: 'image', mime: 'image/png', bytes: 10 }))

    const result = await run(deps, 'finish_task', { taskId: 'V-02' })
    expect(result.isError).toBe(false)
    expect(result.details).toMatchObject({ status: 'done', versions: 1 })
    expect(projectWork(events).tasks[0]!.status).toBe('done')
  })

  it('没产出 → 回到待办，并明确说「不算完成」', async () => {
    const { deps } = fakeDeps()
    await run(deps, 'create_task', { title: 't', brief: 'b', lane: 'story', kind: 'text', id: 'V-02' })
    const result = await run(deps, 'finish_task', { taskId: 'V-02' })
    expect(result.details).toMatchObject({ status: 'todo', versions: 0 })
    expect(result.text).toContain('没有产出')
  })

  it('任务不存在 → 拒绝，提示用 list_tasks', async () => {
    const { deps } = fakeDeps()
    const result = await run(deps, 'finish_task', { taskId: 'ghost' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('list_tasks')
  })

  it('已完成的任务 → 幂等提示，不再追加事实', async () => {
    const { deps, events } = fakeDeps()
    await run(deps, 'create_task', { title: 't', brief: 'b', lane: 'assets/visual', kind: 'image', id: 'V-02' })
    events.push(event('artifact.recorded', 'V-02', { path: 'assets/visual/a.png', kind: 'image', mime: 'image/png', bytes: 10 }))
    await run(deps, 'finish_task', { taskId: 'V-02' })
    const before = events.length
    const again = await run(deps, 'finish_task', { taskId: 'V-02' })
    expect(again.isError).toBe(false)
    expect(events).toHaveLength(before)
  })

  it('缺 taskId → 拒绝', async () => {
    const { deps } = fakeDeps()
    const result = await run(deps, 'finish_task', {})
    expect(result.isError).toBe(true)
  })
})

describe('drop_task', () => {
  it('进行中的任务 → dropped', async () => {
    const { deps } = fakeDeps()
    await run(deps, 'create_task', { title: 't', brief: 'b', lane: 'story', kind: 'text', id: 'V-02' })
    const result = await run(deps, 'drop_task', { taskId: 'V-02' })
    expect(result.isError).toBe(false)
    expect(result.details).toMatchObject({ taskId: 'V-02', status: 'dropped' })
  })

  it('已放弃的幂等；已完成的不许放弃', async () => {
    const { deps, events } = fakeDeps()
    await run(deps, 'create_task', { title: 't', brief: 'b', lane: 'story', kind: 'text', id: 'V-02' })
    await run(deps, 'drop_task', { taskId: 'V-02' })
    const before = events.length
    const again = await run(deps, 'drop_task', { taskId: 'V-02' })
    expect(again.isError).toBe(false)
    expect(events).toHaveLength(before)

    // 另一个任务做完再放弃 → 拒绝
    await run(deps, 'create_task', { title: 't2', brief: 'b2', lane: 'story', kind: 'text', id: 'V-03' })
    events.push(event('artifact.recorded', 'V-03', { path: 'story/a.md', kind: 'text', mime: 'text/markdown', bytes: 5 }))
    await run(deps, 'finish_task', { taskId: 'V-03' })
    const done = await run(deps, 'drop_task', { taskId: 'V-03' })
    expect(done.isError).toBe(true)
    expect(done.text).toContain('已完成')
  })

  it('任务不存在 → 拒绝', async () => {
    const { deps } = fakeDeps()
    const result = await run(deps, 'drop_task', { taskId: 'ghost' })
    expect(result.isError).toBe(true)
  })

  it('放弃后不再是「当前任务」', async () => {
    const { deps, events } = fakeDeps()
    await run(deps, 'create_task', { title: 't', brief: 'b', lane: 'story', kind: 'text', id: 'V-02' })
    await run(deps, 'drop_task', { taskId: 'V-02' })
    expect(projectWork(events).tasks[0]!.status).toBe('dropped')
  })
})

describe('list_tasks', () => {
  it('空任务板给出下一步指引', async () => {
    const { deps } = fakeDeps()
    const result = await run(deps, 'list_tasks')
    expect(result.text).toContain('还没有任务')
    expect(result.text).toContain('create_task')
  })

  it('列出 id / 状态 / 标题 / 写区 / 版本数', async () => {
    const { deps, events } = fakeDeps()
    await run(deps, 'create_task', { title: '主视觉', brief: 'b', lane: 'assets/visual', kind: 'image', id: 'V-02' })
    events.push(event('artifact.recorded', 'V-02', { path: 'assets/visual/a.png', kind: 'image', mime: 'image/png', bytes: 10 }))

    const result = await run(deps, 'list_tasks')
    expect(result.text).toContain('V-02')
    expect(result.text).toContain('进行中')
    expect(result.text).toContain('主视觉')
    expect(result.text).toContain('assets/visual/')
    expect(result.text).toContain('已产出 1 个版本')
  })

  it('有被忽略的历史记录时如实说一声', async () => {
    const { deps, events } = fakeDeps()
    events.push(event('work.started', 'ghost'))
    const result = await run(deps, 'list_tasks')
    expect(result.text).toContain('无法应用')
  })
})

describe('无工作区', () => {
  it('三个工具都给出明确提示而不是抛错', async () => {
    const { deps } = fakeDeps()
    const noWs: TaskToolDeps = { ...deps, currentDir: () => null }
    for (const name of ['create_task', 'finish_task', 'list_tasks']) {
      const result = await run(noWs, name, { title: 't', brief: 'b', lane: 'l', kind: 'text', taskId: 'x' })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('尚未打开工作区')
    }
  })
})

describe('createTask 与工具的一致性', () => {
  it('工具接受的参数能被原子层接受（同一套规则）', () => {
    const task = createTask(
      { title: 't', brief: 'b', lane: 'assets/visual', kind: 'image' },
      { id: 'X', createdAt: '2026-11-11T10:00:00.000Z' }
    )
    expect(task.status).toBe('todo')
    expect(task.lane).toBe('assets/visual')
  })
})
