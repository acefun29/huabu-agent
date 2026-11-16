import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WorkspaceJournal } from '../superagent/journal'
import { projectWork } from '../store/tasks'
import { finishTask } from '../core/task'
import { bindSessionTask, resetSessionTasks, sessionTaskId, unbindSessionTask } from './sessionTask'
import {
  artifactFromToolResult,
  recordToolArtifact,
  withArtifactRecording,
  type RecordArtifactDeps
} from './record'
import type { ToolDefinition } from '../agent/contracts'

/**
 * 产物记账：工具说它产出了什么，系统就把这条事实记到活跃任务上。
 *
 * 这一层是闭环的关键——没有它，任务永远无法变成 done。
 * 断言的重点：**记的时候要准，不记的时候要有理由**。
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

async function workspace(): Promise<{ journal: WorkspaceJournal; deps: RecordArtifactDeps }> {
  const dir = mkdtempSync(join(tmpdir(), 'huabu-record-'))
  dirs.push(dir)
  const journal = new WorkspaceJournal(join(dir, 'journal.jsonl'))
  return { journal, deps: { journal: () => journal } }
}

async function startTask(
  journal: WorkspaceJournal,
  options: { id?: string; lane?: string; kind?: string } = {}
): Promise<void> {
  await journal.append('work.created', options.id ?? 'V-02', 'main', {
    title: 't',
    brief: 'b',
    lane: options.lane ?? 'assets/visual',
    kind: options.kind ?? 'image'
  })
  await journal.append('work.started', options.id ?? 'V-02', 'main')
}

function mediaDetails(path: string, bytes = 2048): Record<string, unknown> {
  return {
    artifactPath: path,
    artifact: { relPath: 'a.png', mime: 'image/png', bytes }
  }
}

describe('artifactFromToolResult', () => {
  it('生成类：读 artifactPath + artifact 的 mime/bytes', () => {
    expect(artifactFromToolResult(mediaDetails('assets/visual/a.png'))).toMatchObject({
      path: 'assets/visual/a.png',
      kind: 'image',
      mime: 'image/png',
      bytes: 2048,
      generated: true
    })
  })

  it('文本产出类：读 details.artifact 的 path + bytes', () => {
    expect(artifactFromToolResult({ artifact: { path: 'story/ep01.md', bytes: 120 } })).toMatchObject({
      path: 'story/ep01.md',
      kind: 'text',
      mime: 'text/markdown',
      bytes: 120,
      generated: false
    })
  })

  it('read 回执（有 path + bytes 但没有 artifact）→ null：只读不是产出', () => {
    expect(
      artifactFromToolResult({ path: 'story/ep01.md', bytes: 120, truncated: false })
    ).toBeNull()
  })

  it('没有产物路径 → null（大多数工具都是这样）', () => {
    expect(artifactFromToolResult({ ok: true })).toBeNull()
    expect(artifactFromToolResult(null)).toBeNull()
    expect(artifactFromToolResult('text')).toBeNull()
  })

  it('0 字节 / 越界路径 → null（坏产物不记账）', () => {
    expect(artifactFromToolResult(mediaDetails('a.png', 0))).toBeNull()
    expect(artifactFromToolResult(mediaDetails('../escape.png'))).toBeNull()
  })
})

describe('recordToolArtifact', () => {
  it('活跃任务 + 路径在写区 → 记一条 artifact.recorded', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'assets/visual' })

    const outcome = await recordToolArtifact(deps, mediaDetails('assets/visual/a.png'), 'V-02')
    expect(outcome).toMatchObject({ recorded: true, taskId: 'V-02', path: 'assets/visual/a.png' })

    const state = projectWork(await journal.read())
    expect(state.tasks[0]!.artifacts).toHaveLength(1)
    expect(state.artifacts[0]).toMatchObject({ path: 'assets/visual/a.png', kind: 'image', bytes: 2048 })
  })

  it('没有活跃任务 → 不记（宁缺毋滥，不猜一个任务）', async () => {
    const { journal, deps } = await workspace()
    const outcome = await recordToolArtifact(deps, mediaDetails('assets/visual/a.png'))
    expect(outcome).toMatchObject({ recorded: false })
    expect((await journal.read())).toHaveLength(0)
  })

  it('路径越出写区 → 不记', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'assets/visual' })
    const outcome = await recordToolArtifact(deps, mediaDetails('story/a.png'), 'V-02')
    expect(outcome).toMatchObject({ recorded: false })
    expect((await journal.read())).toHaveLength(2) // 只有 created + started
  })

  it('文本写入记到文本任务上', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'story', kind: 'text' })
    const outcome = await recordToolArtifact(deps, { artifact: { path: 'story/ep01.md', bytes: 120 } }, 'V-02')
    expect(outcome).toMatchObject({ recorded: true })
  })

  it('文本写入不记到图片任务上（中间文件不是交付物）', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'assets/visual', kind: 'image' })
    const outcome = await recordToolArtifact(deps, { artifact: { path: 'assets/visual/prompt.txt', bytes: 20 } }, 'V-02')
    expect(outcome).toMatchObject({ recorded: false })
  })

  it('同任务多次产出 → 累积成多个版本', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'assets/visual' })
    await recordToolArtifact(deps, mediaDetails('assets/visual/v1.png'), 'V-02')
    await recordToolArtifact(deps, mediaDetails('assets/visual/v2.png'), 'V-02')

    const state = projectWork(await journal.read())
    expect(state.tasks[0]!.artifacts).toHaveLength(2)
    expect(state.artifacts.map((artifact) => artifact.path)).toEqual([
      'assets/visual/v1.png',
      'assets/visual/v2.png'
    ])
  })
})

describe('withArtifactRecording', () => {
  function fakeTool(details: Record<string, unknown>, isError = false): ToolDefinition {
    return {
      name: 'generate_image',
      label: 'x',
      description: 'x',
      parameters: { type: 'object', properties: {} } as never,
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        details,
        ...(isError ? { isError: true } : {})
      })
    }
  }

  it('成功的工具调用被记账，返回形状不变', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'assets/visual' })

    const [wrapped] = withArtifactRecording([fakeTool(mediaDetails('assets/visual/a.png'))], {
      ...deps,
      taskId: () => 'V-02'
    })
    const result = await wrapped!.execute('c1', {}, undefined, undefined, {})
    expect(result).toMatchObject({ details: { artifactPath: 'assets/visual/a.png' } })

    const state = projectWork(await journal.read())
    expect(state.tasks[0]!.artifacts).toHaveLength(1)
  })

  it('失败的工具调用不记账', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'assets/visual' })

    const [wrapped] = withArtifactRecording([fakeTool(mediaDetails('assets/visual/a.png'), true)], deps)
    await wrapped!.execute('c1', {}, undefined, undefined, {})
    const state = projectWork(await journal.read())
    expect(state.tasks[0]!.artifacts).toHaveLength(0)
  })

  it('归属在调用开始时定格：工具执行期间任务收工，产物不再补记', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'assets/visual' })
    const inner = fakeTool(mediaDetails('assets/visual/a.png'))
    const closing = {
      ...inner,
      // 长工具跑到一半，任务被收工（模型/用户随时可能这么做）
      execute: async (...args: never[]) => {
        await journal.append('work.finished', 'V-02', 'main')
        return (inner.execute as (...a: never[]) => unknown)(...args)
      }
    } as never
    const [wrapped] = withArtifactRecording([closing], { ...deps, taskId: () => 'V-02' })
    await wrapped!.execute('c1', {}, undefined, undefined, {})
    const state = projectWork(await journal.read())
    expect(state.tasks[0]!.artifacts).toHaveLength(0)
  })

  it('记账抛错不影响工具结果（文件已经落盘，不能让模型以为生成失败）', async () => {
    const deps: RecordArtifactDeps = {
      journal: () => {
        throw new Error('journal 打不开')
      }
    }
    const [wrapped] = withArtifactRecording([fakeTool(mediaDetails('assets/visual/a.png'))], {
      ...deps,
      taskId: () => 'V-02'
    })
    const result = await wrapped!.execute('c1', {}, undefined, undefined, {})
    expect(result.isError).toBeUndefined()
    expect(result.details).toMatchObject({ artifactPath: 'assets/visual/a.png' })
  })
})

/**
 * 产出契约的回归（定向修复批次 1 的两条 P1）。
 *
 * 判据来自 codex：文本任务里「只读 → 收工」必须是 todo；「同写区建文本卡 → 收工」必须是 done
 * 且记下的路径正确、只记一版。这里直接用真实的收工迁移（finishTask）验，而不是只看记录条数——
 * 记账层的唯一价值就是决定收工判定。
 */
describe('产出契约回归：只读不算产出，create_note 算', () => {  const noteDetails = (relPath: string, bytes = 400): Record<string, unknown> => ({
    created: true,
    published: { relPath, name: relPath.split('/').pop()!, kind: 'doc' },
    artifact: { path: relPath, bytes }
  })

  it('文本任务只读后收工 → todo（读不产生版本）', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { id: 'T-01', lane: 'assets/documents', kind: 'text' })

    const outcome = await recordToolArtifact(deps, {
      path: 'assets/documents/a.md',
      bytes: 120,
      truncated: false
    })
    expect(outcome).toMatchObject({ recorded: false })

    const state = projectWork(await journal.read())
    expect(state.tasks[0]!.artifacts).toHaveLength(0)
    expect(finishTask(state.tasks[0]!, '2026-01-01T00:00:00.000Z').status).toBe('todo')
  })

  it('同写区 create_note 后收工 → done，且只记一次、路径正确', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { id: 'T-02', lane: 'assets/documents', kind: 'text' })

    const outcome = await recordToolArtifact(deps, noteDetails('assets/documents/方案-1010.md'), 'T-02')
    expect(outcome).toMatchObject({
      recorded: true,
      taskId: 'T-02',
      path: 'assets/documents/方案-1010.md'
    })

    const state = projectWork(await journal.read())
    expect(state.tasks[0]!.artifacts).toHaveLength(1)
    expect(state.artifacts[0]).toMatchObject({
      path: 'assets/documents/方案-1010.md',
      kind: 'text',
      mime: 'text/markdown'
    })
    expect(finishTask(state.tasks[0]!, '2026-01-01T00:00:00.000Z').status).toBe('done')
  })

  it('create_note 落在写区外 → 不记（写区仍是交付边界）', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { id: 'T-03', lane: 'story', kind: 'text' })
    const outcome = await recordToolArtifact(deps, noteDetails('assets/documents/方案-1010.md'), 'T-03')
    expect(outcome).toMatchObject({ recorded: false })
    expect((await journal.read())).toHaveLength(2) // 只有 created + started
  })
})

/**
 * 多会话并行：归属必须跟着会话走。
 *
 * 交火顺序（codex 复现的那条）：A 开任务 → 暂停；B 开任务（同写区）→ A 继续写文件。
 * 全局「最近开工」此时是 B，A 的产物会被记给 B、A 自己退回待办。
 */
describe('会话级归属：多会话不串记账', () => {
  it('A 会话的产物记给 A 的任务，不被 B 新开的任务抢走', async () => {
    resetSessionTasks()
    const { journal, deps } = await workspace()
    await startTask(journal, { id: 'T-A', lane: 'assets/documents', kind: 'text' })
    bindSessionTask('node-a', 'T-A')
    await startTask(journal, { id: 'T-B', lane: 'assets/documents', kind: 'text' })

    const outcome = await recordToolArtifact(
      { ...deps, taskId: () => sessionTaskId('node-a') },
      { artifact: { path: 'assets/documents/a.md', bytes: 12 } }
    )
    expect(outcome).toMatchObject({ recorded: true, taskId: 'T-A' })

    const state = projectWork(await journal.read())
    const taskA = state.tasks.find((task) => task.id === 'T-A')!
    const taskB = state.tasks.find((task) => task.id === 'T-B')!
    expect(taskA.artifacts).toHaveLength(1)
    expect(taskB.artifacts).toHaveLength(0)
    // A 收工：有产物 → done（旧行为下这里是 todo）
    expect(finishTask(taskA, '2026-01-01T00:00:00.000Z').status).toBe('done')
    resetSessionTasks()
  })

  it('未绑定会话不记账：不回退全局（否则会记给另一个会话的 B）', async () => {
    resetSessionTasks()
    const { journal, deps } = await workspace()
    await startTask(journal, { id: 'T-A', lane: 'assets/documents', kind: 'text' })
    await startTask(journal, { id: 'T-B', lane: 'assets/documents', kind: 'text' })

    const outcome = await recordToolArtifact(
      { ...deps, taskId: () => sessionTaskId('node-unbound') },
      { artifact: { path: 'assets/documents/x.md', bytes: 8 } }
    )
    expect(outcome).toMatchObject({ recorded: false })
    const state = projectWork(await journal.read())
    expect(state.tasks.every((task) => task.artifacts.length === 0)).toBe(true)
  })

  it('A 收工后继续写文件：不记给仍在做的 B', async () => {
    resetSessionTasks()
    const { journal, deps } = await workspace()
    await startTask(journal, { id: 'T-A', lane: 'assets/documents', kind: 'text' })
    bindSessionTask('node-a', 'T-A')
    await startTask(journal, { id: 'T-B', lane: 'assets/documents', kind: 'text' })
    // A 收工：解绑（与 taskTools 的 onTaskClosed 同语义）
    await journal.append('work.finished', 'T-A', 'main')
    unbindSessionTask('node-a', 'T-A')

    const outcome = await recordToolArtifact(
      { ...deps, taskId: () => sessionTaskId('node-a') },
      { artifact: { path: 'assets/documents/unowned.md', bytes: 9 } }
    )
    expect(outcome).toMatchObject({ recorded: false })
    const state = projectWork(await journal.read())
    expect(state.tasks.find((task) => task.id === 'T-B')!.artifacts).toHaveLength(0)
    resetSessionTasks()
  })
})
