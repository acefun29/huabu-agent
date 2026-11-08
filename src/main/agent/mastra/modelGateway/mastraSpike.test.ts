/**
 * Phase 0 Spike：vendored Mastra Agent × 自有 ModelGateway（计划 §1.5/§11.2-5）。
 *
 * 真实模型、真实工具、走现有 `ChatModelManager` 目录 + 凭据解析路径：
 * - 通道 1：DeepSeek 官方（openai-completions 协议，DEEPSEEK_API_KEY）
 * - 通道 2：anthropic-messages 协议（DeepSeek 的 /anthropic 兼容端点，userProviders
 *   baseUrl 覆盖这条真实用户路径；本机 ANTHROPIC_BASE_URL 指向该端点）
 * - 通道 3：通义千问（openai-completions，ALI_API_KEY）——第二家真供应商
 * 无环境凭据时整组跳过（CI 的 `pnpm test` 不跑网络用例）。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { ChatModelManager } from '../../../models/manager'
import { aiSdkLanguageModel, createModelGateway } from './index'
import { formatModelRef, type ModelRef } from './types'

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY
const ALI_KEY = process.env.ALI_API_KEY
/** DeepSeek 的 Anthropic 兼容端点（curl 实测：x-api-key + claude-ssi-5 可用） */
const DS_ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic'

/** Spike 专用目录：anthropic 用兼容端点 baseUrl 覆盖（用户 overlay 的同一条真实路径） */
async function buildGateway() {
  const credentials = new InMemoryCredentialStore()
  if (DEEPSEEK_KEY) {
    await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY }))
  }
  if (DEEPSEEK_KEY) {
    await credentials.modify('anthropic', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY }))
  }
  if (ALI_KEY) {
    await credentials.modify('qwen', async () => ({ type: 'api_key' as const, key: ALI_KEY }))
  }
  const manager = new ChatModelManager({
    credentials,
    config: {
      // anthropic 内置条目被用户 overlay 覆盖到 DeepSeek 的 /anthropic 端点，
      // 并按用户自建模型登记该端点实际提供的 claude-ssi-5（真实用户路径）
      userProviders: [
        {
          id: 'anthropic',
          baseUrl: DS_ANTHROPIC_BASE,
          models: [
            {
              id: 'claude-ssi-5',
              name: 'Claude SSI 5（DeepSeek Anthropic 兼容）',
              reasoning: true,
              input: ['text'],
              contextWindow: 200_000,
              maxTokens: 8_192,
            },
          ],
        },
      ],
    },
  })
  return { gateway: createModelGateway({ registrations: () => manager.registrations() }), manager }
}

const DEEPSEEK_REF: ModelRef = { providerId: 'deepseek', modelId: 'deepseek-flash' }
const ANTHROPIC_REF: ModelRef = { providerId: 'anthropic', modelId: 'claude-ssi-5' }
const QWEN_REF: ModelRef = { providerId: 'qwen', modelId: 'qwen3.7-plus' }

const weatherTool = createTool({
  id: 'get_weather',
  description: '查询指定城市的天气',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
  } as Record<string, unknown>,
  execute: async (inputData: unknown) => {
    // Mastra 1.82：第一个参数就是校验后的输入
    const c = (inputData ?? {}) as { city?: string }
    return { city: c.city ?? '?', weather: '晴，24℃' }
  },
})

function buildAgent(ref: ModelRef, withTool: boolean) {
  const { gateway } = gatewayHandle!
  return new Agent({
    name: 'spike-agent',
    id: 'spike-agent',
    instructions: '你是花布 spike 助手。回答保持一句话。需要天气时必须调用 get_weather 工具。',
    model: aiSdkLanguageModel(gateway, ref),
    ...(withTool ? { tools: { get_weather: weatherTool } } : {}),
  })
}

let gatewayHandle: Awaited<ReturnType<typeof buildGateway>> | null = null

afterAll(() => {
  gatewayHandle = null
})

describe.skipIf(!DEEPSEEK_KEY)('ModelGateway × Mastra（DeepSeek / openai-completions）', () => {
  it(
    'resolve：模型进生效清单，能力声明正确',
    async () => {
      gatewayHandle = await buildGateway()
      const handle = await gatewayHandle.gateway.resolve(DEEPSEEK_REF)
      expect(formatModelRef(handle.ref)).toBe('deepseek/deepseek-flash')
      expect(handle.capabilities.toolCall).toBe(true)
      expect(handle.capabilities.imageInput).toBe(true) // deepseek-flash 目录声明含 image
      expect(handle.capabilities.maxContext).toBeGreaterThan(0)
    },
30_000
  )

  it(
    'stream：文本流式 + 工具调用 + usage + finish',
    async () => {
      gatewayHandle ??= await buildGateway()
      const agent = buildAgent(DEEPSEEK_REF, true)
      const events = await agent.stream('北京今天天气如何？')
      const textChunks: string[] = []
      const toolCalls: string[] = []
      const toolResults: string[] = []
      let usageTotal = -1
      for await (const chunk of events.fullStream) {
        if (chunk.type === 'text-delta') textChunks.push(chunk.payload.text)
        else if (chunk.type === 'tool-call') toolCalls.push(chunk.payload.toolName)
        else if (chunk.type === 'tool-result' && chunk.payload.toolName === 'get_weather') {
          toolResults.push(String((chunk.payload.result as { weather?: string } | undefined)?.weather ?? ''))
        } else if (chunk.type === 'finish') {
          const usage = chunk.payload.output.usage
          usageTotal = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        }
      }
      expect(toolCalls).toContain('get_weather')
      expect(toolResults).toContain('晴，24℃')
      expect(textChunks.join('')).toContain('晴')
      expect(usageTotal).toBeGreaterThan(0)
    },
120_000
  )

  it(
    'abort：运行中取消，流终止且不崩',
    async () => {
      gatewayHandle ??= await buildGateway()
      const agent = buildAgent(DEEPSEEK_REF, false)
      const controller = new AbortController()
      const events = await agent.stream('写一篇 500 字的散文', { abortSignal: controller.signal })
      let sawDelta = false
      let ended = false
      try {
        for await (const chunk of events.fullStream) {
          if (chunk.type === 'text-delta' && !sawDelta) {
            sawDelta = true
            controller.abort()
          }
        }
      } catch {
        // 中止后的读取异常是可接受路径之一（AbortError）
      } finally {
        ended = true
      }
      expect(sawDelta).toBe(true)
      expect(ended).toBe(true)
    },
60_000
  )
})

describe.skipIf(!DEEPSEEK_KEY)('ModelGateway × Mastra（anthropic-messages 协议 · DeepSeek /anthropic 兼容端点）', () => {
  it(
    'stream：第二供应商文本 + usage（不经 Mastra provider router）',
    async () => {
      gatewayHandle ??= await buildGateway()
      const agent = buildAgent(ANTHROPIC_REF, false)
      const events = await agent.stream('用一句话说明你是否能看到这条消息。')
      const text: string[] = []
      let totalTokens = -1
      for await (const chunk of events.fullStream) {
        if (chunk.type === 'text-delta') text.push(chunk.payload.text)
        else if (chunk.type === 'finish') {
          const usage = chunk.payload.output.usage
          totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        }
      }
      expect(text.join('').length).toBeGreaterThan(0)
      expect(totalTokens).toBeGreaterThan(0)
    },
120_000
  )

  it(
    'tool call：anthropic 通道的工具调用往返',
    async () => {
      gatewayHandle ??= await buildGateway()
      const agent = buildAgent(ANTHROPIC_REF, true)
      const events = await agent.stream('上海天气怎么样？')
      const toolNames: string[] = []
      for await (const chunk of events.fullStream) {
        if (chunk.type === 'tool-call') toolNames.push(chunk.payload.toolName)
      }
      expect(toolNames).toContain('get_weather')
    },
120_000
  )
})

describe.skipIf(!ALI_KEY)('ModelGateway × Mastra（通义千问 / 第二家供应商）', () => {
  it.skip('stream：qwen 文本 + usage（多供应商同网关）——ALI key 在 dashscope/compatible-mode 返回 401，'
    + 'token-plan 端点可鉴权但当前无已购模型；待补可用凭据后启用（Phase0 记录遗留项）', async () => {
      gatewayHandle ??= await buildGateway()
      const agent = buildAgent(QWEN_REF, false)
      const events = await agent.stream('用一句话回答：1+1 等于几？')
      const text: string[] = []
      let totalTokens = -1
      for await (const chunk of events.fullStream) {
        if (chunk.type === 'text-delta') text.push(chunk.payload.text)
        else if (chunk.type === 'finish') {
          const usage = chunk.payload.output.usage
          totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        }
      }
      expect(text.join('')).toContain('2')
      expect(totalTokens).toBeGreaterThan(0)
    },
    120_000
  )
})
