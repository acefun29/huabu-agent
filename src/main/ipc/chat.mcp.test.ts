import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * chat.ts 的工具装配接线。
 *
 * 这个用例只测「接线」，所以把兄弟装配函数与运行时都换成桩：
 * 真正要证明的是 chat.ts 把 MCP 工具拼进会话工具面、并且把媒体落盘目录
 * 接到「当前活跃任务」上。MCP 管理器自身的连接/启用/可执行由
 * mcp/manager.test.ts 用真实子进程验证，媒体落库链由 mediaToolAssembly.test.ts 验证。
 */
const captured = vi.hoisted(() => ({
  deps: null as unknown,
  mediaDeps: null as unknown
}))

vi.mock('./ipcMainBridge', () => ({ ipcMain: { handle: () => {} } }))
vi.mock('./shared', () => ({
  broadcastChatEvent: () => {},
  broadcastAssetChanged: () => {},
  broadcastWorkChanged: () => {},
  invalidPayload: () => ({ ok: false }),
  asNodeRequest: () => null,
  isNonEmptyString: () => false
}))
vi.mock('./media', () => ({ settleApprovalsForNode: () => {} }))
vi.mock('../agent/mastra/runtime', () => ({
  MastraAgentRuntime: class {
    constructor(deps: unknown) {
      captured.deps = deps
    }
    disposeAll(): number {
      return 0
    }
    sessionSupportsImages(): boolean {
      return false
    }
  }
}))
vi.mock('../agent/mediaToolAssembly', async () => {
  const actual =
    await vi.importActual<typeof import('../agent/mediaToolAssembly')>('../agent/mediaToolAssembly')
  return {
    ...actual,
    assembleMediaTools: (_nodeId: string, deps: unknown) => {
      captured.mediaDeps = deps
      return {
        mediaTools: [],
        readMediaTool: { name: 'read_media' },
        videoTools: []
      }
    }
  }
})
vi.mock('../agent/blockoutTools', () => ({
  assembleBlockoutTool: () => ({ name: 'blockout' }),
  resolveBuiltinSkillRoots: () => []
}))
vi.mock('../agent/noteTool', () => ({ assembleNoteTool: () => ({ name: 'create_note' }) }))
vi.mock('../agent/facetTools', () => ({ assembleFacetTools: () => [] }))
vi.mock('../tools/taskTools', () => ({ assembleTaskTools: () => [] }))
vi.mock('../loop/run', async () => {
  const actual = await vi.importActual<typeof import('../loop/run')>('../loop/run')
  return {
    ...actual,
    buildWorkspaceContext: async () => '',
    taskToolDeps: () => ({})
  }
})
vi.mock('../loop/record', () => ({ withArtifactRecording: (tools: unknown) => tools }))
vi.mock('../agent/fileTools', () => ({ createFileTools: () => [] }))
vi.mock('../assets/manager', () => ({ inboxRoot: () => process.env.TEMP ?? '.' }))

import { WorkspaceJournal } from '../superagent/journal'
import { bindSessionTask, resetSessionTasks } from '../loop/sessionTask'
import { registerChatIpc } from './chat'

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

function baseCtx(mcpTools: unknown[]) {
  return {
    currentDir: () => null,
    store: {},
    mediaManager: {},
    mediaContext: () => ({}),
    requestMediaApproval: async () => true,
    models: {},
    superAgent: { journalHandle: () => ({}) },
    mcpManager: { assembleTools: async () => mcpTools }
  } as never
}

describe('chat 工具装配', () => {
  it('已装配的 MCP 工具进入会话工具列表', async () => {
    const mcpTool = {
      name: 'mcp_fixture_review_echo',
      label: 'fixture/review_echo',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'echo' }] })
    }
    registerChatIpc(baseCtx([mcpTool]))

    const deps = captured.deps as { assembleTools(nodeId: string, workspaceDir: string): Promise<Array<{ name: string }>> }
    expect(deps).toBeTruthy()
    const names = (await deps.assembleTools('node-1', process.env.TEMP ?? '.')).map((tool) => tool.name)
    expect(names).toContain('mcp_fixture_review_echo')
    // 内置工具仍在同一份列表里（MCP 是追加，不是替换）
    expect(names).toContain('blockout')
    expect(names).toContain('create_note')
  })

  it('媒体落盘目录跟随活跃任务的 lane（同类才套，异类回退默认）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'huabu-chat-lane-'))
    dirs.push(ws)
    const journal = new WorkspaceJournal(join(ws, 'journal.jsonl'))
    await journal.append('work.created', 'V-02', 'main', {
      title: '主视觉',
      brief: 'b',
      lane: 'scenes/s3',
      kind: 'image'
    })
    await journal.append('work.started', 'V-02', 'main')
    // 归属是会话级的：任务必须绑定到这个会话才会被认作「本会话正在做」
    resetSessionTasks()
    bindSessionTask('node-2', ws, 'V-02')

    registerChatIpc({
      ...(baseCtx([]) as Record<string, unknown>),
      currentDir: () => ws,
      superAgent: { journalHandle: () => journal }
    } as never)

    // 装配是惰性的：先走一次 assembleTools，mediaToolAssembly 才拿到 deps
    const deps = captured.deps as { assembleTools(nodeId: string, workspaceDir: string): Promise<unknown> }
    await deps.assembleTools('node-2', ws)

    const mediaDeps = captured.mediaDeps as {
      outputDirFor?: (kind: 'image' | 'video' | 'audio') => Promise<string | undefined>
    }
    expect(mediaDeps.outputDirFor).toBeTruthy()
    expect(await mediaDeps.outputDirFor!('image')).toBe('scenes/s3')
    // 文本/异类任务不套 lane：参考图仍走默认库，不污染任务版本
    expect(await mediaDeps.outputDirFor!('video')).toBeUndefined()
  })

  it('跨工作区不继承绑定：同一会话 id 在另一工作区生成走默认库', async () => {
    const wsA = mkdtempSync(join(tmpdir(), 'huabu-ws-a-'))
    const wsB = mkdtempSync(join(tmpdir(), 'huabu-ws-b-'))
    dirs.push(wsA, wsB)
    const journalA = new WorkspaceJournal(join(wsA, 'journal.jsonl'))
    const journalB = new WorkspaceJournal(join(wsB, 'journal.jsonl'))
    // 两个工作区里都有同 id 的任务（复制工作区的情形），B 的任务同样在 doing
    for (const journal of [journalA, journalB]) {
      await journal.append('work.created', 'image-review', 'main', {
        title: '巡检图',
        brief: 'b',
        lane: 'scenes/s3',
        kind: 'image'
      })
      await journal.append('work.started', 'image-review', 'main')
    }

    // A 工作区里这个会话确实绑定了任务
    resetSessionTasks()
    bindSessionTask('node-x', wsA, 'image-review')

    registerChatIpc({
      ...(baseCtx([]) as Record<string, unknown>),
      currentDir: () => wsB,
      superAgent: { journalHandle: (dir: string) => (dir === wsA ? journalA : journalB) }
    } as never)

    // 到了 B 工作区，同一个会话 id 不能继承 A 的绑定
    const deps = captured.deps as {
      assembleTools(nodeId: string, workspaceDir: string): Promise<unknown>
    }
    await deps.assembleTools('node-x', wsB)
    const mediaDeps = captured.mediaDeps as {
      outputDirFor?: (kind: 'image' | 'video' | 'audio') => Promise<string | undefined>
    }
    expect(await mediaDeps.outputDirFor!('image')).toBeUndefined()
    resetSessionTasks()
  })
})
