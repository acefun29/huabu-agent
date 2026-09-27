import { defineProvider } from '../define'

/**
 * Kimi（月之暗面）内置聊天目录（compat 按实施计划 §2.5/§2.7，**未线上终验**）。
 *
 * compat 的取值经 pi 上游手工数据（providers/data/moonshotai-cn.json）交叉核对，
 * 三条各家不同的规则是这份目录最容易写错的地方：
 *
 * 1. **k3 用 `thinkingFormat:'openai'` + 显式 `supportsReasoningEffort:true`**——
 *    官方要求只发顶层 `reasoning_effort`、**不接受 thinking 参数**；而 moonshot 域名
 *    会被 pi 的 detectCompat 探测成 `supportsReasoningEffort:false`（openai-completions.js:1280），
 *    届时 effort 字段被静默跳过、什么都发不出去。显式 true 是必须的，不是可选优化。
 * 2. **k2.6/k2.7-code 用 `thinkingFormat:'deepseek'` 且 supportsReasoningEffort 留 false**
 *    （§2.7 订正了我最初"也带 effort"的推导）——它们只认 `thinking:{type}`。
 * 3. **k2.7-code 的 `thinkingLevelMap.off:null`**——官方：传 `disabled` 直接报错。
 *    pi 的 deepseek 分支据此在关档时**什么都不发**（:685），而不是发 disabled。
 *
 * 视觉：官方只收 base64 data URI / 文件 ID，公网 URL 不支持；pi 发的正是 base64 ✓（2.4-7）。
 * 回放：k3/k2.7-code 必须原样回传 reasoning_content（k3 由 requiresReasoningContent* 兜住）；
 * k2.6 默认可丢历史思考，更省钱。官方建议 max_tokens ≥16000。
 *
 * 国际站 `api.moonshot.ai` 与 CN 站 Key 不通用，用户可在 workspace.json 覆盖层改 baseUrl。
 */
const KIMI_BASE = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
  supportsStrictMode: false
} as const

/** k2.6 / k2.7-code 形态：只发 thinking:{type}，不吃 effort */
const KIMI_THINKING_COMPAT = { ...KIMI_BASE, supportsReasoningEffort: false, thinkingFormat: 'deepseek' } as const

export default defineProvider({
  id: 'kimi',
  label: 'Kimi',
  baseUrl: 'https://api.moonshot.cn/v1',
  api: 'openai-completions',
  region: 'cn-direct',
  auth: {
    label: 'Kimi（月之暗面）API Key',
    env: 'MOONSHOT_API_KEY',
    helpUrl: 'https://platform.kimi.com/console/api-keys',
    hint: 'CN 站与 api.moonshot.ai 国际站的 Key 不通用'
  },
  models: [
    {
      id: 'kimi-k3',
      label: 'Kimi K3',
      reasoning: true,
      input: ['text', 'image'],
      // 官方仅 low/high/max 三档（默认 max，思考常开）；off:null = 思考常开，关档时什么都不发
      // 2026-09-26 复核：K3 reasoning_effort 取值 low/high/max、不可关闭，与本映射吻合
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      costHint: '旗舰档，output 单价明显高于 k2.6；官方建议 max_tokens ≥16000',
      compat: {
        ...KIMI_BASE,
        // §2.5 推论1 的实战点：域名探测为 false，必须显式覆写才有 effort 字段
        supportsReasoningEffort: true,
        thinkingFormat: 'openai',
        requiresReasoningContentOnAssistantMessages: true,
        deferredToolsMode: 'kimi'
      }
    },
    {
      id: 'kimi-k2.6',
      label: 'Kimi K2.6',
      reasoning: true,
      input: ['text', 'image'],
      // thinkingLevelMap 留空 = 关档时发 thinking:{type:'disabled'}（k2.6 支持关思考）
      cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 262_144,
      maxTokens: 262_144,
      costHint: '默认可丢历史 reasoning_content，长会话比 k3 省',
      compat: KIMI_THINKING_COMPAT
    },
    {
      id: 'kimi-k2.7-code',
      label: 'Kimi K2.7 Code',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { off: null },
      cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 262_144,
      maxTokens: 262_144,
      note: '官方：thinking 传 disabled 直接报错，故 off 映射为 null（关档不发字段）',
      compat: KIMI_THINKING_COMPAT
    },
    {
      id: 'kimi-k2.7-code-highspeed',
      label: 'Kimi K2.7 Code Highspeed',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { off: null },
      cost: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
      costSource: 'pi-upstream',
      contextWindow: 262_144,
      maxTokens: 262_144,
      status: 'beta',
      compat: KIMI_THINKING_COMPAT
    }
  ]
})
