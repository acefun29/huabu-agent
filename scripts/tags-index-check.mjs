/**
 * 文件标签索引自检（.huabu/tags.json 的读写契约）。
 *
 * 运行：pnpm tags-index:check
 *
 * tagsIndex.ts 只依赖 fs/path（纯 Node 可跑），这里在临时工作区里真写真读：
 *   1. setFileTags 写入 → loadTagsIndex 读回一致；
 *   2. 清洗规则：去 # 前缀 / 去重 / 单条 12 字截断 / 最多 8 条 / 空白丢弃；
 *   3. 空标签数组 = 删除条目（索引里不留空键）；
 *   4. 路径归一：反斜杠与前导斜杠统一成 POSIX 相对键；
 *   5. 损坏的 tags.json 回退空索引（不抛错，标签丢了不挡素材库）；
 *   6. 落盘形态：合法 JSON 且无 .tmp 残留（tmp+rename 原子写的证据）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'tags-index-check-tmp')
const SOURCE = path.join(PROJECT_ROOT, 'src', 'main', 'assets', 'tagsIndex.ts')

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

fs.rmSync(OUT_DIR, { recursive: true, force: true })
const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(SOURCE, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: SOURCE,
  reportDiagnostics: true
})
const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
assert(errors.length === 0, `tagsIndex.ts 转译失败：${errors.map((d) => d.messageText).join('; ')}`)
fs.mkdirSync(OUT_DIR, { recursive: true })
const outFile = path.join(OUT_DIR, 'tagsIndex.js')
fs.writeFileSync(outFile, outputText, 'utf8')
const { loadTagsIndex, setFileTags, cleanTags } = await import(`file://${outFile.replaceAll('\\', '/')}`)

const WS = path.join(OUT_DIR, 'ws')
fs.mkdirSync(path.join(WS, '.huabu'), { recursive: true })

check('写入读回一致：setFileTags → loadTagsIndex', () => {
  const cleaned = setFileTags(WS, '素材库/公共/brief.md', ['需求', 'v1'])
  assert(cleaned.length === 2, JSON.stringify(cleaned))
  const index = loadTagsIndex(WS)
  assert(index['素材库/公共/brief.md'].join() === '需求,v1', JSON.stringify(index))
  return '两条标签'
})

check('清洗：# 前缀 / 去重 / 12 字截断 / 上限 8 条 / 空白丢弃', () => {
  assert(cleanTags(['#标签', '标签']).length === 1, '应去 # 并去重')
  assert(cleanTags(['x'.repeat(30)])[0].length === 12, '单条应截到 12 字')
  assert(cleanTags(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']).length === 8, '应截到 8 条')
  assert(cleanTags(['', '   ']).length === 0, '空白应丢弃')
  return '四条规则'
})

check('空标签数组 = 删除条目（索引不留空键）', () => {
  setFileTags(WS, 'assets/images/poster.png', ['主视觉'])
  assert(loadTagsIndex(WS)['assets/images/poster.png'] !== undefined, '前置失败')
  setFileTags(WS, 'assets/images/poster.png', [])
  assert(loadTagsIndex(WS)['assets/images/poster.png'] === undefined, '空数组应删键')
  return '键已移除'
})

check('路径归一：反斜杠/前导斜杠统一成 POSIX 相对键', () => {
  setFileTags(WS, '\\素材库\\A\\海报.png', ['a'])
  const index = loadTagsIndex(WS)
  assert(index['素材库/A/海报.png'] !== undefined, `键应归一，实际：${JSON.stringify(Object.keys(index))}`)
  return 'POSIX 键'
})

check('损坏的 tags.json 回退空索引（不抛错）', () => {
  fs.writeFileSync(path.join(WS, '.huabu', 'tags.json'), '{not json!!', 'utf8')
  assert(Object.keys(loadTagsIndex(WS)).length === 0, '损坏文件应回退空索引')
  return '静默回退'
})

check('落盘形态：合法 JSON 且无 .tmp 残留', () => {
  setFileTags(WS, 'a.md', ['t'])
  const file = path.join(WS, '.huabu', 'tags.json')
  JSON.parse(fs.readFileSync(file, 'utf8'))
  const leftovers = fs.readdirSync(path.join(WS, '.huabu')).filter((f) => f.includes('.tmp'))
  assert(leftovers.length === 0, `tmp 残留：${leftovers.join(',')}`)
  return '原子写无残留'
})

const pass = results.filter((r) => r.pass).length
const allPass = pass === results.length
console.log(`\n============ tags-index:check ${pass}/${results.length} ${allPass ? 'PASS' : 'FAIL'} ============`)
fs.rmSync(OUT_DIR, { recursive: true, force: true })
process.exit(allPass ? 0 : 1)
