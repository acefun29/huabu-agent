import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SuperAgentRunner, buildExpertToolDefinitions, type SuperAgentRunnerDeps } from './runner'
import { findExpert } from './experts'
import { SuperAgentService } from './index'
import type { TaskEvent } from '../../shared/ipc'

/**
 * 运行器的单元覆盖（C23 的测试缺口）。
 *
 * 此前 `runner.ts` 完全没有直接测试：`start` / `waitFor` / `cancel` / `live` 快照 /
 * 启动对账全靠 `superagentTools.test.ts` 里的 fake runner 间接覆盖——那测的是工具层，
 * 不是运行器本身。这里只覆盖**不需要真实模型**的分支（模型不可用、取消未知任务、
 * 启动对账、按工作区隔离、user.changed 落盘），真模型路径留给 E2E。
 */

const dirs: string[] = []
function tmpWs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-runner-'))
  mkdirSync(join(dir, '.huabu'), { recursive: true })
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 下句柄未释放时 best-effort
    }
  }
})

function makeRunner(overrides: Partial<SuperAgentRunnerDeps> = {}): {
  runner: SuperAgentRunner
  events: TaskEvent[]
} {
  const events: TaskEvent[] = []
  const runner = new SuperAgentRunner({
    currentDir: () => null,
    defaultModelId: () => undefined,
    // 返回 null = 没有已配置的模型 → start 走「受理失败」分支，不碰网络
    modelManagerFor: async () => null,
    media: {
      store: { mediaConfig: () => ({}), getLibraries: () => [] },
      mediaManager: {
        submit: async () => ({ jobId: 'job-1' }),
        waitForCompletion: async () => ({ state: 'done' }) as never
      },
      mediaContext: () => ({ providers: [], config: {}, mediaDir: null }) as never,
      requestApproval: async () => true,
      inboxRoot: () => join(tmpdir(), 'inbox')
    },
    broadcastTaskEvent: (event) => events.push(event),
    ...overrides
  })
  return { runner, events }
}

describe('专家工具面装配（A03）', () => {
  const exec = findExpert('expert-exec')!

  it('文本专家必须拿到 ls/read/write ——早退曾把它挡掉，导致文件永远落不了盘', () => {
    const tools = buildExpertToolDefinitions({
      expert: exec,
      lane: ['story/s1/'],
      currentDir: () => '/ws',
      supportsImages: () => false,
      media: null
    })
    expect(tools.map((tool) => tool.name)).toEqual(['ls', 'read', 'write', 'patch'])
  })

  it('write 沿用任务的 lane 作为写区（越界会被工具拒绝）', async () => {
    const tools = buildExpertToolDefinitions({
      expert: exec,
      lane: ['story/s1/'],
      currentDir: () => process.cwd(),
      supportsImages: () => false,
      media: null
    })
    const write = tools.find((tool) => tool.name === 'write')!
    const denied = (await write.execute('c', { path: 'elsewhere/x.md', content: 'x' }, undefined, undefined, undefined)) as {
      isError?: boolean
    }
    expect(denied.isError).toBe(true)
  })

  it('没有能力的专家不挂任何工具（保持纯文本专家可收敛）', () => {
    const tools = buildExpertToolDefinitions({
      expert: { ...exec, tools: [] },
      lane: [],
      currentDir: () => '/ws',
      supportsImages: () => false,
      media: null
    })
    expect(tools).toEqual([])
  })
})

describe('工作区切换收口（A07）', () => {
  /** 访问 runner 的内部运行时表：这里要构造「在跑任务」，没有模型无法走 start() */
  type Internals = {
    runtimeFor(dir: string): {
      running: Map<string, AbortController>
      completions: Map<string, Promise<void>>
    }
  }
  const internals = (runner: SuperAgentRunner): Internals => runner as unknown as Internals

  it('取消该工作区全部在跑任务，并等待终态收口', async () => {
    const { runner } = makeRunner()
    const ws = tmpWs()
    const rt = internals(runner).runtimeFor(ws)
    const controller = new AbortController()
    let settled = false
    rt.running.set('task-a', controller)
    rt.completions.set(
      'task-a',
      new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => {
          settled = true
          resolve()
        })
      })
    )

    expect(await runner.cancelWorkspace(ws)).toBe(1)
    expect(controller.signal.aborted).toBe(true)
    expect(settled).toBe(true)
    // 再取消一次：终态已收口 → stopped（幂等，不会报"还在停"）
    expect(await runner.cancel(ws, 'task-a')).toBe('stopped')
  })

  it('任务卡在不可中断的等待里：按统一超时返回，不逐个任务各等满', async () => {
    const { runner } = makeRunner()
    const ws = tmpWs()
    const rt = internals(runner).runtimeFor(ws)
    const controllers = [new AbortController(), new AbortController()]
    controllers.forEach((controller, index) => {
      rt.running.set(`task-${index}`, controller)
      // 永不 settle：模拟工具里的 await 不响应 abort
      rt.completions.set(`task-${index}`, new Promise<void>(() => {}))
    })

    const started = Date.now()
    expect(await runner.cancelWorkspace(ws, 30)).toBe(2)
    const elapsed = Date.now() - started
    // 统一超时（30ms）而不是 2 × 30ms
    expect(elapsed).toBeLessThan(200)
    expect(controllers.every((controller) => controller.signal.aborted)).toBe(true)
  })

  it('该工作区没有在跑任务 → 0（不创建运行时、不报错）', async () => {
    const { runner } = makeRunner()
    expect(await runner.cancelWorkspace(tmpWs())).toBe(0)
    expect(await runner.cancelWorkspace(tmpWs())).toBe(0)
  })
})

describe('SuperAgentRunner（无模型路径）', () => {
  it('没有可用模型时同步拒绝派单，而不是让任务卡在 active 等一个不会来的产物', async () => {
    const { runner } = makeRunner()
    const result = await runner.start(tmpWs(), { scope: 'scenes/s3', prompt: '画分镜', accept: ['16:9'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('model_unavailable')
  })

  it('取消未知任务返回 false；waitFor 未知任务立即返回（不悬挂等待）', async () => {
    const { runner } = makeRunner()
    const ws = tmpWs()
    expect(await runner.cancel(ws, 'task-ghost')).toBe('not-running')
    await expect(runner.waitFor(ws, 'task-ghost')).resolves.toBeUndefined()
  })

  it('首次读看板即做启动对账：幽灵 active 收成 blocked 并广播一次，再读不重复收', async () => {
    const ws = tmpWs()
    // 直接写 journal，模拟「上次进程在 task.started 之后崩了」
    const seed = new SuperAgentService(ws)
    await seed.append('task.created', 'ghost', 'main', { scope: 's', prompt: 'p' })
    await seed.append('task.started', 'ghost', 'expert', { attempt: 1 })

    const { runner, events } = makeRunner()
    const first = await runner.board(ws)
    expect(first.tasks[0]).toMatchObject({ taskId: 'ghost', status: 'blocked' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'task.status', taskId: 'ghost', status: 'blocked' })

    const second = await runner.board(ws)
    expect(second.tasks[0]?.status).toBe('blocked')
    // 已收口过：没有新的广播（journal 里不再是 active）
    expect(events).toHaveLength(1)
  })

  it('工作区之间互不串味：各自的 journal / 看板独立', async () => {
    const a = tmpWs()
    const b = tmpWs()
    const seedA = new SuperAgentService(a)
    await seedA.append('task.created', 'only-a', 'main', {})

    const { runner } = makeRunner()
    const boardA = await runner.board(a)
    const boardB = await runner.board(b)
    expect(boardA.tasks.map((t) => t.taskId)).toEqual(['only-a'])
    expect(boardB.tasks).toEqual([])
    expect((await runner.journal(b))).toEqual([])
  })

  it('user.changed 落盘后，看板上的 prompt/accept 就是新版（重派不会用旧需求）', async () => {
    const ws = tmpWs()
    const seed = new SuperAgentService(ws)
    await seed.append('task.created', 't1', 'main', { prompt: '旧需求', accept: ['16:9'] })

    const { runner } = makeRunner()
    await runner.appendUserChange(ws, { taskId: 't1', prompt: '改成 4:3', accept: ['4:3'] })

    const board = await runner.board(ws)
    expect(board.tasks[0]).toMatchObject({ prompt: '改成 4:3', accept: ['4:3'] })
    expect(board.tasks[0]?.requirementChangedAt).toBeTruthy()
    // 状态不变（用户改需求不是状态迁移）
    expect(board.tasks[0]?.status).toBe('todo')
  })

  it('未知任务的专家对话直接报错，而不是返回空壳', async () => {
    const { runner } = makeRunner()
    await expect(runner.conversation(tmpWs(), 'task-ghost')).rejects.toThrow(/任务不存在/)
  })

  it('重派（A10）：任务不存在 → task_missing；存在则按 journal 重建后进入受理流程', async () => {
    const { runner } = makeRunner()
    const ws = tmpWs()
    expect(await runner.redispatch(ws, 'nope')).toMatchObject({ ok: false, error: { code: 'task_missing' } })

    const seed = new SuperAgentService(ws)
    await seed.append('task.created', 't1', 'main', {
      scope: 'scenes/s3',
      prompt: '重派我',
      accept: ['16:9'],
      spec: { negative: ['不要水印'], lane: ['scenes/s3/'] }
    })
    // 台账里没有模型 → 说明输入重建成功、已经走到 start 的模型解析
    expect(await runner.redispatch(ws, 't1')).toMatchObject({ ok: false, error: { code: 'model_unavailable' } })
  })

  it('重派：旧任务落一条 superseded 事实并关联新 taskId，看板收成 blocked（C14）', async () => {
    const ws = tmpWs()
    const seed = new SuperAgentService(ws)
    await seed.append('task.created', 'old', 'main', { scope: 's', prompt: '旧需求' })
    await seed.append('task.started', 'old', 'expert', { attempt: 1 })

    const { runner } = makeRunner()
    expect(await runner.supersede(ws, 'old', 'new')).toBe(true)

    const superseded = (await runner.journal(ws)).find((e) => e.type === 'task.superseded')
    expect(superseded).toMatchObject({ taskId: 'old', actor: 'user' })
    expect(superseded?.payload).toMatchObject({ supersededBy: 'new' })

    const board = await runner.board(ws)
    expect(board.tasks[0]).toMatchObject({ taskId: 'old', status: 'blocked' })
  })

  it('已交付（done）的任务不会被后续 superseded 打回受阻', async () => {
    const ws = tmpWs()
    const seed = new SuperAgentService(ws)
    await seed.append('task.created', 'done-task', 'main', {})
    await seed.append('validation.passed', 'done-task', 'validator', {
      acceptCriteria: [],
      diff: [],
      artifactId: 'a1',
      contextHash: 'h'
    })
    // 完成事实是版本激活（R03）：只有验收通过时任务是「已验收待激活」，不是 done
    await seed.append('version.activated', 'done-task', 'system', { assetId: 'as1', version: 'v1', artifactId: 'a1' })

    const { runner } = makeRunner()
    await runner.supersede(ws, 'done-task', 'replacement')
    const board = await runner.board(ws)
    // done 是终态：重派关联可以记，但不该把已交付的卡片改成受阻
    expect(board.tasks[0]?.status).toBe('done')
  })
})
