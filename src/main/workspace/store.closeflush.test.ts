import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * 关窗收口的主进程半边：合并窗口里的快照必须能立刻写盘。
 * 放行信号（渲染端回执）在 ipc/closeFlush.test.ts 里单独验证——
 * 这里只保证「放行之后确实落了盘」。
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

describe('关窗收口：flushPendingWrites', () => {
  it('立刻写盘，不等 200ms 合并窗口', () => {
    const store = new WorkspaceStore()
    const dir = workspaceDir()
    store.openByPath(dir)
    store.saveCanvas(snapshot() as never)
    store.flushPendingWrites()
    const file = join(dir, '.huabu', 'canvas.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).nodes).toHaveLength(1)
  })

  it('没有待写快照时是空操作（不抛错）', () => {
    const store = new WorkspaceStore()
    workspaceDir()
    expect(() => store.flushPendingWrites()).not.toThrow()
  })
})
