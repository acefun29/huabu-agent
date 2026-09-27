import { defineProvider } from '../define'

/**
 * Anthropic 官方站聊天模型目录（全球服务，架构计划 §3 决策1「管理器是唯一枚举源」的补录）。
 *
 * 为什么要进目录而不是让用户自建：设置页此前直接遍历 `pi runtime.getProviders()`，
 * 用户看得到 anthropic 这一行并能录 Key。改成唯一枚举源后，不写进目录就等于
 * **连用户已有的 Key 一起从 UI 消失**。同理还有 openai（见 providers/openai.ts）。
 *
 * ⚠ **数值出处与已知缺口**：本期（2026-09-24）本机网络访问 `docs.claude.com` /
 * `docs.anthropic.com` / `platform.claude.com` 全部 307 跳到 app-unavailable-in-region，
 * 官方模型页与 pricing 页**未能逐页复核**。这里每条数据的来源是 pi 上游手工维护的
 * `providers/data/anthropic.json`（pi 每天真打这条线的生产数据），wire 形态另经
 * `pi-ai/dist/api/anthropic-messages.js` 源码核对，并由 `pnpm chat-catalog:wire`
 * 用真 pi 出网报文坐实。`costSource` 一律标 `pi-upstream`、逐条 note；拿到可达网络后
 * 对官方 pricing 页复核，再把 costSource 升成 `official`。
 *
 * thinking 形态（源码核对结论，与 openai-completions 那套分支完全不同，别照抄 §2.5）：
 * - `compat.forceAdaptiveThinking:true` → `thinking:{type:'adaptive',display}` +
 *   `output_config:{effort}`（Claude 4.7+/5 系要求这个形态），**不发** `interleaved-thinking` beta；
 * - 不写或 false → 老一代的预算形态 `thinking:{type:'enabled',budget_tokens,display}`，
 *   并且会带 `interleaved-thinking-2025-05-14` beta（anthropic-messages.js:761-768）。
 *   pi 的默认值是 false，所以新代模型**漏写 true 就是拿预算形态打要求 adaptive 的模型**——
 *   这类错不会静默：官方会 400。真正的静默风险是反向的（给老模型写 true）。
 * - 关思考：`thinkingEnabled===false && thinkingLevelMap.off !== null` 才发
 *   `thinking:{type:'disabled'}`（:872-874）。所以 `off:null` = 该模型不能关思考。
 *
 * 刻意**不搬**上游的两个 compat：
 * - `allowedFallbackModels`（服务端拒答回退）：驱动 `fallbacks` 字段与
 *   `server-side-fallback` beta 头，缺省时 pi 一律不发（:117-119）；我们没有"被拒后自动
 *   换模型"的产品形态，条目里还内嵌第二套价格，留着只会误导复核。
 * - `supportsMidConvoEffort`（Fable 5.1 / Opus 5 上游有）：**它会吃掉用户的思考档选择**。
 *   `pnpm chat-catalog:wire` 实测：带这个标志时"关思考"那一路照样发
 *   `thinking:{type:"adaptive",...,block_binding}` + `output_config:{effort:"high"}`
 *   （anthropic-messages.js:840-849 的分支在 `model.reasoning` 判断之前），
 *   档位恒为 high、关不掉。我们 Composer 上有思考档选择，所以宁可不要那两个 beta 头。
 *
 * 其余 compat 照抄上游，**包括 `supportsTemperature:false`**（Opus 5）：漏写会让 pi 给
 * 该模型发非默认 temperature，那是直接 400，不是静默失效。
 */
export default defineProvider({
  id: 'anthropic',
  label: 'Anthropic',
  baseUrl: 'https://api.anthropic.com',
  api: 'anthropic-messages',
  region: 'global',
  auth: {
    label: 'Anthropic API Key',
    env: 'ANTHROPIC_API_KEY',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    hint: '官方 Key 需完成账户验证；中国大陆网络不可达官方端点'
  },
  models: [
    {
      id: 'claude-fable-5-1',
      label: 'Claude Fable 5.1',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
      cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      costSource: 'pi-upstream',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      costHint: '顶配档；缓存写入 12.5、命中 0.25（每百万 tokens，美元）',
      note: '官方页网络不可达未复核，数值取自 pi 上游；off:null = 不能关思考',
      compat: { forceAdaptiveThinking: true, supportsStrictTools: true }
    },
    {
      id: 'claude-opus-5',
      label: 'Claude Opus 5',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      costSource: 'pi-upstream',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      note: '官方页网络不可达未复核，数值取自 pi 上游',
      compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true }
    },
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      reasoning: true,
      input: ['text', 'image'],
      // 上游没有 off 键 → 关档时 pi 走"off !== null"分支，照发 thinking:{type:"disabled"}
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      costSource: 'pi-upstream',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      costHint: '主力档',
      note: '官方页网络不可达未复核，数值取自 pi 上游',
      compat: { forceAdaptiveThinking: true, supportsStrictTools: true }
    },
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      reasoning: true,
      input: ['text', 'image'],
      // 预算形态那一代：没有 xhigh/max 档可映射，思考只能开或关（缺 off 即"不能关"）
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      costSource: 'pi-upstream',
      contextWindow: 200_000,
      maxTokens: 64_000,
      costHint: '便宜快模',
      note: '官方页网络不可达未复核，数值取自 pi 上游；刻意显式写 false 以走预算形态',
      compat: { forceAdaptiveThinking: false, supportsStrictTools: true }
    }
  ]
})
