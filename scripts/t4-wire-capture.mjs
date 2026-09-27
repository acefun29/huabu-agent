/**
 * 目录 → 真实报文捕获（架构计划 T4 验证项，**不需要任何 API Key**）。
 *
 * 为什么不需要 Key：要验的命题是"我们的 catalog 会让 pi 往请求体里放什么字段"，
 * 这一步发生在报文出网之前。把 globalThis.fetch 换成"记录请求体 + 返回 canned SSE"，
 * 就能拿到 pi **真正上送**的 params，而不是我按源码复刻出来的预测。
 * （chat-catalog-check.mjs 里的 predictThinking 是复刻，复刻可以保真也可以一起错；
 * 这里是对着实现验，两者互为交叉核对。）
 *
 * Key 仍然必须是假的：一旦断言的是"厂商是否接受这个字段"（§2.5 右列），才需要真 Key
 * 或官方文档，那是 S3 线上终验的范围（本次已被取消，见计划 §2.5 末段）。
 *
 * 运行：pnpm chat-catalog:wire
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 't4-wire-capture-tmp')
const FAKE_KEY = 'sk-capture-not-a-real-key'

/* ---------------- 目录转译（与 chat-catalog-check.mjs 同一套路） ---------------- */
function transpileAndLoad() {
  const files = []
  const walk = (entry) => {
    const stat = fs.statSync(entry)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) walk(path.join(entry, name))
      return
    }
    if (/\.tsx?$/.test(entry)) files.push(entry)
  }
  walk(path.join(PROJECT_ROOT, 'src', 'main', 'models'))
  // 协议白名单在 shared/chatApi（渲染端要枚举它做下拉），main/models/types.ts 对它做**值**
  // 再导出 → 运行时真 require，不一起转译就会在模块解析上炸
  files.push(path.join(PROJECT_ROOT, 'src', 'shared', 'chatApi.ts'))
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  for (const file of files) {
    const target = path.join(OUT_DIR, path.relative(PROJECT_ROOT, file).replace(/\.ts$/, '.js'))
    const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
      reportDiagnostics: true
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    if (errors.length > 0) {
      console.error(`转译失败：${ts.flattenDiagnosticMessageText(errors[0].messageText, ' ')}`)
      process.exit(1)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, outputText, 'utf8')
  }
}

/* ---------------- fetch 挡板 ---------------- */
const captured = []
const WATCHED = [
  'thinking',
  'reasoning_effort',
  'enable_thinking',
  'chat_template_kwargs',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'output_config',
  'include',
  'tool_stream',
  'reasoning'
]
/** 三个协议各自的输出上限字段名（断言"只发属于本协议的那一个"） */
const MAX_FIELDS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens']

function recordBody(url, init) {
  if (typeof init?.body !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(init.body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed.model !== 'string') return null
  const fields = {}
  for (const key of WATCHED) if (parsed[key] !== undefined) fields[key] = parsed[key]
  captured.push({
    url,
    model: parsed.model,
    auth: authOf(init.headers),
    n_tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    fields
  })
  return parsed
}

/** 从 fetch 的 headers（SDK 可能给 Headers 也可能给普通对象）里取认证头，用于验"这把 Key 真的出网了" */
function authOf(headers) {
  if (!headers) return ''
  if (typeof headers.get === 'function') {
    return headers.get('authorization') || headers.get('x-api-key') || ''
  }
  const plain = headers
  for (const name of Object.keys(plain)) {
    if (/^(authorization|x-api-key)$/i.test(name)) return String(plain[name])
  }
  return ''
}

/**
 * 按端点协议回一段合法 SSE。断言对象永远是**出网的请求体**（挡板在解析响应之前就已记录），
 * 所以这里回错形状也不影响结论；回对只是为了让日志里不混进无关报错。
 */
function cannedResponse(url, model) {
  const sse = (lines) => new Response(lines.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' }
  })
  if (typeof url === 'string' && url.includes('/messages')) {
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    return sse([
      ev('message_start', { type: 'message_start', message: { id: 'msg_capture', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      ev('message_stop', { type: 'message_stop' })
    ])
  }
  if (typeof url === 'string' && url.includes('/responses')) {
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    return sse([
      ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_capture', output_index: 0, content_index: 0, delta: 'ok' }),
      ev('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_capture',
          object: 'response',
          status: 'completed',
          model,
          output: [{ type: 'message', id: 'msg_capture', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      })
    ])
  }
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-capture',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }]
    })}\n\n`
  return sse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop'), 'data: [DONE]\n\n'])
}

/* ---------------- 每个模型开/关思考两路的期望（= §2.5 最终 wire 效果列） ----------------
 * 只写"思考相关"的字段；未列出的字段一律断言为不存在（多发一个官方未记载的字段也算失败）。
 */
const T = { enabled: { type: 'enabled' }, disabled: { type: 'disabled' } }
const ZAI = { type: 'enabled', clear_thinking: false }
const EXPECT = {
  'deepseek/deepseek-flash': {
    on: { thinking: T.enabled, reasoning_effort: 'high' },
    off: { thinking: T.disabled },
    maxTokensField: 'max_tokens'
  },
  'deepseek/deepseek-v4-pro': {
    on: { thinking: T.enabled, reasoning_effort: 'high' },
    off: { thinking: T.disabled },
    maxTokensField: 'max_tokens'
  },
  // k3：官方只收顶层 reasoning_effort，且关档时什么都不发（thinking 常开）
  'kimi/kimi-k3': { on: { reasoning_effort: 'high' }, off: {}, maxTokensField: 'max_tokens' },
  'kimi/kimi-k2.6': { on: { thinking: T.enabled }, off: { thinking: T.disabled }, maxTokensField: 'max_tokens' },
  'kimi/kimi-k2.7-code': { on: { thinking: T.enabled }, off: {}, maxTokensField: 'max_tokens' },
  'kimi/kimi-k2.7-code-highspeed': { on: { thinking: T.enabled }, off: {}, maxTokensField: 'max_tokens' },
  'glm/glm-5.3': { on: { thinking: ZAI, reasoning_effort: 'high' }, off: { thinking: T.disabled }, maxTokensField: 'max_tokens' },
  'glm/glm-5.3-flash': { on: { thinking: ZAI, reasoning_effort: 'high' }, off: { thinking: T.disabled }, maxTokensField: 'max_tokens' },
  'glm/glm-5.2': { on: { thinking: ZAI, reasoning_effort: 'high' }, off: { thinking: T.disabled }, maxTokensField: 'max_tokens' },
  'glm/glm-4.7': { on: { thinking: ZAI }, off: { thinking: T.disabled }, maxTokensField: 'max_tokens' },
  'qwen/qwen3.8-max': { on: { enable_thinking: true }, off: { enable_thinking: false }, maxTokensField: 'max_completion_tokens' },
  'qwen/qwen3.7-plus': { on: { enable_thinking: true }, off: { enable_thinking: false }, maxTokensField: 'max_completion_tokens' },

  /* -------- anthropic-messages：两条互不相同的思考形态（源码 :669-676 / :856-874） -------- */
  // forceAdaptiveThinking:true → thinking:{type:'adaptive',display} + output_config:{effort}
  // 关档能否发 thinking:{type:'disabled'} 取决于 thinkingLevelMap.off 是不是 null：
  //   off:null（fable/opus-5）→ 关不掉，什么都不发；缺 off 键（sonnet-5）→ 照发 disabled。
  'anthropic/claude-fable-5-1': {
    on: { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } },
    off: {},
    maxTokensField: 'max_tokens'
  },
  'anthropic/claude-opus-5': {
    on: { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } },
    off: {},
    maxTokensField: 'max_tokens'
  },
  'anthropic/claude-sonnet-5': {
    on: { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } },
    off: { thinking: T.disabled },
    maxTokensField: 'max_tokens'
  },
  // 预算形态（老一代/未开 adaptive）：thinking:{type:'enabled',budget_tokens,display}，
  // budget 数值由 adjustMaxTokensForThinking 按 maxTokens 推导，只断言形态与正数。
  'anthropic/claude-haiku-4-5': {
    on: {
      thinking: (value) =>
        value?.type === 'enabled' && typeof value.budget_tokens === 'number' && value.budget_tokens > 0
    },
    off: { thinking: T.disabled },
    maxTokensField: 'max_tokens'
  },

  /* -------- openai-responses：reasoning:{effort,summary}（源码 :253-268） -------- */
  // off 键是字符串 → 显式关；off:null → 什么都不发（关不掉）。
  'openai/gpt-6-astra': {
    on: { reasoning: { effort: 'high', summary: 'auto' }, include: ['reasoning.encrypted_content'] },
    off: {},
    maxTokensField: 'max_output_tokens'
  },
  ...['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].reduce(
    (acc, id) => ({
      ...acc,
      [`openai/${id}`]: {
        on: { reasoning: { effort: 'high', summary: 'auto' }, include: ['reasoning.encrypted_content'] },
        off: { reasoning: { effort: 'none' } },
        maxTokensField: 'max_output_tokens'
      }
    }),
    {}
  )
}

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  transpileAndLoad()
  const modelsDir = path.join(OUT_DIR, 'src', 'main', 'models')
  const catalog = await import(pathToFileURL(path.join(modelsDir, 'catalog', 'index.js')).href)
  const { BUILTIN_CHAT_PROVIDERS, mergeChatCatalog } = catalog
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')

  const providers = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, {})
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })
  for (const p of providers) {
    runtime.registerProvider(p.id, {
      name: p.label,
      baseUrl: p.baseUrl,
      api: p.api,
      apiKey: FAKE_KEY,
      models: p.models.map((m) => ({
        id: m.id,
        name: m.label,
        api: m.api,
        baseUrl: m.baseUrl,
        reasoning: m.reasoning,
        ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        ...(m.compat ? { compat: m.compat } : {})
      }))
    })
  }

  const originalFetch = globalThis.fetch
  const stubFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || String(input)
    const parsed = recordBody(url, init)
    return cannedResponse(url, parsed?.model ?? 'capture-unknown')
  }
  globalThis.fetch = stubFetch

  const context = { messages: [{ role: 'user', content: [{ type: 'text', text: '只回复：好' }] }] }
  const missing = []
  try {
    for (const p of providers) {
      for (const m of p.models) {
        const key = `${p.id}/${m.id}`
        const expected = EXPECT[key]
        if (!expected) {
          missing.push(key)
          continue
        }
        const model = runtime.getModel(p.id, m.id)
        if (!model) {
          check(`${key} 注册成功`, false, 'getModel 取不到（registerProvider 未生效或 id 不匹配）')
          continue
        }
        for (const lane of ['on', 'off']) {
          const before = captured.length
          // 断言对象是**出网的请求体**，不是响应；挡板返回的 canned SSE 万一不被 pi 接受
          // 也不影响结论，所以这里吞掉异常，只记一笔，避免整轮中断。
          let streamError = ''
          try {
            await runtime.completeSimple(model, context, lane === 'on' ? { reasoning: 'high' } : {})
          } catch (error) {
            streamError = error instanceof Error ? error.message.split('\n')[0] : String(error)
          }
          const reqs = captured.slice(before)
          const got = reqs.at(-1)
          if (!got) {
            check(`${key} ${lane} 报文捕获`, false, 'fetch 未被调用（请求没出门，注册或 Key 解析就断了）')
            continue
          }
          const want = expected[lane]
          const diffs = []
          for (const field of ['thinking', 'reasoning_effort', 'enable_thinking', 'chat_template_kwargs', 'reasoning', 'output_config', 'include']) {
            const a = got.fields[field]
            const e = want[field]
            if (e === undefined) {
              if (a !== undefined) diffs.push(`${field} 不该出现而出现了：${JSON.stringify(a)}`)
            } else if (typeof e === 'function') {
              // 形态断言：值本身依赖上游推导（如 budget_tokens 的具体数），只验形状
              if (!e(a)) diffs.push(`${field} 形态不符：实际=${JSON.stringify(a)}`)
            } else if (JSON.stringify(a) !== JSON.stringify(e)) {
              diffs.push(`${field} 实际=${JSON.stringify(a)} 期望=${JSON.stringify(e)}`)
            }
          }
          const maxField = expected.maxTokensField
          if (got.fields[maxField] === undefined) diffs.push(`${maxField} 没发出`)
          for (const other of MAX_FIELDS.filter((f) => f !== maxField)) {
            if (got.fields[other] !== undefined) diffs.push(`${other} 不该由这个协议发出（该用 ${maxField}）`)
          }
          check(
            `${key} ${lane}：${JSON.stringify(want, (_k, v) => (typeof v === 'function' ? '<形态断言>' : v)) || '{}'} + ${maxField}`,
            diffs.length === 0,
            [diffs.join('；'), streamError ? `（响应侧异常，不影响报文断言：${streamError}）` : ''].filter(Boolean).join('；')
          )
        }
      }
    }

    check('每个目录模型都在期望表里（新加模型必须同时补期望）', missing.length === 0, missing.join(', '))

  /* ------- 热换 Key：同一个 ModelRuntime 上重注册（T5 删掉 recreateRuntime 的依据） -------
   * 命题是"改配置不需要重建运行时"。这里刻意不新建 runtime：注册→发→再注册→再发，
   * 全程同一个实例，断言出网认证头跟着换、模型清单跟着换。
   * 挡板必须全程在线：假 Key 一个字节都不许出门。
   */
  const swap = providers.find((p) => p.id === 'deepseek')
  if (!swap || swap.models.length < 2) {
    check('热换 Key（重注册即生效）', false, '目录里 deepseek 不足 2 个模型，无法验证')
  } else {
    const [keep, extra] = swap.models
    const payloadOf = (apiKey, models) => ({
      name: swap.label,
      baseUrl: swap.baseUrl,
      api: swap.api,
      apiKey,
      models: models.map((m) => ({
        id: m.id,
        name: m.label,
        api: m.api,
        baseUrl: m.baseUrl,
        reasoning: m.reasoning,
        ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        ...(m.compat ? { compat: m.compat } : {})
      }))
    })
    const firstKey = 'sk-first-key-0000000000'
    const secondKey = 'sk-second-key-1111111111'
    const authAfterRegister = async (apiKey, models) => {
      runtime.registerProvider(swap.id, payloadOf(apiKey, models))
      const before = captured.length
      try {
        await runtime.completeSimple(runtime.getModel(swap.id, keep.id), context, {})
      } catch {
        /* 响应侧异常不影响出网断言 */
      }
      return captured.slice(before).map((c) => c.auth).join(' | ')
    }
    try {
      const authFirst = await authAfterRegister(firstKey, swap.models)
      check('首次注册：Key 随注册入参出网', authFirst.includes(firstKey) && !authFirst.includes(secondKey), authFirst)

      const authSecond = await authAfterRegister(secondKey, swap.models)
      check(
        '重注册即换 Key（未重建运行时）',
        authSecond.includes(secondKey) && !authSecond.includes(firstKey),
        authSecond
      )

      // 只带一个模型重注册 ⇒ 另一个从运行时消失：这就是"每次必须携带完整 models 数组"的证据
      runtime.registerProvider(swap.id, payloadOf(secondKey, [keep]))
      const dropped = runtime.getModel(swap.id, extra.id)
      const kept = runtime.getModel(swap.id, keep.id)
      check(
        '重注册是整体替换（少传的模型会消失，故载荷必须带全量清单）',
        dropped === undefined && kept !== undefined,
        dropped === undefined ? `${extra.id} 已按预期消失，${keep.id} 仍在` : `${extra.id} 仍被解析到（语义与预期不符）`
      )
      runtime.registerProvider(swap.id, payloadOf(secondKey, swap.models))
    } catch (error) {
      check('热换 Key（重注册即生效）', false, error instanceof Error ? error.message : String(error))
    }
  }
  } finally {
    globalThis.fetch = originalFetch
  }

  console.log('\n================ 捕获到的报文（去重摘要） ================')
  const seen = new Set()
  for (const c of captured) {
    const line = `${c.model} ${JSON.stringify(c.fields)}`
    if (seen.has(line)) continue
    seen.add(line)
    console.log(`  ${line}`)
  }
  const pass = results.filter((r) => r.pass).length
  console.log(`\n================ t4-wire-capture ${pass}/${results.length} PASS ================`)
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  process.exit(pass === results.length ? 0 : 2)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
