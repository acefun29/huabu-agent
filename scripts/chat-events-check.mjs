/**
 * 聊天事件链自检（T1 水位 / T2 压缩透明化的回归锁）。
 *
 * 运行：pnpm chat-events:check
 *
 * 断言对象是两层纯函数（不依赖 electron / pi 运行时）：
 * - main/agent/serialize.ts：compaction_start/end 翻译（三种 reason、aborted、
 *   result=undefined、errorMessage、摘要截 2000）、toContextUsageEvent
 *   （undefined → null、tokens=null 如实透传、contextWindow 无效 → null）；
 * - renderer/lib/chatStream.ts：context_usage / compaction_* 归约（水位保存、
 *   分隔条只在校成功时进 tail、aborted 不插条、agent_start 保留 tail）、
 *   compactGate（running / compacting 双禁用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'chat-events-check-tmp')

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

transpileAll([
  path.join('src', 'main', 'agent', 'serialize.ts'),
  path.join('src', 'renderer', 'src', 'lib', 'chatStream.ts'),
  path.join('src', 'renderer', 'src', 'lib', 'chatCommands.ts')
])

const serialize = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'main', 'agent', 'serialize.js')))
const chatStream = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'lib', 'chatStream.js')))
const chatCommands = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'lib', 'chatCommands.js')))

const translator = new serialize.EventTranslator('node-1')

check('compaction_start 三种 reason 原样翻译', () => {
  for (const reason of ['manual', 'threshold', 'overflow']) {
    const events = translator.translate({ type: 'compaction_start', reason })
    assert(events.length === 1, `应产出 1 个事件，实际 ${events.length}`)
    assert(events[0].type === 'compaction_start' && events[0].reason === reason, `reason ${reason} 未原样透传`)
    assert(events[0].nodeId === 'node-1', 'nodeId 应保留')
  }
  // 未知 reason 收敛为 threshold（UI 只标注不报错）
  const fallback = translator.translate({ type: 'compaction_start', reason: 'mystery' })
  assert(fallback[0].reason === 'threshold', '未知 reason 应回退 threshold')
})

check('compaction_end 成功形态：摘要截 2000 + tokens 字段', () => {
  const long = 'x'.repeat(3000)
  const events = translator.translate({
    type: 'compaction_end',
    reason: 'manual',
    aborted: false,
    result: { summary: long, firstKeptEntryId: 'e1', tokensBefore: 120000, estimatedTokensAfter: 24000 }
  })
  assert(events.length === 1, '应产出 1 个事件')
  const e = events[0]
  assert(e.type === 'compaction_end' && e.reason === 'manual' && e.aborted === false, '基础字段不对')
  assert(e.summary.length === 2001 && e.summary.endsWith('…'), '长摘要应截到 2000 加省略号')
  assert(e.tokensBefore === 120000 && e.estimatedTokensAfter === 24000, 'token 数字段应透传')
})

check('compaction_end 失败/中止形态：result 全缺省、aborted/errorMessage 照常', () => {
  const events = translator.translate({
    type: 'compaction_end',
    reason: 'threshold',
    aborted: true,
    willRetry: false,
    errorMessage: 'summarize failed'
  })
  const e = events[0]
  assert(e.aborted === true, 'aborted 应透传')
  assert(e.summary === undefined && e.tokensBefore === undefined && e.estimatedTokensAfter === undefined, 'result 缺省时字段应全缺省')
  assert(e.errorMessage === 'summarize failed', 'errorMessage 应透传')
})

check('agent_end 翻译不变（回归：usage/stopReason 仍在）', () => {
  const events = translator.translate({
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'stop', usage: { input: 10, output: 5, reasoning: 0, totalTokens: 15 } }]
  })
  assert(events[0].type === 'agent_end' && events[0].stopReason === 'stop', 'agent_end 应保持原语义')
  assert(events[0].usage && events[0].usage.input === 10, 'usage 应保留')
})

check('toContextUsageEvent：undefined → null（无模型/无窗口时不发假载荷）', () => {
  assert(serialize.toContextUsageEvent('n', undefined) === null, 'undefined 应返回 null')
  assert(serialize.toContextUsageEvent('n', null) === null, 'null 应返回 null')
  assert(serialize.toContextUsageEvent('n', { contextWindow: 0, tokens: 5, percent: 1 }) === null, 'contextWindow<=0 应返回 null')
})

check('toContextUsageEvent：tokens=null 如实透传（压缩后待下一轮）', () => {
  const event = serialize.toContextUsageEvent('n', { tokens: null, contextWindow: 128000, percent: null })
  assert(event && event.type === 'context_usage', '应产出 context_usage 事件')
  assert(event.tokens === null && event.percent === null, 'tokens/percent null 应如实透传')
  assert(event.contextWindow === 128000, 'contextWindow 应保留')
})

check('toContextUsageEvent：有效数字全透传', () => {
  const event = serialize.toContextUsageEvent('n', { tokens: 32000, contextWindow: 128000, percent: 25 })
  assert(event.tokens === 32000 && event.contextWindow === 128000 && event.percent === 25, '有效值应透传')
})

check('compactGate：running 与 compacting 双禁用且说清后果', () => {
  assert(serialize, 'serialize 已载入')
  const running = chatStream.compactGate(true, false)
  assert(running.disabled === true && /打断/.test(running.reason ?? ''), 'running 应禁用并说明会打断生成')
  const compacting = chatStream.compactGate(false, true)
  assert(compacting.disabled === true, 'compacting 应禁用')
  const idle = chatStream.compactGate(false, false)
  assert(idle.disabled === false, '空闲时应可用')
})

check('reduceChatEvent：水位保存 + 分隔条进 tail', () => {
  let state = chatStream.createStreamState()
  state = chatStream.reduceChatEvent(state, { nodeId: 'n', type: 'agent_start' })
  assert(state.running === true, 'agent_start 应置 running')
  state = chatStream.reduceChatEvent(state, {
    nodeId: 'n',
    type: 'context_usage',
    tokens: null,
    contextWindow: 128000,
    percent: null
  })
  assert(state.contextUsage.tokens === null && state.contextUsage.contextWindow === 128000, '水位 null 语义应保留')
  state = chatStream.reduceChatEvent(state, { nodeId: 'n', type: 'compaction_start', reason: 'threshold' })
  assert(state.compacting === true, '压缩开始应置 compacting')
  state = chatStream.reduceChatEvent(state, {
    nodeId: 'n',
    type: 'compaction_end',
    reason: 'threshold',
    aborted: false,
    summary: '摘要',
    tokensBefore: 100,
    estimatedTokensAfter: 40
  })
  assert(state.compacting === false, '压缩结束应解除 compacting')
  assert(state.tail.length === 1 && state.tail[0].compaction.summary === '摘要', '成功压缩应插入分隔条')
  assert(state.tail[0].compaction.tokensBefore === 100, '分隔条应带 tokensBefore')
  // 同一压缩事件重复归约 ⇒ 同 id（不是新 UUID）⇒ mergeStreamHistory 去重后只有一条
  state = chatStream.reduceChatEvent(state, {
    nodeId: 'n',
    type: 'compaction_end',
    reason: 'threshold',
    aborted: false,
    summary: '摘要',
    tokensBefore: 100,
    estimatedTokensAfter: 40
  })
  assert(state.tail.length === 2, '重复归约会追加第二条')
  assert(state.tail[0].id === state.tail[1].id, '同一压缩两次归约应产生同一个稳定 id')
  // aborted：不插条
  state = chatStream.reduceChatEvent(state, { nodeId: 'n', type: 'compaction_start', reason: 'manual' })
  const before = state.tail.length
  state = chatStream.reduceChatEvent(state, { nodeId: 'n', type: 'compaction_end', reason: 'manual', aborted: true })
  assert(state.tail.length === before && state.compacting === false, 'aborted 压缩不应插条')
  // agent_start 重置 drafts 但保留 tail 与水位
  state = chatStream.reduceChatEvent(state, { nodeId: 'n', type: 'agent_start' })
  assert(state.drafts.length === 0 && state.tail.length === before, '新一轮应清 drafts 保留 tail')
  assert(state.contextUsage !== undefined, '新一轮应保留水位')
})

check('compactionDividerId：内容相同 ⇒ id 相同；内容不同 ⇒ id 不同', () => {
  const a1 = chatStream.compactionDividerId('摘要A', 100, 40)
  const a2 = chatStream.compactionDividerId('摘要A', 100, 40)
  const b = chatStream.compactionDividerId('摘要B', 100, 40)
  const c = chatStream.compactionDividerId('摘要A', 200, 40)
  assert(a1 === a2, '同内容应得同 id（去重与回放对齐的前提）')
  assert(a1 !== b && a1 !== c, '摘要或 token 数不同应得不同 id')
  assert(String(a1).startsWith('compaction-'), 'id 应带前缀便于辨认')
})

check('mergeStreamHistory：tail 与前缀重复的分隔条被去重（真机重复 key 的回归锁）', () => {
  const prefix = [
    { id: 'm1', role: 'user', content: 'hi' },
    { id: 'd1', role: 'model', content: '回复' }
  ]
  const drafts = [{ id: 'd2', role: 'model', content: '草稿' }]
  const divider = { id: 'compaction-xyz', role: 'model', content: '摘要', compaction: { summary: '摘要' } }
  // 场景：分隔条先前已随 tail 固化进前缀（baseLen 抬高越过它），tail 里还留着同一条
  const merged = chatStream.mergeStreamHistory([...prefix, divider], drafts, [divider])
  assert(merged.length === 4, `应去重为 4 条，实际 ${merged.length}`)
  assert(merged.filter((m) => m.id === 'compaction-xyz').length === 1, '分隔条只应出现一次')
  // 前缀内的重复（异常数据）同样保首个
  const merged2 = chatStream.mergeStreamHistory([prefix[0], { ...prefix[0] }], [], [])
  assert(merged2.length === 1, '前缀内部重复也应去重')
  // 正常路径不丢内容
  const merged3 = chatStream.mergeStreamHistory(prefix, drafts, [])
  assert(merged3.length === 3 && merged3[2].id === 'd2', '正常合并顺序：前缀 → 草稿')
})

check('斜杠命令解析：命令/别名/未知/空白 与拦截开关', () => {
  assert(chatCommands.parseChatCommand('/compact')?.type === 'compact', '/compact 应命中')
  assert(chatCommands.parseChatCommand('  /compact  \n')?.type === 'compact', '前后空白应容忍')
  assert(chatCommands.parseChatCommand('/压缩')?.type === 'compact', '中文别名应命中')
  assert(chatCommands.parseChatCommand('/fork')?.type === 'fork', '/fork 应命中')
  assert(chatCommands.parseChatCommand('/分叉')?.type === 'fork', '中文别名应命中')
  assert(chatCommands.parseChatCommand('/compact now') === null, '带参数的形态不命中（本期无参数命令）')
  assert(chatCommands.parseChatCommand('普通消息') === null, '普通消息不是命令')
  assert(chatCommands.parseChatCommand('') === null, '空串不是命令')
  // 拦截开关：以 / 开头的一律进命令模式（防误发字面斜杠文本给模型）
  assert(chatCommands.isCommandInput('/x') === true, '/ 开头应进命令模式')
  assert(chatCommands.isCommandInput('  /x') === true, '前导空白后 / 也算')
  assert(chatCommands.isCommandInput('a /x') === false, '正文中的 / 不算')
})

check('斜杠命令建议过滤：前缀匹配名与别名', () => {
  assert(chatCommands.filterCommands('/').length === 2, '裸 / 应列出全部命令')
  assert(chatCommands.filterCommands('/co').length === 1 && chatCommands.filterCommands('/co')[0].name === '/compact', '前缀应过滤')
  assert(chatCommands.filterCommands('/压').length === 1, '中文别名前缀也应过滤')
  assert(chatCommands.filterCommands('/nothing').length === 0, '无匹配返回空（UI 隐藏建议，回车 toast 未知命令）')
  assert(chatCommands.filterCommands('普通').length === 0, '非命令输入不给建议')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const r of failed) console.error(`FAILED: ${r.name} — ${r.detail}`)
}
