import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * 正常关窗的收口保证（主进程半边）。
 *
 * 关窗流程要跨两层缓冲：渲染端 800ms 自动保存防抖 + 主进程 200ms 合并写盘。
 * 这里验的是主进程这两件事：能等到「真落盘」，以及能立刻冲刷合并窗口。
 * 渲染端收到 app:flush-before-close 后调 saveCanvasNow 的那一段由接线保证
 * （canvasStore 订阅该事件 → workspace:saveCanvas），Electron 全链路由 codex 的
 * 生产构建实测覆盖。
 */
const { stateRoot } = vi.hoisted(() => ({
  stateRoot: `${process.env.TEMP ?? '.'}/huabu-store-flush-${process.pid}-${Date.now()}`
}))

vi.mock('electron', () => ({
  app: { getPath: () => stateRoot },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' }
}))

import { WorkspaceStore } from './store'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 下句柄未释放时留给系统清理 */
    }
  }
})

function workspaceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'huabu-ws-'))
  dirs.push(dir)
  return dir
}

const snapshot = (): Record<string, unknown> => ({
  version: 3,
  nodes: [{ id: 'n1', type: 'asset', x: 0, y: 0, width: 100, height: 100, zIndex: 1, data: {} }],
  view: { x: 0, y: 0, scale: 1 },
  sessions: [{ id: 's1', name: '会话 1', sessionFile: null }],
  activeSessionId: 's1'
})

describe('关窗收口：画布快照落盘', () => {
  it('saveCanvas 后能等到真正落盘（关窗流程等的是这个信号）', async () => {
    const store = new WorkspaceStore()
    const dir = workspaceDir()
    store.openByPath(dir)
    store.saveCanvas(snapshot() as never)

    expect(await store.waitForCanvasSave(2_000)).toBe(true)
    const file = join(dir, '.huabu', 'canvas.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).nodes).toHaveLength(1)
  })

  it('flushPendingWrites 立刻写盘，不等 200ms 合并窗口', () => {
    const store = new WorkspaceStore()
    const dir = workspaceDir()
    store.openByPath(dir)
    store.saveCanvas(snapshot() as never)
    store.flushPendingWrites()
    expect(existsSync(join(dir, '.huabu', 'canvas.json'))).toBe(true)
  })

  it('没有保存时等待会超时返回 false，不会把退出挂死', async () => {
    const store = new WorkspaceStore()
    workspaceDir()
    expect(await store.waitForCanvasSave(50)).toBe(false)
  })
})
