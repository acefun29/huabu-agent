import { defineProvider } from '../define'

/**
 * OpenAI 官方站聊天模型目录（全球服务，与 anthropic 同批补录，理由见 providers/anthropic.ts 头）。
 *
 * ⚠ **数值出处与已知缺口**：本期（2026-09-24）本机访问 `platform.openai.com/docs/models`
 * 与 `/docs/pricing` 返回 **403**，官方页**未能逐页复核**。数据取自 pi 上游手工维护的
 * `providers/data/openai.json`（pi 的生产数据），wire 形态经 `pi-ai/dist/api/openai-responses.js`
 * 源码核对并由 `pnpm chat-catalog:wire` 真 pi 报文坐实。`costSource` 一律 `pi-upstream`。
 *
 * 协议用 `openai-responses`（不是 completions）：pi 的 openai provider 上游清单整族走
 * Responses API，模型 id 与思考字段都按那一套发。别以为它是 §2.5 那张 openai-completions
 * 分支表里的 `"openai"` 兜底——那张表管的是 `/chat/completions`，这里是 `/responses`。
 *
 * thinking 形态（openai-responses.js:253-271 核对结论）：
 * 2026-09-26 官网复核：GPT-5.1+ 系 reasoning.effort 官方值为 none/minimal/low/medium/high
 * （默认随代次演进，GPT-5.1 起 none）；xhigh/max 为 pi 上游对新代模型的扩展映射，wire 实测在案。
 * - 会话里选了档位（有 reasoningEffort）→ `reasoning:{effort, summary:"auto"}`
 *   + `include:["reasoning.encrypted_content"]`；effort 值过 `thinkingLevelMap`，
 *   映射到 `null` 的档位被跳过并回落请求值；
 * - **没选档位**时看 `thinkingLevelMap.off`：是字符串（多为 `"none"`）→ 发
 *   `reasoning:{effort:"none"}` 显式关；是 `null` → **什么都不发**（该模型不能关思考）。
 *   这就是本文件每条模型都必须显式写 `off` 的原因：漏写与写 null 落同一个行为，
 *   想关却关不掉是静默的（不报错、只是照旧思考、照旧计费）。
 *
 * `cost.tiers`（输入 token 超过阈值后的第二档价）按上游原样带上，pi 的 ModelCost 支持；
 * 我们当前不在 UI 展示价格（grep 证实），带错了不影响主链路，复核时一并订正。
 */
export default defineProvider({
  id: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  api: 'openai-responses',
  region: 'global',
  auth: {
    label: 'OpenAI API Key',
    env: 'OPENAI_API_KEY',
    helpUrl: 'https://platform.openai.com/api-keys',
    hint: '组织需完成验证才能调用部分新代模型；中国大陆网络不可达官方端点'
  },
  models: [
    {
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      reasoning: true,
      input: ['text', 'image'],
      // off:null → 关不掉（什么都不发）；max 档存在说明它吃最高思考档
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }]
      },
      costSource: 'pi-upstream',
      contextWindow: 272_000,
      maxTokens: 128_000,
      costHint: '超过 272K 输入上下文按第二档计价（约翻倍）',
      note: '官方页 403 未复核，数值取自 pi 上游',
      compat: {
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsExplicitPromptCacheMode: true
      }
    },
    {
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      cost: {
        input: 4,
        output: 20,
        cacheRead: 0.4,
        cacheWrite: 5,
        tiers: [{ inputTokensAbove: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }]
      },
      costSource: 'pi-upstream',
      contextWindow: 272_000,
      maxTokens: 128_000,
      costHint: '主力档；超 272K 输入走第二档',
      note: '官方页 403 未复核，数值取自 pi 上游',
      compat: {
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsExplicitPromptCacheMode: true
      }
    },
    {
      id: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      cost: {
        input: 2,
        output: 12,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 272_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }]
      },
      costSource: 'pi-upstream',
      contextWindow: 272_000,
      maxTokens: 128_000,
      note: '官方页 403 未复核，数值取自 pi 上游',
      compat: {
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsExplicitPromptCacheMode: true
      }
    },
    {
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      cost: {
        input: 0.2,
        output: 1.2,
        cacheRead: 0.02,
        cacheWrite: 0.25,
        tiers: [{ inputTokensAbove: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }]
      },
      costSource: 'pi-upstream',
      contextWindow: 272_000,
      maxTokens: 128_000,
      costHint: '便宜档，适合默认快模',
      note: '官方页 403 未复核，数值取自 pi 上游',
      compat: {
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsExplicitPromptCacheMode: true
      }
    }
  ]
})
