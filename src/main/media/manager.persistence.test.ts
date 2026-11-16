import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * 任务账本写入失败时的可见反馈。
 *
 * 账本读写被替换成可编程的假实现：提交时要求账本必须写成功（否则任务不能进入远程队列），
 * 运行中的终态写入失败则通过任务状态上的 persistenceWarning 告知界面。
 */

const { writeJobLedger } = vi.hoisted(() => ({ writeJobLedger: vi.fn() }))
vi.mock('./jobLedger', () => ({
  readJobLedger: () => [],
  writeJobLedger
}))

const { MediaJobManager } = await import('./manager')
const { MEDIA_ROOT_REL } = await import('../../shared/assets')
type Manager = InstanceType<typeof MediaJobManager>
type Context = import('./manager').MediaJobContext
type Adapter = import('./provider').MediaProviderAdapter

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄未释放时交给系统清理
    }
  }
})

function workspace(tag: string): { root: string; media: string } {
  const root = mkdtempSync(join(tmpdir(), `ledger-${tag}-`))
  dirs.push(root)
  const media = join(root, MEDIA_ROOT_REL)
  mkdirSync(media, { recursive: true })
  return { root, media }
}

function stubAdapter(dir: string): Adapter {
  let n = 0
  return {
    id: 'stub',
    type: 'gateway-openai-compat',
    label: 'Stub',
    models: [{ id: 'stub-1', kind: 'image', provider: 'stub' }],
    isConfigured: () => true,
    authHint: () => 'stub',
    submit: async () => `remote-${n}`,
    poll: async () => {
      n += 1
      const file = join(dir, `remote-${n}.png`)
      writeFileSync(file, Buffer.from([1, 2, 3]))
      return { status: 'succeeded', resultFile: file, fileExt: '.png', mime: 'image/png' }
    }
  }
}

function contextOf(ws: { root: string; media: string }, adapter: Adapter): Context {
  return {
    mediaDir: ws.media,
    workspaceDir: ws.root,
    config: { concurrency: 2 } as Context['config'],
    providers: [],
    adapters: [adapter],
    ready: true,
    notifyAssetsChanged: () => {}
  }
}

async function waitTerminal(manager: Manager, jobId: string): Promise<string | undefined> {
  const deadline = Date.now() + 5_000
  let state = manager.get(jobId)?.state
  while (Date.now() < deadline && state !== 'succeeded' && state !== 'failed' && state !== 'cancelled') {
    await new Promise((resolve) => setTimeout(resolve, 20))
    state = manager.get(jobId)?.state
  }
  return state
}

describe('媒体任务账本的失败反馈', () => {
  it('提交时账本写入失败：任务不进入队列，错误明确说明未提交', async () => {
    const ws = workspace('submit')
    const manager = new MediaJobManager(() => {}, () => contextOf(ws, stubAdapter(ws.root)))
    writeJobLedger.mockImplementation(() => {
      throw new Error('磁盘只读')
    })

    await expect(
      manager.submit({ provider: 'stub', model: 'stub-1', kind: 'image', prompt: '画一只猫' })
    ).rejects.toThrow(/任务未提交/)
    expect(manager.list()).toHaveLength(0)
  })

  it('终态写入失败时状态带提醒，账本恢复后提醒消失', async () => {
    const ws = workspace('recover')
    const manager = new MediaJobManager(() => {}, () => contextOf(ws, stubAdapter(ws.root)))
    // 提交成功一次；终态写入失败一次；之后恢复
    writeJobLedger
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('磁盘忙')
      })
      .mockImplementation(() => {})

    const submitted = await manager.submit({ provider: 'stub', model: 'stub-1', kind: 'image', prompt: '画一只狗' })
    expect(await waitTerminal(manager, submitted.jobId)).toBe('succeeded')
    expect(manager.get(submitted.jobId)?.persistenceWarning).toMatch(/保存失败/)

    // 再提交一个任务：persistJobs 会重写所有待写账本，失败目录恢复后提醒消失
    await manager.submit({ provider: 'stub', model: 'stub-1', kind: 'image', prompt: '画一只鸟' })
    expect(manager.get(submitted.jobId)?.persistenceWarning).toBeUndefined()
  })
})
