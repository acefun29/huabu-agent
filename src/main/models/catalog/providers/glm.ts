import { defineProvider } from '../define'

/**
 * 智谱 GLM 内置聊天目录（compat 按实施计划 §2.5/§2.7，**未线上终验**）。
 *
 * 数值出处：pi 上游手工数据 `providers/data/zai.json`，其中 5.3 / 5.3-flash 的
 * contextWindow=1M、maxTokens=128K 已与官方模型页核对一致；**价格仍是上游值**
 * （官方只给相对定价"GLM-5.3 的 1/10，限时折扣 1/20"，无绝对数字可抄），故逐条 note。
 * §2.7 的交叉核对在这家给出两个结论：
 *
 * - `thinkingFormat:'zai'` + **必须显式 `supportsReasoningEffort:true`**：`open.bigmodel.cn`
 *   命中 pi 的 isZai 探测（openai-completions.js:1242），而 isZai 会把 supportsReasoningEffort
 *   探测成 false（:1280）→ 不覆写就只发 `thinking` 不发 effort。上游也是显式 true，独立吻合。
 * - `zaiToolStream:true`：z.ai 系支持顶层 `tool_stream:true` 流式工具增量（我们原本不知道该字段）。
 *
 * **视觉（2026-09-24 对官方文档页复核订正）**：官方把 `glm-5.3-flash` 归在
 * `docs.bigmodel.cn/cn/guide/models/vlm/`（视觉语言模型）目录下并标 Vision: Yes，
 * 而 `glm-5.3` 归在 `/models/text/`（纯文本）——所以"5.x 旗舰不带视觉"是初稿误读，
 * 目录给 5.3-flash 标 `['text','image']` 与官方一致。`glm-4.6v` 是更早的一代视觉模
 * （官方页仍在，128K 上下文、图/视频/文件输入），一期不用它做视觉路径；它仍可作为
 * 用户自定义条目或后续按需补录，缺的是价格与上限复核，不是可行性。
 *
 * baseUrl 说明：Coding 套餐用户需覆盖成套餐专属端点，覆盖层见 merge.ts。
 */
const GLM_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
  supportsReasoningEffort: true,
  thinkingFormat: 'zai',
  zaiToolStream: true
} as const

/** 官方 reasoning_effort 七档，但 5.3 文档仅列 max/high/low（§2.3-3）。
 * 2026-09-26 复核：官方文档/社区一致确认 thinking.type:enabled + reasoning_effort
 * low/high/max（官方推荐 max），与本映射吻合。 */
const GLM_LEVELS = {
  off: null,
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: null,
  max: 'max'
} as const

export default defineProvider({
  id: 'glm',
  label: '智谱 GLM',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  api: 'openai-completions',
  region: 'cn-direct',
  auth: {
    label: 'GLM API Key',
    env: 'ZHIPUAI_API_KEY',
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    hint: 'Coding 套餐是专属端点，需在设置里覆盖 baseUrl'
  },
  models: [
    {
      id: 'glm-5.3',
      label: 'GLM 5.3',
      reasoning: true,
      input: ['text'],
      thinkingLevelMap: GLM_LEVELS,
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      note: '1M/128K 与官方模型页一致（纯文本，无视觉）；cost 取自上游，未复核',
      compat: GLM_COMPAT
    },
    {
      id: 'glm-5.3-flash',
      label: 'GLM 5.3 Flash',
      reasoning: true,
      // 官方视觉模：docs.bigmodel.cn 的 /guide/models/vlm/glm-5.3-flash（见文件头订正）
      input: ['text', 'image'],
      thinkingLevelMap: GLM_LEVELS,
      cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      costHint: '便宜档，适合默认快模；官方只给相对价（GLM-5.3 的 1/10，限时 1/20）',
      note: 'cost 取自 pi 上游手工数据（官方无绝对价格数字可抄）；1M/128K 与视觉能力已对官方模型页核实',
      compat: GLM_COMPAT
    },
    {
      id: 'glm-5.2',
      label: 'GLM 5.2',
      reasoning: true,
      input: ['text'],
      thinkingLevelMap: GLM_LEVELS,
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      status: 'stable',
      note: '数值取自 pi 上游手工数据',
      compat: GLM_COMPAT
    },
    {
      id: 'glm-4.7',
      label: 'GLM 4.7',
      reasoning: true,
      input: ['text'],
      cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 204_800,
      maxTokens: 131_072,
      // 上游对 4.7 给的是 supportsReasoningEffort:false（只有 thinking 开关，无档位）
      compat: { ...GLM_COMPAT, supportsReasoningEffort: false }
    }
  ]
})
