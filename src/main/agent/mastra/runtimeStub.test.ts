import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startStubProvider } from './stubProvider'
import { InMemoryCredentialStore } from '../contracts'
import { ChatModelManager } from '../../models/manager'
import { createFileTools } from '../fileTools'
import { MastraAgentRuntime, type MastraRuntimeDeps } from './runtime'
import type { ChatEvent } from '../../../shared/ipc'

/**
 * **端到端**跑通 Mastra 运行时（不碰任何真实凭据）。
 *
 * ## 为什么需要这个测试
 *
 * 整套 `pnpm test` 到这一轮为止都用 stub 模型，走的是「目录解析 + 会话管理」，
 * **从没有一次真正把消息发给模型、把工具结果喂回去**。真实链路有三段是单测盖不到的：
 * 自写网关 ↔ OpenAI 兼容协议的字节层、Mastra Agent 的 tool 往返、以及
 * LibSQL memory 真正落库后再被读出来。而这三段恰恰是翻默认运行时之后最先暴露问题的
 * 地方。
 *
 * 办法：本地起一个最小的 OpenAI 兼容 stub（`POST /v1/chat/completions` + SSE），
 * 把它登记成用户供应商。整个 loop 走的是**生产代码路径**：
 *   ChatModelManager → registrations() → createModelGateway → fetch → SSE
 *   → aiSdkLanguageModel → Mastra Agent → toMastraTools 桥 → 真文件工具
 *   → streamReducer → ChatEvent
 *
 * 不消耗额度、不需要 key、结果确定。
 */


/* ---------------- 用例 ---------------- */

const cleanups: Array<() => void> = []
afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn()
    } catch {
      /* best-effort */
    }
  }
})

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待事件超时')
}

describe('Mastra 运行时端到端（本地 OpenAI 兼容 stub）', () => {
  it('一轮带工具的对话完整跑通：文本增量 → 工具桥 → 定稿快照与用量', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'huabu-e2e-stub-'))
    writeFileSync(join(ws, 'note.md'), '# 分镜\n第一镜', 'utf8')
    const stub = await startStubProvider({ plan: 'tool-then-text' })
    cleanups.push(() => rmSync(ws, { recursive: true, force: true }))
    cleanups.push(() => void stub.close())

    const credentials = new InMemoryCredentialStore()
    // 走真实的「已配置凭据」路径（tail 会带 Authorization，stub 不校验内容）
    await credentials.modify('stub', async () => ({ type: 'api_key' as const, key: 'stub-key' }))
    const manager = new ChatModelManager({
      credentials,
      config: {
        userProviders: [
          {
            id: 'stub',
            name: '本地 stub',
            baseUrl: stub.baseUrl,
            models: [
              {
                id: 'stub-1',
                name: 'Stub 1',
                reasoning: true,
                input: ['text'],
                contextWindow: 64_000,
                maxTokens: 4_096
              }
            ]
          }
        ]
      } as never
    })

    const events: ChatEvent[] = []
    const deps: MastraRuntimeDeps = {
      broadcast: (event) => events.push(event),
      currentDir: () => ws,
      defaultModel: () => 'stub/stub-1',
      managerForWorkspace: async () => manager,
      runtimeInfo: async () => ({ ok: true as const, value: { ready: true, models: [], configuredProviders: ['stub'] } }),
      assembleTools: async () => createFileTools({ currentDir: () => ws }),
      disabledSkills: () => [],
      builtinSkillRoots: () => []
    }
    const runtime = new MastraAgentRuntime(deps)
    cleanups.push(() => void runtime.disposeAll())

    const created = await runtime.create({ nodeId: 'n1', modelId: 'stub/stub-1' })
    expect(created.ok).toBe(true)

    const prompted = await runtime.prompt({ nodeId: 'n1', text: '工作区里有什么？' })
    expect(prompted.ok).toBe(true)

    await waitFor(() => events.some((event) => event.type === 'agent_end'))

    // 1) 事件顺序：start 在前，message 定稿在 agent_end 之前（末尾可能跟 context_usage）
    const types = events.map((event) => event.type)
    expect(types[0]).toBe('agent_start')
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_end')
    expect(types).toContain('message')
    expect(types).toContain('agent_end')
    expect(types.indexOf('message')).toBeGreaterThan(types.indexOf('tool_end'))
    expect(types.indexOf('agent_end')).toBeGreaterThan(types.indexOf('message'))

    // 2) 思考通道：网关把 reasoning_content 映射成 thinking 增量
    const thinking = events.filter(
      (event): event is Extract<ChatEvent, { type: 'delta' }> => event.type === 'delta' && event.stream === 'thinking'
    )
    expect(thinking.map((event) => event.delta).join('')).toBe('先看看工作区')

    // 3) 工具往返：模型要求 ls → 真文件工具在真目录上执行 → 结果回到模型
    const toolEnd = events.find(
      (event): event is Extract<ChatEvent, { type: 'tool_end' }> => event.type === 'tool_end'
    )
    expect(toolEnd?.toolName).toBe('ls')
    expect(toolEnd?.isError).toBe(false)
    expect(toolEnd?.resultText).toContain('note.md')
    // 第二轮请求必须把工具结果作为 role=tool 消息带回去
    expect(stub.requests.length).toBe(2)
    expect(stub.requests[1]?.messages.some((message) => message.role === 'tool')).toBe(true)

    // 4) 定稿快照与用量（streamReducer 的产出）
    const message = events.find(
      (event): event is Extract<ChatEvent, { type: 'message' }> => event.type === 'message'
    )
    const text = (message?.message.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
    expect(text).toBe('工作区里有一个 note.md')

    const end = events.find((event): event is Extract<ChatEvent, { type: 'agent_end' }> => event.type === 'agent_end')
    expect(end).toMatchObject({ usage: { input: 42, output: 7 } })

    // 5) 收尾后会话可以继续用（run 已解绑，不会卡在 busy）
    expect(await runtime.prompt({ nodeId: 'n1', text: '再来一次' })).toMatchObject({ ok: true })
    await waitFor(() => events.filter((event) => event.type === 'agent_end').length >= 2)

    // 6) 分叉：真复制 LibSQL 里的整条线程，新句柄能独立回放同一段历史
    const sourceFile = created.ok ? created.value.sessionFile : undefined
    expect(sourceFile).toMatch(/^mastra:/)
    expect(await runtime.history({ nodeId: 'n1', sessionFile: sourceFile! })).toMatchObject({ ok: true })

    const forked = await runtime.fork({ nodeId: 'n1', sessionFile: sourceFile! })
    expect(forked.ok).toBe(true)
    const forkedFile = forked.ok ? forked.value.sessionFile : ''
    expect(forkedFile).toMatch(/^mastra:/)
    expect(forkedFile).not.toBe(sourceFile)

    const forkedHistory = await runtime.history({ nodeId: 'n2', sessionFile: forkedFile })
    expect(forkedHistory).toMatchObject({ ok: true })
    const forkedMessages = forkedHistory.ok ? forkedHistory.value.messages : []
    // 复制出来的线程带着源线程的对话（至少有一轮用户消息与一条模型回复）
    expect(forkedMessages.some((message) => message.role === 'user')).toBe(true)
    expect(forkedMessages.some((message) => message.role === 'model')).toBe(true)
  }, 30_000)
})
