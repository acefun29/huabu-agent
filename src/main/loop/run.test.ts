import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WorkspaceJournal } from '../superagent/journal'
import { buildWorkspaceContext, readStudioContent, taskToolDeps } from './run'
import { bindSessionTask, resetSessionTasks } from './sessionTask'

/**
 * Loop 的读写边界：真实读 `studio.md`、真实写 journal、真实投影。
 *
 * 这是「记忆真的进到上下文里」的最后一段验证——纯函数层（context.ts）已经测过格式，
 * 这里测**磁盘上的东西能不能被读出来并拼进去**。
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

function workspace(): { dir: string; journal: WorkspaceJournal } {
  const dir = mkdtempSync(join(tmpdir(), 'huabu-loop-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.huabu', 'memory'), { recursive: true })
  return { dir, journal: new WorkspaceJournal(join(dir, '.huabu', 'journal.jsonl')) }
}

describe('readStudioContent', () => {
  it('文件不存在 → 空串（不是错误：新工作区还没有记忆）', async () => {
    const { dir } = workspace()
    expect(await readStudioContent(dir)).toBe('')
  })

  it('有文件 → 原文', async () => {
    const { dir } = workspace()
    writeFileSync(join(dir, '.huabu', 'memory', 'studio.md'), '硬约束：16:9，不出现字幕\n', 'utf8')
    expect(await readStudioContent(dir)).toContain('16:9')
  })
})

describe('buildWorkspaceContext', () => {
  it('空工作区：只有记忆块，明确说没有任务', async () => {
    const { dir, journal } = workspace()
    const context = await buildWorkspaceContext({ dir, journal: () => journal })
    expect(context).toContain('项目记忆')
    expect(context).not.toContain('当前任务')
  })

  it('有记忆 + 有在跑的任务：两块都在，记忆在前', async () => {
    const { dir, journal } = workspace()
    writeFileSync(
      join(dir, '.huabu', 'memory', 'studio.md'),
      '当前阶段：第 3 场分镜\n硬约束：暖色，不出现字幕',
      'utf8'
    )
    await journal.append('work.created', 'V-02', 'main', {
      title: '主视觉 6 张',
      brief: '3 张产品正面 + 3 张场景融入',
      lane: 'assets/visual',
      kind: 'image'
    })
    await journal.append('work.started', 'V-02', 'main')
    // 上下文里的任务跟着会话走：必须显式绑定，不会借用全局「最近开工」
    resetSessionTasks()
    bindSessionTask('node-1', 'V-02')

    const context = await buildWorkspaceContext({ dir, journal: () => journal, nodeId: 'node-1' })
    expect(context.indexOf('项目记忆')).toBeLessThan(context.indexOf('当前任务'))
    expect(context).toContain('暖色')
    expect(context).toContain('V-02')
    expect(context).toContain('写区：assets/visual/')
  })

  it('任务有产物时带出当前版本路径', async () => {
    const { dir, journal } = workspace()
    await journal.append('work.created', 'V-02', 'main', {
      title: 't',
      brief: 'b',
      lane: 'assets/visual',
      kind: 'image'
    })
    await journal.append('work.started', 'V-02', 'main')
    await journal.append('artifact.recorded', 'V-02', 'main', {
      path: 'assets/visual/s03.png',
      kind: 'image',
      mime: 'image/png',
      bytes: 2048
    })
    resetSessionTasks()
    bindSessionTask('node-1', 'V-02')

    const context = await buildWorkspaceContext({ dir, journal: () => journal, nodeId: 'node-1' })
    expect(context).toContain('已产出：1 个版本')
    expect(context).toContain('assets/visual/s03.png')
  })

  it('未绑定会话不显示别人的任务（归属是会话级的）', async () => {
    const { dir, journal } = workspace()
    await journal.append('work.created', 'V-02', 'main', {
      title: 't',
      brief: 'b',
      lane: 'assets/visual',
      kind: 'image'
    })
    await journal.append('work.started', 'V-02', 'main')
    resetSessionTasks()

    const context = await buildWorkspaceContext({ dir, journal: () => journal, nodeId: 'node-other' })
    expect(context).not.toContain('当前任务')
  })

  it('已完成的任务不再算「当前任务」', async () => {
    const { dir, journal } = workspace()
    await journal.append('work.created', 'V-02', 'main', {
      title: 't',
      brief: 'b',
      lane: 'assets/visual',
      kind: 'image'
    })
    await journal.append('work.started', 'V-02', 'main')
    await journal.append('artifact.recorded', 'V-02', 'main', {
      path: 'assets/visual/a.png',
      kind: 'image',
      mime: 'image/png',
      bytes: 1
    })
    await journal.append('work.finished', 'V-02', 'main')

    const context = await buildWorkspaceContext({ dir, journal: () => journal })
    expect(context).not.toContain('当前任务')
  })
})

describe('taskToolDeps 接真实 journal', () => {
  it('append 写进 journal，load 能读回', async () => {
    const { dir, journal } = workspace()
    const deps = taskToolDeps({
      currentDir: () => dir,
      journal: () => journal,
      newTaskId: () => 'task-1'
    })
    expect((await deps.load()).tasks).toEqual([])

    await deps.append('work.created', 'V-02', {
      title: '主视觉',
      brief: '做三张',
      lane: 'assets/visual',
      kind: 'image'
    })
    await deps.append('work.started', 'V-02')

    const state = await deps.load()
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ id: 'V-02', status: 'doing', title: '主视觉' })
  })
})
