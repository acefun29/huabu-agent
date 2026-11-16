import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WorkspaceJournal } from '../superagent/journal'
import { projectWork } from '../store/tasks'
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

  it('写入类：读 path + bytes，按文本产物记', () => {
    expect(artifactFromToolResult({ path: 'story/ep01.md', bytes: 120 })).toMatchObject({
      path: 'story/ep01.md',
      kind: 'text',
      mime: 'text/markdown',
      bytes: 120,
      generated: false
    })
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

    const outcome = await recordToolArtifact(deps, mediaDetails('assets/visual/a.png'))
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
    const outcome = await recordToolArtifact(deps, mediaDetails('story/a.png'))
    expect(outcome).toMatchObject({ recorded: false })
    expect((await journal.read())).toHaveLength(2) // 只有 created + started
  })

  it('文本写入记到文本任务上', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'story', kind: 'text' })
    const outcome = await recordToolArtifact(deps, { path: 'story/ep01.md', bytes: 120 })
    expect(outcome).toMatchObject({ recorded: true })
  })

  it('文本写入不记到图片任务上（中间文件不是交付物）', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'assets/visual', kind: 'image' })
    const outcome = await recordToolArtifact(deps, { path: 'assets/visual/prompt.txt', bytes: 20 })
    expect(outcome).toMatchObject({ recorded: false })
  })

  it('同任务多次产出 → 累积成多个版本', async () => {
    const { journal, deps } = await workspace()
    await startTask(journal, { lane: 'assets/visual' })
    await recordToolArtifact(deps, mediaDetails('assets/visual/v1.png'))
    await recordToolArtifact(deps, mediaDetails('assets/visual/v2.png'))

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

    const [wrapped] = withArtifactRecording([fakeTool(mediaDetails('assets/visual/a.png'))], deps)
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

  it('记账抛错不影响工具结果（文件已经落盘，不能让模型以为生成失败）', async () => {
    const deps: RecordArtifactDeps = {
      journal: () => {
        throw new Error('journal 打不开')
      }
    }
    const [wrapped] = withArtifactRecording([fakeTool(mediaDetails('assets/visual/a.png'))], deps)
    const result = await wrapped!.execute('c1', {}, undefined, undefined, {})
    expect(result.isError).toBeUndefined()
    expect(result.details).toMatchObject({ artifactPath: 'assets/visual/a.png' })
  })
})
