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
  const roots = [path.join(PROJECT_ROOT, 'src', 'main', 'media'), path.join(PROJECT_ROOT, 'src', 'shared', 'media.ts')]
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
        { id: 'my-oai-noenv', type: 'gateway-openai-compat', authEnv: 'MY_KEY', models: { 'gpt-image-x': { kind: 'video' } } }
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
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ output: { task_id: 'task-dry' } }), { status: 200 })
    }
    // 参考图夹具：firstImageRefDataUri 只看扩展名 + 读文件，内容不要求是真 PNG
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
      await adapter.submit('dashscope/wan2.7-image', { prompt: 'p', width: 1024, height: 1024, refFiles: [refPng] })
      c = calls.at(-1)
      const content = c.body.input.messages[0].content
      assert(content.length === 2 && content[1].image.startsWith('data:image/png;base64,'), `图生图 content 不对：${JSON.stringify(content).slice(0, 120)}`)
      assert(typeof c.body.parameters.size === 'string', '图生图显式比例必须传 size（缺省才随输入图比例）')

      // ②' wan2.7-image 图生图（未指定比例）：不传 size，保持输出比例随参考图的缺省语义
      await adapter.submit('dashscope/wan2.7-image', { prompt: 'p', refFiles: [refPng] })
      c = calls.at(-1)
      assert(c.body.parameters.size === undefined, '图生图未指定比例不应传 size（输出随参考图）')

      // ③ wan2.7-i2v：input.media[{type:'first_frame',url:dataURI}]、无 ratio、duration clamp [2,15]
      await adapter.submit('dashscope/wan2.7-i2v', { prompt: 'p', width: 1024, height: 1024, durationSeconds: 99, refFiles: [refPng] })
      c = calls.at(-1)
      assert(c.url.includes('/api/v1/services/aigc/video-generation/video-synthesis'), `i2v 端点不对：${c.url}`)
      assert(c.body.input.media?.[0]?.type === 'first_frame' && c.body.input.media[0].url.startsWith('data:image/png;base64,'), `首帧 media 不对：${JSON.stringify(c.body.input.media)}`)
      assert(c.body.parameters.ratio === undefined, 'wan2.7-i2v 无 ratio 参数（官方 API 参考）')
      assert(c.body.parameters.duration === 15, `duration 应 clamp 到 15：${c.body.parameters.duration}`)
      assert(c.body.parameters.resolution === '1080P', `resolution 不对：${c.body.parameters.resolution}`)

      // ④ wan3.0-video：duration 上限 30
      await adapter.submit('dashscope/wan3.0-video', { prompt: 'p', durationSeconds: 99, refFiles: [refPng] })
      c = calls.at(-1)
      assert(c.body.input.media?.[0]?.type === 'first_frame', 'wan3.0-video 应走 media 形态')
      assert(c.body.parameters.duration === 30, `wan3.0 duration 应 clamp 到 30：${c.body.parameters.duration}`)

      // ⑤ wan2.7-t2v 回归：仍走 t2v 形态（无 media、有 ratio），不被 i2v 分支误伤
      await adapter.submit('dashscope/wan2.7-t2v', { prompt: 'p', width: 1920, height: 1080, durationSeconds: 10 })
      c = calls.at(-1)
      assert(c.body.input.media === undefined && typeof c.body.parameters.ratio === 'string', `t2v 形态被误伤：${JSON.stringify(c.body).slice(0, 160)}`)

      // ⑥ wan2.5 旧协议回归：旧端点、input.prompt 直传
      await adapter.submit('dashscope/wan2.5-t2i-preview', { prompt: 'p', width: 1024, height: 1024 })
      c = calls.at(-1)
      assert(c.url.includes('/api/v1/services/aigc/text2image/image-synthesis') && c.body.input.prompt === 'p', '旧协议形态被误伤')
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
      await adapter.submit('minimax/image-01', { prompt: 'p', ratio: '1:1', refFiles: [refPng] })
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
      await adapter.submit('minimax/h3-max', { prompt: 'p', ratio: '3:4', width: 864, height: 1152, durationSeconds: 2, refFiles: [refPng] })
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
      await adapter.submit('tencent/hunyuan-image', { prompt: 'p', ratio: '9:16', refFiles: [refPng] })
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
          type: 'gateway-openai-compat',
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
