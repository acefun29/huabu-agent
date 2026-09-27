import { defineProvider } from '../define'

/**
 * 通义千问（阿里云百炼 / DashScope）内置聊天目录（compat 按 §2.5/§2.7，**未线上终验**）。
 *
 * 本文件**不**用 pi 的 `qwen-token-plan` 数据当价格来源：那是订阅制（token plan）通道，
 * 上游给的是 `cost 0/0/0`，搬到 API-Key 通道上就是个假数字（§2.7 末段）。这里只借它的
 * contextWindow/maxTokens（那是模型固有上限，与计费通道无关），价格一律标 `unverified`。
 *
 * 两个必写的 compat：
 * - **`thinkingFormat:'qwen'`**：官方开思考用顶层 `enable_thinking`，而 dashscope 域名不在
 *   pi 的任何特判里 → 不覆写就走 `"openai"` 兜底、只发 `reasoning_effort`、**开不了思考**。
 * - **`thinkingTokenBudgetField:'thinking_budget'`**：官方预算参数叫 `thinking_budget`，
 *   pi 默认发 `thinking_token_budget`（vLLM 名）。pi 留了这个覆写口（openai-completions.js:767，
 *   其类型注释原文就写着 `"thinking_budget"` is Qwen/DashScope/SGLang），所以字段名错配在
 *   catalog 层就修掉了，不需要改 pi、也不需要自定义 streamSimple。
 *
 * `supportsReasoningEffort:false`：官方 deep-thinking 页给的是 `enable_thinking` +
 * `thinking_budget`，没有 `reasoning_effort`；上游对 dashscope 也没有可交叉核对的数据。
 * 宁缺勿滥——多发一个官方未记载的字段属于未定义行为。
 * 2026-09-26 复核：官方文档确认 enable_thinking（开关，商业版默认 false）+
 * thinking_budget（预算上限，思考 token 全额计费），无档位枚举——档位经 pi 预算换算。
 *
 * 未入目录（等官方复核，勿凭印象补数字）：`qwen-plus`/`qwen3-max` 稳定别名、Qwen3-VL 系视觉模型。
 * Key 按地域绑定、跨地域 401（§2.3-4），故 auth.hint 原文提示。
 */
export default defineProvider({
  id: 'qwen',
  label: '通义千问',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  api: 'openai-completions',
  region: 'cn-direct',
  auth: {
    label: '百炼 API Key',
    env: 'DASHSCOPE_API_KEY',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    hint: 'Key 与站点地域绑定，跨地域调用返回 401'
  },
  models: [
    {
      id: 'qwen3.8-max',
      label: 'Qwen3.8 Max',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'unverified',
      // 价格未复核就按目录自检的规则挂 beta（validateBuiltinCatalog 会拒 stable+unverified 组合）
      status: 'beta',
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      note: '价格为占位（当前 cost 不参与任何 UI 展示）；待对官方 pricing 页复核',
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen',
        thinkingTokenBudgetField: 'thinking_budget'
      }
    },
    {
      id: 'qwen3.7-plus',
      label: 'Qwen3.7 Plus',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'unverified',
      status: 'beta',
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      note: '价格为占位；待复核',
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen',
        thinkingTokenBudgetField: 'thinking_budget'
      }
    }
  ]
})
