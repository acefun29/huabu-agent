/**
 * 派单工具测试（`list_tasks` / `delegate_tasks` / `cancel_task`）。
 *
 * 这里不跑真模型、不落真 journal：SuperAgentRunner 用一个「形状兼容」的假实现
 * 注入，验证工具层的职责——参数校验、上限、未打开工作区的指引文本、错误聚合。
 * 真正的编排不变量由 superagent.test.ts 的 runTask 套件负责。
 */

import { describe, expect, it } from 'vitest'
import { assembleSuperAgentTools } from './superagentTools'
import type { SuperAgentRunner } from '../superagent/runner'
import type { BoardTask } from '../superagent/board'
import type { VersionSlots } from '../superagent/versions'

/** 假 runner：记录 start/waitFor 调用，返回可预测的 taskId 与最终状态 */
function fakeRunner(options?: { failStart?: boolean; finishStatus?: BoardTask['status'] }) {
  const started: Array<Record<string, unknown>> = []
  const cancelled: string[] = []
  const waited: string[] = []
  const boardTasks: BoardTask[] = [
    {
      taskId: 'task-old-done',
      status: 'done',
      title: '第2场分镜',
      scope: '第02集/第2场',
      expert: 'expert-visual',
      attempts: 0,
      requirementRevision: 1,
      updatedAt: '2026-03-01T00:00:00Z'
    },
    {
      taskId: 'task-attention',
      status: 'attention',
      title: '第3场分镜',
      scope: '第02集/第3场',
      expert: 'expert-visual',
      attempts: 2,
      requirementRevision: 1,
      lastReason: '比例不符 16:9',
      updatedAt: '2026-03-01T00:01:00Z'
    }
  ]
  let seq = 0
  const runner = {
    board: async () => ({
      tasks: boardTasks,
      versions: {} as VersionSlots,
      eventCount: 9,
      runningTaskIds: ['task-live']
    }),
    journal: async () => [],
    cancel: (dir: string, taskId: string) => {
      void dir
      cancelled.push(taskId)
      // 取消结果三态（A08）：stopped / stopping / not-running
      if (taskId === 'task-stopping') return 'stopping'
      if (taskId === 'task-live' || taskId.startsWith('task-new-')) return 'stopped'
      return 'not-running'
    },
    appendUserChange: async () => {
      throw new Error('本测试不覆盖 user.changed')
    },
    experts: () => [],
    start: async (_dir: string, request: Record<string, unknown>) => {
      started.push(request)
      if (options?.failStart) {
        return { ok: false as const, error: { code: 'model_unavailable' as const, message: '没有可用的对话模型' } }
      }
      seq += 1
      const taskId = `task-new-${seq}`
      const status = options?.finishStatus ?? 'done'
      boardTasks.push({
        taskId,
        status,
        scope: String(request.scope ?? ''),
        expert: String(request.expert ?? 'expert-visual'),
        attempts: 0,
        requirementRevision: 1,
        ...(status === 'attention' || status === 'blocked' ? { lastReason: '验收未通过' } : { lastArtifactId: 'art-new' }),
        updatedAt: '2026-03-01T00:02:00Z'
      })
      return {
        ok: true as const,
        value: { taskId, expert: String(request.expert ?? 'expert-visual'), rejected: [], dropped: [] }
      }
    },
    waitFor: async (_dir: string, taskId: string) => {
      waited.push(taskId)
    }
  } as unknown as SuperAgentRunner
  return { runner, started, cancelled, waited }
}

type ToolResult = {
  content: Array<{ type: string; text?: string }>
  details: Record<string, unknown>
}

const textOf = (result: ToolResult): string => result.content.map((block) => block.text ?? '').join('\n')

const runTool = async (
  tools: ReturnType<typeof assembleSuperAgentTools>,
  name: string,
  params: unknown
): Promise<ToolResult> => {
  const tool = tools.find((entry) => entry.name === name)
  if (!tool) throw new Error(`工具不存在：${name}`)
  return (await tool.execute('call-1', params as never, undefined, undefined, {} as never)) as ToolResult
}

describe('派单工具：未打开工作区', () => {
  const tools = assembleSuperAgentTools({ currentDir: () => null, runner: fakeRunner().runner })

  it.each(['list_tasks', 'delegate_tasks', 'cancel_task'])('%s 返回指引文本而不是抛错', async (name) => {
    const result = await runTool(tools, name, name === 'delegate_tasks' ? { tasks: [] } : {})
    expect(result.details.ok).toBe(false)
    expect(textOf(result)).toContain('尚未打开工作区')
  })
})

describe('list_tasks', () => {
  const { runner } = fakeRunner()
  const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })

  it('列出任务板：状态中文标签 + 在跑数量 + 失败原因', async () => {
    const result = await runTool(tools, 'list_tasks', {})
    const text = textOf(result)
    expect(text).toContain('共 2 个任务')
    expect(text).toContain('当前 1 个在跑')
    expect(text).toContain('已完成')
    expect(text).toContain('待重派')
    expect(text).toContain('比例不符 16:9')
    expect(text).toContain('已试 2 次')
    expect(result.details.ok).toBe(true)
  })

  it('需求变更后，最新 prompt/accept 出现在模型可见文本里（A05）', async () => {
    const { runner } = fakeRunner()
    const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })
    // 模拟用户在专家对话里改需求：投影上 prompt/accept 已更新、requirementChangedAt 有值
    const board = await runner.board('E:/ws')
    const target = board.tasks.find((task) => task.taskId === 'task-attention')
    Object.assign(target!, {
      prompt: '按 4:3 重新出一版，保留原构图',
      accept: ['4:3', '角色与参考一致'],
      requirementChangedAt: '2026-03-01T10:00:00Z',
      requirementRevision: 2
    })
    const text = textOf(await runTool(tools, 'list_tasks', { status: 'attention' }))
    // 关键：这些内容此前只在 details 里，模型的 toModelOutput 只拿 text → 看不到
    expect(text).toContain('第 2 版')
    expect(text).toContain('4:3')
    expect(text).toContain('最新需求：按 4:3 重新出一版')
  })

  it('status 过滤：只看 attention', async () => {
    const result = await runTool(tools, 'list_tasks', { status: 'attention' })
    const text = textOf(result)
    expect(text).toContain('task-attention')
    expect(text).not.toContain('task-old-done')
  })

  it('过滤无结果时明确说明，而不是空输出', async () => {
    const result = await runTool(tools, 'list_tasks', { status: 'blocked' })
    expect(textOf(result)).toContain('没有状态为')
  })

  it('limit 被夹到 [1,50]', async () => {
    const result = await runTool(tools, 'list_tasks', { limit: 9999 })
    const rows = String(textOf(result)).split('\n').filter((line) => line.startsWith('- task-'))
    expect(rows.length).toBeLessThanOrEqual(50)
    expect(result.details.ok).toBe(true)
  })
})

describe('delegate_tasks', () => {
  it('委派多个任务并等待返回；字段透传、最终状态可见', async () => {
    const { runner, started, waited } = fakeRunner()
    const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })
    const result = await runTool(tools, 'delegate_tasks', {
      tasks: [
        { scope: '第03集/第2场', prompt: '夜巷追逐，雨夜，冷蓝调', accept: ['16:9'] },
        {
          scope: '第03集/第3场',
          prompt: '天台对峙',
          accept: ['16:9', '时长 5 秒'],
          entities: [{ assetId: 'char-1', path: 'assets/images/hero.png', role: 'character' }],
          expert: 'expert-visual'
        }
      ]
    })
    const text = textOf(result)
    expect(text).toContain('专家团已返回：2 个任务结束')
    expect(text).toContain('task-new-1')
    expect(text).toContain('task-new-2')
    expect(text).toContain('已完成')
    expect(started).toHaveLength(2)
    expect(waited).toEqual(['task-new-1', 'task-new-2'])
    expect(started[0]).toMatchObject({ scope: '第03集/第2场', accept: ['16:9'] })
    expect((started[1] as { entities: unknown[] }).entities).toHaveLength(1)
    expect(result.details.ok).toBe(true)
    expect(result.details.allDone).toBe(true)
  })

  it('子任务验收失败时等待后把最终状态与原因带回模型', async () => {
    const { runner } = fakeRunner({ finishStatus: 'attention' })
    const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })
    const result = await runTool(tools, 'delegate_tasks', {
      tasks: [{ scope: '第03集/第2场', prompt: '夜巷', accept: ['16:9'] }]
    })
    const text = textOf(result)
    expect(text).toContain('待重派')
    expect(text).toContain('验收未通过')
    expect(result.details.allDone).toBe(false)
  })

  it('超过上限的条目被丢弃（只派前 20 个），并如实报告', async () => {
    const { runner, started } = fakeRunner()
    const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })
    const tasks = Array.from({ length: 24 }, (_, i) => ({
      scope: `s${i}`,
      prompt: `p${i}`,
      accept: ['16:9']
    }))
    const result = await runTool(tools, 'delegate_tasks', { tasks })
    expect(started).toHaveLength(20)
    expect(textOf(result)).toContain('专家团已返回：20 个任务结束')
  })

  it('缺 scope/prompt 或 accept 为空的条目逐条拒绝，其余照常受理', async () => {
    const { runner, started } = fakeRunner()
    const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })
    const result = await runTool(tools, 'delegate_tasks', {
      tasks: [
        { scope: '', prompt: 'x', accept: ['16:9'] },
        { scope: 'ok', prompt: 'y', accept: [] },
        { scope: 'ok2', prompt: 'z', accept: ['16:9'] }
      ]
    })
    expect(started).toHaveLength(1)
    const text = textOf(result)
    expect(text).toContain('专家团已返回：1 个任务结束')
    expect(text).toContain('2 个未受理')
  })

  it('全部失败时返回失败明细而不是「成功 0 个」', async () => {
    const { runner } = fakeRunner()
    const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })
    const result = await runTool(tools, 'delegate_tasks', { tasks: [{ scope: 'x', prompt: '', accept: ['16:9'] }] })
    expect(result.details.ok).toBe(false)
    expect(textOf(result)).toContain('没有任务被受理')
  })

  it('runner 拒绝（模型不可用）时把原因原样带给模型', async () => {
    const { runner } = fakeRunner({ failStart: true })
    const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })
    const result = await runTool(tools, 'delegate_tasks', {
      tasks: [{ scope: '第03集/第2场', prompt: '夜巷', accept: ['16:9'] }]
    })
    expect(result.details.ok).toBe(false)
    expect(textOf(result)).toContain('没有可用的对话模型')
  })

  it('shadow 透传到 runner（只写 staging）', async () => {
    const { runner, started } = fakeRunner()
    const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })
    await runTool(tools, 'delegate_tasks', {
      tasks: [{ scope: 's', prompt: 'p', accept: ['16:9'] }],
      shadow: true
    })
    expect((started[0] as { shadow: boolean }).shadow).toBe(true)
  })

  it('引用条目的非法 role/kind 回落默认值（不整单失败）', async () => {
    const { runner, started } = fakeRunner()
    const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })
    await runTool(tools, 'delegate_tasks', {
      tasks: [
        {
          scope: 's',
          prompt: 'p',
          accept: ['16:9'],
          entities: [{ assetId: 'a', path: 'assets/a.png', role: '不存在的角色', kind: '未知' }]
        }
      ]
    })
    const entities = (started[0] as { entities: Array<{ kind: string; role: string; status: string }> }).entities
    expect(entities[0]).toMatchObject({ kind: 'image', role: 'reference', status: 'active' })
  })
})

describe('cancel_task', () => {
  const { runner, cancelled } = fakeRunner()
  const tools = assembleSuperAgentTools({ currentDir: () => 'E:/ws', runner })

  it('在跑的任务 → 取消成功', async () => {
    const result = await runTool(tools, 'cancel_task', { taskId: 'task-live' })
    expect(cancelled).toContain('task-live')
    expect(textOf(result)).toContain('已取消任务 task-live')
    expect(result.details.cancelled).toBe(true)
  })

  it('不在跑的任务 → 如实说明（不谎报成功）', async () => {
    const result = await runTool(tools, 'cancel_task', { taskId: 'task-old-done' })
    expect(textOf(result)).toContain('不在运行中')
    expect(result.details.cancelled).toBe(false)
  })

  it('超时未收口 → 不谎称已停止（A08）', async () => {
    const result = await runTool(tools, 'cancel_task', { taskId: 'task-stopping' })
    const text = textOf(result)
    expect(text).toContain('发出取消请求')
    expect(text).toContain('还没有收口')
    expect(text).not.toContain('已取消任务')
    expect(result.details.state).toBe('stopping')
  })

  it('缺 taskId → 指引从 list_tasks 取', async () => {
    const result = await runTool(tools, 'cancel_task', {})
    expect(result.details.ok).toBe(false)
    expect(textOf(result)).toContain('需要 taskId')
  })
})
