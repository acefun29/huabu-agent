/**
 * create_note 工具探针（文本上画布的唯一通道）。
 *
 * 运行：pnpm probe:note-tool
 *
 * 覆盖：
 * - 工具契约：name / parameters / 描述写明「write 的文本不上画布」；
 * - 无工作区 ⇒ 返回指引文本不抛错（details.created=false）；
 * - 成功创建：文件真实落盘 assets/documents/<标题>-<HHmm>.md、内容一致、
 *   details.published = { relPath, name, kind:'doc' }（渲染端钉卡通道）；
 * - 标题净化：路径非法字符归一为 -；纯符号标题落兜底名；
 * - 同分钟同名冲突 ⇒ 自动加序号，两个文件并存；
 * - 空内容 ⇒ 拒绝且不落盘；
 * - 成功后 broadcastAssetChanged 恰好一次（stub 计数）。
 *
 * ipc/shared 重定向到 stub（真实现链拖进 electron 全家，本探针只验工具语义）。
 */
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 'note-tool-probe-tmp')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 'note-tool-result.json')

const results = []
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail: typeof detail === 'string' ? detail : '' })
    console.log(`PASS ${name}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function flush(startedAt) {
  fs.mkdirSync(path.join(PROJECT_ROOT, 'out'), { recursive: true })
  const pass = results.filter((r) => r.pass).length
  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify({ startedAt, pass, total: results.length, verdict: pass === results.length ? 'PASS' : 'FAIL', results }, null, 2),
    'utf8'
  )
}

function transpileToTmp(relSources) {
  fs.rmSync(TMP, { recursive: true, force: true })
  for (const rel of relSources) {
    const source = path.join(PROJECT_ROOT, rel)
    const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: source,
      reportDiagnostics: true
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    assert(errors.length === 0, `${rel} 转译失败：${errors.map((d) => d.messageText).join('; ')}`)
    const target = path.join(TMP, rel).replace(/\.ts$/, '.js')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, outputText)
  }
}

/** stub 状态经 globalThis 回记（stub 模块与探针不共享模块闭包） */
globalThis.__noteProbe = { broadcastCount: 0 }

function writeStubs() {
  const stubDir = path.join(TMP, 'stubs')
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(
    path.join(stubDir, 'ipcShared.js'),
    [
      'function broadcastAssetChanged() {',
      '  globalThis.__noteProbe.broadcastCount += 1',
      '}',
      'module.exports = { broadcastAssetChanged }'
    ].join('\n')
  )
  return stubDir
}

// 转译产物里的 ../ipc/shared 重定向到 stub；typebox 走工程 node_modules 正常解析
let stubDir
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && String(parent.filename).includes('note-tool-probe-tmp')) {
    if (request === '../ipc/shared') return path.join(stubDir, 'ipcShared.js')
  }
  return origResolve.call(this, request, parent, ...rest)
}

const startedAt = new Date().toISOString()

async function main() {
  transpileToTmp(['src/main/agent/noteTool.ts'])
  stubDir = writeStubs()
  const { assembleNoteTool } = require(path.join(TMP, 'src', 'main', 'agent', 'noteTool.js'))

  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huabu-note-'))
  const wsRoot = path.join(parent, 'ws')
  fs.mkdirSync(wsRoot, { recursive: true })
  let currentDir = wsRoot
  const tool = assembleNoteTool({ currentDir: () => currentDir })
  const textOf = (r) => (r?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')

  await check('工具契约：name / parameters / 画布拦截契约描述', async () => {
    assert(tool.name === 'create_note', `name=${tool.name}`)
    assert(typeof tool.execute === 'function', 'execute 不是函数')
    assert(tool.parameters && typeof tool.parameters === 'object', 'parameters 缺失（pi 靠它生成 schema）')
    const description = String(tool.description)
    assert(/write/.test(description) && /画布/.test(description), '描述没写清「write 的文本不上画布、文本上画布走本工具」')
    return `${tool.name} / ${tool.label}`
  })

  await check('无工作区 ⇒ 指引文本不抛错', async () => {
    currentDir = null
    const out = await tool.execute('p0', { title: 'x', content: 'y' })
    currentDir = wsRoot
    assert(out.details.created === false, JSON.stringify(out.details))
    assert(/打开工作区/.test(textOf(out)), '文案没引导打开工作区')
    return 'created=false + 指引'
  })

  await check('成功创建 ⇒ 落盘 + published 通道 + 广播恰好一次', async () => {
    const before = globalThis.__noteProbe.broadcastCount
    const out = await tool.execute('p1', { title: '品牌方案', content: '# 品牌方案\n\n正文' })
    const published = out.details.published
    assert(out.details.created === true && published && published.kind === 'doc', JSON.stringify(out.details))
    assert(/^assets\/documents\/品牌方案-\d{4}\.md$/.test(published.relPath), `relPath=${published.relPath}`)
    const abs = path.join(wsRoot, ...published.relPath.split('/'))
    assert(fs.existsSync(abs), '文件没落盘')
    assert(fs.readFileSync(abs, 'utf8') === '# 品牌方案\n\n正文', '落盘内容与入参不一致')
    assert(textOf(out).includes(published.relPath), '结果文本没带落盘路径')
    assert(globalThis.__noteProbe.broadcastCount === before + 1, 'broadcastAssetChanged 应恰好一次')
    return published.relPath
  })

  await check('标题净化 ⇒ 非法字符归一为 -，纯符号标题落兜底名', async () => {
    const a = await tool.execute('p2', { title: 'a/b:c*d', content: 'x' })
    assert(a.details.created === true, JSON.stringify(a.details))
    assert(!/[\\/:*?"<>|\s]/.test(a.details.published.name), `name=${a.details.published.name}`)
    const b = await tool.execute('p3', { title: '///', content: 'x' })
    assert(b.details.created === true, '纯符号标题也应创建成功（兜底名）')
    return `${a.details.published.name} / ${b.details.published.name}`
  })

  await check('同分钟同名冲突 ⇒ 自动加序号且两文件并存', async () => {
    const first = await tool.execute('p4', { title: '复盘', content: '一' })
    const second = await tool.execute('p5', { title: '复盘', content: '二' })
    const rel1 = first.details.published.relPath
    const rel2 = second.details.published.relPath
    assert(rel1 !== rel2, `重名未错开：${rel1} vs ${rel2}`)
    assert(fs.existsSync(path.join(wsRoot, ...rel1.split('/'))), '第一个文件应存在')
    assert(fs.existsSync(path.join(wsRoot, ...rel2.split('/'))), '第二个文件应存在')
    assert(fs.readFileSync(path.join(wsRoot, ...rel2.split('/')), 'utf8') === '二', '第二个文件内容不对')
    return `${path.basename(rel1)} / ${path.basename(rel2)}`
  })

  await check('空内容 ⇒ 拒绝且不落盘', async () => {
    const docs = path.join(wsRoot, 'assets', 'documents')
    const before = fs.readdirSync(docs).length
    const out = await tool.execute('p6', { title: '空', content: '   ' })
    assert(out.details.created === false, JSON.stringify(out.details))
    assert(fs.readdirSync(docs).length === before, '拒绝时不应落盘新文件')
    return 'created=false'
  })

  const pass = results.filter((r) => r.pass).length
  const allPass = pass === results.length
  console.log(`\n============ probe:note-tool ${pass}/${results.length} ${allPass ? 'PASS' : 'FAIL'} ============`)
  flush(startedAt)
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(parent, { recursive: true, force: true })
  app.exit(allPass ? 0 : 2)
}

main().catch((error) => {
  console.log(`ERROR ${error && error.stack ? error.stack : error}`)
  results.push({ name: '夹具/运行', pass: false, detail: String(error && error.stack ? error.stack : error) })
  flush(startedAt)
  app.exit(3)
})
