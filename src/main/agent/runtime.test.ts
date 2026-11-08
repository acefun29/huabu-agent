import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { normalizeAgentRuntime, UnavailableRuntime } from './runtime'
import { PiAgentRuntime } from './piRuntime'
import type { AgentHost } from './host'

describe('normalizeAgentRuntime', () => {
  it('只认 mastra，其余一律回落 pi（回滚友好）', () => {
    expect(normalizeAgentRuntime('mastra')).toBe('mastra')
    expect(normalizeAgentRuntime('pi')).toBe('pi')
    expect(normalizeAgentRuntime(undefined)).toBe('pi')
    expect(normalizeAgentRuntime(null)).toBe('pi')
    expect(normalizeAgentRuntime('Mastra')).toBe('pi')
    expect(normalizeAgentRuntime(42)).toBe('pi')
  })
})

describe('UnavailableRuntime', () => {
  it('所有方法统一 host_not_ready，不静默回落', async () => {
    const rt = new UnavailableRuntime('mastra', '尚未实现')
    const results = await Promise.all([
      rt.runtime(), rt.create(), rt.prompt(), rt.steer(), rt.abort(), rt.dispose(),
      rt.history(), rt.contextUsage(), rt.compact(), rt.fork(), rt.setModel(), rt.setThinking()
    ])
    for (const result of results) {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('host_not_ready')
        expect(result.error).toBe('尚未实现')
      }
    }
  })
})

function stubHost() {
  const okResult = { ok: true as const, value: undefined }
  return {
    runtime: vi.fn().mockResolvedValue({ ok: true, value: { ready: true, models: [], configuredProviders: [] } }),
    create: vi.fn().mockResolvedValue({ ok: true, value: { sessionFile: 's.jsonl' } }),
    prompt: vi.fn().mockResolvedValue(okResult),
    steer: vi.fn().mockResolvedValue(okResult),
    abort: vi.fn().mockResolvedValue(okResult),
    dispose: vi.fn().mockResolvedValue(okResult),
    readSessionHistory: vi.fn().mockResolvedValue({ ok: true, value: { messages: [] } }),
    contextUsage: vi.fn().mockReturnValue({ ok: true, value: { tokens: null, contextWindow: null, percent: null } }),
    compact: vi.fn().mockResolvedValue(okResult),
    forkSession: vi.fn().mockResolvedValue({ ok: true, value: { sessionFile: 'fork.jsonl' } }),
    setModel: vi.fn().mockResolvedValue(okResult),
    setThinking: vi.fn().mockResolvedValue(okResult)
  }
}

describe('PiAgentRuntime', () => {
  it('逐方法委托 AgentHost，参数原样透传', async () => {
    const host = stubHost()
    const rt = new PiAgentRuntime(host as unknown as AgentHost, {
      currentDir: () => 'E:/ws',
      defaultModel: () => 'deepseek/chat',
      disabledSkills: () => ['x'],
      assembleTools: async () => []
    })
    await rt.prompt({ nodeId: 'n1', text: '你好' })
    expect(host.prompt).toHaveBeenCalledWith({ nodeId: 'n1', text: '你好' })
    await rt.steer({ nodeId: 'n1', text: '插话' })
    expect(host.steer).toHaveBeenCalledWith({ nodeId: 'n1', text: '插话' })
    await rt.abort({ nodeId: 'n1' })
    expect(host.abort).toHaveBeenCalledWith({ nodeId: 'n1' })
    await rt.dispose({ nodeId: 'n1' })
    expect(host.dispose).toHaveBeenCalledWith({ nodeId: 'n1' })
    await rt.contextUsage({ nodeId: 'n1' })
    expect(host.contextUsage).toHaveBeenCalledWith('n1')
    await rt.compact({ nodeId: 'n1' })
    expect(host.compact).toHaveBeenCalledWith({ nodeId: 'n1' })
    await rt.fork({ nodeId: 'n1', sessionFile: 's.jsonl' })
    expect(host.forkSession).toHaveBeenCalledWith({ nodeId: 'n1', sessionFile: 's.jsonl' }, 'E:/ws')
    await rt.setModel({ nodeId: 'n1', modelId: 'm' })
    expect(host.setModel).toHaveBeenCalledWith({ nodeId: 'n1', modelId: 'm' })
    await rt.setThinking({ nodeId: 'n1', thinkingLevel: 'high' })
    expect(host.setThinking).toHaveBeenCalledWith({ nodeId: 'n1', thinkingLevel: 'high' })
  })

  it('create 经 deps 装配工具并带上工作区上下文', async () => {
    const host = stubHost()
    const tool = { name: 't' } as never
    const rt = new PiAgentRuntime(host as unknown as AgentHost, {
      currentDir: () => 'E:/ws',
      defaultModel: () => 'deepseek/chat',
      disabledSkills: () => ['x'],
      assembleTools: async (nodeId) => {
        expect(nodeId).toBe('n1')
        return [tool]
      }
    })
    await rt.create({ nodeId: 'n1' })
    expect(host.create).toHaveBeenCalledWith({ nodeId: 'n1' }, {
      currentDir: 'E:/ws',
      defaultModel: 'deepseek/chat',
      customTools: [tool],
      disabledSkills: ['x']
    })
  })

  it('未打开工作区：runtime 返回 not-ready，history 拒绝', async () => {
    const host = stubHost()
    const rt = new PiAgentRuntime(host as unknown as AgentHost, {
      currentDir: () => null,
      defaultModel: () => undefined,
      disabledSkills: () => [],
      assembleTools: async () => []
    })
    const info = await rt.runtime()
    expect(info.ok).toBe(true)
    if (info.ok) expect(info.value.ready).toBe(false)
    expect(host.runtime).not.toHaveBeenCalled()
    const history = await rt.history({ nodeId: 'n1', sessionFile: 'E:/elsewhere/s.jsonl' })
    expect(history.ok).toBe(false)
  })

  it('history 路径守卫：越出 sessions 目录拒绝，目录内放行', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'huabu-rt-'))
    const sessions = join(ws, '.huabu', 'sessions')
    mkdirSync(sessions, { recursive: true })
    const file = join(sessions, 's.jsonl')
    writeFileSync(file, '')
    const host = stubHost()
    const rt = new PiAgentRuntime(host as unknown as AgentHost, {
      currentDir: () => ws,
      defaultModel: () => undefined,
      disabledSkills: () => [],
      assembleTools: async () => []
    })
    const rejected = await rt.history({ nodeId: 'n1', sessionFile: join(ws, 'outside.jsonl') })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe('cwd_rejected')
    expect(host.readSessionHistory).not.toHaveBeenCalled()
    const accepted = await rt.history({ nodeId: 'n1', sessionFile: file })
    expect(accepted.ok).toBe(true)
    expect(host.readSessionHistory).toHaveBeenCalledWith(file, 'n1')
  })
})