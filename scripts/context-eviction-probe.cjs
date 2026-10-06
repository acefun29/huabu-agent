/**
 * 历史图片淘汰探针（contextEviction 的机器证据）。
 *
 * 运行：pnpm probe:context-eviction
 *
 * 纯函数、无 electron/shell 依赖，node 直接跑：ts.transpileModule 镜像转译后
 * require 真模块，伪造消息断言计划第 7 节全部规则——工具结果图块替换为锚点且
 * 含完整路径、文字部分一字不动、幂等、用户/助手消息不碰、无标记行兜底
 * （路径未记录）、锚点文本逐字节固定、同源帧组共享同一锚点。
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 'context-eviction-probe-tmp')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 'context-eviction-result.json')

const results = []
function check(name, fn) {
  try {
    const detail = fn()
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

/** 镜像转译 src/main（与 workspace-delete-probe 同款）：保目录结构，require 真模块 */
function transpileAll() {
  fs.rmSync(TMP, { recursive: true, force: true })
  const sources = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.ts')) sources.push(full)
    }
  }
  walk(path.join(PROJECT_ROOT, 'src', 'main'))
  for (const source of sources) {
    const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: source,
      reportDiagnostics: true
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    assert(errors.length === 0, `${source} 转译失败：${errors.map((d) => d.messageText).join('; ')}`)
    const target = path.join(TMP, path.relative(PROJECT_ROOT, source)).replace(/\.ts$/, '.js')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, outputText)
  }
}

transpileAll()
const { evictAllImages, mediaEvictionAnchor, MEDIA_SRC_MARKER } = require(
  path.join(TMP, 'src', 'main', 'agent', 'contextEviction.js')
)

const ABS_PATH = 'E:/workspaces/demo/assets/参考图.png'
const IMG = () => ({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' })
/** 工具结果夹具：1 段文字 + N 个图块 */
function toolResult(text, imageCount) {
  return {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'read_media',
    content: [{ type: 'text', text }, ...Array.from({ length: imageCount }, IMG)],
    isError: false,
    timestamp: 1700000000000
  }
}

// 1+2：替换 + 路径 + 文字不动
const marked = toolResult(`文件：assets/参考图.png\n原图 800×600px，已缩到 1024px 内。\n${MEDIA_SRC_MARKER}${ABS_PATH}]`, 1)
check('替换：image 块变锚点，含标记行完整路径', () => {
  const n = evictAllImages([marked])
  assert(n === 1, `应替换 1 块，实际 ${n}`)
  assert(marked.content.length === 2, '文字保留 + 图块变锚点，content 长度不变')
  assert(marked.content[0].type === 'text' && marked.content[0].text.includes('原图 800×600px'), '文字部分一字未动')
  const anchor = marked.content[1]
  assert(anchor.type === 'text', '图块应替换为 text 块')
  assert(
    anchor.text === mediaEvictionAnchor(ABS_PATH),
    `锚点应逐字节等于 mediaEvictionAnchor(路径)：${anchor.text}`
  )
  assert(anchor.text.includes(ABS_PATH), '锚点应含完整路径')
  return '1 块替换，文字原样'
})

// 3：幂等
check('幂等：第二遍零替换，结果与第一遍完全一致', () => {
  const snapshot = JSON.stringify(marked)
  const n = evictAllImages([marked])
  assert(n === 0, `第二遍应零替换，实际 ${n}`)
  assert(JSON.stringify(marked) === snapshot, '第二遍不应改动任何字节')
  return '重跑无操作'
})

// 4：用户/助手消息不碰
check('边界：用户/助手消息中的图块一律不碰', () => {
  const image = IMG()
  const user = { role: 'user', content: [{ type: 'text', text: '参考这张' }, image], timestamp: 1 }
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: '好的' }, { type: 'toolCall', id: 'call_1', name: 'read_media', arguments: { path: 'x' } }],
    api: 'anthropic-messages', provider: 'p', model: 'm', usage: {}, stopReason: 'stop', timestamp: 2
  }
  const n = evictAllImages([user, assistant])
  assert(n === 0, `不应有替换，实际 ${n}`)
  assert(user.content[1] === image, 'user 的 image 块应是原引用')
  assert(assistant.content[0].text === '好的', 'assistant 文本不应被动')
  return '原样通过'
})

// 5：无标记行兜底
check('兜底：无标记行（旧历史/MCP 结果）照常淘汰，路径写「路径未记录」', () => {
  const legacy = toolResult('MCP 工具返回了一张截图。', 1)
  const n = evictAllImages([legacy])
  assert(n === 1, `应替换 1 块，实际 ${n}`)
  assert(legacy.content[1].text === mediaEvictionAnchor(null), '锚点应等于无路径版本')
  assert(legacy.content[1].text.includes('路径未记录'), '应含「路径未记录」占位')
  return '淘汰成功，路径未记录'
})

// 6：锚点逐字节固定
check('稳定：锚点文本逐字节固定，不含时间戳等可变内容', () => {
  assert(mediaEvictionAnchor(ABS_PATH) === mediaEvictionAnchor(ABS_PATH), '同路径两次生成应完全一致')
  const expected =
    '[图片已从上下文移除 · 文件：E:/workspaces/demo/assets/参考图.png · 画面未随历史保留。需要查看画面或将其用作图生图/图生视频参考时，必须用 read_media 读取该路径，或在生成参数中直接引用该路径。不要凭文件名猜测画面内容。]'
  assert(mediaEvictionAnchor(ABS_PATH) === expected, '锚点文案与计划文档定义逐字节一致')
  assert(!/\d{4}-\d{2}-\d{2}|\d{10,}/.test(mediaEvictionAnchor(null)), '锚点不应含日期/时间戳形态内容')
  return '逐字节一致'
})

// 7：帧组共享路径
check('帧组：视频多帧同源，全部替换且共享同一锚点', () => {
  const frames = toolResult(
    `时长 00:12；已抽取 3 个关键帧，时间点：帧1=00:01、帧2=00:05、帧3=00:09。\n${MEDIA_SRC_MARKER}E:/ws/clip.mp4]`,
    3
  )
  const n = evictAllImages([frames])
  assert(n === 3, `应替换 3 块，实际 ${n}`)
  const anchor = mediaEvictionAnchor('E:/ws/clip.mp4')
  assert(frames.content[1].text === anchor && frames.content[3].text === anchor, '三帧应共享同一锚点')
  assert(frames.content[0].text.includes('帧2=00:05'), '时间戳清单应保留（要看某时间点就重调 read_media）')
  return '3 帧 → 1 个锚点 ×3，时间轴保留'
})

const pass = results.filter((r) => r.pass).length
fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true })
fs.writeFileSync(
  RESULT_PATH,
  JSON.stringify(
    { pass, total: results.length, verdict: pass === results.length ? 'PASS' : 'FAIL', results },
    null,
    2
  ),
  'utf8'
)
console.log(`\n${pass}/${results.length} passed -> ${RESULT_PATH}`)
process.exitCode = pass === results.length ? 0 : 1
