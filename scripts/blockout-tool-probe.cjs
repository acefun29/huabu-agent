/**
 * blockout 工具探针（引擎集成 P1/P3/P4 的机器证据）。
 *
 * 运行：pnpm probe:blockout-tool
 *
 * 在 electron 主进程语境里真调 assembleBlockoutTool（依赖注入 mock：currentDir 指向
 * 临时工作区；assets/manager 与 ipc/shared 用 stub 换掉，经 globalThis 回记调用），
 * 断言的是工具语义本身，引擎子进程是真跑的：
 *
 *   工具面：name/label/description/schema（action 七枚举、无 promptSnippet）
 *   环境失败：无工作区 / 引擎目录缺失 → 可操作指引文本（不抛）
 *   数值动作：check（stdout JSON 透传 + 版本头）、shot（逐帧表落 .huabu/blockout/）
 *   像素动作：sheet（text+image 混合返回，PNG 落盘且 base64 是真 PNG）
 *   退出码语义：exit2 解算错误 → 结果可读不标错；exit1 用法/IO → 抛错
 *   路径安全带：scene 越出工作区被拒
 *   video：进度回调触发、成片落盘、发布细节（同镜头覆盖 / publish:false 不发布 / details.published）
 *   取消：渲染中 abort → 已取消文本，无残留产物
 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 'blockout-tool-probe-tmp')
const WS = path.join(TMP, 'ws')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 'blockout-tool-result.json')

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
function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true })
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
    mkdir(path.dirname(target))
    fs.writeFileSync(target, outputText)
  }
}

/** stub 状态经 globalThis 回记（stub 模块与探针不共享模块闭包） */
globalThis.__blockoutProbe = { importCalls: [], broadcastCount: 0 }

function writeStubs() {
  const stubDir = path.join(TMP, 'stubs')
  mkdir(stubDir)
  fs.writeFileSync(
    path.join(stubDir, 'manager.js'),
    [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      'async function importToWorkspace(workspaceDir, files) {',
      '  const g = globalThis.__blockoutProbe',
      '  const imported = []',
      '  for (const f of files) {',
      "    const name = f.name || path.basename(f.sourcePath).replace(/\\.[^.]+$/, '')",
      "    const destDir = path.join(workspaceDir, 'assets', 'video')",
      '    fs.mkdirSync(destDir, { recursive: true })',
      "    const dest = path.join(destDir, `${name}.mp4`)",
      '    fs.copyFileSync(f.sourcePath, dest)',
      '    g.importCalls.push({ sourcePath: f.sourcePath, name: f.name, mime: f.mime })',
      "    imported.push({ name, kind: 'video', relPath: `assets/video/${name}.mp4`, absPath: dest, bytes: fs.statSync(dest).size })",
      '  }',
      '  return { imported, failed: [] }',
      '}',
      'module.exports = { importToWorkspace }'
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(stubDir, 'ipcShared.js'),
    [
      'function broadcastAssetChanged() {',
      '  globalThis.__blockoutProbe.broadcastCount += 1',
      '}',
      'module.exports = { broadcastAssetChanged }'
    ].join('\n')
  )
  return stubDir
}

// 转译产物里的 ../assets/manager、../ipc/shared 重定向到 stub（真实现链拖进
// workspace/store 全家，本探针只验工具语义，发布细节靠 stub 断言）
let stubDir
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && String(parent.filename).includes('blockout-tool-probe-tmp')) {
    if (request === '../assets/manager') return path.join(stubDir, 'manager.js')
    if (request === '../ipc/shared') return path.join(stubDir, 'ipcShared.js')
  }
  return origResolve.call(this, request, parent, ...rest)
}

function firstText(result) {
  const block = (result?.content ?? []).find((b) => b.type === 'text')
  return block?.text ?? ''
}
/** 头部行后的正文里截出完整 JSON（video 结果在 JSON 后还追加了发布说明行） */
function textJson(text) {
  const body = text.slice(text.indexOf('\n') + 1)
  return JSON.parse(body.slice(0, body.lastIndexOf('}') + 1))
}
function isMp4(absPath) {
  if (!fs.existsSync(absPath)) return false
  const buf = fs.readFileSync(absPath)
  return buf.length > 10_000 && buf.subarray(4, 8).toString('ascii') === 'ftyp'
}

async function main() {
  transpileToTmp(['src/main/agent/blockoutTools.ts', 'src/main/media/videoFrames.ts'])
  stubDir = writeStubs()
  const toolMod = require(path.join(TMP, 'src', 'main', 'agent', 'blockoutTools.js'))
  const {
    assembleBlockoutTool,
    resolveBlockoutEngineDir,
    isBlockoutSkillReadPath,
    BLOCKOUT_TOOL_NAME,
    BLOCKOUT_ENGINE_VERSION
  } = toolMod

  // 夹具：真实模板场景 + 短时长变体（video 动作别把探针拖到十几秒）
  mkdir(WS)
  const templatePath = path.join(PROJECT_ROOT, '.huabu', 'skills', 'blockout-shot', 'templates', 'perfume-on-table.author.json')
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'))
  fs.mkdirSync(path.join(WS, 'scenes'), { recursive: true })
  fs.writeFileSync(path.join(WS, 'scenes', 'perfume.author.json'), JSON.stringify(template, null, 2))
  const fast = JSON.parse(JSON.stringify(template))
  fast.shots.hero.durationS = 2
  fs.writeFileSync(path.join(WS, 'scenes', 'perfume-fast.author.json'), JSON.stringify(fast, null, 2))

  const tool = assembleBlockoutTool({ currentDir: () => WS })
  const run = (params, signal, onUpdate) => tool.execute('probe-call', params, signal, onUpdate)

  await check('工具面：name/description/action 枚举且无 promptSnippet', () => {
    assert(tool.name === BLOCKOUT_TOOL_NAME && BLOCKOUT_TOOL_NAME === 'blockout', `工具名 ${tool.name}`)
    assert(tool.description.includes('blockout-shot'), 'description 应指向技能')
    assert(tool.promptSnippet === undefined && tool.promptGuidelines === undefined, '惰性工具不得设 promptSnippet')
    const props = tool.parameters.properties
    assert(props.action && props.scene, '缺少 action/scene 参数')
    assert((props.action.anyOf ?? []).length === 7, `action 枚举数 ${props.action.anyOf?.length}`)
    return `v${BLOCKOUT_ENGINE_VERSION}`
  })

  await check('环境失败：无工作区返回指引文本', async () => {
    const bare = assembleBlockoutTool({ currentDir: () => null })
    const result = await bare.execute('c', { action: 'check', scene: 'x.json' })
    assert(firstText(result).includes('尚未打开工作区'), firstText(result).slice(0, 80))
  })

  await check('引擎目录解析（开发态指向源目录）', () => {
    const dir = resolveBlockoutEngineDir()
    assert(dir && fs.existsSync(path.join(dir, 'cli.mjs')), `解析失败：${dir}`)
    return dir
  })

  await check('check 数值动作：stdout JSON + 版本头透传', async () => {
    const result = await run({ action: 'check', scene: 'scenes/perfume.author.json' })
    const text = firstText(result)
    assert(text.includes(`[blockout engine v${BLOCKOUT_ENGINE_VERSION} · check]`), text.slice(0, 80))
    const json = JSON.parse(text.slice(text.indexOf('\n') + 1))
    assert(json.ok === true && Array.isArray(json.collisions), 'check 载荷缺 collisions')
    assert(result.details.engine === BLOCKOUT_ENGINE_VERSION, 'details 缺版本')
  })

  await check('shot 数值动作：逐帧表落 .huabu/blockout/<场景>/', async () => {
    const result = await run({ action: 'shot', scene: 'scenes/perfume.author.json', shot: 'hero' })
    const json = textJson(firstText(result))
    assert(json.frames > 0 && json.durationS > 0, 'shot 摘要缺帧数')
    const framesFile = path.join(WS, '.huabu', 'blockout', 'perfume', 'hero.frames.json')
    assert(fs.existsSync(framesFile), `逐帧表未落盘：${framesFile}`)
    return `${json.frames} 帧`
  })

  await check('shot keyframes：关键帧拼版回图', async () => {
    const result = await run({ action: 'shot', scene: 'scenes/perfume-fast.author.json', shot: 'hero', keyframes: true })
    const image = (result.content ?? []).find((b) => b.type === 'image')
    assert(image, '结果未附 image block')
    const buf = Buffer.from(image.data, 'base64')
    assert(buf.subarray(1, 4).toString('ascii') === 'PNG' && buf.length > 20_000, '附图不是合法 PNG')
    assert(fs.existsSync(path.join(WS, '.huabu', 'blockout', 'perfume-fast', 'hero-keys.png')), '拼版未落盘')
  })

  await check('sheet 拼版：text+image 混合返回', async () => {
    const result = await run({ action: 'sheet', scene: 'scenes/perfume.author.json', size: 1024 })
    const image = (result.content ?? []).find((b) => b.type === 'image')
    assert(image && Buffer.from(image.data, 'base64').length > 20_000, '拼版图缺失或过小')
    assert(fs.existsSync(path.join(WS, '.huabu', 'blockout', 'perfume', 'sheet.png')), '拼版未落盘')
  })

  await check('view 单视图：图返回', async () => {
    const result = await run({ action: 'view', scene: 'scenes/perfume.author.json', view: 'top', width: 512, height: 512 })
    assert((result.content ?? []).some((b) => b.type === 'image'), 'view 未附图')
  })

  await check('路径安全带：scene 越出工作区被拒', async () => {
    const result = await run({ action: 'check', scene: '../outside.json' })
    assert(firstText(result).includes('越出工作区'), firstText(result).slice(0, 80))
  })

  await check('路径安全带：绝对路径 scene 被拒', async () => {
    const result = await run({ action: 'check', scene: templatePath.replace(/\//g, path.sep) })
    assert(firstText(result).includes('越出工作区'), firstText(result).slice(0, 80))
  })

  await check('scene 缺失文件指引', async () => {
    const result = await run({ action: 'check', scene: 'scenes/nope.json' })
    assert(firstText(result).includes('不存在'), firstText(result).slice(0, 80))
  })

  await check('exit2 语义：解算错误可读不抛错', async () => {
    fs.writeFileSync(
      path.join(WS, 'scenes', 'broken.author.json'),
      JSON.stringify({ version: 2, drivers: { bad: '$missing' }, scene: [{ id: 'f', shape: 'plane', size: [4, 4] }] })
    )
    const result = await run({ action: 'check', scene: 'scenes/broken.author.json' })
    const text = firstText(result)
    assert(text.includes('解算有 error'), text.slice(0, 100))
  })

  await check('exit1 语义：用法/IO 错误抛错（isError）', async () => {
    fs.writeFileSync(path.join(WS, 'scenes', 'notjson.txt'), '这不是 JSON')
    let threw = false
    try {
      await run({ action: 'check', scene: 'scenes/notjson.txt' })
    } catch {
      threw = true
    }
    assert(threw, '损坏 JSON 应走抛错路径')
  })

  await check('video：渲染 + 进度回调 + 发布细节', async () => {
    // 预埋旧同名成片（同镜头覆盖的对象）
    const stale = path.join(WS, 'assets', 'video', 'perfume-fast-hero.mp4')
    mkdir(path.dirname(stale))
    fs.writeFileSync(stale, 'stale-bytes-that-are-not-mp4')
    const updates = []
    const result = await run(
      { action: 'video', scene: 'scenes/perfume-fast.author.json', shot: 'hero', width: 640, height: 360 },
      undefined,
      (u) => updates.push(u.content?.[0]?.text ?? '')
    )
    const json = textJson(firstText(result))
    assert(json.ok === true && json.video, 'video 结果不 ok')
    assert(fs.existsSync(json.video), `成片未落盘：${json.video}`)
    assert(isMp4(stale), '旧同名文件未被新成片覆盖')
    assert(result.details.published?.relPath === 'assets/video/perfume-fast-hero.mp4', JSON.stringify(result.details.published))
    assert(firstText(result).includes('已发布到素材库'), '结果文本未说明发布')
    assert(globalThis.__blockoutProbe.importCalls.length === 1, 'importToWorkspace 调用数异常')
    assert(globalThis.__blockoutProbe.broadcastCount === 1, '广播数异常')
    assert(updates.some((t) => t.includes('渲染中')), `进度回调未触发：${JSON.stringify(updates)}`)
    return `${json.frames} 帧 / ${updates.length} 条进度`
  })

  await check('video publish:false 不发布', async () => {
    const before = globalThis.__blockoutProbe.importCalls.length
    const result = await run({ action: 'video', scene: 'scenes/perfume-fast.author.json', shot: 'hero', publish: false })
    assert(globalThis.__blockoutProbe.importCalls.length === before, 'publish:false 仍发布了')
    assert(!result.details.published, 'details 不应带 published')
  })

  await check('video 自定义 out 且覆盖发布', async () => {
    const result = await run({ action: 'video', scene: 'scenes/perfume-fast.author.json', shot: 'hero', out: 'renders/custom.mp4' })
    assert(fs.existsSync(path.join(WS, 'renders', 'custom.mp4')), '自定义 out 未生效')
    assert(globalThis.__blockoutProbe.importCalls.at(-1).name === 'perfume-fast-hero', '自定义 out 后成片名应保持 <场景>-<镜头>')
  })

  await check('取消：渲染中 abort 返回已取消', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    const result = await run({ action: 'video', scene: 'scenes/perfume.author.json', shot: 'hero' }, controller.signal)
    assert(firstText(result).includes('已取消'), firstText(result).slice(0, 80))
    assert(result.details.cancelled === true, 'details 缺 cancelled')
  })

  await check('惰性激活判定：工作区技能目录命中/不命中', () => {
    const ws = path.join(TMP, 'ws2')
    const skillFile = path.join(ws, '.huabu', 'skills', 'blockout-shot', 'SKILL.md')
    assert(isBlockoutSkillReadPath(ws, skillFile) === true, '工作区 SKILL.md 应命中')
    assert(isBlockoutSkillReadPath(ws, path.join(path.dirname(skillFile), 'references', 'schema.md')) === true, '技能内任意文件应命中')
    assert(isBlockoutSkillReadPath(ws, '.huabu/skills/blockout-shot/SKILL.md') === true, '相对路径应命中')
    assert(isBlockoutSkillReadPath(ws, path.join(ws, '.huabu', 'skills', 'other-skill', 'SKILL.md')) === false, '其他技能不命中')
    assert(isBlockoutSkillReadPath(ws, path.join(ws, 'SKILL.md')) === false, '工作区根的 SKILL.md 不命中')
    assert(isBlockoutSkillReadPath(ws, path.join(ws, '.huabu', 'skills', 'blockout-shot-evil', 'SKILL.md')) === false, '前缀伪造目录不命中')
  })

  await check('惰性激活判定：内置技能层命中（P5 落地后生效）', () => {
    const builtin = path.join(PROJECT_ROOT, 'resources', 'skills', 'blockout-shot', 'SKILL.md')
    if (!fs.existsSync(builtin)) return `内置技能未落地（P5 前跳过）：${path.relative(PROJECT_ROOT, builtin)}`
    assert(isBlockoutSkillReadPath(WS, builtin) === true, '内置层 SKILL.md 应命中')
  })

  const failed = results.filter((r) => !r.pass)
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true })
  fs.writeFileSync(RESULT_PATH, JSON.stringify({ at: new Date().toISOString(), pass: failed.length === 0, results }, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} 项通过 → ${path.relative(PROJECT_ROOT, RESULT_PATH)}`)
  app.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('探针崩溃：', error)
  app.exit(1)
})
