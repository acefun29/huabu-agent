/**
 * 历史回放保真自检（T4 的回归锁）。
 *
 * 运行：pnpm session-history:check
 *
 * 用**真的 pi.buildContextEntries**（包根导出）驱动 main/agent/history.ts 的纯函数，
 * fixture JSONL entries 覆盖：
 * - 注入段拆分（[引用素材 · 共 N 项] 头 → 正文 / contextPayload 两段）；
 * - 工具卡配对（toolCallId → status/resultText；错误结果标 error；无结果的标失败）；
 * - 图片槽位登记（原图 base64 不出本层，带配对 toolCall 参数里的源路径 label）；
 * - 压缩截断 inContext 标记（压缩点之前的消息 inContext=false）；
 * - compaction / branch_summary 分隔条目重建；
 * - 无图会话零冗余（images 字段不出现）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'session-history-check-tmp')

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
  path.join('src', 'main', 'agent', 'history.ts'),
  path.join('src', 'main', 'agent', 'serialize.ts'),
  path.join('src', 'shared', 'injection.ts')
])

const history = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'main', 'agent', 'history.js')))
const pi = await import('@earendil-works/pi-coding-agent')

/** 真 pi 视图构建（与 host.readSessionHistory 同一注入形态） */
const buildWithPi = (list) => pi.buildContextEntries(list)

/* ---------------- fixture：压缩截断 + 工具卡 + 注入段 ---------------- */

const entries = [
  // 头部（应被忽略）
  { type: 'session', version: 3, id: 'sess', cwd: '/tmp/w', timestamp: 't0' },
  // 压缩点之前（应标 inContext:false）
  {
    type: 'message', id: 'a1', parentId: null, timestamp: 't1',
    message: { role: 'user', content: '帮我看看这张参考图', timestamp: 1 }
  },
  {
    type: 'message', id: 'a2', parentId: 'a1', timestamp: 't2',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '用户想让我先读图' },
        { type: 'toolCall', id: 'tc1', name: 'read_media', arguments: { path: 'E:/assets/ref.png' } },
        { type: 'text', text: '收到，我来读图' }
      ],
      model: 'provider-a/model-a', stopReason: 'toolUse', timestamp: 2
    }
  },
  {
    type: 'message', id: 'a3', parentId: 'a2', timestamp: 't3',
    message: {
      role: 'toolResult', toolCallId: 'tc1', toolName: 'read_media', isError: false, timestamp: 3,
      content: [
        { type: 'text', text: '图片内容如下：一只橘猫' },
        { type: 'image', data: 'ZmFrZS1pbWFnZS1kYXRh', mimeType: 'image/png' }
      ]
    }
  },
  {
    type: 'message', id: 'a4', parentId: 'a3', timestamp: 't4',
    message: { role: 'assistant', content: [{ type: 'text', text: '这是一只橘猫' }], stopReason: 'stop', model: 'provider-a/model-a', timestamp: 4 }
  },
  // 压缩分界：firstKept = a5（a4 之后的这条 user 保留）
  {
    type: 'compaction', id: 'c1', parentId: 'a4', timestamp: 't5',
    summary: '此前完成了参考图阅读与描述。', firstKeptEntryId: 'a5', tokensBefore: 50000
  },
  {
    type: 'message', id: 'a5', parentId: 'c1', timestamp: 't6',
    message: { role: 'user', content: '那再画一只', timestamp: 5 }
  },
  // 压缩后的 user 消息带注入段（应拆出 contextPayload）
  {
    type: 'message', id: 'a6', parentId: 'a5', timestamp: 't7',
    message: {
      role: 'user', timestamp: 6,
      content: '结合素材再改一版\n\n[引用素材 · 共 1 项]（仅传入绝对路径，文件内容不随消息携带，请按路径自行读取）\n- [图片 · 工作区素材] E:/assets/new.png\n\n[素材库清单]（共 1 库；引用任一文件时请在消息中给出它的绝对路径）\n- 素材归档 / assets/new.png → E:/w/assets/new.png'
    }
  },
  {
    type: 'message', id: 'a7', parentId: 'a6', timestamp: 't8',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc-lost', name: 'read', arguments: { path: 'E:/x.txt' } }],
      stopReason: 'toolUse', timestamp: 7
    }
  },
  // tc-lost 的结果缺失（会话中断）→ 工具卡应标失败
  {
    type: 'message', id: 'a8', parentId: 'a7', timestamp: 't9',
    message: { role: 'assistant', content: [{ type: 'text', text: '继续' }], stopReason: 'stop', timestamp: 8 }
  }
]

const built = history.buildSessionHistory(entries, buildWithPi)
const byText = (text) => built.messages.find((m) => m.text === text)

check('注入段拆分：正文与 contextPayload 两段', () => {
  const user = byText('结合素材再改一版')
  assert(user, '应存在该 user 消息')
  assert(user.contextPayload, '应拆出注入段')
  assert(user.contextPayload.startsWith('[引用素材 · 共 1 项]'), '注入段应以引用素材头开始')
  assert(user.contextPayload.includes('[素材库清单]'), '注入段应包含素材库清单')
  assert(!user.text.includes('[引用素材'), '正文不应再含注入头')
  assert(user.inContext === undefined, '压缩后的消息应 inContext 缺省（=在上下文中）')
  // 无注入段的 user 不产生 contextPayload
  const plain = byText('帮我看看这张参考图')
  assert(plain && plain.contextPayload === undefined, '无注入段的 user 不应有 contextPayload')
})

check('工具卡配对：status/resultText 按结果回填', () => {
  const assistant = byText('收到，我来读图')
  assert(assistant && assistant.blocks, 'assistant 应有 blocks')
  const toolBlock = assistant.blocks.find((b) => b.kind === 'tool')
  assert(toolBlock && toolBlock.toolCall.id === 'tc1', '应存在工具卡 tc1')
  assert(toolBlock.toolCall.status === 'done', '有成功结果应标 done')
  assert(toolBlock.toolCall.resultText === '图片内容如下：一只橘猫', 'resultText 应取自 toolResult 文本')
  // thinking/text 块同在
  assert(assistant.blocks.some((b) => b.kind === 'thinking'), 'thinking 块应保留')
  const textBlock = assistant.blocks.find((b) => b.kind === 'text')
  assert(textBlock && textBlock.text === '收到，我来读图', 'text 块应保留')
  assert(assistant.model === 'provider-a/model-a' && assistant.stopReason === 'toolUse', 'model/stopReason 应透传')
})

check('图片槽位登记：挂在工具卡上、label 取参数里的源路径、原图不外泄', () => {
  assert(built.images.length === 1, `应登记 1 个图片槽位，实际 ${built.images.length}`)
  const slot = built.images[0]
  const assistant = byText('收到，我来读图')
  const assistantIndex = built.messages.indexOf(assistant)
  assert(slot.messageIndex === assistantIndex, '槽位应指向含工具卡的消息')
  assert(slot.toolCallId === 'tc1', '槽位应挂到工具卡')
  assert(slot.label === 'E:/assets/ref.png', 'label 应取配对 toolCall 参数里的源路径')
  assert(slot.data === 'ZmFrZS1pbWFnZS1kYXRh', '槽位携带原图 base64（仅主进程内可见）')
  // 消息本体此时还没有 images 字段（缩略由 host 回填）
  assert(byText('帮我看看这张参考图').images === undefined, 'user 消息无图片时不应有 images 字段')
})

check('压缩截断 inContext 标记：压缩点之前的消息全部淡化', () => {
  for (const text of ['帮我看看这张参考图', '收到，我来读图', '这是一只橘猫']) {
    const m = byText(text)
    assert(m && m.inContext === false, `"${text}" 应标 inContext=false`)
  }
  for (const text of ['那再画一只', '结合素材再改一版', '继续']) {
    const m = byText(text)
    assert(m && m.inContext === undefined, `"${text}" 应在上下文中（inContext 缺省）`)
  }
})

check('compaction 分隔条目重建（与流式分隔条同形）', () => {
  const divider = built.messages.find((m) => m.entryKind === 'compaction')
  assert(divider, '应存在压缩分隔条')
  assert(divider.compaction.summary === '此前完成了参考图阅读与描述。', '分隔条应带摘要')
  assert(divider.compaction.tokensBefore === 50000, '分隔条应带 tokensBefore')
  assert(divider.estimatedTokensAfter === undefined, '无 estimatedTokensAfter 时缺省')
  // 压缩条目本身在视图里（pi 语义：压缩点由 entry 自身代表）→ 不标 inContext=false
  assert(divider.inContext === undefined, '最新压缩分界在上下文中')
})

check('无结果工具卡标失败（不留假「完成」）', () => {
  const assistant = byText('继续')
  // tc-lost 的卡片挂在 a7 的 assistant 上
  const pending = built.messages.find((m) => m.blocks?.some((b) => b.kind === 'tool' && b.toolCall.id === 'tc-lost'))
  assert(pending, '应找到含 tc-lost 的消息')
  const toolBlock = pending.blocks.find((b) => b.kind === 'tool' && b.toolCall.id === 'tc-lost')
  assert(toolBlock.toolCall.status === 'error', '无结果记录的工具卡应标 error')
  assert(toolBlock.toolCall.resultText === '（无工具结果记录）', '应给出可读说明')
})

/* ---------------- branch_summary 分隔条 ---------------- */

check('branch_summary 同形重建为分隔条', () => {
  const built2 = history.buildSessionHistory(
    [
      { type: 'message', id: 'b1', parentId: null, timestamp: 't', message: { role: 'user', content: 'hi', timestamp: 1 } },
      { type: 'branch_summary', id: 'b2', parentId: 'b1', timestamp: 't', fromId: 'b1', summary: '分支摘要内容' }
    ],
    buildWithPi
  )
  const divider = built2.messages.find((m) => m.entryKind === 'compaction')
  assert(divider && divider.compaction.summary === '分支摘要内容', 'branch_summary 应重建为分隔条')
  assert(divider.compaction.tokensBefore === undefined, 'branch_summary 无 tokensBefore')
})

/* ---------------- 无图会话零冗余 + 坏行容错 ---------------- */

check('无图会话零冗余：images 槽位为空、消息无 images 字段', () => {
  const built3 = history.buildSessionHistory(
    [
      { type: 'message', id: 'z1', parentId: null, timestamp: 't', message: { role: 'user', content: '纯文本', timestamp: 1 } },
      { type: 'message', id: 'z2', parentId: 'z1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: '回复' }], stopReason: 'stop', timestamp: 2 } }
    ],
    buildWithPi
  )
  assert(built3.images.length === 0, '不应有图片槽位')
  assert(built3.messages.every((m) => m.images === undefined), '消息不应带 images 字段')
})

check('视图构建失败时退化为全量淡化（不丢历史）', () => {
  const built4 = history.buildSessionHistory(entries, () => {
    throw new Error('boom')
  })
  assert(built4.messages.length > 0, '消息仍应全部保留')
  assert(built4.messages.every((m) => m.inContext === false), '视图失败时应全部标 inContext=false')
})

check('splitUserInjection 边界：头在开头不拆、纯正文不拆', () => {
  const whole = history.splitUserInjection('[素材库清单]（共 1 库）\n- x')
  assert(whole.contextPayload === undefined, '正文为空时不拆（整条按正文展示）')
  const plain = history.splitUserInjection('普通消息')
  assert(plain.body === '普通消息' && plain.contextPayload === undefined, '纯正文不拆')
  const split = history.splitUserInjection('正文\n\n[画布态势]（画布上共 1 张卡片）\n- 卡')
  assert(split.body === '正文' && split.contextPayload.startsWith('[画布态势]'), '画布态势头也应触发拆分')
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  process.exitCode = 1
  for (const r of failed) console.error(`FAILED: ${r.name} — ${r.detail}`)
}
