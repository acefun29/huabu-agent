import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MediaJobManager } from './manager'
import type { MediaJobContext } from './manager'
import type { MediaProviderAdapter } from './provider'
import { createAdapters, registerAdapter } from './adapters/registry'
import { MEDIA_ROOT_REL } from '../../shared/assets'

/**
 * 媒体调用的工作区归属（R04）。
 *
 * 断点：共享的 `MediaJobManager` 全程用 `this.context()`——切到工作区 B 之后，
 * A 的**在途任务**会用 B 的媒体目录算产物路径、把账本写进 B 的 jobs.json；
 * 适配器的凭据闭包也读全局 currentDir，于是拿 B 的 Key 去请求供应商。
 *
 * 这些用例只碰文件系统与假适配器，不联网、不调真实模型。
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

function workspace(tag: string): { root: string; media: string } {
  const root = mkdtempSync(join(tmpdir(), `r04-${tag}-`))
  dirs.push(root)
  // 产物根的字面量只允许出现在 shared/assets（asset-path:check 会查）
  const media = join(root, MEDIA_ROOT_REL)
  mkdirSync(media, { recursive: true })
  return { root, media }
}

/**
 * 假适配器：submit 挂住，等测试切完工作区再放行；poll 每次现造一个本地产物。
 * （轮询可能被重复调用，产物文件不能复用同一个路径——rename 之后第二次就 ENOENT。）
 */
function stubAdapter(gate: Promise<void>, dir: string): MediaProviderAdapter {
  let n = 0
  return {
    id: 'stub',
    type: 'gateway-openai-compat',
    label: 'Stub',
    models: [{ id: 'stub-1', kind: 'image', provider: 'stub' }],
    isConfigured: () => true,
    authHint: () => 'stub',
    submit: async () => {
      await gate
      return 'remote-1'
    },
    poll: async () => {
      n += 1
      const file = join(dir, `remote-${n}.png`)
      if (!existsSync(file)) writeFileSync(file, Buffer.from([1, 2, 3]))
      return { status: 'succeeded', resultFile: file, fileExt: '.png', mime: 'image/png' }
    }
  }
}

function contextOf(
  ws: { root: string; media: string },
  adapter: MediaProviderAdapter,
  concurrency = 2
): MediaJobContext {
  return {
    mediaDir: ws.media,
    workspaceDir: ws.root,
    config: { concurrency } as MediaJobContext['config'],
    providers: [],
    adapters: [adapter],
    ready: true,
    notifyAssetsChanged: () => {}
  }
}

describe('媒体任务的工作区归属（R04）', () => {
  it('排队中的任务在切到 B 之后才开跑：产物与账本仍落在 A，B 的目录不被写入', async () => {
    const a = workspace('a')
    const b = workspace('b')
    let current = a

    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    // 两个任务共用一个适配器；submit 卡在闸门上，让第二个任务停留在排队态
    const adapters = new Map<string, MediaProviderAdapter>()
    const adapterFor = (tag: string): MediaProviderAdapter => {
      const cached = adapters.get(tag)
      if (cached) return cached
      const adapter = stubAdapter(gate, a.root)
      adapters.set(tag, adapter)
      return adapter
    }
    const manager = new MediaJobManager(
      () => {},
      () => contextOf(current, adapterFor(current === a ? 'job-a' : 'job-b'), 1)
    )

    const first = await manager.submit({ provider: 'stub', model: 'stub-1', kind: 'image', prompt: '画一只猫' })
    // 第二个任务排队（并发上限 1），此刻还没开始跑
    const second = await manager.submit({ provider: 'stub', model: 'stub-1', kind: 'image', prompt: '画一只狗' })
    // 用户切到工作区 B，然后放行——第二个任务此时才真正开跑（修复前会读 B 的目录）
    current = b
    release()

    const waitTerminal = async (jobId: string): Promise<string | undefined> => {
      const deadline = Date.now() + 5_000
      let state = manager.get(jobId)?.state
      while (Date.now() < deadline && state !== 'succeeded' && state !== 'failed') {
        await new Promise((r) => setTimeout(r, 20))
        state = manager.get(jobId)?.state
      }
      return state
    }
    expect(await waitTerminal(first.jobId), String(manager.get(first.jobId)?.error)).toBe('succeeded')
    expect(await waitTerminal(second.jobId), String(manager.get(second.jobId)?.error)).toBe('succeeded')

    // 排队的那个任务：产物落在 A 的媒体目录，而不是切换后的 B
    expect(existsSync(join(a.media, `${second.jobId}.png`))).toBe(true)
    expect(existsSync(join(b.media, `${second.jobId}.png`))).toBe(false)
    // 账本写在 A
    const ledgerA = existsSync(join(a.media, 'jobs.json')) ? readFileSync(join(a.media, 'jobs.json'), 'utf8') : ''
    expect(ledgerA).toContain(second.jobId)
    // B 的账本里不得出现 A 的任务
    const bLedger = join(b.media, 'jobs.json')
    expect(existsSync(bLedger) ? readFileSync(bLedger, 'utf8').includes(second.jobId) : false).toBe(false)
  })
})

describe('适配器依赖绑定工作区（R04）', () => {
  it('createAdapters 把工作区绑进凭据解析；媒体目录在创建时求值，不随后续切换漂移', async () => {
    const seen: Array<string | null> = []
    const captured: Array<{ mediaDir: () => string | null; resolveKey: (a: object) => Promise<unknown> }> = []
    // 用真实注册表里的假工厂观察 createAdapters 交出的 deps（不联网、不发请求）
    registerAdapter('gateway-openai-compat', (deps) => {
      captured.push({
        mediaDir: deps.mediaDir,
        resolveKey: (auth) => deps.resolveKey(auth as { authKey?: string; authEnv?: string })
      })
      return {
        id: 'stub',
        type: 'gateway-openai-compat',
        label: 'Stub',
        models: [],
        isConfigured: () => true,
        authHint: () => 'stub',
        submit: async () => '',
        poll: async () => ({ status: 'succeeded' })
      }
    })

    let currentMediaDir = '/ws/a/.huabu/media'
    const adapters = createAdapters(
      [{ id: 'stub', type: 'gateway-openai-compat', label: 'Stub', source: 'builtin', authKey: 'stub', models: [] }],
      {
        mediaDir: () => currentMediaDir,
        resolveKey: async (_auth, workspace) => {
          seen.push(workspace)
          return 'key'
        }
      },
      '/ws/a'
    )
    // 模拟切工作区：闭包里的"当前值"变了，但已创建的适配器不该跟着变
    currentMediaDir = '/ws/b/.huabu/media'
    expect(adapters[0]?.id).toBe('stub')
    const deps = captured[0]!
    expect(deps.mediaDir()).toBe('/ws/a/.huabu/media')
    await deps.resolveKey({})
    expect(seen).toEqual(['/ws/a'])
  })
})
