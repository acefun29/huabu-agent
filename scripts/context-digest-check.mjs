/**
 * 逐轮上下文采集自检（T9 素材库摘要 / T10 画布态势 / T11 生成卡回喂 的回归锁）。
 *
 * 运行：pnpm context-digest:check
 *
 * 这三个任务都落在 store/canvas/contextCollector.ts 的纯函数上——"发给模型的清单
 * 长什么样"不该只在真机上靠人眼验一次。断言的是文本内容与截断规则本身：
 *
 *   T9 素材库摘要：空清单零注入 / 行含绝对路径 / 单库与库数上限折叠 / 空库标注
 *   T10 画布态势：空画布零注入 / 选中与注入态标注 / 生成卡状态与参数 / 卡片上限折叠
 *   T11 产物回喂：带 gen 的卡片附 genSummary（状态+提示词+参数+版本数）/ 长提示词截断
 *   载荷格式：buildReferencePayload 行尾附加 genSummary
 *   逐轮去重（token 经济）：未变化摘要折叠占位 / genSummary 只在首次或变化时携带 /
 *   不带新参数时行为与旧版逐字一致（向后兼容锁）
 */
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'context-digest-check-tmp')

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

/** 镜像目录结构转译（保留相对 require），并把 @shared/* 解析到 src/shared/* */
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

const origResolve = Module._resolveFilename
// @shared/* 重定向到 OUT_DIR 里的**转译产物**（Node 解析不了 .ts 源码）；
// assetCategories 对 @shared/assets 做值再导出，这步不 hook 就 MODULE_NOT_FOUND
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@shared/')) {
    const target = path.join(OUT_DIR, 'src', 'shared', request.slice('@shared/'.length))
    return origResolve.call(this, target, parent, ...rest)
  }
  return origResolve.call(this, request, parent, ...rest)
}

transpileAll([
  path.join('src', 'renderer', 'src', 'store', 'canvas', 'contextCollector.ts'),
  path.join('src', 'renderer', 'src', 'harness', 'assetCategories.ts'),
  path.join('src', 'renderer', 'src', 'harness', 'prompt.ts'),
  path.join('src', 'renderer', 'src', 'types.ts'),
  path.join('src', 'shared', 'assets.ts'),
  path.join('src', 'shared', 'prompt.ts'),
  path.join('src', 'shared', 'injection.ts')
])

const collector = (await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'store', 'canvas', 'contextCollector.js'))).then(
  (m) => m.default ?? m
))
const promptMod = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'harness', 'prompt.js')))
const injectionMod = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'shared', 'injection.js')))

const WS = '/ws-root'
/** 造卡片数据（只填 digest 用到的字段） */
function card(name, extra = {}) {
  return { id: name, type: 'asset', data: { name, kind: 'image', ...extra } }
}
function lib(name, relPaths, extra = {}) {
  return {
    id: name,
    name,
    path: `libraries/${name}`,
    files: relPaths.map((relPath) => ({ name: relPath.split('/').pop(), kind: 'image', relPath, bytes: 1 })),
    ...extra
  }
}

/* ---------------- T9 素材库摘要 ---------------- */

check('T9 空清单 ⇒ 零注入（contextText 不含素材库段）', () => {
  const out = collector.collectRoundContext({
    selectedAssetIds: [], injectedAssetIds: [], nodes: [], tempAttachments: [], workspaceDir: WS, libraries: []
  })
  assert(out.contextText === '', `contextText=${JSON.stringify(out.contextText)}`)
  return '空库 + 空画布 = 不加任何文本'
})

check('T9 摘要行含库名 / 相对路径 / 可直接引用的绝对路径', () => {
  const out = collector.collectRoundContext({
    selectedAssetIds: [], injectedAssetIds: [], nodes: [], tempAttachments: [], workspaceDir: WS,
    libraries: [lib('产品图库', ['libraries/产品图库/poster.png', 'libraries/产品图库/logo.png'])]
  })
  const text = out.contextText
  assert(text.includes('素材库清单'), '缺标题')
  assert(text.includes('产品图库 / libraries/产品图库/poster.png'), `缺条目行：${text}`)
  assert(text.includes(`${WS}/libraries/产品图库/poster.png`), '缺绝对路径（Agent 要按它引用）')
  return `${text.split('\n').length} 行`
})

check('T9 单库超上限 ⇒ 折叠为「另有 N 个文件未列出」', () => {
  const many = Array.from({ length: collector.LIBRARY_DIGEST_FILES_PER_LIB + 3 }, (_, i) => `libraries/l/f${i}.png`)
  const text = collector.buildLibraryDigest([lib('大库', many)], WS)
  assert(text.includes(`另有 3 个文件未列出`), `缺折叠行：${text}`)
  const listed = text.split('\n').filter((l) => l.includes('→')).length
  assert(listed === collector.LIBRARY_DIGEST_FILES_PER_LIB, `实际列出 ${listed} 行`)
  return `列出 ${listed} + 折叠 3`
})

check('T9 库数超上限 ⇒ 折叠为「另有 N 个素材库」', () => {
  const libs = Array.from({ length: collector.LIBRARY_DIGEST_MAX_LIBS + 2 }, (_, i) => lib(`库${i}`, [`x/${i}.png`]))
  const text = collector.buildLibraryDigest(libs, WS)
  assert(text.includes(`另有 2 个素材库未列出`), `缺折叠行：${text}`)
  return `${collector.LIBRARY_DIGEST_MAX_LIBS + 2} 库 → 折叠 2`
})

check('T9 空库 ⇒ 标注「暂无文件」（Agent 能区分"没这库"与"库是空的"）', () => {
  const text = collector.buildLibraryDigest([lib('空库', [])], WS)
  assert(text.includes('暂无文件'), `缺空库标注：${text}`)
  return '一行'
})

/* ---------------- T10 画布态势 ---------------- */

check('T10 空画布 ⇒ 零注入', () => {
  const text = collector.buildCanvasDigest([], [], [])
  assert(text === '', `text=${JSON.stringify(text)}`)
  return '空串'
})

check('T10 卡片行含类型 / 路径，selected 标「已选中」', () => {
  const nodes = [card('封面.png', { storage: 'ws', path: 'assets/images/封面.png' })]
  const text = collector.buildCanvasDigest(nodes, [nodes[0].id], [])
  assert(text.includes('画布态势'), '缺标题')
  assert(text.includes('已选中'), '缺选中标注')
  assert(text.includes('图片'), '缺类型标签')
  assert(text.includes('assets/images/封面.png'), '缺路径')
  return '单卡'
})

check('T10 injected（非 selected）标「已注入上下文」', () => {
  const nodes = [card('a.png')]
  const text = collector.buildCanvasDigest(nodes, [], [nodes[0].id])
  const cardLine = text.split('\n').find((l) => l.startsWith('- 卡片'))
  assert(cardLine.includes('已注入上下文'), `缺注入标注：${cardLine}`)
  assert(!cardLine.includes('已选中'), '不应标已选中')
  return 'chip 语义区分'
})

check('T10 生成卡 ⇒ 状态 + 提示词 + 参考数 + 版本数；无产物标「尚无产物」', () => {
  const nodes = [
    card('生成中卡', {
      gen: { prompt: '一只猫', refs: ['x'], params: { ratio: '1:1' }, status: 'running', progress: 0.5, versions: [] }
    }),
    card('已完成的卡', {
      storage: 'ws',
      path: 'assets/images/cat.png',
      gen: { prompt: '', refs: [], params: { ratio: '9:16' }, status: 'succeeded', progress: 1, versions: [{ id: 'v1' }] }
    })
  ]
  const text = collector.buildCanvasDigest(nodes, [], [])
  assert(text.includes('生成中'), `缺 running 标注：${text}`)
  assert(text.includes('尚无产物'), '无产物的生成卡没有标注')
  assert(text.includes('提示词"一只猫"'), '缺提示词')
  assert(text.includes('参考 1 张'), '缺参考数')
  assert(text.includes('1 版'), '缺版本数')
  assert(text.includes('已完成'), 'succeeded 卡缺状态词')
  return '两张生成卡'
})

check('T10 卡片超上限 ⇒ 折叠为「另有 N 张卡片」', () => {
  const nodes = Array.from({ length: collector.CANVAS_DIGEST_MAX_CARDS + 5 }, (_, i) => card(`c${i}.png`))
  const text = collector.buildCanvasDigest(nodes, [], [])
  assert(text.includes(`另有 5 张卡片未列出`), `缺折叠行：${text}`)
  return `${nodes.length} 张 → 折叠 5`
})

/* ---------------- T11 生成卡回喂 ---------------- */

check('T11 带 gen 的卡片 ⇒ attachment 附 genSummary（状态/提示词/参数/版本数）', () => {
  const out = collector.collectRoundContext({
    selectedAssetIds: ['g'], injectedAssetIds: [], workspaceDir: WS,
    tempAttachments: [],
    nodes: [
      card('g', {
        storage: 'ws',
        path: 'assets/images/cat.png',
        gen: {
          prompt: 'a cute cat poster',
          refs: [],
          params: { ratio: '3:4', model: 'fal/flux-2-flash' },
          status: 'succeeded',
          progress: 1,
          versions: [{ id: 'v1' }, { id: 'v2' }],
          activeVersionId: 'v2'
        }
      })
    ],
    libraries: []
  })
  assert(out.attachments.length === 1, `附件数=${out.attachments.length}`)
  const s = out.attachments[0].genSummary
  assert(typeof s === 'string' && s.length > 0, 'genSummary 缺失')
  assert(s.includes('a cute cat poster'), '缺提示词')
  assert(s.includes('3:4'), '缺比例')
  assert(s.includes('fal/flux-2-flash'), '缺模型')
  assert(s.includes('共 2 版'), '缺版本数')
  return s.slice(0, 60)
})

check('T11 长提示词 ⇒ genSummary 截断到 80 字符（清单不吃上下文预算）', () => {
  const long = '喵'.repeat(200)
  const out = collector.collectRoundContext({
    selectedAssetIds: ['g'], injectedAssetIds: [], workspaceDir: WS, tempAttachments: [],
    nodes: [
      card('g', {
        storage: 'ws', path: 'assets/images/x.png',
        gen: { prompt: long, refs: [], params: { ratio: '1:1' }, status: 'succeeded', progress: 1, versions: [{ id: 'v' }] }
      })
    ],
    libraries: []
  })
  const s = out.attachments[0].genSummary
  assert(s.includes('喵'.repeat(80)) && !s.includes('喵'.repeat(81)), '截断点不是 80')
  return `提示词段 ${Math.min(200, 80)} 字`
})

check('T11 无 gen 的卡片 ⇒ 不带 genSummary 字段（普通引用行不变）', () => {
  const out = collector.collectRoundContext({
    selectedAssetIds: ['n'], injectedAssetIds: [], workspaceDir: WS, tempAttachments: [],
    nodes: [card('n', { storage: 'ws', path: 'assets/images/plain.png' })],
    libraries: []
  })
  assert(out.attachments[0].genSummary === undefined, '不应有 genSummary')
  return '普通卡片零变化'
})

check('T11 无产物的生成卡（queued/running）不进引用载荷，只进画布态势', () => {
  const out = collector.collectRoundContext({
    selectedAssetIds: ['g'], injectedAssetIds: [], workspaceDir: WS, tempAttachments: [],
    nodes: [
      card('g', {
        gen: { prompt: 'x', refs: [], params: { ratio: '1:1' }, status: 'queued', progress: 0, versions: [] }
      })
    ],
    libraries: []
  })
  assert(out.attachments.length === 0, `无产物不应发路径：${JSON.stringify(out.attachments)}`)
  assert(out.contextText.includes('排队中') && out.contextText.includes('尚无产物'), '画布态势里看不到它')
  return '载荷干净 + 态势可见'
})

/* ---------------- 载荷格式（prompt.ts） ---------------- */

check('buildReferencePayload ⇒ genSummary 附加在引用行尾', () => {
  const text = promptMod.buildReferencePayload([
    { id: 'a', name: 'cat.png', kind: 'image', absPath: `${WS}/assets/images/cat.png`, origin: 'workspace-asset', genSummary: '生成卡片「cat.png」：已完成' }
  ])
  assert(text.includes(`${WS}/assets/images/cat.png`), '缺绝对路径')
  assert(text.includes('（生成卡片「cat.png」：已完成）'), `genSummary 没上载荷：${text}`)
  const plain = promptMod.buildReferencePayload([
    { id: 'b', name: 'x.png', kind: 'image', absPath: `${WS}/x.png`, origin: 'temp-upload' }
  ])
  assert(!plain.includes('（生成卡片'), '普通附件不应有括注')
  return '两形态'
})

/* ---------------- 逐轮去重（token 经济） ---------------- */

check('向后兼容：不带新参数 ⇒ contextText 仍为两段全文拼接、genSummary 照带（旧版行为逐字一致）', () => {
  const genCard = card('g', {
    storage: 'ws', path: 'assets/images/cat.png',
    gen: { prompt: '一只猫', refs: [], params: { ratio: '1:1' }, status: 'succeeded', progress: 1, versions: [{ id: 'v1' }] }
  })
  const nodes = [card('封面.png', { storage: 'ws', path: 'assets/images/封面.png' }), genCard]
  const out = collector.collectRoundContext({
    selectedAssetIds: ['g'], injectedAssetIds: [], workspaceDir: WS, tempAttachments: [],
    nodes,
    libraries: [lib('产品图库', ['libraries/产品图库/poster.png'])]
  })
  const expected = [
    collector.buildLibraryDigest([lib('产品图库', ['libraries/产品图库/poster.png'])], WS),
    collector.buildCanvasDigest(nodes, ['g'], [])
  ].filter(Boolean).join('\n\n')
  assert(out.contextText === expected, `contextText 与旧版全文拼接不一致：${out.contextText}`)
  assert(!out.contextText.includes('（与上轮一致'), '不带新参数不应出现折叠占位')
  assert(typeof out.attachments.find((a) => a.name === 'g')?.genSummary === 'string', '不带新参数 genSummary 应照带')
  assert(out.digests.library.includes('poster.png') && out.digests.canvas.includes('封面.png'), 'digests 出参应为全文')
  assert(out.genSummarySeen.g === 'succeeded|1|一只猫', `签名口径不符：${out.genSummarySeen.g}`)
})

check('去重：两段摘要与上轮一致 ⇒ 各折叠为「头+未变化」单行占位；digests 出参仍是全文', () => {
  const nodes = [card('封面.png', { storage: 'ws', path: 'assets/images/封面.png' })]
  const libraries = [lib('产品图库', ['libraries/产品图库/poster.png'])]
  const first = collector.collectRoundContext({
    selectedAssetIds: [], injectedAssetIds: [], nodes, tempAttachments: [], workspaceDir: WS, libraries
  })
  const second = collector.collectRoundContext({
    selectedAssetIds: [], injectedAssetIds: [], nodes, tempAttachments: [], workspaceDir: WS, libraries,
    previousDigests: first.digests
  })
  const libNote = `${injectionMod.LIBRARY_DIGEST_HEADER}${injectionMod.DIGEST_UNCHANGED_NOTE}`
  const canvasNote = `${injectionMod.CANVAS_DIGEST_HEADER}${injectionMod.DIGEST_UNCHANGED_NOTE}`
  assert(second.contextText.includes(libNote), `库清单段未折叠为占位：${second.contextText}`)
  assert(second.contextText.includes(canvasNote), `画布态势段未折叠为占位：${second.contextText}`)
  assert(!second.contextText.includes('poster.png'), '折叠后不应再含文件列表行')
  assert(!second.contextText.includes('封面.png'), '折叠后不应再含卡片清单行')
  // 两段各折叠为单行、段间仍以空行分隔（与全文形态同构）
  assert(second.contextText === `${libNote}\n\n${canvasNote}`, `占位形态应为两段单行：${JSON.stringify(second.contextText)}`)
  assert(
    second.digests.library === first.digests.library && second.digests.canvas === first.digests.canvas,
    'digests 出参应仍是全文（供下轮继续比较）'
  )
  assert(second.digests.library.includes('poster.png'), 'digests.library 存的应是全量而非占位')
})

check('去重：库清单变化、画布未变 ⇒ 库段全文 + 画布段占位（逐段独立判断）', () => {
  const nodes = [card('封面.png', { storage: 'ws', path: 'assets/images/封面.png' })]
  const first = collector.collectRoundContext({
    selectedAssetIds: [], injectedAssetIds: [], nodes, tempAttachments: [], workspaceDir: WS,
    libraries: [lib('库A', ['a/1.png'])]
  })
  const second = collector.collectRoundContext({
    selectedAssetIds: [], injectedAssetIds: [], nodes, tempAttachments: [], workspaceDir: WS,
    libraries: [lib('库B', ['b/2.png'])],
    previousDigests: first.digests
  })
  assert(second.contextText.includes('库B / b/2.png'), '变化的库段应是全文')
  assert(!second.contextText.includes('库A'), '旧库内容不应残留')
  const canvasNote = `${injectionMod.CANVAS_DIGEST_HEADER}${injectionMod.DIGEST_UNCHANGED_NOTE}`
  assert(second.contextText.endsWith(canvasNote), `未变的画布段应折叠为占位并排在最后：${second.contextText}`)
})

check('去重：genSummary 首轮带 ⇒ 签名一致二轮不带 ⇒ 改提示词后又带', () => {
  const round = (prompt, seen) =>
    collector.collectRoundContext({
      selectedAssetIds: ['g'], injectedAssetIds: [], workspaceDir: WS, tempAttachments: [],
      nodes: [
        card('g', {
          storage: 'ws', path: 'assets/images/cat.png',
          gen: { prompt, refs: [], params: { ratio: '1:1' }, status: 'succeeded', progress: 1, versions: [{ id: 'v1' }] }
        })
      ],
      libraries: [],
      ...(seen ? { genSummarySeen: seen } : {})
    })
  const first = round('一只猫')
  assert(first.attachments[0].genSummary?.includes('一只猫'), '首轮应携带 genSummary')
  assert(first.genSummarySeen.g === 'succeeded|1|一只猫', `签名口径不符：${first.genSummarySeen.g}`)
  const second = round('一只猫', first.genSummarySeen)
  assert(second.attachments[0].genSummary === undefined, '签名一致不应重复携带 genSummary')
  assert(second.genSummarySeen.g === 'succeeded|1|一只猫', '仍在附件集合里的卡片签名应保留在表中')
  const third = round('一只狗', second.genSummarySeen)
  assert(third.attachments[0].genSummary?.includes('一只狗'), '提示词变化应重新携带 genSummary')
  assert(third.genSummarySeen.g === 'succeeded|1|一只狗', '签名应随内容更新')
})

check('去重：genSummary 签名表只含当前仍在附件集合里的卡片（离场即出局）', () => {
  const gen = { prompt: 'x', refs: [], params: { ratio: '1:1' }, status: 'succeeded', progress: 1, versions: [{ id: 'v1' }] }
  const withCard = collector.collectRoundContext({
    selectedAssetIds: ['g'], injectedAssetIds: [], workspaceDir: WS, tempAttachments: [],
    nodes: [card('g', { storage: 'ws', path: 'assets/images/x.png', gen })], libraries: []
  })
  assert(Object.keys(withCard.genSummarySeen).length === 1, '带产物的生成卡应在签名表里')
  const withoutCard = collector.collectRoundContext({
    selectedAssetIds: [], injectedAssetIds: [], workspaceDir: WS, tempAttachments: [],
    nodes: [card('g', { storage: 'ws', path: 'assets/images/x.png', gen })], libraries: [],
    genSummarySeen: withCard.genSummarySeen
  })
  assert(Object.keys(withoutCard.genSummarySeen).length === 0, '不在附件集合里的卡片签名应出局')
})

const pass = results.filter((r) => r.pass).length
console.log(`\n============ context-digest:check ${pass}/${results.length} ${pass === results.length ? 'PASS' : 'FAIL'} ============`)
fs.mkdirSync(path.join(PROJECT_ROOT, 'out'), { recursive: true })
fs.writeFileSync(
  path.join(PROJECT_ROOT, 'out', 'context-digest-check-result.json'),
  JSON.stringify({ pass, total: results.length, verdict: pass === results.length ? 'PASS' : 'FAIL', results }, null, 2),
  'utf8'
)
fs.rmSync(OUT_DIR, { recursive: true, force: true })
if (pass !== results.length) process.exit(1)
