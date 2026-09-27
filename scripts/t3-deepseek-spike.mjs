// T3 模型 spike — DeepSeek 真 Key 实测（S1/S2/S3/S4）
// 用法：node scripts/t3-deepseek-spike.mjs   （读环境变量 DEEPSEEK_API_KEY）
// 结论以输出为准回写《Agent架构优化实施计划.md》。一次性脚本，验完可删。
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

/* ---------- 线上报文抓取（对表 2.4 的源码推断） ---------- */
const wire = []
const origFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || String(input)
  let parsed = null
  if (url.includes('deepseek') && typeof init?.body === 'string') {
    try {
      parsed = JSON.parse(init.body)
    } catch {}
  }
  const res = await origFetch(input, init)
  if (parsed) {
    wire.push({
      status: res.status,
      model: parsed.model,
      stream: parsed.stream ?? null,
      thinking: parsed.thinking ?? null,
      reasoning_effort: parsed.reasoning_effort ?? null,
      max_tokens: parsed.max_tokens ?? null,
      max_completion_tokens: parsed.max_completion_tokens ?? null,
      n_tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      msg_line: (parsed.messages || [])
        .map((m) => m.role + (m.reasoning_content ? '+RC' : '') + (m.tool_calls ? '+TC' : ''))
        .join(',')
    })
  }
  return res
}

/* ---------- 供应商注册（新架构形态：modelsPath:null + apiKey 直传 + compat） ---------- */
const SPIKE_MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 8192,
    compat: { thinkingFormat: 'deepseek' }
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    reasoning: true,
    input: ['text'],
    cost: { input: 3, output: 6, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 8192,
    compat: { thinkingFormat: 'deepseek' }
  }
]
const providerConfig = (apiKey, models = SPIKE_MODELS) => ({
  name: 'DeepSeek(spike)',
  baseUrl: 'https://api.deepseek.com',
  api: 'openai-completions',
  apiKey,
  models
})

const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })

/* ---------- S2 同 id 撞车 ---------- */
const builtinIds = runtime.getModels('deepseek').map((m) => m.id)
runtime.registerProvider('deepseek', providerConfig(KEY))
const afterIds = runtime.getModels('deepseek').map((m) => m.id)
const ourFlash = runtime.getModel('deepseek', 'deepseek-flash')
const proDef = runtime.getModel('deepseek', 'deepseek-v4-pro')
console.log(`\n内置 deepseek 模型（注册前）: ${builtinIds.join(', ') || '无'}`)
console.log(`注册后 deepseek 模型清单: ${afterIds.join(', ')}`)
check(
  'S2 registerProvider 同 id(deepseek) 可注册且我们的 id 可解析',
  Boolean(ourFlash),
  `deepseek-flash → ${ourFlash ? `ctx=${ourFlash.contextWindow}` : 'undefined'}`
)
console.log(
  `  · v4-pro 是否被我们覆盖: ctx=${proDef?.contextWindow}, input=${JSON.stringify(proDef?.input)}（我们的定义=1000000/["text"]）`
)
console.log(
  `  · authStatus=${JSON.stringify(runtime.getProviderAuthStatus('deepseek'))}`
)

/* ---------- 会话与问答工具 ---------- */
const SPIKE_CWD = path.join(os.tmpdir(), 'huabu-t3-spike')
mkdirSync(SPIKE_CWD, { recursive: true })

async function newSession(modelId, extra = {}) {
  const model = runtime.getModel('deepseek', modelId)
  if (!model) throw new Error(`模型未注册: ${modelId}`)
  const { session } = await createAgentSession({
    cwd: SPIKE_CWD,
    modelRuntime: runtime,
    model,
    tools: extra.tools ?? ['echo_now'],
    ...(extra.customTools ? { customTools: extra.customTools } : {})
  })
  return session
}

function describeAssistant(session, sinceLen) {
  const msgs = session.messages.filter((m) => m.role === 'assistant')
  const last = msgs.at(-1)
  if (!last) return { text: '', blocks: [], error: true, reason: 'no-assistant-message' }
  const blocks = (last.content || []).map((b) => b.type)
  const text = (last.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return {
    text,
    blocks,
    error: last.stopReason === 'error' || Boolean(last.errorMessage),
    reason: last.errorMessage || last.stopReason || '',
    thinkingBlocks: blocks.filter((b) => b === 'thinking' || b === 'reasoning').length
  }
}

async function ask(session, text, opts = {}) {
  const before = session.messages.length
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('prompt 超时')), opts.ms ?? 150000))
  await Promise.race([session.prompt(text, { images: opts.images }), timeout])
  return { ...describeAssistant(session, before), before }
}

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

/* ---------- S1 最小对话 ---------- */
try {
  const s1 = await newSession('deepseek-flash')
  const a = await ask(s1, '不要思考太多，只回复两个字：收到')
  check('S1 modelsPath:null + registerProvider 最小对话走通', !a.error && a.text.length > 0, `text="${a.text.slice(0, 40)}" blocks=${JSON.stringify(a.blocks)} ${a.reason}`)
  s1.dispose()
} catch (error) {
  check('S1 modelsPath:null + registerProvider 最小对话走通', false, String(error))
}

/* ---------- S3a 思考形态 + S3b tools 循环与 reasoning_content 回放 ---------- */
try {
  const s3 = await newSession('deepseek-flash', { tools: ['echo_now'], customTools: [echoTool] })
  const a = await ask(s3, '北京天气怎么样？必须调用 echo_now 工具查询后再回答。', { ms: 240000 })
  check('S3 tools+流式 工具循环走通（无 400）', !a.error && /FIXED-WEATHER|晴/.test(a.text), `text="${a.text.slice(0, 60)}" ${a.reason}`)
  s3.dispose()
  const toolReqs = wire.filter((w) => w.n_tools > 0)
  check('S3 wire: 带 tools 的请求已发出', toolReqs.length > 0, `带tools请求数=${toolReqs.length}`)
  const replay = toolReqs.find((w) => w.msg_line.includes('+RC'))
  console.log(`  · reasoning_content 回放: ${replay ? '有 assistant 消息带 RC' : '未见 RC 回放（若仍 200，说明 400 论断需复核）'}`)
  console.log(`  · 带tools请求的报文行: ${toolReqs.map((w) => `[${w.status}] ${w.msg_line}`).join('  |  ')}`)
} catch (error) {
  check('S3 tools+流式 工具循环走通（无 400）', false, String(error))
}

/* ---------- S3c max_tokens 字段形态（2.4-4 验证） ---------- */
{
  const req = wire.find((w) => w.model)
  if (req) {
    console.log(
      `\n  · wire 首请求: thinking=${JSON.stringify(req.thinking)} effort=${req.reasoning_effort} max_tokens=${req.max_tokens} mct=${req.max_completion_tokens} stream=${req.stream}`
    )
    const hasAny = wire.some((w) => w.max_tokens != null)
    const hasMct = wire.some((w) => w.max_completion_tokens != null)
    check('wire: deepseek 域名用 max_tokens 而非 max_completion_tokens', hasAny || !hasMct, `max_tokens出现=${hasAny} mct出现=${hasMct}`)
  }
}

/* ---------- S3d vision（deepseek-flash 有视觉） ---------- */
try {
  const RED_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const s4 = await newSession('deepseek-flash')
  const a = await ask(s4, '图里是一个纯色像素，说出它大致的颜色（红/绿/蓝任选其一）。', {
    images: [{ type: 'image', data: RED_PNG, mimeType: 'image/png' }],
    ms: 120000
  })
  check('S3 deepseek-flash 视觉（base64 图片进、文出）', !a.error && a.text.length > 0, `text="${a.text.slice(0, 60)}" ${a.reason}`)
  s4.dispose()
} catch (error) {
  check('S3 deepseek-flash 视觉（base64 图片进、文出）', false, String(error))
}

/* ---------- S4 凭据热生效（改 Key=重注册，无 recreateRuntime） ---------- */
async function directProbe(label) {
  const model = runtime.getModel('deepseek', 'deepseek-flash')
  try {
    const msg = await runtime.completeSimple(model, {
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复：好' }] }]
    })
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    const err = msg.stopReason === 'error' || Boolean(msg.errorMessage)
    return { err, text: text || msg.errorMessage || msg.stopReason || '' }
  } catch (error) {
    return { err: true, text: String(error).slice(0, 160) }
  }
}
{
  const okBefore = await directProbe('real')
  check('S4 真 Key 直连可用（基线）', !okBefore.err, okBefore.text.slice(0, 60))

  runtime.registerProvider('deepseek', providerConfig('sk-BOGUS-0000000000000000000000'))
  const bad = await directProbe('bogus')
  check('S4 假 Key 重注册后新请求被拒（401/invalid key）', bad.err, bad.text.slice(0, 100))

  runtime.registerProvider('deepseek', providerConfig(KEY))
  const okAfter = await directProbe('restored')
  check('S4 真 Key 重注册即时恢复（无需重建运行时）', !okAfter.err, okAfter.text.slice(0, 60))
}

/* ---------- 汇总 ---------- */
console.log('\n================ wire 抓取（deepseek 请求） ================')
for (const w of wire) {
  console.log(
    `[${w.status}] ${w.model} stream=${w.stream} thinking=${JSON.stringify(w.thinking)} effort=${w.reasoning_effort ?? '-'} max_tokens=${w.max_tokens ?? '-'} mct=${w.max_completion_tokens ?? '-'} tools=${w.n_tools} msgs=${w.msg_line}`
  )
}
const pass = results.filter((r) => r.pass).length
console.log(`\n================ 结果: ${pass}/${results.length} PASS ================`)
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`)
process.exit(results.every((r) => r.pass) ? 0 : 2)
