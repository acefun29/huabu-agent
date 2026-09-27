/**
 * 上下文分布明细自检（T3 的回归锁）。
 *
 * 运行：pnpm context-breakdown:check
 *
 * 用**真的 pi 包根导出**（estimateTokens / calculateContextTokens / buildContextEntries）
 * 驱动 main/agent/breakdown.ts 的纯函数，断言：
 * - 分桶归类（user / assistant_text / thinking / tool_call / tool_result）与 pi 的
 *   estimateTokens 逐消息口径完全吻合（桶合计 === 逐消息估算之和，零差值）；
 * - 图片按 1200 token/张计入 images 桶且带张数；
 * - 校准总量 = 末次有效 usage + 尾随估算，差值全部进「未归因」桶；
 * - 压缩截断后旧 entry 不计入（视图经真 pi.buildContextEntries 构建）；
 * - 工具桶按工具名 top-N 细分。
 */
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'context-breakdown-check-tmp')

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

function transpileAll(relFiles) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  for (const rel of relFiles) {
    const file = path.join(PROJECT_ROOT, rel)
    const target = path.join(OUT_DIR, rel.replace(/\.ts$/, '.js'))
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

// @shared/* 重定向到转译产物（breakdown.ts 只做类型导入，通常不需要；兜底保留）
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@shared/')) {
    return origResolve.call(this, path.join(OUT_DIR, 'src', 'shared', request.slice('@shared/'.length)), parent, ...rest)
  }
  return origResolve.call(this, request, parent, ...rest)
}

transpileAll([path.join('src', 'main', 'agent', 'breakdown.ts')])
const { computeContextBreakdown } = await import(
  pathToFileURL(path.join(OUT_DIR, 'src', 'main', 'agent', 'breakdown.js'))
)

// 真 pi：估算函数与视图构建都来自包根导出（脚本跑在纯 Node，与主进程无涉）
const pi = await import('@earendil-works/pi-coding-agent')
const deps = { estimateTokens: pi.estimateTokens, calculateContextTokens: pi.calculateContextTokens }

const bucketOf = (breakdown, key) => breakdown.buckets.find((b) => b.key === key)

check('分桶归类与 pi estimateTokens 逐消息口径零差值', () => {
  const userMsg = { role: 'user', content: 'a'.repeat(400), timestamp: 1 }
  const assistantMsg = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'b'.repeat(200) },
      { type: 'thinking', thinking: 'c'.repeat(100) },
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'x' } }
    ],
    timestamp: 2
  }
  const toolResultMsg = {
    role: 'toolResult',
    toolCallId: 't1',
    toolName: 'read',
    isError: false,
    content: [{ type: 'text', text: 'd'.repeat(80) }],
    timestamp: 3
  }
  const entries = [
    { type: 'message', id: 'e1', parentId: null, timestamp: 't', message: userMsg },
    { type: 'message', id: 'e2', parentId: 'e1', timestamp: 't', message: assistantMsg },
    { type: 'message', id: 'e3', parentId: 'e2', timestamp: 't', message: toolResultMsg }
  ]
  const breakdown = computeContextBreakdown(entries, deps)
  assert(bucketOf(breakdown, 'user').tokens === Math.ceil(400 / 4), 'user 桶应= chars/4')
  assert(bucketOf(breakdown, 'assistant_text').tokens === Math.ceil(200 / 4), 'assistant_text 桶应= chars/4')
  assert(bucketOf(breakdown, 'thinking').tokens === Math.ceil(100 / 4), 'thinking 桶应= chars/4')
  const expectedToolCall = Math.ceil(('read'.length + JSON.stringify({ path: 'x' }).length) / 4)
  assert(bucketOf(breakdown, 'tool_call').tokens === expectedToolCall, 'tool_call 桶应= (name+args)/4')
  assert(bucketOf(breakdown, 'tool_result').tokens === Math.ceil(80 / 4), 'tool_result 桶应= chars/4')
  // 桶合计必须与逐消息 estimateTokens 之和完全相等（同一口径的内部一致性）
  const perMessageSum = [userMsg, assistantMsg, toolResultMsg].reduce((sum, m) => sum + pi.estimateTokens(m), 0)
  const bucketSum = breakdown.buckets.filter((b) => b.key !== 'unattributed').reduce((s, b) => s + b.tokens, 0)
  assert(bucketSum === perMessageSum, `桶合计 ${bucketSum} 应等于逐消息估算 ${perMessageSum}`)
})

check('图片按 1200 token/张进 images 桶并带张数', () => {
  const entries = [
    {
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: 't',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '看这两张' }, { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }, { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }],
        timestamp: 1
      }
    }
  ]
  const breakdown = computeContextBreakdown(entries, deps)
  const images = bucketOf(breakdown, 'images')
  assert(images && images.images === 2, 'images 桶应带张数 2')
  assert(images.tokens === 2400, '图片应按 1200 token/张计')
  assert(bucketOf(breakdown, 'user').tokens === Math.ceil('看这两张'.length / 4), 'user 桶只计文本，不含图片')
  // 无图会话不产出 images 桶（零冗余）
  const noImage = computeContextBreakdown(
    [{ type: 'message', id: 'e1', parentId: null, timestamp: 't', message: { role: 'user', content: 'hi', timestamp: 1 } }],
    deps
  )
  assert(bucketOf(noImage, 'images') === undefined, '无图会话不应有 images 桶')
})

check('校准总量与未归因桶：差值全进 unattributed', () => {
  const usage = { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5000 }
  const entries = [
    { type: 'message', id: 'e1', parentId: null, timestamp: 't', message: { role: 'user', content: 'a'.repeat(400), timestamp: 1 } },
    {
      type: 'message',
      id: 'e2',
      parentId: 'e1',
      timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage, stopReason: 'stop', timestamp: 2 }
    },
    // 尾随消息：usage 之后的一条 user（80 chars → 20 tokens）
    { type: 'message', id: 'e3', parentId: 'e2', timestamp: 't', message: { role: 'user', content: 'b'.repeat(80), timestamp: 3 } }
  ]
  const breakdown = computeContextBreakdown(entries, deps, 128000)
  assert(breakdown.totalTokens === 5000 + 20, `校准总量应= 5000+20，实际 ${breakdown.totalTokens}`)
  assert(breakdown.contextWindow === 128000, 'contextWindow 应透传')
  const bucketSum = breakdown.buckets.filter((b) => b.key !== 'unattributed').reduce((s, b) => s + b.tokens, 0)
  const unattributed = bucketOf(breakdown, 'unattributed')
  assert(unattributed.tokens === breakdown.totalTokens - bucketSum, '差值应全部进未归因桶（系统提示词/工具定义/误差）')
  assert(Math.abs(breakdown.buckets.reduce((s, b) => s + b.share, 0) - 1) < 1e-6, 'share 合计应≈1')
})

check('无有效 usage 时 totalTokens=null（不硬编总数）', () => {
  const breakdown = computeContextBreakdown(
    [{ type: 'message', id: 'e1', parentId: null, timestamp: 't', message: { role: 'user', content: 'hi', timestamp: 1 } }],
    deps
  )
  assert(breakdown.totalTokens === null, '无 usage 应返回 null')
  const unattributed = bucketOf(breakdown, 'unattributed')
  assert(unattributed.tokens === 0, '无校准总量时未归因桶为 0（不臆造）')
})

check('压缩截断后旧 entry 不计入（视图经真 pi.buildContextEntries）', () => {
  const oldUser = { type: 'message', id: 'a1', parentId: null, timestamp: 't', message: { role: 'user', content: 'old'.repeat(100), timestamp: 1 } }
  const oldAssistant = {
    type: 'message',
    id: 'a2',
    parentId: 'a1',
    timestamp: 't',
    message: { role: 'assistant', content: [{ type: 'text', text: 'old reply'.repeat(50) }], timestamp: 2 }
  }
  const compaction = {
    type: 'compaction',
    id: 'c1',
    parentId: 'a2',
    timestamp: 't',
    summary: 's'.repeat(40),
    firstKeptEntryId: 'a3',
    tokensBefore: 9999
  }
  const keptUser = { type: 'message', id: 'a3', parentId: 'c1', timestamp: 't', message: { role: 'user', content: 'new'.repeat(20), timestamp: 3 } }
  const view = pi.buildContextEntries([oldUser, oldAssistant, compaction, keptUser])
  const viewIds = view.map((e) => e.id)
  assert(!viewIds.includes('a1') && !viewIds.includes('a2'), '压缩点之前的 entry 应被视图排除')
  const breakdown = computeContextBreakdown(view, deps)
  assert(bucketOf(breakdown, 'user').tokens === Math.ceil(60 / 4), 'user 桶只应计 keptUser（旧消息不计入）')
  assert(bucketOf(breakdown, 'compaction').tokens === Math.ceil(40 / 4), '压缩摘要应按 chars/4 计入 compaction 桶')
  assert(bucketOf(breakdown, 'compaction').summary === 's'.repeat(40), 'compaction 桶应带摘要')
})

check('工具桶按工具名 top-N 细分且降序', () => {
  const entries = [
    {
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'x'.repeat(400) } },
          { type: 'toolCall', id: 't2', name: 'write', arguments: { content: 'y'.repeat(100) } }
        ],
        timestamp: 1
      }
    }
  ]
  const breakdown = computeContextBreakdown(entries, deps)
  const tools = bucketOf(breakdown, 'tool_call').tools
  assert(tools.length === 2, '应有两个工具细分')
  assert(tools[0].name === 'read' && tools[0].tokens > tools[1].tokens, '应按 token 降序')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const r of failed) console.error(`FAILED: ${r.name} — ${r.detail}`)
}
