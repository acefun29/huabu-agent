/**
 * MastraAgentRuntime 契约测试（Phase 1）。
 *
 * - 单测（无网络）：create 的校验矩阵、未迁移方法的显式失败、setModel/setThinking、
 *   history 的 sessionFile 前缀闸门。
 * - E2E（真模型，DEEPSEEK_API_KEY 存在时）：create → prompt → ChatEvent 事件序列 →
 *   第二轮记忆连续性 → history 回放 → contextUsage → dispose → abort 幂等。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ChatModelManager } from '../../models/manager'
import type { ChatEvent, ChatRuntimeInfo } from '../../../shared/ipc'
import { MastraAgentRuntime, type MastraRuntimeDeps } from './runtime'
import { mastraMemoryFor } from './memory'
import { MEMORY_RESOURCE } from './storage'

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY

/** 极简目录：两家 provider 各一个模型，凭据不落盘（单测不需要真 key） */
const STUB_BUILTIN = [
  {
    id: 'stub-a',
    label: 'A',
    baseUrl: 'https://a.example',
    api: 'openai-completions' as const,
    auth: { label: 'A Key', env: 'STUB_A_KEY' },
    models: [
      {
        id: 'a1',
        label: 'A1',
        reasoning: false,
        input: ['text' as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  },
]

const stubWsDirs: string[] = []

function stubDeps(overrides: Partial<MastraRuntimeDeps> = {}): MastraRuntimeDeps {
  const manager = new ChatModelManager({
    credentials: new InMemoryCredentialStore(),
    builtin: STUB_BUILTIN as never,
    config: {},
  })
  return {
    broadcast: () => {},
    currentDir: () => {
      // LibSQL 真实建库需要存在的目录；每个 stub 会话独立临时工作区
      const wsDir = mkdtempSync(join(tmpdir(), 'mastra-rt-stub-'))
      stubWsDirs.push(wsDir)
      return wsDir
    },
    defaultModel: () => undefined,
    managerForWorkspace: async () => manager,
    runtimeInfo: async () => ({
      ok: true as const,
      value: { ready: true, models: [], configuredProviders: [] } satisfies ChatRuntimeInfo,
    }),
    assembleTools: async () => [],
    ...overrides,
  }
}

describe('MastraAgentRuntime 契约（无网络）', () => {
  afterAll(() => {
    for (const dir of stubWsDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows 下 LibSQL 句柄未释放时删除失败；临时目录留给系统清理
      }
    }
  })

  it('未打开工作区：create 拒绝 cwd_rejected；runtime 返回未就绪信息', async () => {
    const rt = new MastraAgentRuntime(stubDeps({ currentDir: () => null }))
    const created = await rt.create({ nodeId: 'n1' })
    expect(created).toMatchObject({ ok: false, code: 'cwd_rejected' })
    const info = await rt.runtime()
    expect(info.ok && info.value.ready).toBe(false)
  })

  it('显式模型不可用 → model_unavailable；合法请求返回 mastra: 会话句柄', async () => {
    const rt = new MastraAgentRuntime(stubDeps())
    const bad = await rt.create({ nodeId: 'n1', modelId: 'stub-a/nope' })
    expect(bad).toMatchObject({ ok: false, code: 'model_unavailable' })

    const good = await rt.create({ nodeId: 'n1', modelId: 'stub-a/a1' })
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(good.value.modelId).toBe('stub-a/a1')
    expect(good.value.sessionFile).toMatch(/^mastra:node-n1$/)
    expect(good.value.activeTools).toEqual([])

    const dup = await rt.create({ nodeId: 'n1', modelId: 'stub-a/a1' })
    expect(dup).toMatchObject({ ok: false, code: 'session_exists' })
  })

  it('旧 JSONL sessionFile / history 被前缀闸门挡下（Phase 5 迁移前不误读）', async () => {
    const rt = new MastraAgentRuntime(stubDeps())
    const created = await rt.create({ nodeId: 'n1', modelId: 'stub-a/a1', sessionFile: 'W:\\fake-ws\\.huabu\\sessions\\x.jsonl' })
    expect(created).toMatchObject({ ok: false, code: 'unknown' })
    const history = await rt.history({ nodeId: 'n2', sessionFile: 'W:\\x.jsonl' })
    expect(history).toMatchObject({ ok: false, code: 'unknown' })
  })

  it('未迁移方法显式失败：steer / compact / fork；prompt 未创建 → session_missing', async () => {
    const rt = new MastraAgentRuntime(stubDeps())
    expect(await rt.steer({ nodeId: 'n1', text: 'x' })).toMatchObject({ ok: false, code: 'unknown' })
    // compact 已实装（Phase 2 收尾）：未创建会话才是 session_missing
    expect(await rt.compact({ nodeId: 'n1' })).toMatchObject({ ok: false, code: 'session_missing' })
    expect(await rt.fork({ nodeId: 'n1', sessionFile: 'mastra:t' })).toMatchObject({ ok: false, code: 'unknown' })
    expect(await rt.prompt({ nodeId: 'ghost', text: 'hi' })).toMatchObject({ ok: false, code: 'session_missing' })
  })

  it('setModel / setThinking：非法值拒绝，合法值更新会话', async () => {
    const rt = new MastraAgentRuntime(stubDeps())
    await rt.create({ nodeId: 'n1', modelId: 'stub-a/a1' })
    expect(await rt.setModel({ nodeId: 'n1', modelId: 'stub-a/ghost' })).toMatchObject({ ok: false, code: 'model_unavailable' })
    const set = await rt.setModel({ nodeId: 'n1', modelId: 'stub-a/a1' })
    expect(set.ok && set.value.modelId).toBe('stub-a/a1')
    // stub 目录无 thinkingLevelMap → 全六档（不含 off）
    expect(set.ok && set.value.thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(await rt.setThinking({ nodeId: 'n1', thinkingLevel: 'off' })).toMatchObject({ ok: false, code: 'unknown' })
    const thinking = await rt.setThinking({ nodeId: 'n1', thinkingLevel: 'high' })
    expect(thinking.ok && thinking.value.thinkingLevel).toBe('high')
    const ghost = await rt.setModel({ nodeId: 'ghost', modelId: 'stub-a/a1' })
    expect(ghost).toMatchObject({ ok: false, code: 'session_missing' })
  })

  it('abort 空闲会话幂等 ok；ghost 节点 session_missing', async () => {
    const rt = new MastraAgentRuntime(stubDeps())
    await rt.create({ nodeId: 'n1', modelId: 'stub-a/a1' })
    expect(await rt.abort({ nodeId: 'n1' })).toMatchObject({ ok: true })
    expect(await rt.abort({ nodeId: 'ghost' })).toMatchObject({ ok: false, code: 'session_missing' })
  })
})

describe.skipIf(!DEEPSEEK_KEY)('MastraAgentRuntime E2E（DeepSeek 真模型）', () => {
  const wsDir = mkdtempSync(join(tmpdir(), 'mastra-rt-e2e-'))
  const events: ChatEvent[] = []
  let rt: MastraAgentRuntime

  afterAll(() => {
    try {
      rmSync(wsDir, { recursive: true, force: true })
    } catch {
      // 同上：句柄未释放时的 best-effort 清理
    }
  })

  function eventsOf(nodeId: string, type: ChatEvent['type']): ChatEvent[] {
    return events.filter((e) => e.nodeId === nodeId && e.type === type)
  }

  async function waitForAgentEnd(nodeId: string, timeoutMs = 120_000): Promise<void> {
    const start = Date.now()
    while (!eventsOf(nodeId, 'agent_end').length) {
      if (Date.now() - start > timeoutMs) throw new Error('等待 agent_end 超时')
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  it(
    'create → prompt → 事件序列 → 记忆连续性 → history → contextUsage → dispose',
    async () => {
      const credentials = new InMemoryCredentialStore()
      await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
      const manager = new ChatModelManager({ credentials, config: {} })
      rt = new MastraAgentRuntime({
        broadcast: (e) => events.push(e),
        currentDir: () => wsDir,
        defaultModel: () => 'deepseek/deepseek-flash',
        managerForWorkspace: async () => manager,
        runtimeInfo: async () => ({
          ok: true as const,
          value: { ready: true, models: [], configuredProviders: ['deepseek'] } satisfies ChatRuntimeInfo,
        }),
        assembleTools: async () => [],
      })

      const created = await rt.create({ nodeId: 'e2e-1' })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(created.value.sessionFile).toBe('mastra:node-e2e-1')

      // 第一轮
      const p1 = await rt.prompt({ nodeId: 'e2e-1', text: '我叫小明。请只回复：好的。' })
      expect(p1.ok).toBe(true)
      await waitForAgentEnd('e2e-1')
      const seq = events.filter((e) => e.nodeId === 'e2e-1').map((e) => e.type)
      expect(seq[0]).toBe('agent_start')
      expect(seq[1]).toBe('turn_start')
      expect(seq).toContain('delta')
      expect(seq).toContain('message')
      expect(seq.filter((t) => t === 'turn_end').length).toBe(1)
      const end = eventsOf('e2e-1', 'agent_end')[0] as Extract<ChatEvent, { type: 'agent_end' }>
      expect(['stop', 'toolUse']).toContain(end.stopReason)
      expect(end.usage && end.usage.input + end.usage.output).toBeGreaterThan(0)

      // busy 保护：agent_end 已发，prompt 可再进
      // 第二轮：记忆连续性（thread 历史经网关回放）
      events.length = 0
      await rt.prompt({ nodeId: 'e2e-1', text: '我叫什么名字？只回答名字。' })
      await waitForAgentEnd('e2e-1')
      const msg = eventsOf('e2e-1', 'message')[0] as Extract<ChatEvent, { type: 'message' }> | undefined
      const answer = (msg?.message.content ?? []).map((b) => b.text ?? '').join('')
      expect(answer).toContain('小明')

      // history 回放
      const history = await rt.history({ nodeId: 'e2e-1', sessionFile: 'mastra:node-e2e-1' })
      expect(history.ok).toBe(true)
      if (history.ok) {
        expect(history.value.messages.length).toBeGreaterThanOrEqual(4)
        expect(history.value.messages.some((m) => m.role === 'user' && m.text.includes('小明'))).toBe(true)
        expect(history.value.messages.some((m) => m.role === 'model')).toBe(true)
      }

      // contextUsage
      const usage = await rt.contextUsage({ nodeId: 'e2e-1' })
      expect(usage.ok && usage.value.tokens && usage.value.tokens > 0).toBe(true)
      expect(usage.ok && usage.value.contextWindow && usage.value.contextWindow > 0).toBe(true)

      // dispose 后 prompt → session_missing
      expect(await rt.dispose({ nodeId: 'e2e-1' })).toMatchObject({ ok: true })
      expect(await rt.prompt({ nodeId: 'e2e-1', text: 'x' })).toMatchObject({ ok: false, code: 'session_missing' })
    },
    240_000
  )

  it(
    '重绑 mastra: 会话恢复历史（create 带已存在的 threadId）',
    async () => {
      const credentials = new InMemoryCredentialStore()
      await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
      const manager = new ChatModelManager({ credentials, config: {} })
      const rt2 = new MastraAgentRuntime({
        broadcast: () => {},
        currentDir: () => wsDir,
        defaultModel: () => 'deepseek/deepseek-flash',
        managerForWorkspace: async () => manager,
        runtimeInfo: async () => ({ ok: true as const, value: { ready: true, models: [], configuredProviders: [] } satisfies ChatRuntimeInfo }),
        assembleTools: async () => [],
      })
      // 上一用例的 thread（node-e2e-1）落在同一个工作区库里
      const created = await rt2.create({ nodeId: 'e2e-2', sessionFile: 'mastra:node-e2e-1' })
      expect(created.ok).toBe(true)
      events.length = 0
      const rt3 = new MastraAgentRuntime({
        broadcast: (e) => events.push(e),
        currentDir: () => wsDir,
        defaultModel: () => 'deepseek/deepseek-flash',
        managerForWorkspace: async () => manager,
        runtimeInfo: async () => ({ ok: true as const, value: { ready: true, models: [], configuredProviders: [] } satisfies ChatRuntimeInfo }),
        assembleTools: async () => [],
      })
      // 用 e2e-2（绑定同 thread）继续问，历史应可见
      await rt3.create({ nodeId: 'e2e-2', sessionFile: 'mastra:node-e2e-1' })
      await rt3.prompt({ nodeId: 'e2e-2', text: '再报一次我的名字？只回答名字。' })
      await waitForAgentEnd('e2e-2')
      const msg = eventsOf('e2e-2', 'message')[0] as Extract<ChatEvent, { type: 'message' }> | undefined
      const answer = (msg?.message.content ?? []).map((b) => b.text ?? '').join('')
      expect(answer).toContain('小明')
      await rt3.dispose({ nodeId: 'e2e-2' })
    },
    240_000
  )

  it(
    '思考档位：setThinking(high) 后 thinking 流事件可见（网关 reasoning 通道）',
    async () => {
      const thEvents: ChatEvent[] = []
      const credentials = new InMemoryCredentialStore()
      await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
      const manager = new ChatModelManager({ credentials, config: {} })
      const rtTh = new MastraAgentRuntime({
        broadcast: (e) => thEvents.push(e),
        currentDir: () => wsDir,
        defaultModel: () => 'deepseek/deepseek-flash',
        managerForWorkspace: async () => manager,
        runtimeInfo: async () => ({ ok: true as const, value: { ready: true, models: [], configuredProviders: [] } satisfies ChatRuntimeInfo }),
        assembleTools: async () => [],
      })
      await rtTh.create({ nodeId: 'e2e-thinking' })
      expect(await rtTh.setThinking({ nodeId: 'e2e-thinking', thinkingLevel: 'high' })).toMatchObject({ ok: true })
      const p = await rtTh.prompt({ nodeId: 'e2e-thinking', text: '3.11 和 3.9 哪个大？想清楚再答。' })
      expect(p.ok).toBe(true)
      const start = Date.now()
      while (Date.now() - start < 120_000) {
        if (thEvents.some((e) => e.type === 'agent_end')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      // deepseek-flash 目录 thinkingLevelMap 含 high:'high' → 网关带 reasoning=high → thinking 流应出现
      const thinking = thEvents.filter(
        (e) => e.type === 'delta' && (e as { stream?: string }).stream === 'thinking'
      ) as Array<{ delta: string }>
      expect(thinking.length).toBeGreaterThan(0)
      expect(thinking.map((d) => d.delta).join('').length).toBeGreaterThan(0)
      await rtTh.dispose({ nodeId: 'e2e-thinking' })
    },
    180_000
  )

  it(
    'Phase 2 收尾：compact() 手动触发 observational memory——compaction 事件 + 原文仍可 recall',
    async () => {
      const omEvents: ChatEvent[] = []
      const credentials = new InMemoryCredentialStore()
      await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
      const manager = new ChatModelManager({ credentials, config: {} })
      const rtOm = new MastraAgentRuntime({
        broadcast: (e) => omEvents.push(e),
        currentDir: () => wsDir,
        defaultModel: () => 'deepseek/deepseek-flash',
        managerForWorkspace: async () => manager,
        runtimeInfo: async () => ({ ok: true as const, value: { ready: true, models: [], configuredProviders: [] } satisfies ChatRuntimeInfo }),
        assembleTools: async () => [],
      })
      await rtOm.create({ nodeId: 'e2e-om' })
      // 两轮真实对话（制造可观察历史）
      for (const text of ['记住暗号是蓝鲸七号。只回复"好的"。', '暗号是什么？只回答暗号。']) {
        omEvents.length = 0
        await rtOm.prompt({ nodeId: 'e2e-om', text })
        const start = Date.now()
        while (Date.now() - start < 120_000) {
          if (omEvents.some((e) => e.type === 'agent_end')) break
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      // 手动压缩（force 观察）——真实调用 OM 后台 Observer 模型
      omEvents.length = 0
      const compacted = await rtOm.compact({ nodeId: 'e2e-om' })
      expect(compacted.ok).toBe(true)
      // 压缩事件：start/end 成对（钩子桥接）。force 观察在有两轮真实消息时必须实际发生
      const starts = omEvents.filter((e) => e.type === 'compaction_start')
      const ends = omEvents.filter((e) => e.type === 'compaction_end')
      expect(starts.length).toBeGreaterThan(0)
      expect(starts.length).toBe(ends.length)
      const endEvent = ends[0] as Extract<ChatEvent, { type: 'compaction_end' }> | undefined
      expect(endEvent?.aborted).toBe(false)
      // 原文仍可回查（计划 §16.2-6：压缩后 recall 可回查原文）
      const recalled = await rtOm.history({ nodeId: 'e2e-om', sessionFile: 'mastra:node-e2e-om' })
      expect(recalled.ok).toBe(true)
      if (recalled.ok) {
        expect(recalled.value.messages.some((m) => m.text.includes('蓝鲸七号'))).toBe(true)
      }
      await rtOm.dispose({ nodeId: 'e2e-om' })
    },
    240_000
  )

  it(
    'Phase 2：working memory 写入落库（真 Memory + LibSQL，thread 级）',
    async () => {
      const wmEvents: ChatEvent[] = []
      const credentials = new InMemoryCredentialStore()
      await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
      const manager = new ChatModelManager({ credentials, config: {} })
      const rtWm = new MastraAgentRuntime({
        broadcast: (e) => wmEvents.push(e),
        currentDir: () => wsDir,
        defaultModel: () => 'deepseek/deepseek-flash',
        managerForWorkspace: async () => manager,
        runtimeInfo: async () => ({ ok: true as const, value: { ready: true, models: [], configuredProviders: [] } satisfies ChatRuntimeInfo }),
        assembleTools: async () => [],
      })
      await rtWm.create({ nodeId: 'e2e-wm' })
      const p = await rtWm.prompt({
        nodeId: 'e2e-wm',
        text: '请记住：我的偏好是用中文简洁回复。请把这条偏好更新到工作记忆里，然后只回复"已记住"。',
      })
      expect(p.ok).toBe(true)
      const start = Date.now()
      while (Date.now() - start < 120_000) {
        if (wmEvents.some((e) => e.type === 'agent_end')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const memory = await mastraMemoryFor(wsDir)
      const wm = await memory.getWorkingMemory({ threadId: 'node-e2e-wm', resourceId: MEMORY_RESOURCE })
      expect(wm).toBeTruthy()
      expect(wm!).toContain('简洁')
      await rtWm.dispose({ nodeId: 'e2e-wm' })
    },
    180_000
  )

  it(
    '工具链路：模型调用工具 → tool_start/tool_end + details 钉卡透传 → 定稿消息',
    async () => {
      const toolEvents: ChatEvent[] = []
      // 框架无关的假工具（真实工具经 chat.ts 的 assembleTools 组装，链路同一适配层）
      const fakeTool = {
        name: 'echo_card',
        label: '回声卡片',
        description: '在画布上创建一张回声卡片。用户要求创建卡片时必须调用本工具。',
        parameters: { type: 'object', properties: { title: { type: 'string', description: '卡片标题' } }, required: ['title'] },
        execute: async (_toolCallId: string, params: { title?: string }) => ({
          content: [{ type: 'text' as const, text: `已创建卡片：${params.title ?? '?'}` }],
          details: { published: { name: params.title ?? '?', kind: 'note' } },
        }),
      }
      const credentials = new InMemoryCredentialStore()
      await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
      const manager = new ChatModelManager({ credentials, config: {} })
      const rtTools = new MastraAgentRuntime({
        broadcast: (e) => toolEvents.push(e),
        currentDir: () => wsDir,
        defaultModel: () => 'deepseek/deepseek-flash',
        managerForWorkspace: async () => manager,
        runtimeInfo: async () => ({ ok: true as const, value: { ready: true, models: [], configuredProviders: [] } satisfies ChatRuntimeInfo }),
        assembleTools: async () => [fakeTool as never],
      })
      const created = await rtTools.create({ nodeId: 'e2e-tools' })
      expect(created.ok && created.value.activeTools).toEqual(['echo_card'])
      const p = await rtTools.prompt({ nodeId: 'e2e-tools', text: '请调用 echo_card 创建一张标题为"测试卡片"的卡片，然后告诉我结果。' })
      expect(p.ok).toBe(true)
      const start = Date.now()
      while (Date.now() - start < 120_000) {
        if (toolEvents.some((e) => e.type === 'agent_end')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const toolStart = toolEvents.find((e) => e.type === 'tool_start') as Extract<ChatEvent, { type: 'tool_start' }> | undefined
      expect(toolStart?.toolName).toBe('echo_card')
      expect(toolStart?.args).toMatchObject({ title: '测试卡片' })
      const toolEnd = toolEvents.find((e) => e.type === 'tool_end') as Extract<ChatEvent, { type: 'tool_end' }> | undefined
      expect(toolEnd?.isError).toBe(false)
      expect(toolEnd?.resultText).toContain('已创建卡片')
      expect(toolEnd?.details).toContain('published')
      const end = toolEvents.find((e) => e.type === 'agent_end') as Extract<ChatEvent, { type: 'agent_end' }> | undefined
      expect(end?.stopReason).toBe('stop')
      await rtTools.dispose({ nodeId: 'e2e-tools' })
    },
    180_000
  )

  it(
    '回滚演练（数据层）：Mastra 写入不污染 Pi 会话数据——flag 切回 pi 后 JSONL/canvas 原样',
    async () => {
      // 预置 Pi 侧数据：一个 JSONL 会话 + canvas.json（内容签名记录）
      const sessionsDir = join(wsDir, '.huabu', 'sessions')
      mkdirSync(sessionsDir, { recursive: true })
      const piSession = join(sessionsDir, 'pi-session.jsonl')
      writeFileSync(piSession, '{"v":1,"role":"user","text":"pi 数据"}' + String.fromCharCode(10), 'utf8')
      const canvasFile = join(wsDir, '.huabu', 'canvas.json')
      writeFileSync(canvasFile, '{"version":1,"nodes":[]}', 'utf8')
      const canvasBefore = readFileSync(canvasFile, 'utf8')
      const piBefore = readFileSync(piSession, 'utf8')

      const credentials = new InMemoryCredentialStore()
      await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
      const manager = new ChatModelManager({ credentials, config: {} })
      const rt4 = new MastraAgentRuntime({
        broadcast: () => {},
        currentDir: () => wsDir,
        defaultModel: () => 'deepseek/deepseek-flash',
        managerForWorkspace: async () => manager,
        runtimeInfo: async () => ({ ok: true as const, value: { ready: true, models: [], configuredProviders: [] } satisfies ChatRuntimeInfo }),
        assembleTools: async () => [],
      })
      await rt4.create({ nodeId: 'e2e-rollback' })
      const p = await rt4.prompt({ nodeId: 'e2e-rollback', text: '只回复：好' })
      expect(p.ok).toBe(true)
      const start = Date.now()
      while (Date.now() - start < 120_000) {
        const usage = await rt4.contextUsage({ nodeId: 'e2e-rollback' })
        if (usage.ok && usage.value.tokens !== null) break
        await new Promise((r) => setTimeout(r, 100))
      }
      await rt4.dispose({ nodeId: 'e2e-rollback' })

      // 断言：Pi 的数据字节级未动；sessions 目录没有新增 Mastra 文件；mastra.db 独立存在
      expect(readFileSync(piSession, 'utf8')).toBe(piBefore)
      expect(readFileSync(canvasFile, 'utf8')).toBe(canvasBefore)
      expect(readdirSync(sessionsDir)).toEqual(['pi-session.jsonl'])
      expect(existsSync(join(wsDir, '.huabu', 'mastra.db'))).toBe(true)
      // 前缀路由（chat:history 的 mastra: 键）：Mastra 会话历史在 pi flag 语义下仍可回放
      const history = await rt4.history({ nodeId: 'ghost-after-rollback', sessionFile: 'mastra:node-e2e-rollback' })
      expect(history.ok).toBe(true)
    },
    240_000
  )
})
