/**
 * 历史回放缩略探针（上下文感知计划 T4 的机器证据）。
 *
 * 运行：pnpm probe:history-thumbs
 *
 * 为什么要在 electron 里跑：回放图片的成败取决于 nativeImage 的真解码与真缩放
 * （与 t7 探针同一理由），纯 Node 自检（session-history:check）只能锁住"图片槽位
 * 登记 + 原图不出主进程"那一半。本探针把 src/main/agent/historyThumbs.ts 真转译
 * 出来调一遍，夹具是 nativeImage 现造的真 PNG，断言：
 * - 大图缩到 ≤256px 长边、回得来 JPEG base64；
 * - 小图原样保留（不放大）；
 * - 损坏 base64 返回 null（调用方退化为 chip，不抛异常）；
 * - host 源级回归锁：HISTORY_IMAGE_LIMIT=24、原图块不出主进程（host 只回填缩略）。
 */
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 'history-thumbs-probe-tmp')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 'history-thumbs-result.json')

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
    const file = path.join(PROJECT_ROOT, rel)
    const target = path.join(TMP, rel.replace(/\.ts$/, '.js'))
    const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
      reportDiagnostics: true
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    assert(errors.length === 0, `转译失败 ${rel}：${errors.map((d) => d.messageText).join('; ')}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, outputText, 'utf8')
  }
}

/** 真的 PNG 夹具：nativeImage 造位图再导 PNG（与 t7 探针同一手法，SVG 解不了） */
function makePng(edge) {
  const bitmap = Buffer.alloc(edge * edge * 4)
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = 40
    bitmap[i + 1] = 120
    bitmap[i + 2] = 200
    bitmap[i + 3] = 255
  }
  const image = nativeImage.createFromBitmap(bitmap, { width: edge, height: edge })
  assert(!image.isEmpty(), `夹具位图生成失败（${edge}px）`)
  const png = image.toPNG()
  const decoded = nativeImage.createFromBuffer(png)
  assert(!decoded.isEmpty(), `夹具 PNG 解码失败（${edge}px）`)
  return { base64: png.toString('base64'), width: decoded.getSize().width, height: decoded.getSize().height }
}

const startedAt = new Date().toISOString()
app
  .whenReady()
  .then(async () => {
    transpileToTmp([path.join('src', 'main', 'agent', 'historyThumbs.ts')])
    const { makeHistoryThumbnail } = require(path.join(TMP, 'src', 'main', 'agent', 'historyThumbs.js'))

    await check('大图（512px）⇒ 缩到 ≤256px 长边且解得回', async () => {
      const fixture = makePng(512)
      const thumb = makeHistoryThumbnail(fixture.base64)
      assert(thumb, '应产出缩略 base64')
      const decoded = nativeImage.createFromBuffer(Buffer.from(thumb, 'base64'))
      assert(!decoded.isEmpty(), '缩略应能被解回')
      const size = decoded.getSize()
      assert(Math.max(size.width, size.height) <= 256, `长边应 ≤256，实际 ${Math.max(size.width, size.height)}`)
      assert(size.width >= 1 && size.height >= 1, '尺寸应有效')
      return `${fixture.width}px → ${size.width}×${size.height} JPEG`
    })

    await check('小图（64px）⇒ 不放大，原尺寸保留', async () => {
      const fixture = makePng(64)
      const thumb = makeHistoryThumbnail(fixture.base64)
      assert(thumb, '应产出缩略 base64')
      const decoded = nativeImage.createFromBuffer(Buffer.from(thumb, 'base64'))
      const size = decoded.getSize()
      assert(size.width === 64 && size.height === 64, `小图不应放大（实际 ${size.width}×${size.height}）`)
      return '64×64 保留'
    })

    await check('损坏 base64 ⇒ 返回 null（不抛异常，调用方退化 chip）', async () => {
      assert(makeHistoryThumbnail('!!!not-base64!!!') === null, '非 base64 应返回 null')
      assert(makeHistoryThumbnail(Buffer.from('not an image').toString('base64')) === null, '非图片字节应返回 null')
      assert(makeHistoryThumbnail('') === null, '空串应返回 null')
    })

    await check('源级回归锁：回放上限 24 张、原图块不出主进程', async () => {
      const host = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'agent', 'host.ts'), 'utf8')
      assert(/HISTORY_IMAGE_LIMIT = 24/.test(host), '回放缩略上限应是 24 张')
      // 槽位原图（slot.data）只允许出现在 thumbnailSlot 内（主进程内缩略），
      // host 其余代码只经 thumbBase64/label 回填——出现第二处即视为原图外泄
      const occurrences = host.split('slot.data').length - 1
      assert(occurrences === 1, `slot.data 只应出现在 thumbnailSlot 内，实际出现 ${occurrences} 次`)
      const thumbs = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'agent', 'historyThumbs.ts'), 'utf8')
      assert(/from 'electron'/.test(thumbs), '缩略模块应显式依赖 electron（唯一出口）')
      const history = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'agent', 'history.ts'), 'utf8')
      assert(!/from 'electron'/.test(history), 'history.ts 纯函数层不得 import electron（自检要能在纯 Node 跑）')
    })

    const pass = results.filter((r) => r.pass).length
    const allPass = pass === results.length
    console.log(`\n================ probe:history-thumbs ${pass}/${results.length} ${allPass ? 'PASS' : 'FAIL'} ================`)
    flush(startedAt)
    fs.rmSync(TMP, { recursive: true, force: true })
    app.exit(allPass ? 0 : 2)
  })
  .catch((error) => {
    console.log(`ERROR ${error && error.stack ? error.stack : error}`)
    results.push({ name: '夹具/运行', pass: false, detail: String(error && error.stack ? error.stack : error) })
    flush(startedAt)
    app.exit(3)
  })
