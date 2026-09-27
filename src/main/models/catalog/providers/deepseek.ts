import { defineProvider } from '../define'

/**
 * DeepSeek 内置聊天模型目录（compat 按实施计划 §2.5/§2.7，形态已线上实测 9/9）。
 *
 * 出处分两路，各自可回溯：
 * - 模型 id / 能力 / thinking 形态：官方文档（api-docs.deepseek.com 的 pricing、
 *   thinking_mode、vision、create-chat-completion 四页，2026-09-24 逐页核实）；
 *   `deepseek-chat`/`deepseek-reasoner` 已不在官方文档，旧 `deepseek-v4-flash*`
 *   官方标注"名可调但模型已下线"→ 标 deprecated 保留（取代关系写在 replacedBy）。
 * - cost / contextWindow / maxTokens：`deepseek-flash` 用官方 pricing 页 peak 档；
 *   `deepseek-v4-pro` 用 pi 上游手工数据（providers/data/deepseek.json）—— 它不是
 *   我们独立复核的，故标 note。
 *
 * wire 形态实测记录（scripts/t3-deepseek-spike.mjs）：
 *   thinking={"type":"enabled"} + 顶层 reasoning_effort + max_tokens（非 mct）；
 *   带 tools 的前轮 assistant 消息必须原样回传 reasoning_content，pi 的
 *   requiresReasoningContentOnAssistantMessages + thinkingSignature 原生满足。
 */
export default defineProvider({
  id: 'deepseek',
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  api: 'openai-completions',
  region: 'cn-direct',
  auth: {
    label: 'DeepSeek API Key',
    env: 'DEEPSEEK_API_KEY',
    helpUrl: 'https://platform.deepseek.com/api_keys'
  },
  models: [
    {
      // 官方推荐模型（V4.1-Flash，2026-09-10 上线），视觉能力已并入本模型
      id: 'deepseek-flash',
      label: 'DeepSeek V4.1 Flash',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      costSource: 'official',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      costHint: '官方 peak 档；off-peak 约减半（input 0.15 / output 0.6）',
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek'
      }
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      reasoning: true,
      input: ['text'],
      // 官方无 low 档（§2.7 用上游数据精修：只有 high/max 可发）
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
      cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      note: 'cost 取自 pi 上游手工数据，未独立对官方 pricing 页复核',
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek'
      }
    },
    /* ---------------- 上游已退役，保留条目只为让老配置能解释自己 ---------------- */
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash（已下线）',
      reasoning: true,
      input: ['text'],
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      status: 'deprecated',
      replacedBy: 'deepseek-flash',
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek'
      }
    },
    {
      id: 'deepseek-v4-flash-vision-exp',
      label: 'DeepSeek V4 Flash Vision Exp（已下线）',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      status: 'deprecated',
      replacedBy: 'deepseek-flash',
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek'
      }
    }
  ]
})
