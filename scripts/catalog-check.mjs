/**
 * 内置媒体模型目录校验（catalog 架构 §7.1，纳入 CI）。
 *
 * 运行：pnpm catalog:check
 *
 * 用项目自带的 typescript 把 src/main/media（+ shared/media.ts）即时转译成
 * CommonJS 临时产物后加载——目录与适配器层不依赖 electron，纯 Node 可执行。
 *
 * 校验内容：
 *   1. 目录数据：provider/model id 唯一且格式合法、kind 合法、适配器类型已注册、
 *      auth.env 符合 <VENDOR>_KEY 约定、capabilities.durations 升序、helpUrl 可用。
 *   2. dry-run：mergeCatalog + createAdapters 逐供应商实例化（零网络请求），
 *      配置结构错误当场报。
 *   3. 合并层行为回归：hiddenBuiltin / modelOverrides / deprecated / 同名覆盖 /
 *      remoteModel 缺省派生 / 坏配置清洗（内置清单灌入 P2 数据后同样被覆盖）。
 *   4. 全量浏览目录（设置页「浏览完整模型库」数据源）：条目形态、精选 ⊆ 全量、
 *      用户模型 capabilities/costHint 的清洗与透传。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'catalog-check-tmp')
const REQUIRE = createRequire(import.meta.url)

/** 收集待转译文件：媒体域全部 TS + 共享类型（适配器/目录层必须保持 electron-free） */
function collectSources() {
  // fsutil 只依赖 fs/path，上传索引的原子写复用它，因此一并纳入转译范围
  const roots = [
    path.join(PROJECT_ROOT, 'src', 'main', 'media'),
    path.join(PROJECT_ROOT, 'src', 'main', 'fsutil'),
    path.join(PROJECT_ROOT, 'src', 'shared', 'media.ts')
  ]
  const files = []
  const walk = (entry) => {
    const stat = fs.statSync(entry)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) {
        if (name === 'node_modules') continue
        walk(path.join(entry, name))
      }
      return
    }
    if (/\.tsx?$/.test(entry)) files.push(entry)
  }
  for (const root of roots) walk(root)
  return files
}

/** 逐文件 transpileModule 成 CJS，保持相对目录结构（相对 import 原样可用） */
function transpileAll(files) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  for (const file of files) {
    const rel = path.relative(PROJECT_ROOT, file)
    const target = path.join(OUT_DIR, rel.replace(/\.ts$/, '.js'))
    const source = fs.readFileSync(file, 'utf8')
    const { outputText, diagnostics } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      },
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
/** 异步版：adapter.submit 走真 fetch 挡板，断言必须 await（否则错误会变成 unhandled rejection） */
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
/** 断言异步调用必须抛错且错误文本匹配 —— "该报错的地方没报错"本身就是回归 */
async function assertRejects(fn, pattern, message) {
  let thrown
  try {
    await fn()
  } catch (error) {
    thrown = error
  }
  if (!thrown) throw new Error(`${message}：实际没有抛错`)
  const text = thrown instanceof Error ? thrown.message : String(thrown)
  if (!pattern.test(text)) throw new Error(`${message}：错误文本不符（${text.slice(0, 200)}）`)
}

/**
 * 适配器夹具：带角色的参考素材。编排层闸门产出的就是 ProviderMediaRef[]，
 * 适配器只读它（refFiles 形态已删除），夹具照同一形状给。
 */
function refImg(file, role = 'reference_image') {
  return { role, mediaType: 'image', mime: 'image/png', bytes: 0, absPath: file }
}

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i
const MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._/-]*$/i
const AUTH_ENV_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_KEY$/
const MEDIA_KINDS = new Set(['image', 'video', 'audio'])
const STATUSES = new Set(['stable', 'beta', 'deprecated'])

async function main() {
  transpileAll(collectSources())
  const catalog = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'main', 'media', 'catalog', 'index.js')).href)
  const adapters = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'main', 'media', 'adapters', 'index.js')).href)
  const { BUILTIN_PROVIDERS, mergeCatalog } = catalog

  /* ---------------- 1. 目录数据校验 ---------------- */

  const adapterTypes = new Set(adapters.getAdapterTypes())
  check(`适配器注册表非空（${[...adapterTypes].join(', ')}）`, () => {
    assert(adapterTypes.size > 0, '注册表为空：adapters/index.ts 的 barrel import 未生效')
  })

  const seenModelIds = new Map()
  for (const provider of BUILTIN_PROVIDERS) {
    const pid = `catalog[${provider.id ?? '?'}]`
    check(`${pid} id 格式`, () => {
      assert(typeof provider.id === 'string' && PROVIDER_ID_RE.test(provider.id), `供应商 id 不合法：${JSON.stringify(provider.id)}`)
    })
    check(`${pid} 适配器类型已注册`, () => {
      assert(adapterTypes.has(provider.adapter), `适配器类型未注册：${provider.adapter}（可用：${[...adapterTypes].join(', ')}）`)
    })
    check(`${pid} auth 声明`, () => {
      assert(provider.auth && typeof provider.auth === 'object', '缺少 auth 声明')
      assert(AUTH_ENV_RE.test(provider.auth.env ?? ''), `auth.env 不符合 <VENDOR>_KEY 约定：${provider.auth.env}`)
      assert(typeof provider.auth.helpUrl === 'string' && provider.auth.helpUrl.startsWith('http'), `auth.helpUrl 不是 http(s) 链接：${provider.auth.helpUrl}`)
      assert(typeof provider.auth.label === 'string' && provider.auth.label.length > 0, 'auth.label 缺失')
    })
    check(`${pid} region 声明`, () => {
      assert(provider.region === undefined || provider.region === 'global' || provider.region === 'cn-direct', `region 不合法：${provider.region}`)
    })
    check(`${pid} models 非空数组`, () => {
      assert(Array.isArray(provider.models) && provider.models.length > 0, 'models 必须是非空数组（供应商目录没有模型就没有存在意义）')
    })
    for (const model of provider.models ?? []) {
      const mid = `${pid}/${model.id ?? '?'}`
      check(`${mid} 定义`, () => {
        assert(typeof model.id === 'string' && model.id.startsWith(`${provider.id}/`), `模型 id 必须以 "${provider.id}/" 开头：${model.id}`)
        const slug = model.id.slice(provider.id.length + 1)
        assert(MODEL_SLUG_RE.test(slug), `模型 slug 不合法：${slug}`)
        assert(!seenModelIds.has(model.id), `模型 id 全局重复：${model.id}（先见于 ${seenModelIds.get(model.id)}）`)
        seenModelIds.set(model.id, mid)
        assert(MEDIA_KINDS.has(model.kind), `kind 不合法：${model.kind}`)
        assert(typeof model.label === 'string' && model.label.length > 0, 'label 缺失')
        assert(STATUSES.has(model.status ?? 'stable'), `status 不合法：${model.status}`)
        const remote = model.remoteModel ?? model.id.slice(provider.id.length + 1)
        assert(typeof remote === 'string' && remote.length > 0, 'remoteModel 派生结果为空')
        if (model.capabilities?.durations) {
          const durations = model.capabilities.durations
          assert(Array.isArray(durations) && durations.every((d) => typeof d === 'number' && d > 0), `durations 必须是正数数组：${JSON.stringify(durations)}`)
          for (let i = 1; i < durations.length; i += 1) {
            assert(durations[i] > durations[i - 1], `durations 必须升序：${JSON.stringify(durations)}`)
          }
        }
      })
    }
  }
  check(
    `目录条目数（providers=${BUILTIN_PROVIDERS.length}，models=${seenModelIds.size}）`,
    () => 'P2 灌入首批清单后此数应显著增长'
  )

  /* ---------------- 2. dry-run 实例化 + 合并层回归 ---------------- */

  const dummyDeps = {
    mediaDir: () => null,
    resolveKey: async () => undefined
  }

  check('mergeCatalog + createAdapters dry-run（空目录）', () => {
    const effective = mergeCatalog(BUILTIN_PROVIDERS, {})
    const created = adapters.createAdapters(effective, dummyDeps)
    assert(created.length === effective.length, '实例化数量与清单不一致')
  })

  check('合并层回归：hidden / override / deprecated / remoteModel 派生', () => {
    const builtin = [
      {
        id: 'acme',
        label: 'ACME 网关',
        adapter: 'gateway-dashscope',
        auth: { env: 'ACME_KEY', label: 'ACME Key', helpUrl: 'https://example.com/keys' },
        models: [
          { id: 'acme/img', kind: 'image', label: 'ACME 图' },
          { id: 'acme/vid', kind: 'video', label: 'ACME 视频', remoteModel: 'acme-ai/vid-v9' },
          { id: 'acme/old', kind: 'image', label: 'ACME 旧图', status: 'deprecated' }
        ]
      }
    ]
    const effective = mergeCatalog(builtin, {
      hiddenBuiltin: ['acme/img'],
      modelOverrides: { 'acme/vid': { label: '我的视频' } }
    })
    assert(effective.length === 1, `应合并出 1 个内置供应商，实际 ${effective.length}`)
    const models = effective[0].models
    assert(models.length === 1, `hidden+deprecated 剔除后应剩 1 个模型，实际 ${models.length}（${models.map((m) => m.id).join(',')}）`)
    assert(models[0].id === 'acme/vid', `保留的应是 acme/vid，实际 ${models[0].id}`)
    assert(models[0].label === '我的视频', 'modelOverrides.label 未生效')
    assert(models[0].requestModel === 'acme-ai/vid-v9', `remoteModel 未透传：${models[0].requestModel}`)
    // remoteModel 缺省派生：acme/img 若未被隐藏应为 'img'
    const noHide = mergeCatalog(builtin, {})
    const img = noHide[0].models.find((m) => m.id === 'acme/img')
    assert(img && img.requestModel === 'img', `remoteModel 缺省派生失败：${img?.requestModel}`)
    assert(noHide[0].authKey === 'acme' && noHide[0].authEnv === 'ACME_KEY', '内置 auth 缺省化失败')
  })

  check('合并层回归：同名覆盖合并模型子集 + 异 id 追加 + 默认 authEnv 回退', () => {
    const effective = mergeCatalog([], {
      userProviders: [
        { id: 'my-oai', type: 'gateway-openai-compat', models: { 'gpt-image-1': { kind: 'image', label: 'GPT Image' } } },
        { id: 'my-oai-noenv', type: 'gateway-openai-compat', authEnv: 'MY_KEY', models: { 'gpt-audio-x': { kind: 'audio' } } }
      ]
    })
    assert(effective.length === 2, `应追加 2 个用户供应商，实际 ${effective.length}`)
    const first = effective[0]
    assert(first.source === 'user' && first.authKey === 'my-oai', '用户供应商 authKey 缺省 = id')
    assert(first.authEnv === 'OPENAI_API_KEY', `gateway-openai-compat 未声明 authEnv 时应回退 OPENAI_API_KEY，实际 ${first.authEnv}`)
    assert(first.models[0].requestModel === undefined || first.models[0].requestModel === first.models[0].id, '用户模型 requestModel 应等于 id')
    assert(effective[1].authEnv === 'MY_KEY', '用户显式 authEnv 未生效')
  })

  check('合并层回归：坏配置清洗（逐条丢弃 + 精确报错不抛异常）', () => {
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const effective = mergeCatalog([], {
        userProviders: [
          'not-an-object',
          { id: 'bad type', type: 'gateway-replicate', models: {} },
          { id: 'no-models', type: 'gateway-openai-compat' },
          { id: 'bad-model', type: 'gateway-openai-compat', models: { 'ok/model': { kind: 'sticker' } } },
          {
            id: 'good',
            type: 'gateway-openai-compat',
            models: { 'good/model': { kind: 'image', label: '好模型' } }
          }
        ]
      })
      assert(effective.length === 1 && effective[0].id === 'good', `应只剩 1 个合法供应商，实际 ${JSON.stringify(effective.map((e) => e.id))}`)
      assert(effective[0].models.length === 1, '坏 kind 的模型应被丢弃')
      assert(warnings.some((w) => w.includes('media.userProviders[3]')), '应按条目索引给出可定位警告')
    } finally {
      console.warn = originalWarn
    }
  })

  check('合并层回归：baseUrl 透传（gateway-openai-compat 协议家族）', () => {
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const effective = mergeCatalog([], {
        userProviders: [
          {
            id: 'siliconflow',
            type: 'gateway-openai-compat',
            baseUrl: 'https://api.siliconflow.com/v1/',
            models: { 'Kwai-Kolors/Kolors': { kind: 'image' } }
          },
          { id: 'bad-url', type: 'gateway-openai-compat', baseUrl: 'ftp://not-http', models: { m: { kind: 'image' } } }
        ]
      })
      assert(effective.length === 2, `两条用户供应商都应保留，实际 ${effective.length}`)
      assert(effective[0].baseUrl === 'https://api.siliconflow.com/v1', `baseUrl 应清洗尾部斜杠后透传：${effective[0].baseUrl}`)
      assert(effective[1].baseUrl === undefined, '非 http(s) 的 baseUrl 应被忽略（供应商保留）')
      assert(warnings.some((w) => w.includes('baseUrl')), '非法 baseUrl 应给出可定位警告')
    } finally {
      console.warn = originalWarn
    }
  })

  check('dry-run 实例化 gateway-openai-compat（label/模型透传）', () => {
    const effective = mergeCatalog([], {
      userProviders: [
        {
          id: 'dry-oai',
          label: 'Dry OpenAI',
          type: 'gateway-openai-compat',
          authKey: 'dry-oai',
          models: { 'gpt-image-1': { kind: 'image', label: 'GPT Image' } }
        }
      ]
    })
    const created = adapters.createAdapters(effective, dummyDeps)
    assert(created.length === 1, '应实例化 1 个适配器')
    const adapter = created[0]
    assert(adapter.id === 'dry-oai' && adapter.type === 'gateway-openai-compat', '实例 id/type 不符')
    assert(adapter.label === 'Dry OpenAI', '实例 label 不符')
    assert(adapter.models.length === 1 && adapter.models[0].id === 'gpt-image-1' && adapter.models[0].label === 'GPT Image', '模型清单透传失败')
    assert(adapter.isConfigured() === true, 'isConfigured 应可调用（同步保守判断）')
    assert(typeof adapter.authHint() === 'string' && adapter.authHint().length > 0, 'authHint 应非空')
  })

  await checkAsync('dashscope 图生图/图生视频协议形态（官方 API 参考核实的 body 断言）', async () => {
    const effective = mergeCatalog(
      BUILTIN_PROVIDERS.filter((p) => p.id === 'dashscope'),
      {}
    )
    const created = adapters.createAdapters(effective, { mediaDir: () => null, resolveKey: async () => 'sk-dry' })
    const adapter = created[0]
    assert(adapter.id === 'dashscope', 'dashscope 适配器未实例化')

    // fetch 挡板：抓 submit 实际发出的 URL + body
    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers ?? {} })
      return new Response(JSON.stringify({ output: { task_id: 'task-dry' } }), { status: 200 })
    }
    // 参考图夹具：装载只看扩展名 + 读文件，内容不要求是真 PNG
    const refPng = path.join(OUT_DIR, 'ref-fixture.png')
    fs.mkdirSync(path.dirname(refPng), { recursive: true })
    fs.writeFileSync(refPng, Buffer.from('89504e47', 'hex'))

    try {
      // ① wan2.7-image 文生图：新协议端点、content 只有 text、带 size
      await adapter.submit('dashscope/wan2.7-image', { prompt: 'p', width: 1024, height: 1024 })
      let c = calls.at(-1)
      assert(c.url.includes('/api/v1/services/aigc/image-generation/generation'), `端点不对：${c.url}`)
      assert(c.body.input.messages[0].content.length === 1 && c.body.input.messages[0].content[0].text === 'p', '文生图 content 应只有 text')
      assert(typeof c.body.parameters.size === 'string', '文生图应带 size')

      // ② wan2.7-image 图生图（显式比例）：content 追加 {image: dataURI}，size 必须显式传入
      //   覆盖编辑模式「缺省随输入图比例」——不传 size 时竖版请求会静默出成参考图的横版
      await adapter.submit('dashscope/wan2.7-image', { prompt: 'p', width: 1024, height: 1024, refs: [refImg(refPng)] })
      c = calls.at(-1)
      const content = c.body.input.messages[0].content
      assert(content.length === 2 && content[1].image.startsWith('data:image/png;base64,'), `图生图 content 不对：${JSON.stringify(content).slice(0, 120)}`)
      assert(typeof c.body.parameters.size === 'string', '图生图显式比例必须传 size（缺省才随输入图比例）')

      // ②' wan2.7-image 图生图（未指定比例）：不传 size，保持输出比例随参考图的缺省语义
      await adapter.submit('dashscope/wan2.7-image', { prompt: 'p', refs: [refImg(refPng)] })
      c = calls.at(-1)
      assert(c.body.parameters.size === undefined, '图生图未指定比例不应传 size（输出随参考图）')

      // ②'' 多张参考图：官方 wan2.7-image 支持 0–9 张，按声明数量全部装进 content
      //   （旧实现只 push 第 1 张，挂多张的用户素材被静默丢掉）
      await adapter.submit('dashscope/wan2.7-image', { prompt: 'p', width: 1024, height: 1024, refs: [refImg(refPng), refImg(refPng), refImg(refPng)] })
      c = calls.at(-1)
      const multi = c.body.input.messages[0].content
      assert(multi.length === 4 && multi.slice(1).every((i) => i.image?.startsWith('data:image/png;base64,')), `多图参考应全装进 content：${multi.length}`)

      // ③ wan2.7-i2v：input.media[{type:'first_frame',url:dataURI}]、无 ratio、duration clamp [2,15]
      await adapter.submit('dashscope/wan2.7-i2v', { prompt: 'p', width: 1024, height: 1024, durationSeconds: 99, refs: [refImg(refPng, 'first_frame')] })
      c = calls.at(-1)
      assert(c.url.includes('/api/v1/services/aigc/video-generation/video-synthesis'), `i2v 端点不对：${c.url}`)
      assert(c.body.input.media?.[0]?.type === 'first_frame' && c.body.input.media[0].url.startsWith('data:image/png;base64,'), `首帧 media 不对：${JSON.stringify(c.body.input.media)}`)
      assert(c.body.parameters.ratio === undefined, 'wan2.7-i2v 无 ratio 参数（官方 API 参考）')
      assert(c.body.parameters.duration === 15, `duration 应 clamp 到 15：${c.body.parameters.duration}`)
      assert(c.body.parameters.resolution === '1080P', `resolution 不对：${c.body.parameters.resolution}`)

      // ④ wan3.0-video：duration 上限 30；官方视频端点没有 n 字段（不再无条件塞 n:1）
      await adapter.submit('dashscope/wan3.0-video', { prompt: 'p', durationSeconds: 99, refs: [refImg(refPng, 'first_frame')] })
      c = calls.at(-1)
      assert(c.body.input.media?.[0]?.type === 'first_frame', 'wan3.0-video 应走 media 形态')
      assert(c.body.parameters.duration === 30, `wan3.0 duration 应 clamp 到 30：${c.body.parameters.duration}`)
      assert(c.body.parameters.n === undefined, `wan3.0 无 n 参数：${JSON.stringify(c.body.parameters)}`)

      // ⑤ wan2.7-t2v 回归：仍走 t2v 形态（无 media、有 ratio），不被 i2v 分支误伤
      await adapter.submit('dashscope/wan2.7-t2v', { prompt: 'p', width: 1920, height: 1080, durationSeconds: 10 })
      c = calls.at(-1)
      assert(c.body.input.media === undefined && typeof c.body.parameters.ratio === 'string', `t2v 形态被误伤：${JSON.stringify(c.body).slice(0, 160)}`)

      // ⑤' oss:// 临时引用必须带 X-DashScope-OssResourceResolve 头（缺了它网关报无效 URL），
      //     data URI 形态则不该带这个头
      await adapter.submit('dashscope/wan3.0-video', {
        prompt: 'p',
        durationSeconds: 5,
        refs: [{ role: 'reference_video', mediaType: 'video', mime: 'video/mp4', bytes: 10, url: 'oss://dashscope-instant/abc/x.mp4' }]
      })
      assert(calls.at(-1).headers['X-DashScope-OssResourceResolve'] === 'enable', 'oss:// 引用应带临时存储解析头')
      assert(calls.at(-1).body.input.media[0].url === 'oss://dashscope-instant/abc/x.mp4', `oss:// 引用应原样进 media[]：${JSON.stringify(calls.at(-1).body.input.media)}`)
      await adapter.submit('dashscope/wan2.7-image', { prompt: 'p', width: 1024, height: 1024, refs: [refImg(refPng)] })
      assert(calls.at(-1).headers['X-DashScope-OssResourceResolve'] === undefined, 'base64 形态不该带临时存储解析头')

      // ⑥ wan2.5 旧协议回归：旧端点、input.prompt 直传
      await adapter.submit('dashscope/wan2.5-t2i-preview', { prompt: 'p', width: 1024, height: 1024 })
      c = calls.at(-1)
      assert(c.url.includes('/api/v1/services/aigc/text2image/image-synthesis') && c.body.input.prompt === 'p', '旧协议形态被误伤')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await checkAsync('dashscope 千问/happyhorse 新族协议（模型名不带 wan 前缀的识别回归）', async () => {
    const effective = mergeCatalog(
      BUILTIN_PROVIDERS.filter((p) => p.id === 'dashscope'),
      {}
    )
    const created = adapters.createAdapters(effective, { mediaDir: () => null, resolveKey: async () => 'sk-dry' })
    const adapter = created.find((a) => a.id === 'dashscope')
    assert(adapter, 'dashscope 适配器未实例化')

    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const urlText = String(url)
      if (urlText.includes('/api/v1/tasks/')) {
        return new Response(JSON.stringify({ output: { task_status: 'SUCCEEDED', video_url: 'https://cdn/v.mp4' } }), { status: 200 })
      }
      calls.push({ url: urlText, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ output: { task_id: 'task-dry' } }), { status: 200 })
    }
    const refPng = path.join(OUT_DIR, 'ref-fixture.png')
    fs.mkdirSync(path.dirname(refPng), { recursive: true })
    fs.writeFileSync(refPng, Buffer.from('89504e47', 'hex'))

    try {
      // ① qwen-image-3.0-pro 文生图：必须走新端点 + messages 形态（回归点：模型名不含 wan）
      await adapter.submit('dashscope/qwen-image-3.0-pro', { prompt: 'p', width: 1280, height: 720 })
      let c = calls.at(-1)
      assert(c.url.includes('/api/v1/services/aigc/image-generation/generation'), `千问应走新图片端点：${c.url}`)
      assert(c.body.model === 'qwen-image-3.0-pro', `模型名未透传：${c.body.model}`)
      assert(c.body.input.messages[0].content[0].text === 'p', '千问应走 messages 形态')
      assert(typeof c.body.parameters.size === 'string' && c.body.parameters.size.includes('*'), `size 应为「宽*高」：${c.body.parameters.size}`)

      // ② qwen-image-3.0-pro 图生图：同端点 + content 追加 {image}（data URI）
      await adapter.submit('dashscope/qwen-image-3.0-pro', { prompt: 'p', width: 1024, height: 1024, refs: [refImg(refPng)] })
      c = calls.at(-1)
      const content = c.body.input.messages[0].content
      assert(content.length === 2 && content[1].image?.startsWith('data:image/png;base64,'), `千问图生图 content 不对：${JSON.stringify(content).slice(0, 120)}`)

      // ③ happyhorse-1.1-t2v 文生视频：video-synthesis + resolution/ratio/duration 新参数
      //   （回归点：模型名不含 wan，不能落到旧 size 分支）
      await adapter.submit('dashscope/happyhorse-1.1-t2v', { prompt: 'p', width: 1280, height: 720, durationSeconds: 99 })
      c = calls.at(-1)
      assert(c.url.includes('/api/v1/services/aigc/video-generation/video-synthesis'), `happyhorse 端点不对：${c.url}`)
      assert(c.body.parameters.size === undefined, 'happyhorse 不应传旧 size 字段')
      assert(c.body.parameters.resolution === '720P' && c.body.parameters.ratio === '16:9', `参数形态不对：${JSON.stringify(c.body.parameters)}`)
      assert(c.body.parameters.duration === 15, `duration 应 clamp 到 15：${c.body.parameters.duration}`)

      // ③' happyhorse-1.1-t2v 时长**下限 3**（官方 3~15）：回归钉——t2v 分支曾把下限
      //   写成 2，与自家 media 分支/文件头矛盾；现两分支共用 dashscope.ts 的 videoDurationWindow 族表
      await adapter.submit('dashscope/happyhorse-1.1-t2v', { prompt: 'p', width: 1280, height: 720, durationSeconds: 1 })
      assert(calls.at(-1).body.parameters.duration === 3, `happyhorse t2v 下限应为 3：${calls.at(-1).body.parameters.duration}`)

      // ④ happyhorse-1.1-i2v 图生视频：media 数组 + duration 下限 3（官方 3~15 秒）
      await adapter.submit('dashscope/happyhorse-1.1-i2v', { prompt: 'p', durationSeconds: 1, refs: [refImg(refPng, 'first_frame')] })
      c = calls.at(-1)
      assert(c.body.input.media?.[0]?.type === 'first_frame', `happyhorse i2v 应走 media 形态：${JSON.stringify(c.body.input)}`)
      assert(c.body.parameters.duration === 3, `happyhorse duration 下限应为 3：${c.body.parameters.duration}`)

      // ⑤ wan3.0-video-prime 优速版：复用 wan3.0 的 duration 上限 30
      await adapter.submit('dashscope/wan3.0-video-prime', { prompt: 'p', durationSeconds: 99, refs: [refImg(refPng, 'first_frame')] })
      c = calls.at(-1)
      assert(c.body.input.media?.[0]?.type === 'first_frame', 'wan3.0-video-prime 应走 media 形态')
      assert(c.body.parameters.duration === 30, `wan3.0-video-prime duration 应 clamp 到 30：${c.body.parameters.duration}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await checkAsync('token-plan 文生图（同步）/文生视频（异步）协议形态（2026-10-25 官方 token-plan-multimodal-gen 核实）', async () => {
    const effective = mergeCatalog(BUILTIN_PROVIDERS.filter((p) => p.id === 'token-plan'), {})
    const created = adapters.createAdapters(effective, { mediaDir: () => null, resolveKey: async () => 'sk-dry' })
    const adapter = created.find((a) => a.id === 'token-plan')
    assert(adapter, 'token-plan 适配器未实例化')
    assert(adapter.type === 'gateway-token-plan', `适配器类型不对：${adapter.type}`)

    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const urlText = String(url)
      if (init?.method === 'POST' && !urlText.includes('/cancel')) {
        calls.push({ url: urlText, body: JSON.parse(init.body), headers: init.headers ?? {} })
        if (urlText.includes('multimodal-generation')) {
          return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ type: 'image', image: 'https://cdn/i.png' }] } }] } }), { status: 200 })
        }
        return new Response(JSON.stringify({ output: { task_id: 'task-tp-1' } }), { status: 200 })
      }
      // GET 轮询：回终态成功
      return new Response(JSON.stringify({ output: { task_status: 'SUCCEEDED', video_url: 'https://cdn/v.mp4' } }), { status: 200 })
    }

    try {
      // ① 文生图：token-plan 专属同步端点（**不是**标准百炼的 image-generation/generation）、
      //   不带 X-DashScope-Async，URL 产物编码进 jobId，poll 首轮直接成功
      const jobImage = await adapter.submit('token-plan/qwen-image-3.0-pro', { prompt: 'p', width: 1024, height: 1024 })
      let c = calls.at(-1)
      assert(c.url === 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', `图片端点不对：${c.url}`)
      assert(c.headers['X-DashScope-Async'] === undefined, '同步文生图不该带异步头')
      assert(c.body.input.messages[0].content.length === 1 && c.body.input.messages[0].content[0].text === 'p', '文生图 content 应只有 text')
      assert(c.body.parameters.size === '1024*1024', `size 不对：${c.body.parameters.size}`)
      assert(jobImage === 'tp-url|https://cdn/i.png', `同步结果 URL 应编进 jobId：${jobImage}`)
      const imgPoll = await adapter.poll('token-plan/qwen-image-3.0-pro', jobImage)
      assert(imgPoll.status === 'succeeded' && imgPoll.resultUrl === 'https://cdn/i.png', `tp-url 通道 poll 应直接回成功：${JSON.stringify(imgPoll)}`)

      // ② 未给像素：不传 size（吃网关缺省 1024*1024，官方示例值）
      await adapter.submit('token-plan/wan2.7-image', { prompt: 'p' })
      c = calls.at(-1)
      assert(c.body.parameters === undefined, `未给像素应整个缺省 parameters：${JSON.stringify(c.body.parameters)}`)

      // ②' 宽高覆盖项裸传：边长按族窗口 [512,2048] clamp（IPC「高级覆盖」直通适配器，
      //   比例闸门拦不住；同 slug 在 gateway-dashscope 会被归一，行为必须一致不裸传 400）
      await adapter.submit('token-plan/qwen-image-3.0-pro', { prompt: 'p', width: 3000, height: 300 })
      c = calls.at(-1)
      assert(c.body.parameters.size === '2048*512', `size 边长应 clamp 到 [512,2048]：${c.body.parameters.size}`)

      // ③ 文生视频：video-synthesis + 异步头、input.prompt 形态、resolution/ratio/duration、无 n
      const jobVideo = await adapter.submit('token-plan/happyhorse-1.1-t2v', { prompt: 'p', width: 1280, height: 720, durationSeconds: 99 })
      c = calls.at(-1)
      assert(c.url === 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis', `视频端点不对：${c.url}`)
      assert(c.headers['X-DashScope-Async'] === 'enable', '视频必须带异步头')
      assert(c.body.input.prompt === 'p' && c.body.input.media === undefined, '文生视频应走 prompt 形态')
      assert(c.body.parameters.resolution === '720P' && c.body.parameters.ratio === '16:9', `分辨率/比例归档不对：${JSON.stringify(c.body.parameters)}`)
      assert(c.body.parameters.duration === 15, `happyhorse duration 应 clamp 到 15：${c.body.parameters.duration}`)
      assert(c.body.parameters.n === undefined, '视频端点无 n 字段（同标准百炼）')
      assert(jobVideo === 'tp-task|task-tp-1', `任务 jobId 形态不对：${jobVideo}`)
      const vPoll = await adapter.poll('token-plan/happyhorse-1.1-t2v', jobVideo)
      assert(vPoll.status === 'succeeded' && vPoll.resultUrl === 'https://cdn/v.mp4', `视频 poll 不对：${JSON.stringify(vPoll)}`)

      // ③' ratio 与宽高并存：**像素优先**派生 ratio（与 gateway-dashscope 同端点族同规则；
      //   input.ratio 压过宽高会与成对下发的 resolution 打架）；只给 ratio 时补 720P 缺省档
      await adapter.submit('token-plan/happyhorse-1.1-t2v', { prompt: 'p', ratio: '1:1', width: 1920, height: 1080, durationSeconds: 5 })
      c = calls.at(-1)
      assert(c.body.parameters.ratio === '16:9' && c.body.parameters.resolution === '1080P', `并存时应按像素派生 ratio：${JSON.stringify(c.body.parameters)}`)
      await adapter.submit('token-plan/happyhorse-1.1-t2v', { prompt: 'p', ratio: '3:4', durationSeconds: 5 })
      c = calls.at(-1)
      assert(c.body.parameters.ratio === '3:4' && c.body.parameters.resolution === '720P', `只给 ratio 应补 resolution 缺省档：${JSON.stringify(c.body.parameters)}`)

      // ④ 时长下限（happyhorse 3 秒）与 wan3.0 上限 30 秒、高度 ≥1000 归 1080P
      await adapter.submit('token-plan/happyhorse-1.1-t2v', { prompt: 'p', width: 1024, height: 1024, durationSeconds: 1 })
      assert(calls.at(-1).body.parameters.duration === 3, `happyhorse duration 下限应为 3：${calls.at(-1).body.parameters.duration}`)
      await adapter.submit('token-plan/wan3.0-video', { prompt: 'p', width: 1920, height: 1080, durationSeconds: 99 })
      c = calls.at(-1)
      assert(c.body.parameters.duration === 30, `wan3.0 duration 应 clamp 到 30：${c.body.parameters.duration}`)
      assert(c.body.parameters.resolution === '1080P', `高度≥1000 应归 1080P：${c.body.parameters.resolution}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await checkAsync('minimax 图生图/视频协议形态（2026-10 官方 API 参考核实的 body 断言）', async () => {
    const effective = mergeCatalog(BUILTIN_PROVIDERS.filter((p) => p.id === 'minimax'), {})
    const created = adapters.createAdapters(effective, { mediaDir: () => null, resolveKey: async () => 'sk-dry' })
    const adapter = created[0]
    assert(adapter.id === 'minimax', 'minimax 适配器未实例化')

    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const urlText = String(url)
      // 查询端点回终态成功（不记入 calls）；提交端点抓 body 回 task_id/图片成功体
      if (urlText.includes('/v2/query/video_generation/')) {
        return new Response(JSON.stringify({ task: { status: 'succeeded', content: { url: 'https://cdn/x.png' } } }), { status: 200 })
      }
      calls.push({ url: urlText, body: JSON.parse(init?.body ?? '{}') })
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { image_urls: ['https://cdn/x.png'] }, task_id: 't-1' }), { status: 200 })
    }
    const refPng = path.join(OUT_DIR, 'ref-fixture.png')
    fs.mkdirSync(path.dirname(refPng), { recursive: true })
    fs.writeFileSync(refPng, Buffer.from('89504e47', 'hex'))

    try {
      // ① image-01 文生图：同步端点、aspect_ratio 直用应用比例枚举
      await adapter.submit('minimax/image-01', { prompt: 'p', ratio: '3:4', width: 864, height: 1152 })
      let c = calls.at(-1)
      assert(c.url === 'https://api.minimaxi.com/v1/image_generation', `端点不对：${c.url}`)
      assert(c.body.model === 'image-01' && c.body.aspect_ratio === '3:4', `aspect_ratio 未生效：${JSON.stringify(c.body)}`)
      assert(c.body.response_format === 'url' && c.body.subject_reference === undefined, '文生图不应带垫图')

      // ② image-01 垫图：subject_reference[{character, image_file:dataURI}]
      await adapter.submit('minimax/image-01', { prompt: 'p', ratio: '1:1', refs: [refImg(refPng)] })
      c = calls.at(-1)
      const ref = c.body.subject_reference?.[0]
      assert(ref?.type === 'character' && ref?.image_file?.startsWith('data:image/png;base64,'), `垫图形态不对：${JSON.stringify(c.body.subject_reference)}`)

      // ③ H3 文生视频：t2v ratio 必传、duration clamp 到 15、分辨率按高度归档
      await adapter.submit('minimax/h3', { prompt: 'p', ratio: '16:9', width: 1280, height: 720, durationSeconds: 99 })
      c = calls.at(-1)
      assert(c.url === 'https://api.minimaxi.com/v2/video_generation', `视频端点不对：${c.url}`)
      assert(c.body.model === 'MiniMax-H3' && c.body.resolution === '768P', `分辨率归档不对：${JSON.stringify(c.body)}`)
      assert(c.body.duration === 15, `duration 应 clamp 到 15：${c.body.duration}`)
      assert(c.body.ratio === '16:9' && c.body.content.length === 1, 't2v 必须带 ratio 且 content 只有 text')

      // ④ H3-Max 图生视频：首帧 image_url + role，ratio 不传（官方按 adaptive 处理），duration clamp [5,15]
      await adapter.submit('minimax/h3-max', { prompt: 'p', ratio: '3:4', width: 864, height: 1152, durationSeconds: 2, refs: [refImg(refPng, 'first_frame')] })
      c = calls.at(-1)
      assert(c.body.model === 'MiniMax-H3-Max' && c.body.resolution === '768P', 'H3-Max 分辨率应为 768P')
      assert(c.body.duration === 5, `H3-Max duration 应 clamp 到 5：${c.body.duration}`)
      const frame = c.body.content[1]
      assert(frame?.type === 'image_url' && frame?.role === 'first_frame' && frame?.image_url?.url?.startsWith('data:image/png;base64,'), `首帧形态不对：${JSON.stringify(frame)}`)
      assert(c.body.ratio === undefined, 'i2v 不应传 ratio（官方按 adaptive 处理）')

      // ⑤ poll：视频 succeeded → content.url
      const polled = await adapter.poll('minimax/h3', 'mm-video|t-1')
      assert(polled.status === 'succeeded' && polled.resultUrl === 'https://cdn/x.png', `poll 形态不对：${JSON.stringify(polled)}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await checkAsync('tencent 生图/生视频协议形态（2026-10 官方 API 参考核实的 body 断言）', async () => {
    const effective = mergeCatalog(BUILTIN_PROVIDERS.filter((p) => p.id === 'tencent'), {})
    const created = adapters.createAdapters(effective, { mediaDir: () => null, resolveKey: async () => 'AKID:secret' })
    const adapter = created[0]
    assert(adapter.id === 'tencent', 'tencent 适配器未实例化')

    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const urlText = String(url)
      const action = String(init?.headers?.['X-TC-Action'] ?? '')
      // 查询端点按 Action 回终态成功；提交端点抓 body 回 JobId
      if (action === 'QueryHunyuanImageJob') {
        return new Response(JSON.stringify({ Response: { JobStatusCode: 5, ResultImage: ['https://cdn/x.png'] } }), { status: 200 })
      }
      calls.push({ url: urlText, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') })
      return new Response(JSON.stringify({ Response: { JobId: 'job-1', RequestId: 'r' } }), { status: 200 })
    }
    const refPng = path.join(OUT_DIR, 'ref-fixture.png')
    fs.mkdirSync(path.dirname(refPng), { recursive: true })
    fs.writeFileSync(refPng, Buffer.from('89504e47', 'hex'))

    try {
      // ① 混元生图：hunyuan 域名 + TC3 签名头 + Resolution「宽:高」映射
      const longPrompt = '字'.repeat(1500)
      await adapter.submit('tencent/hunyuan-image', { prompt: longPrompt, ratio: '9:16', width: 720, height: 1280 })
      let c = calls.at(-1)
      assert(c.url === 'https://hunyuan.tencentcloudapi.com/', `生图域名不对：${c.url}`)
      assert(String(c.headers['X-TC-Action']) === 'SubmitHunyuanImageJob' && String(c.headers['X-TC-Version']) === '2023-09-01', `Action/Version 不对：${JSON.stringify(c.headers)}`)
      assert(String(c.headers.Authorization ?? '').startsWith('TC3-HMAC-SHA256 Credential=AKID/'), 'TC3 签名头形态不对')
      assert(c.body.Resolution === '768:1280', `比例映射不对：${c.body.Resolution}`)
      assert([...c.body.Prompt].length === 1024, `Prompt 应按码点截断到 1024：${[...c.body.Prompt].length}`)

      // ② 混元生图垫图：ContentImage.Base64 为裸 base64；9:16 在参考图场景归档到 768:1024
      await adapter.submit('tencent/hunyuan-image', { prompt: 'p', ratio: '9:16', refs: [refImg(refPng)] })
      c = calls.at(-1)
      const rawBase64 = Buffer.from('89504e47', 'hex').toString('base64')
      assert(c.body.ContentImage?.Base64 === rawBase64, `参考图应为裸 base64：${JSON.stringify(c.body.ContentImage)}`)
      assert(c.body.Resolution === '768:1024', `参考图场景 9:16 应归档 3:4：${c.body.Resolution}`)

      // ③ 混元生视频：vclm 域名 + Prompt 截断 200 + 720p；jobId 可查询
      await adapter.submit('tencent/hunyuan-video', { prompt: '字'.repeat(300) })
      c = calls.at(-1)
      assert(c.url === 'https://vclm.tencentcloudapi.com/', `视频域名不对：${c.url}`)
      assert(String(c.headers['X-TC-Action']) === 'SubmitHunyuanToVideoJob' && String(c.headers['X-TC-Version']) === '2024-05-23', '视频 Action/Version 不对')
      assert([...c.body.Prompt].length === 200 && c.body.Resolution === '720p', `视频参数不对：${JSON.stringify(c.body)}`)

      // ④ poll：生图完成态 → ResultImage[0]
      const polled = await adapter.poll('tencent/hunyuan-image', 'tc-img|job-1')
      assert(polled.status === 'succeeded' && polled.resultUrl === 'https://cdn/x.png', `poll 形态不对：${JSON.stringify(polled)}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await checkAsync('volcark 生图/生视频协议形态（2026-10 方舟官方 API 参考核实的 body 断言）', async () => {
    const effective = mergeCatalog(BUILTIN_PROVIDERS.filter((p) => p.id === 'volcark'), {})
    const created = adapters.createAdapters(effective, { mediaDir: () => null, resolveKey: async () => 'ark-dry' })
    const adapter = created[0]
    assert(adapter.id === 'volcark', 'volcark 适配器未实例化')

    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const urlText = String(url)
      const method = String(init?.method ?? 'GET')
      // 查询走 GET、取消走 DELETE：都不记入 calls（提交端点才是要断言的对象）
      if (method === 'GET') {
        return new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://cdn/ark/v.mp4' } }), { status: 200 })
      }
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ status: 'cancelled' }), { status: 200 })
      }
      calls.push({ url: urlText, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') })
      if (urlText.includes('/contents/generations/tasks')) {
        return new Response(JSON.stringify({ id: 'task-ark-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn/ark/x.png' }] }), { status: 200 })
    }
    const refPng = path.join(OUT_DIR, 'ref-fixture.png')
    fs.mkdirSync(path.dirname(refPng), { recursive: true })
    fs.writeFileSync(refPng, Buffer.from('89504e47', 'hex'))

    try {
      // ① Seedream 文生图：同步端点、response_format url、watermark 显式关、小尺寸按像素下限放大
      //   （官方 Seedream 4.0 起总像素下限 2560×1440；1024×1024 → 1920×1920 恰好过闸）
      await adapter.submit('volcark/seedream-5.0-pro', { prompt: 'p', width: 1024, height: 1024 })
      let c = calls.at(-1)
      assert(c.url === 'https://ark.cn-beijing.volces.com/api/v3/images/generations', `生图端点不对：${c.url}`)
      assert(String(c.headers.Authorization) === 'Bearer ark-dry', `认证头不对：${JSON.stringify(c.headers)}`)
      assert(c.body.model === 'doubao-seedream-5-0-pro-260628', `线上模型标识未透传：${c.body.model}`)
      assert(c.body.size === '1920x1920', `小尺寸应按比例放大过像素下限：${c.body.size}`)
      assert(c.body.response_format === 'url' && c.body.watermark === false, `同步出图参数不对：${JSON.stringify(c.body)}`)
      assert(c.body.image === undefined, '文生图不应带参考图')

      // ② Seedream 图生图：image 字段是数组（官方 string|string[]，5.0 pro/flash 上限 10 张、
      //   4.x 与 5.0 lite 14 张），按模型声明的数量**全部**下发 —— 旧实现只发第 1 张，
      //   声明了多张的模型会把它挂的其余参考静默丢掉
      await adapter.submit('volcark/seedream-5.0-pro', { prompt: 'p', width: 1024, height: 1024, refs: [refImg(refPng), refImg(refPng)] })
      c = calls.at(-1)
      assert(Array.isArray(c.body.image), `参考图应为数组：${JSON.stringify(c.body.image)}`)
      assert(c.body.image.length === 2, `参考图应按声明数量全部下发：${c.body.image.length}`)
      assert(c.body.image[0].startsWith('data:image/png;base64,'), `参考图应为 data URI：${String(c.body.image[0]).slice(0, 40)}`)

      // ③ Seedance 2.x 文生视频：异步任务制，分辨率/比例/时长走顶层结构化字段（1.x 的文本旗标形态另测）
      await adapter.submit('volcark/seedance-2.5', { prompt: 'p', width: 1280, height: 720, durationSeconds: 99 })
      c = calls.at(-1)
      assert(c.url === 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks', `视频端点不对：${c.url}`)
      assert(c.body.model === 'doubao-seedance-2-5-260628', `视频模型标识未透传：${c.body.model}`)
      assert(c.body.resolution === '720p' && c.body.ratio === '16:9', `顶层结构化参数不对：${JSON.stringify(c.body)}`)
      assert(c.body.watermark === false && c.body.content.length === 1 && c.body.content[0].type === 'text', 'content 应只有一条 text')
      // 官方 duration 区间 2.5 是 [4,30]：超上限的请求值夹回上限，别让整单被 400 掉
      assert(c.body.duration === 30, `2.5 duration 应 clamp 到 30：${c.body.duration}`)

      // ④ 分辨率按高度就近归档：1080+ → 1080p，600~999 → 720p，其余 480p
      await adapter.submit('volcark/seedance-2.0', { prompt: 'p', width: 1920, height: 1080 })
      c = calls.at(-1)
      assert(c.body.resolution === '1080p', `1080 高应归档 1080p：${c.body.resolution}`)

      // ⑤ Seedance 图生视频：官方 content 追加 {type:'image_url', image_url:{url}, role:'first_frame'}；
      //   2.5 的首帧模式 ratio 只能 adaptive。旧实现一张都不发（目录却声明了 maxRefImages:1），
      //   用户挂的垫图凭空消失
      await adapter.submit('volcark/seedance-2.5', { prompt: 'p', width: 1024, height: 1024, refs: [refImg(refPng, 'first_frame')] })
      c = calls.at(-1)
      const firstFrame = c.body.content[1]
      assert(c.body.content.length === 2 && firstFrame?.type === 'image_url' && firstFrame?.role === 'first_frame', `首帧参考未进 content：${JSON.stringify(c.body.content)}`)
      assert(firstFrame?.image_url?.url?.startsWith('data:image/png;base64,'), `首帧应为 data URI：${String(firstFrame?.image_url?.url).slice(0, 40)}`)
      assert(c.body.ratio === 'adaptive', `2.5 有首帧时 ratio 只能是 adaptive：${c.body.ratio}`)

      // ⑥ 1.x legacy：仍走 --flag 文本后缀约定，顶层不再带结构化参数（新契约不得改动这条分支）。
      //   内置目录里 1.x 只有 deprecated 条目（merge 后不进生效清单），故用用户自建模型跑同一条分支
      const legacyEffective = mergeCatalog([], {
        userProviders: [
          {
            id: 'ark-legacy',
            type: 'gateway-volcark',
            models: { 'doubao-seedance-1-0-lite-t2v-250428': { kind: 'video' } }
          }
        ]
      })
      const legacyAdapter = adapters.createAdapters(legacyEffective, { mediaDir: () => null, resolveKey: async () => 'ark-dry' })[0]
      await legacyAdapter.submit('doubao-seedance-1-0-lite-t2v-250428', { prompt: 'p', width: 1280, height: 720, durationSeconds: 10 })
      c = calls.at(-1)
      assert(c.body.model === 'doubao-seedance-1-0-lite-t2v-250428', `legacy 模型标识未透传：${c.body.model}`)
      assert(c.body.resolution === undefined && c.body.ratio === undefined && c.body.duration === undefined, `legacy 不应下发顶层参数：${JSON.stringify(c.body)}`)
      const legacyText = c.body.content[0].text
      assert(/--duration 10/.test(legacyText) && /--resolution 720p/.test(legacyText) && /--ratio 16:9/.test(legacyText) && /--watermark false/.test(legacyText), `legacy 文本旗标不对：${legacyText}`)

      // ⑦ poll：带前缀的 jobId 走查询端点取 content.video_url；不带前缀的是同步图片结果 URL，原样回传
      const polled = await adapter.poll('volcark/seedance-2.5', 'ark-video|task-ark-1')
      assert(polled.status === 'succeeded' && polled.resultUrl === 'https://cdn/ark/v.mp4', `视频 poll 不对：${JSON.stringify(polled)}`)
      const syncPoll = await adapter.poll('volcark/seedream-5.0-pro', 'https://cdn/ark/x.png')
      assert(syncPoll.status === 'succeeded' && syncPoll.resultUrl === 'https://cdn/ark/x.png', '同步图片 poll 应原样回传 jobId')

      // ⑧ cancel：DELETE 同路径 /{id}；同步图片 jobId 无远端可取消
      const beforeCancel = calls.length
      await adapter.cancel('ark-video|task-ark-1')
      assert(calls.length === beforeCancel, 'cancel 不应被记为提交调用')
      await adapter.cancel('https://cdn/ark/x.png')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  /* ---------------- 2a. 带角色参考素材：能力派生、互斥判定、投递形态 ---------------- */

  const shared = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'shared', 'media.js')).href)

  check('能力归一：只有老 maxRefImages 时按语义派生角色配额（零迁移的关键路径）', () => {
    const img = shared.normalizeMediaCaps({ maxRefImages: 3 }, 'image')
    assert(img.quota.reference_image === 3 && img.modes.join() === 't2i,i2i', `图片老声明派生不对：${JSON.stringify(img)}`)
    assert(img.legacy === true && img.total === 3, '图片老声明应标记 legacy 且总闸＝配额')

    // 视频的老字段语义是"垫图/首帧数量"，绝不能因为填了 3 就替用户打开 30 张全模态参考
    const vid = shared.normalizeMediaCaps({ maxRefImages: 3 }, 'video')
    assert(vid.quota.first_frame === 1 && vid.quota.reference_image === undefined, `视频老声明不外推成多参考：${JSON.stringify(vid.quota)}`)
    assert(vid.modes.join() === 't2v,i2v_first', `视频老声明的模式不对：${vid.modes.join()}`)

    const none = shared.normalizeMediaCaps(undefined, 'image')
    assert(none.quota.reference_image === 4, `什么都没声明时应兜底 4 张（历史行为）：${JSON.stringify(none.quota)}`)

    // 新字段优先，老字段被忽略（不双计）
    const fresh = shared.normalizeMediaCaps({ maxRefImages: 1, refQuota: [{ role: 'reference_image', max: 9 }] }, 'image')
    assert(fresh.quota.reference_image === 9 && fresh.legacy === false, `新声明应压过老字段：${JSON.stringify(fresh.quota)}`)
  })

  check('参考素材判定：互斥模式、角色配额、素材类型与角色匹配', () => {
    const caps = shared.normalizeMediaCaps(
      {
        refModes: ['t2v', 'i2v_first', 'i2v_fl', 'r2v'],
        refQuota: [
          { role: 'first_frame', max: 1 },
          { role: 'last_frame', max: 1 },
          { role: 'reference_image', max: 2 },
          { role: 'reference_video', max: 1 }
        ]
      },
      'video'
    )
    // 首帧与 reference_* 互斥（官方三家逐字相同的规则）必须在这里被拦下
    const mixed = shared.checkMediaRefs([{ role: 'first_frame' }, { role: 'reference_image' }], caps)
    assert(mixed.issues.some((i) => i.code === 'mode_unreachable'), `混用应报模式不可达：${JSON.stringify(mixed.issues)}`)
    assert(mixed.issues.every((i) => i.message.includes('不能混用') || i.message.includes('用法')), '互斥文案要给出支持的模式')

    // 首尾帧是合法组合
    const fl = shared.checkMediaRefs([{ role: 'first_frame' }, { role: 'last_frame' }], caps)
    assert(fl.issues.length === 0 && fl.accepted.length === 2, `首尾帧应放行：${JSON.stringify(fl.issues)}`)

    // 全模态参考允许子集：只挂一条参考视频是合法用法（官方语义）
    const onlyVideoRef = shared.checkMediaRefs([{ role: 'reference_video', mediaType: 'video' }], caps)
    assert(onlyVideoRef.issues.length === 0, `只挂参考视频应放行：${JSON.stringify(onlyVideoRef.issues)}`)
    assert(shared.inferMediaMode(['reference_video'], 'video', caps.modes) === 'r2v', '参考视频组合应判为全模态参考')

    // 尾帧没有独立语义：必须与首帧同批
    const lonelyLast = shared.checkMediaRefs([{ role: 'last_frame' }], caps)
    assert(lonelyLast.issues.some((i) => i.code === 'mode_unreachable'), `尾帧单独提交应被拦下：${JSON.stringify(lonelyLast.issues)}`)
    assert(lonelyLast.issues[0].message.includes('尾帧需要与首帧'), `尾帧文案要说清依赖：${lonelyLast.issues[0]?.message}`)

    // 超配额＝截断 + 留痕，不是硬失败（今天挂 5 张到只吃 1 张的模型能出图）
    const over = shared.checkMediaRefs([{ role: 'first_frame' }, { role: 'first_frame' }], caps)
    assert(over.issues.length === 0 && over.truncated.length === 1, `超配额应截断而非报错：${JSON.stringify(over)}`)
    assert(over.notes.length === 1 && over.notes[0].includes('首帧'), `截断要留痕：${JSON.stringify(over.notes)}`)

    // 类型与角色不符（把 png 当参考视频）＝硬错误
    const wrong = shared.checkMediaRefs([{ role: 'reference_video', mediaType: 'image' }], caps)
    assert(wrong.issues.some((i) => i.code === 'kind_mismatch'), `类型不符应报 kind_mismatch：${JSON.stringify(wrong.issues)}`)

    // 未声明的角色＝该模型不接受（图片模型收到首帧）
    const imgCaps = shared.normalizeMediaCaps({ maxRefImages: 3 }, 'image')
    const unsupported = shared.checkMediaRefs([{ role: 'first_frame' }], imgCaps)
    assert(unsupported.issues.some((i) => i.code === 'role_unsupported'), '未声明的角色应被拒')
    assert(unsupported.issues[0].message.includes('参考图'), '拒绝文案要列出该模型支持的角色')
  })

  check('扩展名识别：唯一一张表，且 .mp4/.wav 不再被当成图片', () => {
    assert(shared.mediaKindOfPath('a/b/x.PNG')?.kind === 'image', '扩展名应大小写不敏感')
    assert(shared.mediaKindOfPath('clip.mp4')?.kind === 'video', 'mp4 应识别为视频')
    assert(shared.mediaKindOfPath('voice.WAV')?.kind === 'audio', 'wav 应识别为音频')
    assert(shared.mediaKindOfPath('https://cdn/x.mp4?sig=123')?.kind === 'video', 'URL 查询串不应干扰扩展名判定')
    assert(shared.mediaKindOfPath('notes') === undefined, '无扩展名应返回 undefined（调用方决定报错）')
    assert(shared.extOfPath('.gitignore') === '', '点开头文件名不该被当成有扩展名')
  })

  check('合并层回归：refQuota/refModes/refTotal 清洗（非法丢弃、重复取小、超限 clamp）', () => {
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const caps = mergeCatalog([], {
        userProviders: [
          {
            id: 'u',
            type: 'gateway-dashscope',
            models: {
              m: {
                kind: 'video',
                capabilities: {
                  refModes: ['r2v', 'bogus', 'r2v'],
                  refQuota: [
                    { role: 'reference_image', max: 10 },
                    { role: 'reference_image', max: 4 },
                    { role: 'reference_video', max: 5 },
                    { role: 'nope', max: 3 },
                    { role: 'reference_audio', max: 999 },
                    { role: 'last_frame', max: 0 }
                  ],
                  refTotal: 20
                }
              }
            }
          }
        ]
      })[0].models[0].capabilities
      assert(caps.refModes.join() === 'r2v', `非法模式应丢弃、合法去重保序：${JSON.stringify(caps.refModes)}`)
      const byRole = Object.fromEntries(caps.refQuota.map((q) => [q.role, q.max]))
      assert(byRole.reference_image === 4, `同角色重复声明应取小值：${byRole.reference_image}`)
      assert(byRole.reference_audio === 64, `超大配额应 clamp 到 64：${byRole.reference_audio}`)
      assert(byRole.last_frame === undefined, 'max=0 等同未声明，不该画出 0 配额')
      assert(byRole.nope === undefined, '非法角色应被丢弃')
      assert(caps.refTotal === 20, `refTotal 应透传：${caps.refTotal}`)
      assert(warnings.some((w) => w.includes('nope')), '非法角色应有 warn')
    } finally {
      console.warn = originalWarn
    }
  })

  check('适配器投递形态：五家自述齐备、未注册类型走保守兜底', () => {
    const ark = adapters.adapterRefCaps('gateway-volcark')
    assert(ark.byKind.video.delivery === 'url_only', `方舟参考视频只收 URL：${JSON.stringify(ark.byKind.video)}`)
    assert(ark.byKind.image.delivery === 'data_uri' && ark.byKind.image.maxBytes === 30 * 1024 * 1024, `方舟图片 data URI 30MB：${JSON.stringify(ark.byKind.image)}`)
    assert(ark.maxBodyBytes === 64 * 1024 * 1024, '方舟单次请求体 64MB 总闸')
    const dash = adapters.adapterRefCaps('gateway-dashscope')
    assert(dash.byKind.video.delivery === 'upload' && dash.byKind.video.uploadChannel === 'dashscope-instant', `百炼参考视频走上传通道：${JSON.stringify(dash.byKind.video)}`)
    assert(dash.byKind.image.delivery === 'data_uri', '百炼图像素材仍可 data URI 内联')
    const mm = adapters.adapterRefCaps('gateway-minimax')
    // 这是五家里唯一"本地参考视频零上传成本"的一家，形态判据必须钉住
    assert(mm.byKind.video.delivery === 'data_uri', `MiniMax 参考视频应可直接 base64：${JSON.stringify(mm.byKind.video)}`)
    const tc = adapters.adapterRefCaps('gateway-tencent')
    assert(tc.byKind.video?.delivery === 'none' && tc.byKind.audio?.delivery === 'none', '混元没有视频/音频参考输入')
    const unknown = adapters.adapterRefCaps('gateway-not-exist')
    assert(unknown.byKind.image?.delivery === 'data_uri' && unknown.byKind.video === undefined, '未声明的类型应保守兜底')
    assert(Object.keys(adapters.getAdapterRefMatrix()).length === adapters.getAdapterTypes().length, '形态矩阵应覆盖全部已注册类型')
  })

  await checkAsync('编排层参考素材闸门 resolveMediaRefs（角色、类型、投递形态、URL 直传）', async () => {
    const { resolveMediaRefs } = await import(
      pathToFileURL(path.join(OUT_DIR, 'src', 'main', 'media', 'mediaRefs.js')).href
    )
    const dashCaps = {
      refModes: ['t2v', 'i2v_first', 'i2v_fl', 'r2v'],
      refQuota: [
        { role: 'first_frame', max: 1 },
        { role: 'last_frame', max: 1 },
        { role: 'reference_image', max: 10 },
        { role: 'reference_video', max: 5 },
        { role: 'reference_audio', max: 5 }
      ],
      refTotal: 20
    }
    const roots = { mediaRoot: OUT_DIR, wsRoot: PROJECT_ROOT }
    const png = path.join(OUT_DIR, 'ref-fixture.png')
    const mp4 = path.join(OUT_DIR, 'ref-fixture.mp4')
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(png, Buffer.from('89504e47', 'hex'))
    fs.writeFileSync(mp4, Buffer.from('0000001866747970', 'hex'))

    const run = (refs, caps, adapterType, kind = 'video') =>
      resolveMediaRefs({ refs }, kind, caps, adapters.adapterRefCaps(adapterType), roots, 'test/model')

    // ① 本地首帧图（百炼图像素材可 data URI）：解析出绝对路径与字节数
    const first = await run([{ role: 'first_frame', path: 'ref-fixture.png' }], dashCaps, 'gateway-dashscope')
    assert(first.refs.length === 1 && first.refs[0].role === 'first_frame', `首帧未通过闸门：${JSON.stringify(first)}`)
    assert(first.refs[0].absPath === png && first.refs[0].bytes > 0, `本地素材应带路径与字节：${JSON.stringify(first.refs[0])}`)
    assert(first.refs[0].mediaType === 'image' && first.refs[0].mime === 'image/png', `大类/MIME 不对：${JSON.stringify(first.refs[0])}`)

    // ② 本地参考视频在百炼（只收 URL/oss://）且没有上传上下文：必须明确报错，绝不静默丢
    await assertRejects(
      () => run([{ role: 'reference_video', path: 'ref-fixture.mp4' }], dashCaps, 'gateway-dashscope'),
      /上传通道/,
      '百炼本地参考视频应报「需上传」'
    )

    // ③ 同一素材在 MiniMax（三类素材都支持 data URI）：应当放行
    const mmCaps = { ...dashCaps, refQuota: [...dashCaps.refQuota] }
    const mm = await run([{ role: 'reference_video', path: 'ref-fixture.mp4' }], mmCaps, 'gateway-minimax')
    assert(mm.refs.length === 1 && mm.refs[0].mediaType === 'video', `MiniMax 本地参考视频应可直传：${JSON.stringify(mm.refs)}`)

    // ④ 同一素材在方舟（video_url 只收公网 URL）：报「只接受公网 URL」
    await assertRejects(
      () => run([{ role: 'reference_video', path: 'ref-fixture.mp4' }], mmCaps, 'gateway-volcark'),
      /只接受公网 URL/,
      '方舟本地参考视频应报 URL-only'
    )

    // ⑤ URL 型素材：原样透传、不读盘（文件根本不存在也该通过）
    const remote = await run([{ role: 'reference_image', url: 'https://cdn.example.com/none.png' }], dashCaps, 'gateway-dashscope')
    assert(remote.refs.length === 1 && remote.refs[0].url === 'https://cdn.example.com/none.png', `URL 素材应透传：${JSON.stringify(remote.refs)}`)
    assert(remote.refs[0].absPath === undefined, 'URL 素材不该被解析成本地路径')

    // ⑥ 素材大类与角色不符（把 png 当参考视频）：硬错误
    await assertRejects(
      () => run([{ role: 'reference_video', path: 'ref-fixture.png' }], dashCaps, 'gateway-minimax'),
      /只能收视频/,
      '类型不符应报 kind_mismatch'
    )

    // ⑦ 混用首帧与 reference_*（官方互斥）：硬错误，且文案列出支持的模式
    await assertRejects(
      () =>
        run(
          [{ role: 'first_frame', path: 'ref-fixture.png' }, { role: 'reference_image', path: 'ref-fixture.png' }],
          dashCaps,
          'gateway-dashscope'
        ),
      /用法|不能混用/,
      '互斥组合应被拦下'
    )

    // ⑧ 数量超限＝截断 + 留痕（不是错误）
    const many = await run(
      [
        { role: 'first_frame', path: 'ref-fixture.png' },
        { role: 'first_frame', path: 'ref-fixture.png' }
      ],
      dashCaps,
      'gateway-dashscope'
    )
    assert(many.refs.length === 1 && many.notes.some((n) => n.includes('首帧')), `超配额应截断并留痕：${JSON.stringify(many)}`)

    // ⑨ 老入口 refPaths（不带角色）：视频通道按首帧归一，行为与历史一致
    const legacy = await resolveMediaRefs({ refPaths: ['ref-fixture.png'] }, 'video', { maxRefImages: 1 }, adapters.adapterRefCaps('gateway-dashscope'), roots, 'test/model')
    assert(legacy.refs.length === 1 && legacy.refs[0].role === 'first_frame', `老入口应归一成首帧：${JSON.stringify(legacy.refs)}`)
  })

  await checkAsync('上传通道：百炼两步换 oss:// 引用、缓存命中、凭据与体积报错', async () => {
    const upload = await import(
      pathToFileURL(path.join(OUT_DIR, 'src', 'main', 'media', 'upload', 'index.js')).href
    )
    const { resolveMediaRefs } = await import(
      pathToFileURL(path.join(OUT_DIR, 'src', 'main', 'media', 'mediaRefs.js')).href
    )
    const mp4 = path.join(OUT_DIR, 'up-fixture.mp4')
    const indexFile = path.join(OUT_DIR, 'upload-index.json')
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(mp4, Buffer.from('0000001866747970', 'hex'))
    fs.rmSync(indexFile, { force: true })
    const dashCaps = {
      refModes: ['t2v', 'i2v_first', 'i2v_fl', 'r2v'],
      refQuota: [
        { role: 'first_frame', max: 1 },
        { role: 'reference_video', max: 5 }
      ]
    }
    const roots = { mediaRoot: OUT_DIR, wsRoot: PROJECT_ROOT }
    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      calls.push({ url: u, init })
      if (u.includes('/api/v1/uploads')) {
        return new Response(
          JSON.stringify({
            data: {
              policy: 'pol',
              signature: 'sig',
              upload_dir: 'dashscope-instant/abc',
              upload_host: 'https://oss.example.com',
              oss_access_key_id: 'ak',
              expire: Math.floor(Date.now() / 1000) + 48 * 3600
            }
          }),
          { status: 200 }
        )
      }
      return new Response('', { status: 200 })
    }
    try {
      const run = (uploadCtx) =>
        resolveMediaRefs({ refs: [{ role: 'reference_video', path: 'up-fixture.mp4' }] }, 'video', dashCaps,
          adapters.adapterRefCaps('gateway-dashscope'), roots, 'test/model', uploadCtx)

      // ① 没有上传上下文：报"需要上传通道"，绝不静默把视频当图片发出去
      await assertRejects(() => run(undefined), /上传通道/, '无上传上下文应明确报错')
      // ② 有上下文但没凭据：文案必须指向设置页录入 Key
      await assertRejects(
        () => run({ indexFile, model: 'wan3.0-video', resolveKey: async () => null }),
        /凭据/,
        '缺凭据应说清去哪里录入'
      )
      // ③ 正常路径：getPolicy → 表单直传 → oss:// 引用进 refs
      const ctx = { indexFile, model: 'wan3.0-video', resolveKey: async () => 'sk-test' }
      const first = await run(ctx)
      assert(first.refs.length === 1 && first.refs[0].url?.startsWith('oss://dashscope-instant/abc/'), `引用形态不对：${JSON.stringify(first.refs)}`)
      const policyCall = calls.find((c) => c.url.includes('/api/v1/uploads'))
      assert(/action=getPolicy&model=wan3\.0-video/.test(policyCall.url), `getPolicy 应带模型：${policyCall.url}`)
      assert(policyCall.init.headers.Authorization === 'Bearer sk-test', 'getPolicy 要带凭据头')
      const form = calls.find((c) => c.url.includes('oss.example.com')).init.body
      assert(form instanceof FormData, '直传应是 multipart 表单')
      assert(form.get('key')?.startsWith('dashscope-instant/abc/'), `对象 key 应由 upload_dir 拼出：${form.get('key')}`)
      assert(form.get('policy') === 'pol' && form.get('Signature') === 'sig' && form.get('OSSAccessKeyId') === 'ak', `表单凭证字段不全：${[...form.keys()].join(',')}`)
      assert(form.get('x-oss-forbid-overwrite') === 'true', '禁覆盖字段缺失会让同名重传撞车')
      assert(!String(form.get('key')).includes('up-fixture'), `远端文件名不该带本地命名：${form.get('key')}`)
      // ④ 同一素材第二次：命中索引，一次网络都不发
      calls.length = 0
      const second = await run(ctx)
      assert(second.refs[0].url === first.refs[0].url, `缓存应回同一引用：${second.refs[0].url}`)
      assert(calls.length === 0, `命中缓存不该发请求：${calls.map((c) => c.url).join(',')}`)
      const saved = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      assert(Object.keys(saved.entries).length === 1, `索引应只有一条：${JSON.stringify(saved).slice(0, 200)}`)
      const entry = Object.values(saved.entries)[0]
      assert(entry.expiresAt <= Date.now() + 48 * 3600 * 1000, '有效期不该超过官方承诺')
      assert(entry.expiresAt >= Date.now() + 40 * 3600 * 1000, `应留 90% 安全边际而不是贴着到期：${entry.expiresAt - Date.now()}`)
      // ⑤ 声明了但没实现的通道：明确报错，不回落 base64
      await assertRejects(
        () => upload.uploadRef({ channelId: 'not-a-channel', absPath: mp4, mime: 'video/mp4', mediaType: 'video', model: 'm', key: 'k', indexFile: null }),
        /尚未实现/,
        '未知通道应报未实现'
      )
      // ⑥ 五家 refCaps 声明的上传通道都必须有实现
      for (const type of adapters.getAdapterTypes()) {
        for (const [kindName, delivery] of Object.entries(adapters.adapterRefCaps(type).byKind)) {
          if (!delivery.uploadChannel) continue
          assert(upload.channelFor(delivery.uploadChannel), `${type} 的 ${kindName} 声明了 ${delivery.uploadChannel}，但没有实现`)
        }
      }
    } finally {
      globalThis.fetch = originalFetch
      fs.rmSync(indexFile, { force: true })
      fs.rmSync(mp4, { force: true })
    }
  })

  await checkAsync('MiniMax 上传通道：200 响应体里的 base_resp 失败必须当成失败', async () => {
    const upload = await import(
      pathToFileURL(path.join(OUT_DIR, 'src', 'main', 'media', 'upload', 'index.js')).href
    )
    const mp4 = path.join(OUT_DIR, 'mm-fixture.mp4')
    fs.writeFileSync(mp4, Buffer.from('0000001866747970', 'hex'))
    const calls = []
    const originalFetch = globalThis.fetch
    let mode = 'error'
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      if (mode === 'error') {
        return new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid account' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: { file_id: '9527' }, base_resp: { status_code: 0, status_msg: 'SUCCEEDED' } }), { status: 200 })
    }
    try {
      const req = { channelId: 'minimax-files', absPath: mp4, mime: 'video/mp4', mediaType: 'video', model: 'MiniMax-H3', key: 'mk', indexFile: null }
      // MiniMax 的业务失败藏在 HTTP 200 的响应体里：不看 base_resp 就等于把失败读成成功
      await assertRejects(() => upload.uploadRef(req), /status_code=1004/, 'base_resp 非 0 必须抛错')
      mode = 'ok'
      const ticket = await upload.uploadRef(req)
      assert(ticket.ref === 'mm_file://9527', `引用形态不对：${ticket.ref}`)
      assert(calls[0].url.endsWith('/v1/files/upload'), `上传端点不对：${calls[0].url}`)
      assert(calls[0].init.headers.Authorization === 'Bearer mk', '上传要带 Bearer 凭据')
      assert(calls[0].init.body instanceof FormData && calls[0].init.body.get('purpose') === 'file', '表单字段形态不对')
    } finally {
      globalThis.fetch = originalFetch
      fs.rmSync(mp4, { force: true })
    }
  })

  check('附加参数白名单：未声明的键报得清楚，类型按声明收（boolean 认 "true" 串）', () => {
    const declared = [
      { key: 'watermark', label: '水印', type: 'boolean' },
      { key: 'output_format', label: '产物格式', type: 'select', options: ['png', 'jpeg', 'webp'] },
      { key: 'seed', label: '随机种子', type: 'number' }
    ]
    const ok = shared.sanitizeMediaExtra(declared, { watermark: 'true', output_format: 'jpeg', seed: 7 })
    assert(ok.issues.length === 0, `合法附加参数不该报错：${JSON.stringify(ok.issues)}`)
    assert(ok.value.watermark === true && ok.value.output_format === 'jpeg' && ok.value.seed === 7, `取值不对：${JSON.stringify(ok.value)}`)
    const bad = shared.sanitizeMediaExtra(declared, { watermark: 'yes', output_format: 'tiff', nope: 1, seed: 'abc' })
    assert(bad.issues.length === 4, `四条越界都该报出来：${JSON.stringify(bad.issues)}`)
    assert(Object.keys(bad.value).length === 0, `越界键一个都不该留下：${JSON.stringify(bad.value)}`)
    // 模型没声明 extraParams 时，任何附加参数都是越界（不许猜一个意思发出去）
    const none = shared.sanitizeMediaExtra(undefined, { watermark: true })
    assert(none.issues.length === 1 && /可传：无/.test(none.issues[0]), `空声明应拒绝一切：${JSON.stringify(none.issues)}`)
  })

  await checkAsync('附加参数落进请求体：声明过的键按家装配，没挑走的键绝不进 body', async () => {
    const effective = mergeCatalog(BUILTIN_PROVIDERS, {})
    const byType = (type) => {
      const conf = effective.find((p) => p.type === type)
      return adapters.createAdapters([conf], { mediaDir: () => null, resolveKey: async () => 'sk-dry' })[0]
    }
    const capture = async (run) => {
      const calls = []
      const original = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : undefined })
        return new Response(JSON.stringify({ output: { task_id: 't', video_url: 'https://x/y.mp4' }, data: [{ url: 'https://x/z.png' }], id: 'v1', status: 'completed' }), { status: 200 })
      }
      try {
        await run(calls)
      } finally {
        globalThis.fetch = original
      }
      return calls.at(-1)
    }

    const dash = await capture(async (calls) => {
      await byType('gateway-dashscope').submit('dashscope/wan3.0-video', {
        prompt: 'p',
        durationSeconds: 5,
        extra: { watermark: false, prompt_extend: true, not_a_real_key: 'x' }
      })
    })
    assert(dash.body.parameters.watermark === false, `watermark 没进 parameters：${JSON.stringify(dash.body.parameters)}`)
    assert(dash.body.parameters.prompt_extend === true, `prompt_extend 没进 parameters：${JSON.stringify(dash.body.parameters)}`)
    assert(!('not_a_real_key' in dash.body.parameters) && !('not_a_real_key' in dash.body), '未被适配器挑走的键不该出现在请求体里')

    const ark = await capture(async (calls) => {
      await byType('gateway-volcark').submit('volcark/seedance-2.5', {
        prompt: 'p',
        width: 1280,
        height: 720,
        durationSeconds: 5,
        extra: { generate_audio: false }
      })
    })
    assert(ark.body.generate_audio === false, `generate_audio 没进 body：${JSON.stringify(ark.body)}`)
    const arkQuiet = await capture(async (calls) => {
      await byType('gateway-volcark').submit('volcark/seedance-2.5', { prompt: 'p', width: 1280, height: 720 })
    })
    assert(arkQuiet.body.generate_audio === undefined, '没传 generate_audio 时不该造一个字段（让网关按自家默认走）')
    assert(arkQuiet.body.watermark === false, '方舟水印默认值仍是关（产物干净）')
  })

  /* ---------------- 2b. 全量浏览目录（设置页「浏览完整模型库」数据源） ---------------- */

  const { browseCatalog } = catalog
  check('浏览目录：无目录供应商返回空数组', () => {
    assert(browseCatalog('nope').length === 0 && browseCatalog('nonexistent').length === 0, '不存在供应商应返回空数组')
  })

  check('合并层回归：用户模型的 capabilities/costHint 清洗与透传', () => {
    const effective = mergeCatalog([], {
      userProviders: [
        {
          id: 'caps',
          // 时长档位是视频语义；openai-compat 三类端点都有，dashscope 同样支持视频
          type: 'gateway-dashscope',
          models: {
            'veo-4-text-to-video': {
              kind: 'video',
              capabilities: { ratios: ['16:9', '2:3'], durations: [8, 4, 4, 0, -1], maxRefImages: 1 },
              costHint: '约 $0.4/秒'
            }
          }
        }
      ]
    })
    const model = effective[0].models[0]
    assert(model.capabilities, 'capabilities 未透传')
    assert(JSON.stringify(model.capabilities.ratios) === '["16:9"]', `非法比例应被过滤：${JSON.stringify(model.capabilities.ratios)}`)
    assert(JSON.stringify(model.capabilities.durations) === '[4,8]', `durations 应去重升序且丢非正数：${JSON.stringify(model.capabilities.durations)}`)
    assert(model.capabilities.maxRefImages === 1, 'maxRefImages 未透传')
    assert(model.costHint === '约 $0.4/秒', 'costHint 未透传')
  })

  check('合并层回归：模型 kind 超出适配器端点族时逐条丢弃（kind 支持矩阵）', () => {
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const effective = mergeCatalog([], {
        userProviders: [
          // openai-compat 三类端点都有（images/videos/speech）：video 供应商应保留
          { id: 'oai-video-only', type: 'gateway-openai-compat', models: { vid: { kind: 'video' } } },
          // 合法混合：image/audio/video 全保留
          {
            id: 'oai-mixed',
            type: 'gateway-openai-compat',
            models: { img: { kind: 'image' }, tts: { kind: 'audio' }, vid: { kind: 'video' } }
          },
          // volcark 只有 image/video 端点：audio 越界，纯越界供应商整条丢弃
          { id: 'volc-audio-only', type: 'gateway-volcark', models: { tts: { kind: 'audio' } } },
          // 未声明 supportedKinds 的类型（缺省 = 全部）不受限——这里用 dashscope 的合法组合验证不受影响
          { id: 'dash-ok', type: 'gateway-dashscope', models: { v: { kind: 'video' } } }
        ]
      })
      const ids = effective.map((e) => e.id)
      assert(ids.includes('oai-video-only'), `openai-compat 已支持 video，纯 video 供应商应保留：${JSON.stringify(ids)}`)
      assert(!ids.includes('volc-audio-only'), `volcark 下 audio 供应商应被丢弃：${JSON.stringify(ids)}`)
      const mixed = effective.find((e) => e.id === 'oai-mixed')
      assert(mixed && mixed.models.length === 3, `openai-compat 三类端点应全保留，实际 ${mixed?.models.length}`)
      assert(
        warnings.some((w) => w.includes('tts') && w.includes('端点族')),
        `越界 kind 应给出可定位警告（含模型 id 与端点族提示）：${JSON.stringify(warnings)}`
      )
    } finally {
      console.warn = originalWarn
    }
  })

  check('合并层回归：用户模型带前缀 id 剥前缀派生 requestModel（与内置同规则）', () => {
    const builtin = [
      {
        id: 'acme',
        label: 'ACME',
        adapter: 'gateway-dashscope',
        auth: { env: 'ACME_KEY', label: 'K', helpUrl: 'https://example.com/keys' },
        models: [{ id: 'acme/keep', kind: 'image', label: 'Keep' }]
      }
    ]
    // 隐藏内置模型后由用户条目带全 id 重新加回（覆盖/恢复的典型形态）
    const effective = mergeCatalog(builtin, {
      hiddenBuiltin: ['acme/keep'],
      userProviders: [
        {
          id: 'acme',
          type: 'gateway-dashscope',
          models: { 'acme/keep': { kind: 'image' }, bare: { kind: 'video' } }
        }
      ]
    })
    const models = effective[0].models
    const prefixed = models.find((m) => m.id === 'acme/keep')
    assert(prefixed && prefixed.requestModel === 'keep', `带前缀 id 应剥前缀发给网关，实际 ${prefixed?.requestModel}`)
    const bare = models.find((m) => m.id === 'bare')
    assert(bare && bare.requestModel === 'bare', `裸 slug 应原样透传，实际 ${bare?.requestModel}`)
  })

  check('合并层回归：用户供应商 authStyle 清洗与透传（openai-compat 消费）', () => {
    const effective = mergeCatalog([], {
      userProviders: [
        { id: 'xkey', type: 'gateway-openai-compat', authStyle: 'x-api-key', models: { m: { kind: 'image' } } },
        { id: 'default-bearer', type: 'gateway-openai-compat', models: { m: { kind: 'image' } } },
        { id: 'bogus-style', type: 'gateway-openai-compat', authStyle: 'basic', models: { m: { kind: 'image' } } }
      ]
    })
    assert(effective.find((e) => e.id === 'xkey')?.authStyle === 'x-api-key', '合法 authStyle 应透传')
    assert(effective.find((e) => e.id === 'default-bearer')?.authStyle === undefined, '未声明 = 缺省 bearer（不写字段）')
    assert(effective.find((e) => e.id === 'bogus-style')?.authStyle === undefined, '枚举外的 authStyle 应被忽略')
  })

  await checkAsync('openaiCompat 认证头风格与图生图 edits 端点（fetch 挡板断言）', async () => {
    const effective = mergeCatalog([], {
      userProviders: [
        { id: 'oc', type: 'gateway-openai-compat', baseUrl: 'https://gw.example/v1', models: { 'img-1': { kind: 'image' } } },
        { id: 'oc-xkey', type: 'gateway-openai-compat', authStyle: 'x-api-key', models: { 'img-1': { kind: 'image' } } }
      ]
    })
    const created = adapters.createAdapters(effective, { mediaDir: () => OUT_DIR, resolveKey: async () => 'k-1' })
    assert(created.length === 2, '应实例化 2 个 openai-compat 适配器')

    const captured = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init })
      if (String(url).endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/gen.png' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('89504e47', 'hex').toString('base64') }] }), { status: 200 })
    }
    const refPng = path.join(OUT_DIR, 'ref-fixture.png')
    fs.mkdirSync(path.dirname(refPng), { recursive: true })
    fs.writeFileSync(refPng, Buffer.from('89504e47', 'hex'))

    try {
      // ① 文生图（缺省 bearer）：打 generations 端点、Authorization: Bearer
      await created[0].submit('img-1', { prompt: 'p' })
      let c = captured.at(-1)
      assert(c.url === 'https://gw.example/v1/images/generations', `文生图端点不对：${c.url}`)
      assert(c.init.headers.Authorization === 'Bearer k-1', `缺省应走 Bearer 头：${JSON.stringify(c.init.headers)}`)

      // ② x-api-key 风格：只发 x-api-key 头，不带 Authorization
      await created[1].submit('img-1', { prompt: 'p' })
      c = captured.at(-1)
      assert(c.init.headers['x-api-key'] === 'k-1', `x-api-key 头未生效：${JSON.stringify(c.init.headers)}`)
      assert(c.init.headers.Authorization === undefined, 'x-api-key 风格不应再带 Authorization')

      // ③ 图生图：带参考图自动切 edits 端点，multipart 含 model/prompt/size/image
      const jobId = await created[0].submit('img-1', { prompt: 'p', refs: [refImg(refPng)] })
      c = captured.at(-1)
      assert(c.url === 'https://gw.example/v1/images/edits', `有参考图应走 edits 端点：${c.url}`)
      assert(c.init.body instanceof FormData, 'edits 请求体应为 FormData（multipart）')
      assert(c.init.body.get('model') === 'img-1' && c.init.body.get('prompt') === 'p', 'edits 表单缺 model/prompt')
      assert(c.init.body.get('size') === '1024x1024', 'edits 表单缺 size')
      assert(c.init.body.getAll('image').length === 1, 'edits 表单应含 1 个 image 文件字段')
      // ④ b64 结果落临时文件：jobId 带 oc-file| 前缀，文件真实存在
      assert(jobId.startsWith('oc-file|') && fs.existsSync(jobId.slice('oc-file|'.length)), `b64 产物应落临时文件：${jobId.slice(0, 60)}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await checkAsync('openaiCompat 视频协议形态（2026-10 openai-openapi videos.md 核实的 body/轮询断言）', async () => {
    const effective = mergeCatalog([], {
      userProviders: [
        { id: 'ocv', type: 'gateway-openai-compat', baseUrl: 'https://gw.example/v1', models: { 'sora-2': { kind: 'video' } } }
      ]
    })
    const created = adapters.createAdapters(effective, { mediaDir: () => OUT_DIR, resolveKey: async () => 'k-1' })
    assert(created.length === 1 && created[0].models[0].kind === 'video', 'openai-compat 应接受 video 模型')

    const calls = []
    /** 可变任务态：查询端点按它回包，content 端点固定回二进制 */
    let video = { id: 'vid-1', status: 'queued', progress: 0, seconds: 4 }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      const urlText = String(url)
      const method = init?.method ?? 'GET'
      if (urlText.endsWith('/videos') && method === 'POST') {
        calls.push({ url: urlText, init })
        return new Response(JSON.stringify({ id: 'vid-1', status: 'queued' }), { status: 200 })
      }
      if (urlText.endsWith('/videos/vid-1/content')) {
        calls.push({ url: urlText, init })
        return new Response(Buffer.from('89504e47', 'hex'), { status: 200, headers: { 'content-type': 'video/mp4' } })
      }
      calls.push({ url: urlText, init })
      return new Response(JSON.stringify(video), { status: 200 })
    }
    const refPng = path.join(OUT_DIR, 'ref-fixture.png')
    fs.mkdirSync(path.dirname(refPng), { recursive: true })
    fs.writeFileSync(refPng, Buffer.from('89504e47', 'hex'))

    try {
      // ① 文生视频：JSON body（model/prompt/size/seconds）、Bearer 头、jobId 编码 oc-video|
      const jobId = await created[0].submit('sora-2', { prompt: 'p', width: 1280, height: 720, durationSeconds: 5 })
      let c = calls.at(-1)
      assert(c.url === 'https://gw.example/v1/videos', `视频提交端点不对：${c.url}`)
      assert(c.init.headers.Authorization === 'Bearer k-1', '视频提交应带认证头')
      const body = JSON.parse(c.init.body)
      assert(body.model === 'sora-2' && body.prompt === 'p', 'JSON body 缺 model/prompt')
      assert(body.size === '1280x720', `size 应为 WxH 形态：${body.size}`)
      assert(body.seconds === 4, `seconds=5 应就近归档到官方枚举 4：${body.seconds}`)
      assert(jobId === 'oc-video|vid-1', `jobId 编码不对：${jobId}`)

      // ② 轮询 in_progress：running 态 + 百分比进度
      video = { id: 'vid-1', status: 'in_progress', progress: 42 }
      let polled = await created[0].poll('sora-2', jobId)
      c = calls.at(-1)
      assert(c.url === 'https://gw.example/v1/videos/vid-1' && c.init.headers.Authorization === 'Bearer k-1', `轮询请求不对：${c.url}`)
      assert(polled.status === 'running' && Math.abs((polled.progress ?? 0) - 0.42) < 1e-6, `in_progress 形态不对：${JSON.stringify(polled)}`)

      // ③ 图生视频（首帧）：multipart + input_reference 文件，seconds 在枚举内原样透传
      await created[0].submit('sora-2', { prompt: 'p', width: 720, height: 1280, durationSeconds: 8, refs: [refImg(refPng, 'first_frame')] })
      c = calls.at(-1)
      assert(c.init.body instanceof FormData, '带参考图应走 multipart（input_reference）')
      assert(Boolean(c.init.body.get('input_reference')), 'multipart 缺 input_reference 文件字段')
      assert(c.init.body.get('seconds') === '8', 'seconds=8 应原样透传')
      assert(c.init.body.get('size') === '720x1280', `size 未透传：${c.init.body.get('size')}`)

      // ④ completed：content 端点取回二进制并落临时文件（编排层下载 URL 不带认证头，只能在这里落）
      video = { id: 'vid-1', status: 'completed', progress: 100, seconds: 8 }
      polled = await created[0].poll('sora-2', jobId)
      assert(polled.status === 'succeeded' && polled.fileExt === '.mp4' && polled.mime === 'video/mp4', `completed 形态不对：${JSON.stringify(polled)}`)
      assert(polled.durationSeconds === 8, `durationSeconds 应取网关 seconds：${polled.durationSeconds}`)
      assert(polled.resultFile && fs.existsSync(polled.resultFile), 'mp4 应落成真实临时文件')
      assert(calls.at(-1).url === 'https://gw.example/v1/videos/vid-1/content', 'completed 后应打 content 端点')

      // ⑤ failed：携带网关原因
      video = { id: 'vid-1', status: 'failed', error: { message: 'boom' } }
      polled = await created[0].poll('sora-2', jobId)
      assert(polled.status === 'failed' && polled.message?.includes('boom'), `failed 形态不对：${JSON.stringify(polled)}`)

      // ⑥ 取消：DELETE /videos/{id}；同步结果的 jobId 取消是 no-op（不再发请求）
      const before = calls.length
      await created[0].cancel(jobId)
      c = calls.at(-1)
      assert(c.init.method === 'DELETE' && c.url === 'https://gw.example/v1/videos/vid-1', `取消应 DELETE 同路径：${c.init.method} ${c.url}`)
      await created[0].cancel('oc-url|https://cdn.example/x.png')
      assert(calls.length === before + 1, '同步图片结果不应发取消请求')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  /* ---------------- 汇总 ---------------- */

  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  const failed = results.filter((r) => !r.pass)
  console.log(`\ncatalog:check 完成：${results.length - failed.length}/${results.length} 项通过`)
  if (failed.length > 0) {
    console.error('失败项：')
    for (const item of failed) console.error(`  - ${item.name}：${item.detail}`)
    process.exit(1)
  }
}

await main()
