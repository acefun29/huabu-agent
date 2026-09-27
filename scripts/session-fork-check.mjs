/**
 * fork 原生文件级分叉自检（T5 的回归锁）。
 *
 * 运行：pnpm session-fork-check
 *
 * 纯 Node 真 pi：fixture 源 JSONL（含图块与压缩条目）→ SessionManager.forkFrom →
 * 断言新文件 header.parentSession、全部非 header entry 逐条拷贝、
 * 两个文件的 buildContextEntries 视图一致、loadEntriesFromFile 可读（导出面可用性）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const results = []
function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true })
    console.log(`PASS ${name}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const pi = await import('@earendil-works/pi-coding-agent')
// loadEntriesFromFile 是 session-manager 模块的 testing 导出（不在包根 index 上），
// 直接从 dist 文件导入验证（计划 2.1/4-T5 给出的出处就是该模块）
const piDistDir = path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))
const sessionManagerModule = await import(pathToFileURL(path.join(piDistDir, 'core', 'session-manager.js')))

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huabu-fork-check-'))
try {
  const sourceCwd = path.join(tmpRoot, 'src-ws')
  const sourceSessions = path.join(sourceCwd, '.huabu', 'sessions')
  fs.mkdirSync(sourceSessions, { recursive: true })

  // fixture 源会话：user（含图块）→ assistant（toolCall）→ toolResult → 压缩 → kept user
  const sourceEntries = [
    {
      type: 'session', version: 3, id: 'src-sess-0001', timestamp: '2026-09-26T00:00:00.000Z', cwd: sourceCwd
    },
    {
      type: 'message', id: 's1', parentId: null, timestamp: '2026-09-26T00:00:01.000Z',
      message: {
        role: 'user', timestamp: 1,
        content: [{ type: 'text', text: '读这张图' }, { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }]
      }
    },
    {
      type: 'message', id: 's2', parentId: 's1', timestamp: '2026-09-26T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1', name: 'read_media', arguments: { path: 'E:/w/a.png' } }],
        stopReason: 'toolUse', model: 'p/m', timestamp: 2
      }
    },
    {
      type: 'message', id: 's3', parentId: 's2', timestamp: '2026-09-26T00:00:03.000Z',
      message: {
        role: 'toolResult', toolCallId: 'tc1', toolName: 'read_media', isError: false, timestamp: 3,
        content: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }, { type: 'text', text: '图内容' }]
      }
    },
    {
      type: 'compaction', id: 'c1', parentId: 's3', timestamp: '2026-09-26T00:00:04.000Z',
      summary: '摘要', firstKeptEntryId: 's4', tokensBefore: 12000
    },
    {
      type: 'message', id: 's4', parentId: 'c1', timestamp: '2026-09-26T00:00:05.000Z',
      message: { role: 'user', content: '继续', timestamp: 4 }
    }
  ]
  const sourceFile = path.join(sourceSessions, '2026-09-26T00-00-00-000Z_src-sess-0001.jsonl')
  fs.writeFileSync(sourceFile, sourceEntries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')

  const targetDir = path.join(tmpRoot, 'fork-sessions')
  const viewIdsOf = (file) => {
    const parsed = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
    return { parsed, view: pi.buildContextEntries(parsed).map((e) => e.id) }
  }

  check('forkFrom：新文件落在指定 sessionDir、header 记 parentSession', () => {
    const forked = pi.SessionManager.forkFrom(sourceFile, sourceCwd, targetDir)
    const newFile = forked.getSessionFile()
    assert(newFile && fs.existsSync(newFile), 'fork 应产出新 JSONL 文件')
    assert(path.dirname(newFile) === targetDir, '新文件应落在指定目录')
    const lines = fs.readFileSync(newFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const header = lines[0]
    assert(header.type === 'session', '首行应是 session 头')
    assert(header.parentSession === path.resolve(sourceFile), `header.parentSession 应指向源文件（实际 ${header.parentSession}）`)
    assert(header.id !== 'src-sess-0001', '新会话应有新 id')
    assert(header.cwd === sourceCwd, 'header.cwd 应为目标 cwd')
    return newFile
  })

  check('forkFrom：全部非 header entry 逐条拷贝（含图块与压缩条目）', () => {
    const forked = pi.SessionManager.forkFrom(sourceFile, sourceCwd, targetDir)
    const newFile = forked.getSessionFile()
    const sourceParsed = fs.readFileSync(sourceFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const forkParsed = fs.readFileSync(newFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    assert(forkParsed.length === sourceParsed.length, `条目数应一致（源 ${sourceParsed.length}，fork ${forkParsed.length}）`)
    const sourceBody = sourceParsed.filter((e) => e.type !== 'session')
    const forkBody = forkParsed.filter((e) => e.type !== 'session')
    assert(JSON.stringify(forkBody) === JSON.stringify(sourceBody), '非 header entry 应逐字节一致（图块/工具上下文全带走）')
  })

  check('forkFrom：压缩视图与源一致（上下文水位语义相同）', () => {
    const forked = pi.SessionManager.forkFrom(sourceFile, sourceCwd, targetDir)
    const newFile = forked.getSessionFile()
    const source = viewIdsOf(sourceFile)
    const fork = viewIdsOf(newFile)
    assert(JSON.stringify(source.view) === JSON.stringify(fork.view), 'buildContextEntries 视图应一致')
    assert(fork.view.includes('s4') && fork.view.includes('c1'), '视图应含压缩分界与 kept entry')
    assert(!fork.view.includes('s1'), '压缩点之前的消息不应在视图里')
  })

  check('loadEntriesFromFile 可读 fork 产物（计划 T5 验证项；session-manager 的 testing 导出）', () => {
    const forked = pi.SessionManager.forkFrom(sourceFile, sourceCwd, targetDir)
    const newFile = forked.getSessionFile()
    const loaded = sessionManagerModule.loadEntriesFromFile(newFile)
    assert(Array.isArray(loaded) && loaded.length === sourceEntries.length, `loadEntriesFromFile 应读到 ${sourceEntries.length} 条 entry`)
    assert(loaded[0].type === 'session' && loaded[0].parentSession === path.resolve(sourceFile), '首条应是带 parentSession 的 header')
  })

  check('forkFrom 空文件报错（渲染端以此走 session_missing 分支）', () => {
    const emptyFile = path.join(targetDir, 'empty.jsonl')
    fs.writeFileSync(emptyFile, '', 'utf8')
    let threw = false
    try {
      pi.SessionManager.forkFrom(emptyFile, sourceCwd, targetDir)
    } catch {
      threw = true
    }
    assert(threw, '空源文件应抛错（host 转 session_missing，渲染端退回复制空历史）')
  })
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const r of failed) console.error(`FAILED: ${r.name} — ${r.detail}`)
}
