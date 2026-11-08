/**
 * Phase 0 Spike：Mastra memory 基础语义 × 自有 ModelGateway（计划 §1.5/§8）。
 *
 * 用 core 自带的 MockMemory + InMemoryStore（@mastra/memory 未 vendor，observational
 * memory 列为遗留项），经 DeepSeek 真模型验证：
 * - thread 连续性：多轮记忆 + recall 历史落库（网关的消息往返映射被完整回放）
 * - working memory：模型自主调用 update_working_memory 更新，getWorkingMemory 可读
 * - context 临时注入：本轮可见、不落库（资产 manifest 注入机制的同构验证）
 * - inputProcessors：TokenLimiterProcessor 跑通不炸
 * 无环境凭据时整组跳过。
 */

import { describe, expect, it } from 'vitest'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { Agent } from '@mastra/core/agent'
import { InMemoryStore } from '@mastra/core/storage'
import { MockMemory } from '@mastra/core/memory'
import { TokenLimiterProcessor } from '@mastra/core/processors'
import { ChatModelManager } from '../../../models/manager'
import { aiSdkLanguageModel, createModelGateway } from '.'
import type { ModelRef } from './types'

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
const REF: ModelRef = { providerId: 'deepseek', modelId: 'deepseek-flash' }

async function buildAgent(opts: { workingMemory?: boolean; tokenLimit?: number } = {}) {
  const credentials = new InMemoryCredentialStore()
  await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
  const manager = new ChatModelManager({ credentials, config: {} })
  const gateway = createModelGateway({ registrations: () => manager.registrations() })
  const memory = new MockMemory({
    storage: new InMemoryStore(),
    enableWorkingMemory: opts.workingMemory ?? false,
    ...(opts.workingMemory
      ? {
          workingMemoryTemplate: '# 工作记忆\n\n## 用户档案\n- （待补充）\n\n## 当前任务\n- （待补充）\n',
        }
      : {}),
    options: { lastMessages: 20 },
  })
  const agent = new Agent({
    name: 'memory-spike',
    id: 'memory-spike',
    instructions: '你是花布 spike 助手。回答尽量短。'
      + (opts.workingMemory ? '当用户提供关于他自己的持久事实时，调用 update_working_memory 工具把它记进工作记忆。' : ''),
    model: aiSdkLanguageModel(gateway, REF),
    memory,
    ...(opts.tokenLimit ? { inputProcessors: [new TokenLimiterProcessor({ limit: opts.tokenLimit })] } : {}),
  })
  return { agent, memory }
}

async function collectText(stream: Awaited<ReturnType<Agent['stream']>>): Promise<string> {
  let text = ''
  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'text-delta') text += chunk.payload.text
  }
  return text
}

describe.skipIf(!DEEPSEEK_KEY)('Mastra memory × ModelGateway（DeepSeek）', () => {
  it(
    'thread 连续性：第二轮记得第一轮，历史落库',
    async () => {
      const { agent, memory } = await buildAgent()
      await collectText(
        await agent.stream('我叫小明，只说"好的"。', { memory: { thread: 'spike-continuity', resource: 'spike-user' } })
      )
      const answer = await collectText(
        await agent.stream('我叫什么名字？只回答名字。', { memory: { thread: 'spike-continuity', resource: 'spike-user' } })
      )
      expect(answer).toContain('小明')
      const history = await memory.recall({ threadId: 'spike-continuity', resourceId: 'spike-user' })
      // 至少：两轮 user + 两轮 assistant
      expect(history.messages.length).toBeGreaterThanOrEqual(4)
      expect(history.messages.some((m) => m.role === 'assistant')).toBe(true)
    },
    180_000
  )

  it(
    'working memory：模型更新工具可写，getWorkingMemory 可读',
    async () => {
      const { agent, memory } = await buildAgent({ workingMemory: true })
      await collectText(
        await agent.stream('请记住：我喜欢的颜色是青绿色。', { memory: { thread: 'spike-wm', resource: 'spike-wm-user' } })
      )
      const wm = await memory.getWorkingMemory({ threadId: 'spike-wm', resourceId: 'spike-wm-user' })
      expect(wm).toBeTruthy()
      expect(wm!).toContain('青绿')
    },
    180_000
  )

  it(
    'context 临时注入：本轮可见、不落库',
    async () => {
      const { agent, memory } = await buildAgent()
      const first = await collectText(
        await agent.stream('我的名字是什么？只回答名字。', {
          memory: { thread: 'spike-ctx', resource: 'spike-ctx-user' },
          context: [{ role: 'system', content: '背景注入：用户的名字是小红。' }],
        })
      )
      expect(first).toContain('小红')
      const second = await collectText(
        await agent.stream('再报一次我的名字？只回答名字或"不知道"。', {
          memory: { thread: 'spike-ctx', resource: 'spike-ctx-user' },
        })
      )
      expect(second).not.toContain('小红')
      const history = await memory.recall({ threadId: 'spike-ctx', resourceId: 'spike-ctx-user' })
      const persisted = JSON.stringify(history.messages)
      // 助手第一轮的回答自然含名字；要验证的是 context 本身（背景注入段）没有被持久化
      expect(persisted).not.toContain('背景注入')
    },
    180_000
  )

  it(
    'inputProcessors：TokenLimiterProcessor 小预算不炸',
    async () => {
      const { agent } = await buildAgent({ tokenLimit: 400 })
      const text = await collectText(
        await agent.stream('用一句话回答：天空通常是什么颜色？', { memory: { thread: 'spike-tl', resource: 'spike-tl-user' } })
      )
      expect(text.length).toBeGreaterThan(0)
    },
    120_000
  )
})
