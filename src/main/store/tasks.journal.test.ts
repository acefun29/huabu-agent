import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WorkspaceJournal } from '../superagent/journal'
import { activeTask, artifactsOfTask, projectWork } from './tasks'

/**
 * 真实落盘：journal 追加 → 读回 → 投影。
 *
 * 单测里已经覆盖了投影逻辑，这里验证另一件事：**新事件类型能被 journal 接受并原样读写**。
 * 事件类型忘了加进 `JournalEventType`、或 payload 在 JSON 往返里变形，都会在这里暴露。
 */

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 下句柄未释放时留给系统清理
    }
  }
})

function tmpJournal(): WorkspaceJournal {
  const dir = mkdtempSync(join(tmpdir(), 'huabu-work-'))
  dirs.push(dir)
  return new WorkspaceJournal(join(dir, 'journal.jsonl'))
}

describe('journal 落盘 → 投影', () => {
  it('建任务 → 开工 → 记产物 → 收工，读回后状态是 done', async () => {
    const journal = tmpJournal()
    await journal.append('work.created', 'V-02', 'main', {
      title: '主视觉 6 张',
      brief: '3 张产品正面 + 3 张场景融入',
      lane: 'assets/visual',
      kind: 'image'
    })
    await journal.append('work.started', 'V-02', 'main')
    await journal.append('artifact.recorded', 'V-02', 'main', {
      path: 'assets/visual/s03.png',
      kind: 'image',
      mime: 'image/png',
      bytes: 2048,
      params: { ratio: '16:9' }
    })
    await journal.append('work.finished', 'V-02', 'main')

    const state = projectWork(await journal.read())
    expect(state.ignored).toEqual([])
    expect(state.tasks).toHaveLength(1)
    const task = state.tasks[0]!
    expect(task).toMatchObject({ id: 'V-02', status: 'done', lane: 'assets/visual' })

    const artifacts = artifactsOfTask(state, task)
    expect(artifacts).toHaveLength(1)
    // params 经 JSON 往返仍是对象
    expect(artifacts[0]!.params).toEqual({ ratio: '16:9' })
    expect(artifacts[0]!.taskId).toBe('V-02')
  })

  it('多个任务互不干扰，activeTask 命中 doing 的那条', async () => {
    const journal = tmpJournal()
    for (const [id, title] of [
      ['A', '第一场分镜'],
      ['B', '第二场分镜']
    ] as const) {
      await journal.append('work.created', id, 'main', {
        title,
        brief: `${title}的具体要求`,
        lane: 'story',
        kind: 'text'
      })
    }
    await journal.append('work.started', 'B', 'main')

    const state = projectWork(await journal.read())
    expect(state.tasks.map((task) => task.id)).toEqual(['A', 'B'])
    expect(activeTask(state)?.id).toBe('B')
  })

  it('旧模型的事件与新事件混在同一个 journal 里：新投影只认自己那几类', async () => {
    const journal = tmpJournal()
    // 旧事件（扁平看板那一套）
    await journal.append('task.created', 'old-1', 'main', { prompt: 'x', accept: [] })
    await journal.append('task.started', 'old-1', 'expert')
    // 新事件
    await journal.append('work.created', 'new-1', 'main', {
      title: '新任务',
      brief: '只做一件事',
      lane: 'assets/visual',
      kind: 'image'
    })

    const state = projectWork(await journal.read())
    expect(state.tasks.map((task) => task.id)).toEqual(['new-1'])
    expect(state.ignored).toEqual([])
  })
})
