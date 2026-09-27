// T3 模型 spike — S5：anthropic-messages 协议 × 国产端点（DeepSeek /anthropic 真 Key）
// 用法：node scripts/t3-anthropic-spike.mjs   （读环境变量 DEEPSEEK_API_KEY）
// 要回答的问题（计划 §T3-S5 / §2.4-5）：
//   1) pi 的 anthropic-messages 通道固定 POST 到 {baseUrl}/v1/messages?beta=true
//      （@anthropic-ai/sdk 0.123.0 resources/beta/messages/messages.js:43）
//      —— 国产端点接受这个 query 参数吗？
//   2) pi 非 OAuth 分支用 new Anthropic({apiKey}) → 发 `x-api-key` 头
//      （api/anthropic-messages.js:730）—— DeepSeek 认 x-api-key 还是只认 Bearer？
//   3) thinking 开启时 pi 会带 anthropic-beta: interleaved-thinking 头 —— 被忽略还是报错？
//   4) tools / 会话循环在该协议下能否走通。
// 一次性脚本，验完可删。
import os from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { Type } from 'typebox'

const KEY = process.env.DEEPSEEK_API_KEY
if (!KEY) {
  console.error('缺 DEEPSEEK_API_KEY 环境变量')
  process.exit(1)
}

const { ModelRuntime, createAgentSession } = await import('@earendil-works/pi-coding-agent')

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? `\n       ${detail}` : ''}`)
}

/* ---------- wire 抓取：URL + 认证/beta 头 + 报文形状 ---------- */
const wire = []
const origFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || String(input)
  const headers = {}
  const raw = init?.headers
  if (raw) {
    if (typeof raw.forEach === 'function') raw.forEach((v, k) => (headers[k.toLowerCase()] = v))
    else for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v)
  }
  let parsed = null
  if (url.includes('deepseek') && typeof init?.body === 'string') {
    try {
      parsed = JSON.parse(init.body)
    } catch {}
  }
  const res = await origFetch(input, init)
  if (parsed) {
    wire.push({
      url,
      method: init?.method || 'GET',
      status: res.status,
      model: parsed.model,
      stream: parsed.stream ?? null,
      max_tokens: parsed.max_tokens ?? null,
      thinking: parsed.thinking ?? null,
      betas: parsed.betas ?? null,
      n_tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      msg_line: (parsed.messages || [])
        .map((m) => m.role + (m.tool_calls ? '+TC' : '') + (Array.isArray(m.content) ? '+blocks' : ''))
        .join(','),
      has_system: parsed.system != null,
      hdr: {
        'x-api-key': headers['x-api-key'] ? `<set:${headers['x-api-key'].slice(0, 6)}…>` : null,
        authorization: headers['authorization'] ? `<${headers['authorization'].slice(0, 10)}…>` : null,
        'anthropic-version': headers['anthropic-version'] ?? null,
        'anthropic-beta': headers['anthropic-beta'] ?? null
      }
    })
  }
  return res
}

/* ---------- 注册一个 anthropic-messages 协议的供应商 ---------- */
const BASE_URL = 'https://api.deepseek.com/anthropic'
const ANTHROPIC_MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek Flash (anthropic proto)',
    reasoning: false, // S5 先测纯文本无 thinking 的最小通路
    input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 8192
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (anthropic proto)',
    reasoning: true,
    input: ['text'],
    cost: { input: 3, output: 6, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 8192
  }
]

const runtime = await ModelRuntime.create({
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false
})
runtime.registerProvider('ds-anthropic', {
  name: 'DeepSeek/anthropic(spike)',
  baseUrl: BASE_URL,
  api: 'anthropic-messages',
  apiKey: KEY,
  models: ANTHROPIC_MODELS
})
console.log(
  `\n注册 ds-anthropic：models=${runtime.getModels('ds-anthropic').map((m) => m.id).join(', ')} authStatus=${JSON.stringify(runtime.getProviderAuthStatus('ds-anthropic'))}`
)

const SPIKE_CWD = path.join(os.tmpdir(), 'huabu-t3-anthropic-spike')
mkdirSync(SPIKE_CWD, { recursive: true })

function lastAssistant(session) {
  const last = session.messages.filter((m) => m.role === 'assistant').at(-1)
  if (!last) return { text: '', blocks: [], error: true, reason: 'no-assistant-message' }
  const blocks = (last.content || []).map((b) => b.type)
  return {
    text: (last.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    blocks,
    error: last.stopReason === 'error' || Boolean(last.errorMessage),
    reason: last.errorMessage || last.stopReason || ''
  }
}

async function ask(session, text, ms = 150000) {
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('prompt 超时')), ms))
  await Promise.race([session.prompt(text), timeout])
  return lastAssistant(session)
}

async function newSession(modelId, extra = {}) {
  const model = runtime.getModel('ds-anthropic', modelId)
  if (!model) throw new Error(`模型未注册: ${modelId}`)
  const { session } = await createAgentSession({
    cwd: SPIKE_CWD,
    modelRuntime: runtime,
    model,
    tools: extra.tools ?? [],
    ...(extra.customTools ? { customTools: extra.customTools } : {})
  })
  return session
}

/* ---------- A1 completeSimple 最小对话（看 wire 落到哪个 URL/头） ---------- */
try {
  const model = runtime.getModel('ds-anthropic', 'deepseek-flash')
  const msg = await runtime.completeSimple(model, {
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }]
  })
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  const err = msg.stopReason === 'error' || Boolean(msg.errorMessage)
  check('A1 anthropic-messages 协议 completeSimple 最小对话走通', !err && text.length > 0, `text="${text.slice(0, 40)}" ${msg.errorMessage || msg.stopReason}`)
} catch (error) {
  check('A1 anthropic-messages 协议 completeSimple 最小对话走通', false, String(error).slice(0, 200))
}

/* ---------- A2 会话（createAgentSession）最小对话 ---------- */
try {
  const s = await newSession('deepseek-flash')
  const a = await ask(s, '不要思考，只回复两个字：明白')
  check('A2 createAgentSession + anthropic-messages 会话走通', !a.error && a.text.length > 0, `text="${a.text.slice(0, 40)}" blocks=${JSON.stringify(a.blocks)} ${a.reason}`)
  s.dispose()
} catch (error) {
  check('A2 createAgentSession + anthropic-messages 会话走通', false, String(error).slice(0, 200))
}

/* ---------- A3 tools 循环 ---------- */
const echoTool = {
  name: 'echo_now',
  label: 'Echo',
  description: '查询指定城市的演示天气，返回固定字符串。需要用它回答。',
  parameters: Type.Object({ city: Type.String({ description: '城市名' }) }),
  execute: async (_id, params) => ({
    content: [{ type: 'text', text: `FIXED-WEATHER:${params.city}:晴` }],
    details: {}
  })
}
try {
  const s = await newSession('deepseek-flash', { tools: ['echo_now'], customTools: [echoTool] })
  const a = await ask(s, '北京天气怎么样？必须调用 echo_now 工具查询后再回答。', 240000)
  check('A3 anthropic-messages 下 tools 工具循环走通', !a.error && /FIXED-WEATHER|晴/.test(a.text), `text="${a.text.slice(0, 60)}" ${a.reason}`)
  s.dispose()
} catch (error) {
  check('A3 anthropic-messages 下 tools 工具循环走通', false, String(error).slice(0, 200))
}

/* ---------- A4 thinking（reasoning 模型，会带 interleaved-thinking beta） ---------- */
try {
  const s = await newSession('deepseek-v4-pro')
  const a = await ask(s, '7 乘以 8 是多少？给出数字即可。', 180000)
  check('A4 reasoning 模型（thinking/beta 头）可用', !a.error && a.text.length > 0, `text="${a.text.slice(0, 60)}" blocks=${JSON.stringify(a.blocks)} ${a.reason}`)
  s.dispose()
} catch (error) {
  check('A4 reasoning 模型（thinking/beta 头）可用', false, String(error).slice(0, 200))
}

/* ---------- A5 wire 结论断言 ---------- */
{
  const posts = wire.filter((w) => w.method === 'POST')
  const betaQuery = posts.filter((w) => w.url.includes('beta=true'))
  const ok200 = posts.filter((w) => w.status >= 200 && w.status < 300)
  console.log(`\n  · POST 数=${posts.length}，带 ?beta=true=${betaQuery.length}，2xx=${ok200.length}`)
  check('A5 国产端点接受 pi 的 /v1/messages?beta=true 路径', betaQuery.length > 0 && ok200.length > 0, `样例 URL=${posts[0]?.url ?? 'n/a'}`)
  const authHdr = posts[0]?.hdr
  console.log(`  · 认证头实发: ${JSON.stringify(authHdr)}`)
  check('A5 pi 的 x-api-key 认证被 DeepSeek /anthropic 接受', posts.some((w) => w.status === 200 && w.hdr['x-api-key']), `x-api-key=${authHdr?.['x-api-key']} authorization=${authHdr?.authorization}`)
  const betaHdr = posts.find((w) => w.hdr['anthropic-beta'])
  console.log(`  · anthropic-beta 头: ${betaHdr ? `${betaHdr.hdr['anthropic-beta']} → status=${betaHdr.status}` : '未发出（未开 thinking）'}`)
  if (betaHdr) {
    check('A5 带 anthropic-beta 头的那跳未被拒（2xx）', betaHdr.status >= 200 && betaHdr.status < 300, `beta=${betaHdr.hdr['anthropic-beta']} status=${betaHdr.status}`)
  } else {
    console.log('  · 注：本次未触发 beta 头，需 thinking 生效才有样例')
  }
}

/* ---------- 负向对照：Bearer 认证是否被接受（决定兜底方案形态） ---------- */
{
  async function rawProbe(label, headers) {
    try {
      const res = await origFetch(`${BASE_URL}/v1/messages?beta=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'deepseek-flash',
          max_tokens: 32,
          messages: [{ role: 'user', content: '只回复：好' }]
        })
      })
      const body = await res.text()
      return { status: res.status, snippet: body.slice(0, 160).replace(/\s+/g, ' ') }
    } catch (error) {
      return { status: 0, snippet: String(error).slice(0, 160) }
    }
  }
  const bearer = await rawProbe('bearer', {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    authorization: `Bearer ${KEY}`
  })
  console.log(`\n  · 直连 Bearer 对照: [${bearer.status}] ${bearer.snippet}`)
  const xkey = await rawProbe('x-api-key', {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': KEY
  })
  console.log(`  · 直连 x-api-key 对照: [${xkey.status}] ${xkey.snippet}`)
  check('对照：两种认证头至少一种被 /anthropic 接受', bearer.status === 200 || xkey.status === 200, `Bearer=${bearer.status} x-api-key=${xkey.status}`)
}

/* ---------- 汇总 ---------- */
console.log('\n================ anthropic wire 抓取 ================')
for (const w of wire) {
  console.log(
    `[${w.status}] ${w.method} ${w.url.replace(BASE_URL, '<base>')} model=${w.model} stream=${w.stream} max_tokens=${w.max_tokens ?? '-'} thinking=${JSON.stringify(w.thinking)} betas=${JSON.stringify(w.betas ?? [])} tools=${w.n_tools} msgs=${w.msg_line} xapikey=${w.hdr['x-api-key'] ? 'y' : 'n'} beta-hdr=${w.hdr['anthropic-beta'] ?? '-'}`
  )
}
const pass = results.filter((r) => r.pass).length
console.log(`\n================ 结果: ${pass}/${results.length} PASS ================`)
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`)
process.exit(results.every((r) => r.pass) ? 0 : 2)
