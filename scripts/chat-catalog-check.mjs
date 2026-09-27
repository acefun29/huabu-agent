/**
 * 内置聊天模型目录校验（架构计划 T4 验证项，纳入 CI 候选）。
 *
 * 运行：pnpm chat-catalog:check
 *
 * 为什么有这个而不是只靠 tsc：tsc 能挡"compat 键名写错"，但挡不住"键名对、值不对"
 * ——而 §2.5 最凶的一类错正是后者（`supportsReasoningEffort` 漏写 = effort 字段静默不发，
 * 不报错、不炸、只是模型不思考）。S3 线上终验取消后，这里就是唯一的防线。
 *
 * 校验内容：
 *   1. 目录数据自检（validateBuiltinCatalog：id 唯一/白名单/推理模型必须写 thinkingFormat/
 *      stable 条目不许带未复核价格）。
 *   2. **wire 预测**：用纯函数复刻 pi 的 thinking 分支选择（openai-completions.js:634-735）
 *      与 detectCompat 域名探测（:1236-1302），对每个推理模型断言"实际会发出什么字段"。
 *      等号右边抄的是实施计划 §2.5 表的"最终 wire 效果"列。
 *      ⚠ 这是**复刻**，复刻可以和实现一起错——所以另有 `pnpm chat-catalog:wire`
 *      用 fetch 挡板拿 pi 真实出网的请求体做交叉核对（同样不需要任何 Key）。两边都绿才算数。
 *   3. 合并层行为：hiddenBuiltin / deprecated / modelOverrides / 同名覆盖 / api 白名单 /
 *      坏配置逐条清洗。
 *   4. 管理器：生效清单 → pi 注册入参（字段齐全、不带 pi 会置空的 headers、
 *      凭据「存储优先、env 兜底」的解析口径）。
 *   5. 一次性迁移：旧三处（顶层 defaultModel/hiddenModels + .huabu/models.json）→ chat 段，
 *      以及加密凭据搬运（改名、幂等、不覆盖新键）。
 *      迁移只在真机上跑一次，出错就是用户配置被搬坏 —— 所以纯函数路径全部在这里断言。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'chat-catalog-check-tmp')

function collectSources() {
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
  // 协议白名单挪到了 shared（渲染端要枚举它做下拉），main/models/types.ts 对它做的是
  // **值**再导出，运行时真要 require —— 不加进来转译就会在模块解析上炸
  files.push(path.join(PROJECT_ROOT, 'src', 'shared', 'chatApi.ts'))
  return files
}

function transpileAll(files) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  for (const file of files) {
    const rel = path.relative(PROJECT_ROOT, file)
    const target = path.join(OUT_DIR, rel.replace(/\.ts$/, '.js'))
    const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
      reportDiagnostics: true
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    if (errors.length > 0) {
      console.error(`转译失败 ${rel}：${ts.flattenDiagnosticMessageText(errors[0].messageText, ' ')}`)
      process.exit(1)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, outputText, 'utf8')
  }
}

const results = []
function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function check(name, fn) {
  try {
    const detail = fn()
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}
async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 清洗/合并路径按设计"只 warn 不炸"，断言时把警告收起来，免得淹掉 PASS/FAIL 输出 */
function quiet(fn) {
  const before = console.warn
  console.warn = () => {}
  try {
    return fn()
  } finally {
    console.warn = before
  }
}
async function quietAsync(fn) {
  const before = console.warn
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.warn = before
  }
}

/* ---------------- pi 行为复刻（对齐 openai-completions.js 行号） ---------------- */

/** detectCompat 的域名探测：provider id 或 baseUrl 命中即算（:1239-1250） */
function detectPm(providerId, baseUrl) {
  const url = baseUrl.toLowerCase()
  return {
    isDeepSeek: providerId === 'deepseek' || url.includes('deepseek.com'),
    isZai: providerId === 'zai' || providerId === 'zai-coding-cn' || url.includes('api.z.ai') || url.includes('open.bigmodel.cn'),
    isMoonshot: url.includes('api.moonshot.'),
    // supportsReasoningEffort 的默认值（:1280）——自研 provider 命名的隐藏雷区
    defaultSupportsReasoningEffort: !(url.includes('api.x.ai') || url.includes('api.z.ai') || url.includes('open.bigmodel.cn') || url.includes('api.moonshot.') || url.includes('api.together.') || url.includes('gateway.ai.cloudflare.com') || url.includes('integrate.api.nvidia.com') || url.includes('api.ant-ling.com')),
    defaultMaxTokensField: undefined
  }
}

/**
 * 复刻 buildParams 的 thinking 段（:634-735）：给定生效模型，算出 pi 实际会往请求体里放什么。
 * 返回 { thinking, thinkingIsString, reasoning_effort, enable_thinking, reasoning_obj, budgetField }
 */
function predictThinking(model) {
  const pm = detectPm(model.providerId, model.baseUrl)
  const compat = model.compat ?? {}
  const supportsEffort = compat.supportsReasoningEffort ?? pm.defaultSupportsReasoningEffort
  // 会话里用户选档 → reasoningEffort 为字符串；取「开着思考」这一路来验，关档路径单独验
  const effortRequested = 'high'
  const tlm = model.thinkingLevelMap ?? {}
  const out = { thinking: null, thinkingIsString: false, reasoning_effort: null, enable_thinking: null, reasoning_obj: null, budgetField: null }
  if (!model.reasoning) return out
  const format = compat.thinkingFormat
  if (format === 'zai') {
    out.thinking = { type: 'enabled', clear_thinking: false }
    if (supportsEffort) out.reasoning_effort = tlm[effortRequested] ?? effortRequested
  } else if (format === 'qwen') {
    out.enable_thinking = true
    if (supportsEffort) out.reasoning_effort = tlm[effortRequested] ?? effortRequested
  } else if (format === 'deepseek') {
    out.thinking = { type: 'enabled' }
    if (supportsEffort) out.reasoning_effort = tlm[effortRequested] ?? effortRequested
  } else if (format === 'openrouter') {
    out.reasoning_obj = { effort: tlm[effortRequested] ?? effortRequested }
  } else if (format === 'string-thinking') {
    out.thinking = tlm[effortRequested] ?? effortRequested
    out.thinkingIsString = true
  } else if (format === 'together') {
    out.thinking = { enabled: true }
    if (supportsEffort) out.reasoning_effort = tlm[effortRequested] ?? effortRequested
  } else {
    // "openai" / undefined → 兜底分支：只发顶层 reasoning_effort（:727-730）
    if (supportsEffort) out.reasoning_effort = tlm[effortRequested] ?? effortRequested
  }
  // 预算字段与 thinkingFormat 无关（:741-743）
  if (compat.thinkingTokenBudgetField) out.budgetField = compat.thinkingTokenBudgetField
  else if (compat.supportsThinkingTokenBudget) out.budgetField = 'thinking_token_budget'
  out._supportsEffort = supportsEffort
  return out
}

/* ---------------- 各家期望的 wire 形态（= §2.5 表"最终 wire 效果"列） ---------------- */
const EXPECTED_WIRE = {
  'deepseek/deepseek-flash': { thinking: { type: 'enabled' }, reasoning_effort: 'high', enable_thinking: null },
  'deepseek/deepseek-v4-pro': { thinking: { type: 'enabled' }, reasoning_effort: 'high', enable_thinking: null },
  'kimi/kimi-k3': { thinking: null, reasoning_effort: 'high', enable_thinking: null },
  'kimi/kimi-k2.6': { thinking: { type: 'enabled' }, reasoning_effort: null, enable_thinking: null },
  'kimi/kimi-k2.7-code': { thinking: { type: 'enabled' }, reasoning_effort: null, enable_thinking: null },
  'kimi/kimi-k2.7-code-highspeed': { thinking: { type: 'enabled' }, reasoning_effort: null, enable_thinking: null },
  'glm/glm-5.3': { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'high', enable_thinking: null },
  'glm/glm-5.3-flash': { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'high', enable_thinking: null },
  'glm/glm-5.2': { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'high', enable_thinking: null },
  'glm/glm-4.7': { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: null, enable_thinking: null },
  'qwen/qwen3.8-max': { thinking: null, reasoning_effort: null, enable_thinking: true },
  'qwen/qwen3.7-plus': { thinking: null, reasoning_effort: null, enable_thinking: true }
}

async function main() {
  transpileAll(collectSources())
  const modelsDir = path.join(OUT_DIR, 'src', 'main', 'models')
  const catalog = await import(pathToFileURL(path.join(modelsDir, 'catalog', 'index.js')).href)
  const { BUILTIN_CHAT_PROVIDERS, mergeChatCatalog, validateBuiltinCatalog, isChatModelApi } = catalog

  /* ---------------- 1. 目录自检 ---------------- */
  check('内置目录自检无错（id/白名单/推理必写 thinkingFormat/价格可信度）', () => {
    const errors = validateBuiltinCatalog(BUILTIN_CHAT_PROVIDERS)
    assert(errors.length === 0, `自检报错：\n    ${errors.join('\n    ')}`)
    return `${BUILTIN_CHAT_PROVIDERS.length} 家 / ${BUILTIN_CHAT_PROVIDERS.reduce((n, p) => n + p.models.length, 0)} 个模型`
  })

  check('目录覆盖到三个协议（openai-completions / anthropic-messages / openai-responses）', () => {
    const apis = new Set(BUILTIN_CHAT_PROVIDERS.map((p) => p.api))
    for (const want of ['openai-completions', 'anthropic-messages', 'openai-responses']) {
      assert(apis.has(want), `目录里没有 ${want} 协议的样本，该分支无法验证`)
    }
    // openai-completions 内部还有四条 thinkingFormat 分支，各自要有样本。
    // pi 的 detectCompat 默认 thinkingFormat 就是 "openai"（openai-completions.js:1288-1298），
    // 所以"显式写 openai"和"不写"落的是同一分支，这里按同一形态归一。
    const formats = new Set()
    for (const p of BUILTIN_CHAT_PROVIDERS) {
      if (p.api !== 'openai-completions') continue
      for (const m of p.models) formats.add(m.compat?.thinkingFormat ?? 'openai')
    }
    for (const want of ['deepseek', 'zai', 'qwen', 'openai']) {
      assert(formats.has(want), `目录里没有 ${want} 形态的样本，无法验证该分支`)
    }
    return `${[...apis].join(' + ')}；completions 内分支：${[...formats].join(', ')}`
  })

  check('另两个协议的「思考主开关」逐条显式声明（漏写=静默关不掉/形态打错）', () => {
    const offenders = []
    for (const p of BUILTIN_CHAT_PROVIDERS) {
      for (const m of p.models) {
        if (!m.reasoning) continue
        const api = m.api ?? p.api
        if (api === 'anthropic-messages' && typeof m.compat?.forceAdaptiveThinking !== 'boolean') {
          offenders.push(`${p.id}/${m.id} 未写 compat.forceAdaptiveThinking`)
        }
        // openai-responses.js:264：off 缺省与 off:null 同义（什么都不发），想关必须显式给字符串
        if (api === 'openai-responses' && !('off' in (m.thinkingLevelMap ?? {}))) {
          offenders.push(`${p.id}/${m.id} thinkingLevelMap 缺 off 键`)
        }
      }
    }
    assert(offenders.length === 0, offenders.join('\n    '))
    const adaptive = BUILTIN_CHAT_PROVIDERS.flatMap((p) => p.models)
      .filter((m) => m.compat?.forceAdaptiveThinking === true).length
    return `adaptive 形态 ${adaptive} 条 / 预算形态与其余走 completions、responses 各按主开关`
  })

  /* ---------------- 2. wire 预测对表 §2.5 ---------------- */
  // 走 mergeChatCatalog 而不是直接读内置数组：注册出去的是**生效清单**，
  // deprecated 条目本就不该出现在里面，wire 断言的对象必须和真机上送的一致。
  const flat = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, {}).flatMap((p) =>
    p.models.map((m) => ({ ...m, providerId: p.id }))
  )
  // predictThinking/detectPm 复刻的是 openai-completions.js 的分支链，只适用于该协议；
  // anthropic-messages 与 openai-responses 各有自己的主开关（见上面的显式声明检查），
  // 三者的真实报文统一由 pnpm chat-catalog:wire 用真 pi 抓。
  const completions = flat.filter((m) => m.api === 'openai-completions')
  check('每个 openai-completions 推理模型的实发 thinking 控制字段与 §2.5 期望一致', () => {
    const mismatches = []
    for (const model of completions) {
      if (!model.reasoning) continue
      const key = `${model.providerId}/${model.id}`
      const expected = EXPECTED_WIRE[key]
      if (!expected) {
        mismatches.push(`${key} 缺 §2.5 期望条目（新加模型要同时补期望，否则等于没验）`)
        continue
      }
      const actual = predictThinking(model)
      for (const field of ['thinking', 'reasoning_effort', 'enable_thinking']) {
        const a = JSON.stringify(actual[field] ?? null)
        const e = JSON.stringify(expected[field] ?? null)
        if (a !== e) mismatches.push(`${key}.${field} 实际=${a} 期望=${e}`)
      }
    }
    assert(mismatches.length === 0, mismatches.join('\n    '))
    return `${completions.filter((m) => m.reasoning).length} 个 completions 推理模型逐字段对齐（另两协议 ${flat.filter((m) => m.reasoning && m.api !== 'openai-completions').length} 个走主开关+真实报文）`
  })

  check('推理模型必须至少发出一个思考控制字段（静默失效的唯一硬防线）', () => {
    const silent = []
    for (const model of completions) {
      if (!model.reasoning) continue
      const w = predictThinking(model)
      const hasControl = w.thinking !== null || w.enable_thinking !== null || w.reasoning_effort !== null || w.reasoning_obj !== null
      if (!hasControl) silent.push(`${model.providerId}/${model.id}（supportsReasoningEffort=${w._supportsEffort}，thinkingFormat=${model.compat?.thinkingFormat ?? '未写'}）`)
    }
    assert(silent.length === 0, `以下模型开了 reasoning 却什么都发不出去：\n    ${silent.join('\n    ')}`)
  })

  check('moonshot/zai 域名模型都显式覆写了 supportsReasoningEffort', () => {
    const offenders = []
    for (const model of completions) {
      if (!model.reasoning) continue
      const pm = detectPm(model.providerId, model.baseUrl)
      const domainDefaultsFalse = !pm.defaultSupportsReasoningEffort
      const declared = model.compat?.supportsReasoningEffort
      // 域名默认 false 却想用 effort，就必须显式写 true；不想要 effort 则留 false 是对的
      if (domainDefaultsFalse && declared === undefined && !model.compat?.thinkingFormat) {
        offenders.push(`${model.providerId}/${model.id}：域名探测为 false，未显式声明`)
      }
      if (domainDefaultsFalse && declared === undefined && model.compat?.thinkingFormat && model.compat.thinkingFormat !== 'deepseek') {
        offenders.push(`${model.providerId}/${model.id}：${model.compat.thinkingFormat} 分支带 effort 但没显式 true`)
      }
    }
    assert(offenders.length === 0, offenders.join('\n    '))
  })

  check('Qwen 预算字段用官方名 thinking_budget（pi 默认 thinking_token_budget 会静默失效）', () => {
    const qwen = flat.filter((m) => m.providerId === 'qwen')
    assert(qwen.length > 0, '目录里没有 qwen 模型')
    for (const m of qwen) {
      assert(m.compat?.thinkingTokenBudgetField === 'thinking_budget', `qwen/${m.id} 的 thinkingTokenBudgetField=${m.compat?.thinkingTokenBudgetField}`)
      assert(m.compat?.thinkingFormat === 'qwen', `qwen/${m.id} 的 thinkingFormat 必须是 qwen（顶层 enable_thinking）`)
    }
    return `${qwen.length} 个 qwen 模型`
  })

  /* ---------------- 3. 合并层行为 ---------------- */
  check('hiddenBuiltin 生效、deprecated 条目不进生效清单', () => {
    const merged = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, { hiddenBuiltin: ['deepseek/deepseek-v4-pro'] })
    const ds = merged.find((p) => p.id === 'deepseek')
    assert(!ds.models.some((m) => m.id === 'deepseek-v4-pro'), 'hiddenBuiltin 未生效')
    assert(!ds.models.some((m) => m.id === 'deepseek-v4-flash'), 'deprecated 条目应被排除')
    assert(ds.models.some((m) => m.id === 'deepseek-flash'), '正常模型被误删')
    return `deepseek 生效 ${ds.models.length} 个`
  })

  check('modelOverrides 改 label/baseUrl 且不污染内置定义', () => {
    const before = BUILTIN_CHAT_PROVIDERS.find((p) => p.id === 'deepseek').models[0].label
    const merged = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, {
      modelOverrides: { 'deepseek/deepseek-flash': { label: '我的快模', baseUrl: 'https://mirror.example.com' } }
    })
    const m = merged.find((p) => p.id === 'deepseek').models.find((x) => x.id === 'deepseek-flash')
    assert(m.label === '我的快模', `label 未被覆盖：${m.label}`)
    assert(m.baseUrl === 'https://mirror.example.com', `baseUrl 未被覆盖：${m.baseUrl}`)
    assert(
      BUILTIN_CHAT_PROVIDERS.find((p) => p.id === 'deepseek').models[0].label === before,
      '内置目录被写脏了'
    )
  })

  check('继承字段解析到底：生效清单里 api/baseUrl 不可能 undefined', () => {
    const merged = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, {})
    for (const p of merged) {
      assert(typeof p.api === 'string' && /^https?:\/\//.test(p.baseUrl), `${p.id} 供应商级字段不完整`)
      for (const m of p.models) {
        assert(isChatModelApi(m.api), `${p.id}/${m.id} 的 api 未解析：${m.api}`)
        assert(/^https?:\/\//.test(m.baseUrl), `${p.id}/${m.id} 的 baseUrl 未解析：${m.baseUrl}`)
      }
    }
  })

  check('自定义供应商 api 白名单：非白名单协议被拒并回落 completions', () => {
    const warnBefore = console.warn
    const seen = []
    console.warn = (...args) => seen.push(args.join(' '))
    try {
      const merged = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, {
        userProviders: [
          { id: 'my-mirror', baseUrl: 'https://mirror.example.com/v1', api: 'google-generative-ai', models: [{ id: 'm1' }] },
          { id: 'ok-resp', baseUrl: 'https://gw.example.com/v1', api: 'openai-responses', models: [{ id: 'm2' }] }
        ]
      })
      assert(!merged.find((p) => p.id === 'my-mirror') || merged.find((p) => p.id === 'my-mirror').api !== 'google-generative-ai', '白名单外的协议被接受了')
      const ok = merged.find((p) => p.id === 'ok-resp')
      assert(ok && ok.api === 'openai-responses', '白名单内的 openai-responses 被误拒')
      assert(seen.some((s) => s.includes('不在白名单')), '拒绝时没有给出可定位的警告')
    } finally {
      console.warn = warnBefore
    }
  })

  check('坏配置逐条清洗：一条坏模型不炸整个供应商', () => {
    const warnBefore = console.warn
    console.warn = () => {}
    try {
      const merged = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, {
        userProviders: [
          {
            id: 'mixed',
            baseUrl: 'https://gw.example.com/v1',
            models: [{ id: 'good-one' }, { id: 'BAD ID!' }, { id: 'dup' }, { id: 'dup' }, { id: 'no-ctx', contextWindow: -5 }]
          },
          { id: '没有合法id' }
        ]
      })
      const mixed = merged.find((p) => p.id === 'mixed')
      assert(mixed, '整个供应商被丢弃了（应当只丢坏条目）')
      const ids = mixed.models.map((m) => m.id)
      assert(ids.includes('good-one'), '合法条目被误删')
      assert(!ids.includes('BAD ID!'), '非法 id 未被清洗')
      assert(ids.filter((i) => i === 'dup').length === 1, '重复 id 未去重')
      assert(mixed.models.find((m) => m.id === 'no-ctx').contextWindow === 128000, '负数 contextWindow 未回落默认')
      assert(!merged.find((p) => p.id === '没有合法id'), '非法供应商 id 未被丢弃')
    } finally {
      console.warn = warnBefore
    }
  })

  check('用户同名覆盖内置供应商：模型 upsert、baseUrl/label 以用户为准', () => {
    const merged = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, {
      userProviders: [
        {
          id: 'deepseek',
          label: 'DeepSeek 镜像',
          baseUrl: 'https://mirror.example.com',
          models: [{ id: 'deepseek-flash', name: '自配 flash', contextWindow: 200000 }]
        },
        {
          id: 'kimi',
          models: [{ id: 'kimi-next', reasoning: true }]
        }
      ]
    })
    const ds = merged.find((p) => p.id === 'deepseek')
    assert(ds.label === 'DeepSeek 镜像' && ds.baseUrl === 'https://mirror.example.com', '供应商级字段未以用户为准')
    const flash = ds.models.find((m) => m.id === 'deepseek-flash')
    assert(flash.contextWindow === 200000 && flash.label === '自配 flash', '同 id 模型未被用户条目覆盖')
    assert(ds.models.some((m) => m.id === 'deepseek-v4-pro'), '内置其余模型被误删（应 upsert 而非替换）')
    // 同 id 模型是"打补丁"不是"整条替换"：丢 compat = 丢 §2.5 那一整套协议知识，
    // 且是静默失效（字段不发、不报错），所以这条断言是这次改动的主防线。
    assert(flash.compat?.thinkingFormat === 'deepseek', '覆盖时丢了内置 compat')
    assert(flash.cost.input === 0.3 && flash.costSource === 'official', '覆盖时丢了内置价格')
    assert(flash.thinkingLevelMap?.max === 'max', '覆盖时丢了内置思考档位映射')
    const pro = ds.models.find((m) => m.id === 'deepseek-v4-pro')
    assert(pro.baseUrl === 'https://mirror.example.com', `用户改供应商 baseUrl 没传导到未被点名的模型：${pro.baseUrl}`)
    // 用户在同 id 供应商下写的新模型 id：独立条目追加，不该冒充内置
    const added = merged.find((p) => p.id === 'kimi').models.find((m) => m.id === 'kimi-next')
    assert(added?.source === 'user' && added.baseUrl === 'https://api.moonshot.cn/v1', '内置供应商下新增模型未作为独立条目追加')
  })

  check('模型数为 0 的供应商不出现在生效清单（避免注册出空清单）', () => {
    const merged = mergeChatCatalog(BUILTIN_CHAT_PROVIDERS, { hiddenBuiltin: ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'] })
    const noEmpty = merged.every((p) => p.models.length > 0)
    assert(noEmpty, '存在 models 为空的供应商')
  })

  /* ---------------- 4. 管理器：生效清单 → pi 注册入参 ---------------- */
  const { ChatModelManager } = await import(pathToFileURL(path.join(modelsDir, 'manager.js')).href)
  const { migrateChatConfig, applyCredentialMoves } = await import(
    pathToFileURL(path.join(modelsDir, 'migrate.js')).href
  )

  /** 聊天 provider 的环境变量名：断言凭据解析时必须全部隔离，否则会读到开发机真 Key */
  const CHAT_ENV = ['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'ZHIPUAI_API_KEY', 'DASHSCOPE_API_KEY']
  async function withCleanEnv(fn) {
    const backup = CHAT_ENV.map((name) => [name, process.env[name]])
    for (const name of CHAT_ENV) delete process.env[name]
    try {
      // 必须 await：管理器读 env 发生在 async 链路里，同步 finally 会在读取之前就还原
      return await fn()
    } finally {
      for (const [name, value] of backup) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  /** 假凭据存储：形状对齐 pi 的 CredentialStore（read/list/modify/delete），只存 providerId→明文串 */
  function fakeStore(entries = {}, { failOn } = {}) {
    return {
      entries: { ...entries },
      async read(id) {
        return id in this.entries ? { type: 'api_key', key: this.entries[id] } : undefined
      },
      async list() {
        return Object.keys(this.entries).map((id) => ({ providerId: id, type: 'api_key' }))
      },
      async modify(id, updater) {
        if (failOn === id) throw new Error(`模拟存储写入失败：${id}`)
        const next = await updater(await this.read(id))
        if (next === undefined) return this.read(id)
        this.entries[id] = next.key
        return next
      },
      async delete(id) {
        delete this.entries[id]
      }
    }
  }

  await checkAsync('注册入参：providerId 与载荷成对、模型字段齐全、不带 pi 会置空的 headers', () =>
    withCleanEnv(async () => {
      const manager = await quietAsync(() =>
        new ChatModelManager({
          credentials: fakeStore({ deepseek: 'sk-in-store' }),
          config: {
            userProviders: [
              { id: 'my-gw', baseUrl: 'https://gw.example.com/v1', api: 'google-generative-ai', models: [{ id: 'm1' }] }
            ]
          }
        })
      )
      const registrations = await manager.registrations()
      assert(registrations.length === manager.providers().length, '注册项数量与生效清单不一致')
      const seenIds = new Set()
      for (const { providerId, payload } of registrations) {
        assert(typeof providerId === 'string' && providerId.length > 0, '注册项缺 providerId')
        assert(!seenIds.has(providerId), `providerId 重复：${providerId}`)
        seenIds.add(providerId)
        assert(typeof payload.name === 'string' && payload.name, `${providerId} 缺 name`)
        assert(/^https:\/\/\S+$/.test(payload.baseUrl), `${providerId} baseUrl 非法：${payload.baseUrl}`)
        assert(isChatModelApi(payload.api), `${providerId} api 不在白名单：${payload.api}`)
        assert(Array.isArray(payload.models) && payload.models.length > 0, `${providerId} 模型数组为空（pi 拒绝注册空清单）`)
        assert(payload.headers === undefined, `${providerId} 载荷带 headers`)
        for (const model of payload.models) {
          for (const field of ['id', 'name', 'api', 'baseUrl', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens']) {
            assert(model[field] !== undefined, `${providerId}/${model.id} 缺必填字段 ${field}`)
          }
          assert(model.headers === undefined, `${providerId}/${model.id} 带 headers（pi 会强制置 undefined）`)
        }
      }
      assert(
        registrations.find((r) => r.providerId === 'my-gw')?.payload.api === 'openai-completions',
        '白名单外协议没被拒'
      )
      assert(registrations.find((r) => r.providerId === 'deepseek')?.payload.apiKey === 'sk-in-store', '存储 Key 未解析进载荷')
      assert(registrations.find((r) => r.providerId === 'kimi')?.payload.apiKey === undefined, '无凭据的供应商带了 apiKey')
      return `${registrations.length} 家 / ${registrations.reduce((n, r) => n + r.payload.models.length, 0)} 个模型`
    })
  )

  await checkAsync('凭据解析：存储优先、缺省回退 auth.env；statuses() 与载荷同口径且不含密钥', () =>
    withCleanEnv(async () => {
      const empty = await new ChatModelManager({ credentials: fakeStore() }).registrations()
      assert(empty.find((r) => r.providerId === 'deepseek')?.payload.apiKey === undefined, '干净环境下凭空有 Key')
      process.env.DEEPSEEK_API_KEY = '  sk-from-env  '
      const manager = new ChatModelManager({ credentials: fakeStore({ deepseek: 'sk-in-store' }) })
      const viaEnv = await manager.registrations()
      const deepseek = viaEnv.find((r) => r.providerId === 'deepseek')
      assert(deepseek?.payload.apiKey === 'sk-in-store', `存储 Key 未优先于 env：${deepseek?.payload.apiKey}`)
      const envOnly = await new ChatModelManager({ credentials: fakeStore() }).registrations()
      const fallback = envOnly.find((r) => r.providerId === 'deepseek')
      assert(fallback?.payload.apiKey === 'sk-from-env', `env 兜底未生效或未去空白：${fallback?.payload.apiKey}`)
      assert(envOnly.find((r) => r.providerId === 'kimi')?.payload.apiKey === undefined, 'env 泄漏到了别的供应商')
      const statuses = await manager.statuses()
      assert(statuses.find((s) => s.id === 'deepseek')?.configured === true, 'statuses 与载荷凭据口径不一致')
      assert(
        !JSON.stringify(statuses).includes('sk-in-store') && !JSON.stringify(manager.providers()).includes('sk-in-store'),
        '清单/状态返回值里出现了明文 Key'
      )
    })
  )

  check('find() 用 provider/模型 复合串定位，隐藏与退役条目都定位不到', () => {
    const manager = new ChatModelManager({
      credentials: fakeStore(),
      config: { hiddenBuiltin: ['deepseek/deepseek-v4-pro'] }
    })
    assert(manager.find('deepseek/deepseek-flash')?.model.id === 'deepseek-flash', '常规定位失败')
    assert(manager.find('deepseek/deepseek-v4-pro') === undefined, '隐藏的内置模型仍可定位（Agent 会选中已删模型）')
    assert(manager.find('deepseek/deepseek-v4-flash') === undefined, 'deprecated 条目仍可定位')
    for (const bad of ['deepseek', '/deepseek-flash', 'nope/nope', '', null, undefined]) {
      assert(manager.find(bad) === undefined, `非法复合串未被拒：${bad}`)
    }
  })

  /* ---------------- 5. 一次性迁移 ---------------- */
  const LEGACY = {
    defaultModel: 'deepseek/deepseek-v4-flash',
    hiddenModels: ['moonshotai-cn/kimi-k2.6', 'deepseek/deepseek-v4-flash', 'glm/glm-4.5', '自定义/x'],
    modelsFile: {
      providers: {
        'my-gw': {
          name: '内网网关',
          baseUrl: 'https://gw.example.com/v1',
          api: 'openai-responses',
          models: [{ id: 'm1', name: '内网 M1', reasoning: true, contextWindow: 200000, maxTokens: 8000 }]
        },
        'no-url': { models: [{ id: 'x1' }] },
        deepseek: {
          models: [],
          modelOverrides: { 'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: '我的 Pro', contextWindow: 128000 } }
        }
      }
    }
  }

  check('旧三处 → chat 段：自定义供应商/能力补丁/展示改名各归其位', () => {
    const plan = quiet(() => migrateChatConfig({ ...LEGACY }))
    const providers = Object.fromEntries(plan.config.userProviders.map((p) => [p.id, p]))
    assert(providers['my-gw']?.api === 'openai-responses', '自定义供应商的协议未被原样保留')
    assert(providers['my-gw']?.label === '内网网关', '供应商改名丢了')
    assert(providers['my-gw'].models[0].contextWindow === 200000, '自定义模型能力字段丢了')
    const patched = providers.deepseek.models.find((m) => m.id === 'deepseek-v4-pro')
    assert(patched?.contextWindow === 128000, '旧 modelOverrides 的能力字段没落成同 id 补丁')
    assert(patched?.label === undefined && patched?.name === undefined, '改名不该混进能力补丁（应落 modelOverrides）')
    assert(plan.config.modelOverrides['deepseek/deepseek-v4-pro'].label === '我的 Pro', '改名没落进 modelOverrides')
    assert(providers['no-url'], '迁移层把缺 baseUrl 的自定义供应商静默丢了（应由合并层带警告丢弃，见下一项）')
    assert(
      plan.notes.some((n) => n.includes('no-url') && n.includes('baseUrl')),
      '被丢弃的供应商没在 notes 里交代'
    )
  })

  check('hiddenModels：供应商改名跟随、退役条目交回目录、目录外条目出 note', () => {
    const plan = quiet(() => migrateChatConfig({ ...LEGACY }))
    assert(plan.config.hiddenBuiltin.includes('kimi/kimi-k2.6'), 'moonshotai-cn 未随供应商改名映射为 kimi')
    assert(
      !plan.config.hiddenBuiltin.includes('deepseek/deepseek-v4-flash'),
      '退役条目仍被搬进 hiddenBuiltin（目录 status 已接管，搬进来等于双轨）'
    )
    assert(!plan.config.hiddenBuiltin.includes('glm/glm-4.5'), '已不存在的模型仍留在隐藏清单')
    assert(plan.notes.some((n) => n.includes('glm/glm-4.5')), '隐藏清单里被丢弃的条目没在 notes 里交代')
    assert(plan.notes.some((n) => !n.includes('provider/model') && n.includes('自定义/x')), '目录外条目的 note 形态不可定位')
  })

  check('defaultModel 指向退役/隐藏模型时视为未设置（与旧 DEFAULT_HIDDEN_MODELS 行为一致）', () => {
    const retired = quiet(() => migrateChatConfig({ ...LEGACY }))
    assert(retired.config.defaultModel === undefined, '退役模型仍被写成默认模型')
    assert(retired.notes.some((n) => n.includes('默认模型')), '默认模型被丢弃却没在 notes 里说明')
    const alive = quiet(() => migrateChatConfig({ ...LEGACY, defaultModel: 'moonshotai-cn/kimi-k2.7-code' }))
    assert(alive.config.defaultModel === 'kimi/kimi-k2.7-code', '存活模型未随供应商改名保留为默认')
    const hidden = quiet(() => migrateChatConfig({ ...LEGACY, defaultModel: 'moonshotai-cn/kimi-k2.6' }))
    assert(hidden.config.defaultModel === undefined, '默认模型指向被用户删除的模型仍被搬进新层')
    const custom = quiet(() => migrateChatConfig({ ...LEGACY, defaultModel: 'my-gw/m1' }))
    assert(custom.config.defaultModel === 'my-gw/m1', '指向自定义模型的默认被误丢')
  })

  check('迁移结果喂回合并层：补丁保留内置 compat/价格，改名生效', () => {
    const plan = quiet(() => migrateChatConfig({ ...LEGACY }))
    const manager = quiet(() => new ChatModelManager({ credentials: fakeStore(), config: plan.config }))
    const pro = manager.find('deepseek/deepseek-v4-pro')
    assert(pro?.model.contextWindow === 128000, '迁移后的能力补丁没生效')
    assert(pro?.model.compat?.thinkingFormat === 'deepseek', '迁移把内置 compat 弄丢了（§2.5 的静默失效）')
    assert(pro?.model.costSource === 'pi-upstream', '迁移把内置价格来源弄丢了')
    assert(pro?.model.label === '我的 Pro', 'modelOverrides 改名未生效')
    assert(
      manager.providers().every((p) => p.models.length > 0 && p.models.every((m) => isChatModelApi(m.api))),
      '迁移结果注册不出去（空清单或协议不在白名单）'
    )
    assert(manager.find('kimi/kimi-k2.6') === undefined, 'hiddenBuiltin 未生效')
    // 合并层负责丢弃迁移层留下的不可注册条目（两层各说一次，用户能看到是哪个供应商哪条规则）
    assert(manager.find('no-url/x1') === undefined, '缺 baseUrl 的自定义供应商进了生效清单')
    assert(manager.find('my-gw/m1')?.model.reasoning === true, '自定义供应商未注册进生效清单')
  })

  await checkAsync('凭据搬运：改名搬迁、幂等、新键已存在则不覆盖、失败不碰旧键', async () => {
    const moves = [{ from: 'zai', to: 'glm' }]
    const fresh = fakeStore({ zai: 'sk-old-glm' })
    const first = await applyCredentialMoves(fresh, moves)
    assert(first.moved.join() === 'zai', `首次搬运未生效：${JSON.stringify(first)}`)
    assert(fresh.entries.glm === 'sk-old-glm' && !('zai' in fresh.entries), '搬运后新旧键状态不对')
    const second = await applyCredentialMoves(fresh, moves)
    assert(second.moved.length === 0 && second.failed.length === 0, '重复搬运不幂等')

    const conflict = fakeStore({ zai: 'sk-old', glm: 'sk-user-new' })
    const skipped = await applyCredentialMoves(conflict, moves)
    assert(skipped.skipped.join() === 'zai', '新键已存在时未记 skipped')
    assert(conflict.entries.glm === 'sk-user-new', '搬运覆盖了用户在新 UI 里录过的 Key')
    assert(!('zai' in conflict.entries), '冲突时旧键未被清理（下次启动又搬一遍）')

    const failing = fakeStore({ zai: 'sk-old' }, { failOn: 'glm' })
    const failed = await applyCredentialMoves(failing, moves)
    assert(failed.failed.join() === 'zai', '搬运失败未记 failed')
    assert(failing.entries.zai === 'sk-old', '失败时旧键被删（Key 会彻底丢失）')
    assert(!('glm' in failing.entries), '失败的搬运留下了半成品新键')

    const plan = quiet(() => migrateChatConfig({ storedCredentialKeys: ['zai', 'kimi-coding'] }))
    assert(plan.credentialMoves.map((m) => m.from).join() === 'zai', '未按现存凭据键收敛搬运表')
    assert(plan.notes.some((n) => n.includes('api.z.ai')), 'zai→glm 的 endpoint 差异没提示（两站 Key 不通用）')
    assert(plan.notes.some((n) => n.includes('kimi-coding')), '无对应供应商的旧凭据键没交代')
  })

  /* ---------------- 6. 覆盖层写入规则（overlayConfig，纯函数） ---------------- */
  const overlay = await import(pathToFileURL(path.join(modelsDir, 'overlayConfig.js')).href)
  const prune = (chat) => overlay.pruneChatConfig(chat)
  /** 与 overlay.ts 的 mutate 同构：克隆 → 改 → 收拾空字段（所以 apply* 不污染入参） */
  const apply = (chat, fn) => {
    const next = structuredClone(chat)
    fn(next)
    return prune(next)
  }
  function throwsWith(fn, keyword, label) {
    let message = null
    try {
      fn()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(message !== null, `${label}：本该抛错却静默通过`)
    assert(message.includes(keyword), `${label}：报错文案不含「${keyword}」，实际=${message}`)
  }

  await checkAsync('新增自建供应商：设置页立刻可见，但不注册进 pi（空清单 pi 会拒）', async () => {
    const chat = apply({}, (c) =>
      overlay.applyAddProvider(c, { providerId: 'gw', name: '内网网关', baseUrl: 'https://gw.example.com/v1/' })
    )
    assert(chat.userProviders[0].baseUrl === 'https://gw.example.com/v1', '尾部斜杠未归一')
    const manager = await quietAsync(() => new ChatModelManager({ credentials: fakeStore(), config: chat }))
    const status = (await manager.statuses()).find((s) => s.id === 'gw')
    assert(status && status.modelCount === 0 && status.configured === false, '空供应商没进设置页清单')
    assert(status.authLabel === '内网网关 API Key', `authLabel 不对：${status.authLabel}`)
    assert(!manager.providers().some((p) => p.id === 'gw'), '空清单供应商不该被注册')
    assert(!JSON.stringify(manager.providers()).includes('sk-'), '清单里出现密钥')
    return 'statuses 可见 / registrations 不可见'
  })

  check('给自建供应商加模型：字段按录入进注册载荷', () => {
    let chat = apply({}, (c) => overlay.applyAddProvider(c, { providerId: 'gw', baseUrl: 'https://gw.example.com/v1' }))
    chat = apply(chat, (c) =>
      overlay.applyAddModel(c, {
        providerId: 'gw',
        id: 'm1',
        name: '内网 M1',
        contextWindow: 200000,
        maxTokens: 8000,
        reasoning: true,
        input_modalities: ['text', 'image']
      })
    )
    const manager = quiet(() => new ChatModelManager({ credentials: fakeStore(), config: chat }))
    const reg = manager.providers().find((p) => p.id === 'gw')
    assert(reg?.models[0].label === '内网 M1' && reg.models[0].contextWindow === 200000, '录入字段没进生效清单')
    assert(reg.models[0].input.includes('image'), '模态没落进清单（T7 read_media 就靠这个判断）')
    assert(reg.models[0].api === 'openai-completions', `缺省协议不对：${reg.models[0].api}`)
    // 模型级协议：一个网关同时暴露 /chat/completions 与 /responses 时靠它分流
    const mixed = apply(chat, (c) => overlay.applyAddModel(c, { providerId: 'gw', id: 'm-r', api: 'openai-responses' }))
    const mR = quiet(() => new ChatModelManager({ credentials: fakeStore(), config: mixed }))
      .providers()
      .find((p) => p.id === 'gw')
      .models.find((m) => m.id === 'm-r')
    assert(mR.api === 'openai-responses', `模型级协议没进生效清单：${mR.api}`)
    // 模型级协议不许把供应商级带偏：同一家其余模型仍是录入时的缺省
    const m1 = quiet(() => new ChatModelManager({ credentials: fakeStore(), config: mixed }))
      .providers()
      .find((p) => p.id === 'gw')
      .models.find((m) => m.id === 'm1')
    assert(m1.api === 'openai-completions', `模型级协议串台了：m1 变成 ${m1.api}`)
    // 缺省值必须是保守的：自定义端点我们不了解，宁可小也不要超
    const bare = apply(chat, (c) => overlay.applyAddModel(c, { providerId: 'gw', id: 'm2' }))
    const m2 = quiet(() => new ChatModelManager({ credentials: fakeStore(), config: bare }))
      .providers()
      .find((p) => p.id === 'gw')
      .models.find((m) => m.id === 'm2')
    assert(m2.contextWindow === 128000 && m2.maxTokens === 8192, `自定义模型缺省值不对：${m2.contextWindow}/${m2.maxTokens}`)
  })

  check('内置供应商：改 baseUrl 传导到全部模型，删覆盖条目=恢复官方默认', () => {
    let chat = apply({}, (c) =>
      overlay.applyAddProvider(c, { providerId: 'deepseek', name: 'DeepSeek 镜像', baseUrl: 'https://mirror.example.com' })
    )
    const manager = quiet(() => new ChatModelManager({ credentials: fakeStore(), config: chat }))
    const urls = new Set(manager.providers().find((p) => p.id === 'deepseek').models.map((m) => m.baseUrl))
    assert([...urls].join() === 'https://mirror.example.com', `baseUrl 覆盖没传导：${[...urls].join(', ')}`)
    chat = apply(chat, (c) => overlay.applyRemoveProvider(c, 'deepseek'))
    const restored = quiet(() => new ChatModelManager({ credentials: fakeStore(), config: chat }))
    assert(
      restored.providers().find((p) => p.id === 'deepseek').models.every((m) => m.baseUrl === 'https://api.deepseek.com'),
      '删掉覆盖条目后未恢复官方端点'
    )
    assert(restored.find('deepseek/deepseek-flash') !== undefined, '恢复默认时把内置模型弄丢了')
  })

  check('编辑内置模型：改名与能力补丁各走各路，且都不弄丢 compat/价格', () => {
    let chat = apply({}, (c) =>
      overlay.applyEditModel(c, { providerId: 'deepseek', modelId: 'deepseek-v4-pro', name: '我的 Pro' })
    )
    assert(chat.modelOverrides['deepseek/deepseek-v4-pro'].label === '我的 Pro', '改名没进 modelOverrides')
    assert(!chat.userProviders, '纯改名不该产生能力补丁条目')
    chat = apply(chat, (c) =>
      overlay.applyEditModel(c, { providerId: 'deepseek', modelId: 'deepseek-v4-pro', contextWindow: 128000 })
    )
    const model = quiet(() => new ChatModelManager({ credentials: fakeStore(), config: chat })).find(
      'deepseek/deepseek-v4-pro'
    ).model
    assert(model.contextWindow === 128000, '能力补丁未生效')
    assert(model.label === '我的 Pro', '补能力时把改名冲掉了')
    assert(model.compat?.thinkingFormat === 'deepseek', '能力补丁丢了内置 compat')
    assert(model.costSource === 'pi-upstream', '能力补丁丢了内置价格')
    // 清空名字要能回到目录默认名（否则用户误改一次就永久回不去）
    const cleared = apply(chat, (c) => overlay.applyEditModel(c, { providerId: 'deepseek', modelId: 'deepseek-v4-pro', name: '  ' }))
    assert(!cleared.modelOverrides, '清除改名后 modelOverrides 里还留着空条目')
    // name 不传 = 不动这一栏（渲染端只改上下文长度时会省略 name）
    const untouched = apply(chat, (c) => overlay.applyEditModel(c, { providerId: 'deepseek', modelId: 'deepseek-v4-pro', maxTokens: 64000 }))
    assert(
      untouched.modelOverrides['deepseek/deepseek-v4-pro'].label === '我的 Pro',
      '未传 name 时把已有改名清了'
    )
  })

  check('删除/恢复：内置走隐藏、自建走真删，空条目按来源清理', () => {
    let chat = apply({}, (c) => overlay.applyDeleteModel(c, 'deepseek', 'deepseek-v4-pro'))
    const hiddenManager = quiet(() => new ChatModelManager({ credentials: fakeStore(), config: chat }))
    assert(hiddenManager.find('deepseek/deepseek-v4-pro') === undefined, '隐藏未生效')
    assert(hiddenManager.isHidden('deepseek/deepseek-v4-pro'), 'isHidden 判定错（错误文案会指错方向）')
    const inventory = hiddenManager.inventory('deepseek')
    const row = inventory.find((r) => r.model.id === 'deepseek-v4-pro')
    assert(row?.hidden === true, 'inventory 看不到被隐藏的条目（设置页就没法恢复）')
    assert(!inventory.some((r) => r.model.id === 'deepseek-v4-flash'), '退役模型不该出现在管理清单里')
    chat = apply(chat, (c) => overlay.applyRestoreModel(c, 'deepseek', 'deepseek-v4-pro'))
    assert(quiet(() => new ChatModelManager({ credentials: fakeStore(), config: chat })).find('deepseek/deepseek-v4-pro'), '恢复未生效')
    throwsWith(() => overlay.applyRestoreModel(structuredClone(chat), 'deepseek', 'deepseek-v4-pro'), '未被删除', '恢复没隐藏过的模型')

    // 自建供应商删掉最后一个模型 ⇒ 回到"空供应商"状态：设置页仍可见（添加流程要走第二步），
    // 但不会被注册进 pi。只有"除了 id 什么都没剩"的条目才该被清掉。
    let withUser = apply({}, (c) => overlay.applyAddProvider(c, { providerId: 'tmp', baseUrl: 'https://tmp.example.com' }))
    withUser = apply(withUser, (c) => overlay.applyAddModel(c, { providerId: 'tmp', id: 'm' }))
    const deleted = apply(withUser, (c) => overlay.applyDeleteModel(c, 'tmp', 'm'))
    assert(deleted.userProviders?.[0]?.id === 'tmp' && !deleted.userProviders[0].models, '删完模型后条目形状不对')
    assert(deleted.userProviders[0].baseUrl === 'https://tmp.example.com', 'baseUrl 覆盖被误删')
    const shell = prune({ userProviders: [{ id: 'ghost' }] })
    assert(!shell.userProviders, '只剩 id 的空条目没被清掉（左侧会挂着一条没名字的"自定义"）')
    // 但内置供应商的 baseUrl 覆盖条目必须留着（它承载的是端点覆盖，不是模型列表）
    const builtinEntry = apply(
      apply({}, (c) => overlay.applyAddProvider(c, { providerId: 'kimi', baseUrl: 'https://mirror.example.com' })),
      (c) => overlay.applyAddModel(c, { providerId: 'kimi', id: 'kimi-new' })
    )
    const afterDelete = apply(builtinEntry, (c) => overlay.applyDeleteModel(c, 'kimi', 'kimi-new'))
    assert(
      afterDelete.userProviders?.find((p) => p.id === 'kimi')?.baseUrl === 'https://mirror.example.com',
      '删掉自建新增模型时顺手清掉了内置供应商的 baseUrl 覆盖'
    )
  })

  check('写入面拒非法输入且不动原配置（错误文案要能定位）', () => {
    const base = apply({}, (c) => overlay.applyAddProvider(c, { providerId: 'gw', baseUrl: 'https://gw.example.com' }))
    const snapshot = JSON.stringify(base)
    throwsWith(() => overlay.applyAddProvider(base, { providerId: '没有合法id', baseUrl: 'https://x.com' }), '供应商 ID', '非法供应商 id')
    throwsWith(() => overlay.applyAddProvider(base, { providerId: 'ok', baseUrl: 'x.com' }), 'http(s)://', '非 http baseUrl')
    throwsWith(() => overlay.applyAddProvider(base, { providerId: 'ok', baseUrl: 'https://x.com', api: 'google-generative-ai' }), '协议只支持', '白名单外协议')
    throwsWith(() => overlay.applyAddProvider(base, { providerId: 'gw', baseUrl: 'https://y.com' }), '已存在', '重复添加自建供应商')
    throwsWith(() => overlay.applyAddModel(base, { providerId: 'nobody', id: 'm' }), '供应商不存在', '挂在不存在的供应商下')
    throwsWith(() => overlay.applyAddModel(base, { providerId: 'deepseek', id: 'deepseek-flash' }), '内置模型', '给内置模型重复添加')
    throwsWith(() => overlay.applyAddModel(base, { providerId: 'gw', id: '坏 id!' }), '模型 ID', '非法模型 id')
    throwsWith(() => overlay.applyAddModel(base, { providerId: 'gw', id: 'ok1', api: 'anthropic' }), '协议只支持', '模型级白名单外协议')
    throwsWith(() => overlay.applyEditModel(base, { providerId: 'gw', modelId: 'ghost' }), '模型不可用', '编辑不存在的模型')
    throwsWith(() => overlay.applyRemoveProvider(base, 'deepseek'), '不存在', '删没添加过的内置覆盖条目')
    assert(JSON.stringify(base) === snapshot, '抛错路径污染了原配置')
  })

  const pass = results.filter((r) => r.pass).length
  console.log(`\n================ chat-catalog:check ${pass}/${results.length} PASS ================`)
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  process.exit(pass === results.length ? 0 : 2)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
