import { defineProvider } from '../define'

/**
 * 阿里云百炼 Token Plan（订阅制）内置聊天目录。
 *
 * 端点与 Key（2026-10-25 对照 help.aliyun.com/zh/model-studio 官方文档核实：
 * token-plan-personal-overview / token-plan-personal-quick-start）：
 * - 个人版仅华北2（北京），OpenAI 兼容 Base URL `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
 *   （Anthropic 兼容 `…/apps/anthropic` 存在，一期不走，与 qwen.ts 同口径）。
 * - Key 前缀 `sk-sp-`，与按量百炼的 `sk-` Key **不通用**；订阅到期 Key 失效、续费自动恢复。
 * - 计费为 Credits 统一抵扣，无按 token 价格——cost 全 0 是订阅制的真实语义
 *   （qwen.ts 文件头所述「上游给的是 cost 0/0/0」正是本通道），不是占位假数字。
 *
 * 18 个模型逐字段取自 pi 包内本通道的上游数据
 * `@earendil-works/pi-ai/dist/providers/data/qwen-token-plan-cn.json`（costSource
 * 'pi-upstream'）：baseUrl/compat/thinkingLevelMap/contextWindow/maxTokens 与官方文档
 * 交叉一致。pi 的 provider id 是 `qwen-token-plan-cn`，本目录**另起** `token-plan`——
 * 不复用同名（避开 migrate.ts 把它列进 ORPHAN_CREDENTIAL_KEYS 的搬运语义）。
 *
 * 3 个官方「支持的模型」表有而 pi 数据无的新条目，数值出处为官方模型信息页
 * （2026-10-25 取回）；其 cost 无 token 价目可复核，按自检规则挂 beta：
 * - glm-5.3（help.aliyun.com/zh/model-studio/glm-5-3）：1048576/131072；
 *   GLM 页核实「仅支持思考模式、不支持关闭」→ thinkingLevelMap.off:null，effort 三档 low/high/max。
 * - deepseek-v4.1-flash / -1017（…/deepseek-v4-1-flash）：1000000/393216，
 *   表内标注具备视觉理解 → input text+image；compat 镜像 pi 的 deepseek-v4-flash 条目。
 *
 * 一期未入目录（宁缺勿滥，同 qwen.ts 先例）：`auto`（智能路由、无固定窗口数值出处）、
 * `decision-model-preview`（领域模型，接入方式走专属文档）、`qwen3.8-max-preview`
 * （官方已下线、旧 ID 自动路由 qwen3.8-max）。
 *
 * **合规提示**（官方「订阅前须知」）：Token Plan 仅限编程/智能体工具中交互式使用，
 * 脚本化批量调用会被判违规。本应用属交互式 Agent 工具，auth.hint 原文提醒。
 */
export default defineProvider({
  id: 'token-plan',
  label: '阿里云 Token Plan',
  baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  api: 'openai-completions',
  region: 'cn-direct',
  auth: {
    label: 'Token Plan 套餐 API Key（订阅页生成，与按量百炼 Key 不通用）',
    env: 'TOKEN_PLAN_KEY',
    helpUrl: 'https://bailian.console.aliyun.com/cn-beijing/subscription/overview',
    hint: '订阅制 Credits 抵扣；套餐到期 Key 即失效、续费自动恢复。官方条款：仅限编程/智能体工具内交互式使用'
  },
  models: [
    /* ---------------- 以下 18 条逐字段取自 pi qwen-token-plan-cn 数据 ---------------- */
    {
      id: 'MiniMax-M2.5',
      label: 'MiniMax M2.5',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 196608,
      maxTokens: 32768,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'deepseek-v3.2',
      label: 'DeepSeek V3.2',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 131072,
      maxTokens: 65536,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 384000,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'deepseek-v4-flash-0731',
      label: 'DeepSeek V4 Flash 0731',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 384000,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      },
      costHint: '限时夜间五折（22:00-08:00，Credits）'
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 384000,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'deepseek-v4-pro-0813',
      label: 'DeepSeek V4 Pro 0813',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 384000,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      },
      costHint: '限时夜间五折（22:00-08:00，Credits）'
    },
    {
      id: 'glm-5',
      label: 'GLM-5',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 202752,
      maxTokens: 16384,
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'glm-5.1',
      label: 'GLM-5.1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 202752,
      maxTokens: 128000,
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'glm-5.2',
      label: 'GLM-5.2',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 131072,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'kimi-k2.5',
      label: 'Kimi K2.5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 262144,
      maxTokens: 98304,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'kimi-k2.6',
      label: 'Kimi K2.6',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 262144,
      maxTokens: 262144,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'kimi-k2.7-code',
      label: 'Kimi K2.7 Code',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 262144,
      maxTokens: 262144,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'qwen3.6-flash',
      label: 'Qwen3.6 Flash',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 65536,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'qwen3.6-plus',
      label: 'Qwen3.6 Plus',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 65536,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'qwen3.7-max',
      label: 'Qwen3.7 Max',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 131072,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'qwen3.7-plus',
      label: 'Qwen3.7 Plus',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 65536,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'qwen'
      }
    },
    {
      id: 'qwen3.8-flash',
      label: 'Qwen3.8 Flash',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 131072,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh', max: null },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      },
      costHint: '限时夜间四折（22:00-08:00，Credits）'
    },
    {
      id: 'qwen3.8-max',
      label: 'Qwen3.8 Max',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1000000,
      maxTokens: 131072,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh', max: null },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      },
      costHint: '限时夜间四折（22:00-08:00，Credits）'
    },

    /* ---------------- 官方表新增（pi 数据无，数值出处见文件头；beta = 价目待复核） ---------------- */
    {
      id: 'glm-5.3',
      label: 'GLM-5.3',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'unverified',
      status: 'beta',
      contextWindow: 1048576,
      maxTokens: 131072,
      // 官方 GLM 页：仅支持思考模式、不支持关闭（off:null），effort 三档 low/high/max
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      },
      note: '窗口/输出取自官方 glm-5.3 模型信息页（2026-10-25）；Credits 通道无 token 价目，价格标 unverified'
    },
    {
      id: 'deepseek-v4.1-flash',
      label: 'DeepSeek V4.1 Flash',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'unverified',
      status: 'beta',
      contextWindow: 1000000,
      maxTokens: 393216,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      },
      costHint: '限时夜间五折（22:00-08:00，Credits）',
      note: '窗口/输出取自官方 deepseek-v4.1-flash 模型信息页（2026-10-25），Token Plan 表标注具备视觉理解；compat 镜像 pi 的 v4-flash 条目'
    },
    {
      id: 'deepseek-v4.1-flash-1017',
      label: 'DeepSeek V4.1 Flash 1017',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: 'unverified',
      status: 'beta',
      contextWindow: 1000000,
      maxTokens: 393216,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: 'qwen'
      },
      costHint: '限时夜间五折（22:00-08:00，Credits）',
      note: '同 deepseek-v4.1-flash 的快照版'
    }
  ]
})
