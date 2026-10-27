/**
 * 媒体引用链（media reference chain）回归锁 —— 自动链重构版。
 *
 * 运行：pnpm media-reference:check
 *
 * 用真实模块（TS 临时转译到 out/media-reference-check-tmp，CJS + @shared 别名重定向）驱动：
 * - src/renderer/src/lib/mediaReferenceGraph.ts —— 链条三级解析/角色派生/校验/新鲜度/血脉；
 * - src/renderer/src/lib/genMigration.ts —— 旧 AssetGen 壳 → 新 AssetData 的存量迁移；
 * - src/renderer/src/store/canvas/jobRuntime.ts —— 自动链运行时（提交冻结 → 终态写版本
 *   + inputs → 链自动派生；Agent 任务按 job.refs 回执 absPath 反查成链）；
 * - src/renderer/src/store/canvas/nodeOps.ts —— 删除清理 jobStates/索引与撤销恢复绑定；
 * - src/shared/media.ts —— 角色/配额/模式语义的唯一事实源。
 *
 * 覆盖（新模型不变量）：
 * - 迁移：versions/activeVersionId/references/refs 无损搬运；在途任务 → pendingJob；
 *   失败/空壳卡规则（无版本无文件无在途 = 丢弃）；
 * - 解析顺序：激活版本 inputs.refs（画布外条目不画链）→ 迁移 references → legacy
 *   refs/refRoles 按真实 caps 懒派生（reference_image 专用视频模型不得变 first_frame）；
 * - 角色派生 assignRefRoles（去重/按 caps）与 validateRefSet 硬错误（缺失/类型/配额/
 *   总闸/首尾依赖/互斥模式/未产出）；
 * - 新鲜度：unknown/current/changed（上游再生成、文件移动）/missing；
 * - 血脉 deriveLineage/formatLineageText：深度分组、防环（ping-pong 迭代合法）、截断；
 * - 运行时：画布提交成功 → 版本 inputs 定格 + 链自动出现；产物卡贴参考来源落位；
 *   Agent 事件链路（absPath 反查成链 / 反查不到 = 无链但历史保留）；失败保留
 *   pendingJob + retryGeneration 重交；重启对账（终态收尾 + 在途恢复）；重复终态幂等；
 *   先到事件缓冲（快速成功早于 IPC 返回）；提交校验失败不发起 IPC。
 *
 * 无网络、无 Electron、无新增依赖；out/ 产物不入库（.gitignore 已忽略 out/）。
 */
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'media-reference-check-tmp')

const results = []
const tests = []
/** 顺序异步执行：运行时测试要 await mock bridge，乱序会互相污染（window/jobCardIndex 是模块级） */
function check(name, fn) {
  tests.push({ name, fn })
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function assertIncludes(haystack, needle, label = '文本') {
  assert(typeof haystack === 'string' && haystack.includes(needle), `${label}应含「${needle}」，实际：${haystack}`)
}

function transpileAll(relFiles) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  for (const rel of relFiles) {
    const file = path.join(PROJECT_ROOT, rel)
    const target = path.join(OUT_DIR, rel.replace(/\.tsx?$/, '.js'))
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

// @shared/* 重定向到转译产物（media.ts 是值导入，必须能解析）
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@shared/')) {
    return origResolve.call(this, path.join(OUT_DIR, 'src', 'shared', request.slice('@shared/'.length)), parent, ...rest)
  }
  return origResolve.call(this, request, parent, ...rest)
}

const SRC_FILES = [
  'src/shared/media.ts',
  'src/shared/mediaResolve.ts',
  'src/shared/assets.ts',
  'src/renderer/src/types.ts',
  'src/renderer/src/harness/assetCategories.ts',
  'src/renderer/src/lib/agent.ts',
  'src/renderer/src/lib/mediaReferenceGraph.ts',
  'src/renderer/src/lib/genMigration.ts',
  'src/renderer/src/store/canvas/shared.ts',
  'src/renderer/src/store/canvas/nodeOps.ts',
  'src/renderer/src/store/canvas/jobRuntime.ts'
]
transpileAll(SRC_FILES)
// BRIDGE_AVAILABLE 在 shared.js 载入期求值（typeof window），window 桩必须先于导入
globalThis.window = { huabu: { chat: {} } }
const graph = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'lib', 'mediaReferenceGraph.js')))
const migration = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'lib', 'genMigration.js')))
const nodeOpsMod = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'store', 'canvas', 'nodeOps.js')))
const sharedMod = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'store', 'canvas', 'shared.js')))
const jobRuntimeMod = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'store', 'canvas', 'jobRuntime.js')))

/* ---------------- 夹具（贴 types.ts 真实形状，不复写实现） ---------------- */

let seq = 0
const baseNode = (id, kind, data) => ({
  id,
  type: 'asset',
  x: 0,
  y: 0,
  width: 280,
  height: 320,
  zIndex: ++seq,
  data: { name: id, kind, ...data }
})
/** 已产出文件卡（storage=ws，path 为工作区相对路径） */
const fileCard = (id, kind = 'image', extra = {}) =>
  baseNode(id, kind, {
    storage: 'ws',
    path: `assets/${kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'images'}/${id}.${kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png'}`,
    ...extra
  })
/** 旧结构生成卡（迁移测试入参；未产出 = 无 storage/path） */
const legacyGen = (id, kind, gen = {}, data = {}) =>
  baseNode(id, kind, { gen: { prompt: '', refs: [], params: {}, status: 'idle', progress: 0, versions: [], ...gen }, ...data })

const capsOf = (modes, quota, total = 0) => ({ modes, quota, total, legacy: false })
/** 图片模型：i2i 4 张参考图 */
const IMAGE_I2I = capsOf(['t2i', 'i2i'], { reference_image: 4 }, 4)
/** 视频模型：首尾帧都声明 */
const VIDEO_FL = capsOf(['t2v', 'i2v_first', 'i2v_fl'], { first_frame: 1, last_frame: 1 }, 2)
/** 视频模型：全模态参考（reference_image 专用，没有 first_frame） */
const VIDEO_R2V = capsOf(['t2v', 'r2v'], { reference_image: 3, reference_video: 1, reference_audio: 1 }, 4)
/** 视频模型：声明了两种角色配额但只支持首帧用法（互斥模式校验用） */
const VIDEO_FIRST_Q = capsOf(['i2v_first'], { first_frame: 1, reference_image: 2 }, 3)

/** 新结构的产物卡：一版带 inputs 定格（refsSnapshot 由调用方给） */
const productCard = (id, kind, refsSnapshot, extraData = {}) => {
  const version = {
    id: 'v1',
    storage: 'media',
    path: `${id}-out.png`,
    name: `${id}-out.png`,
    prompt: 'p',
    inputs: { prompt: 'p', params: {}, provider: 'prov', model: 'm', refs: refsSnapshot, createdAt: 1 },
    createdAt: '2026-01-01'
  }
  return baseNode(id, kind, {
    storage: 'media',
    path: `${id}-out.png`,
    versions: [version],
    activeVersionId: 'v1',
    ...extraData
  })
}
const snap = (sourceNodeId, role, over = {}) => ({
  referenceId: `s:${sourceNodeId}:${role}`,
  sourceNodeId,
  role,
  sourceName: sourceNodeId,
  storage: 'ws',
  path: `assets/images/${sourceNodeId}.png`,
  ...over
})

/* ---------------- 1. 存量迁移（genMigration） ---------------- */

check('迁移：gen.versions/activeVersionId 与 references 无损搬到 data 顶层', () => {
  const v1 = { id: 'v1', storage: 'media', path: 'a.png', name: 'a.png', prompt: 'p', createdAt: '2026-01-01' }
  const v2 = { id: 'v2', storage: 'media', path: 'b.png', name: 'b.png', prompt: 'p2', createdAt: '2026-01-02' }
  const references = [{ id: 't:img1:reference_image', sourceNodeId: 'img1', role: 'reference_image', order: 0 }]
  const out = migration.migrateAssetData({
    name: 't',
    kind: 'image',
    storage: 'media',
    path: 'b.png',
    gen: { prompt: 'p2', refs: ['img1'], references, versions: [v2, v1], activeVersionId: 'v1', status: 'succeeded' }
  })
  assert(out, '有版本有文件：不得丢弃')
  assert(out.versions.length === 2 && out.activeVersionId === 'v1', `版本栈与激活版本应保留，实际 ${out.activeVersionId}`)
  assert(Array.isArray(out.references) && out.references.length === 1, '显式 references 应原样保留（legacy 手动链）')
  assert(out.gen === undefined, 'gen 壳必须移除')
  assert(out.refs === undefined && out.refRoles === undefined, 'references 存在时 legacy 双视图不应再写')
})

check('迁移：activeVersionId 失效回退最新版本', () => {
  const v1 = { id: 'v1', storage: 'media', path: 'a.png', name: 'a.png', prompt: '', createdAt: '1' }
  const out = migration.migrateAssetData({ name: 't', kind: 'image', storage: 'media', path: 'a.png', gen: { versions: [v1], activeVersionId: 'gone', status: 'succeeded' } })
  assert(out.activeVersionId === 'v1', `失效激活版本应回退 v1，实际 ${out.activeVersionId}`)
})

check('迁移：只有 refs/refRoles 的更旧数据保留懒派生通道', () => {
  const out = migration.migrateAssetData({
    name: 't',
    kind: 'video',
    gen: { refs: ['img1'], refRoles: { img1: 'first_frame' }, versions: [{ id: 'v1', storage: 'media', path: 'a.mp4', name: 'a.mp4', prompt: '', createdAt: '1' }], status: 'succeeded' }
  })
  assert(out.refs.join() === 'img1' && out.refRoles.img1 === 'first_frame', 'refs/refRoles 应保留（懒派生第三级）')
  const img1 = fileCard('img1')
  const refs = graph.getCardReferences(baseNode('t', 'video', out), [img1], VIDEO_R2V)
  assert(refs[0].role === 'first_frame', `显式 refRoles 应优先，实际 ${refs[0].role}`)
})

check('迁移：在途任务 → data.pendingJob（含 pendingInputs 定格）', () => {
  const pendingInputs = { prompt: 'p', params: {}, provider: 'prov', model: 'm', refs: [], createdAt: 1 }
  const out = migration.migrateAssetData({ name: '生成中', kind: 'image', gen: { prompt: 'p', refs: [], status: 'running', progress: 0.4, jobId: 'job-9', pendingInputs, versions: [] } })
  assert(out, '在途任务卡不得丢弃（无版本无文件也要保留对账通道）')
  assert(out.pendingJob?.jobId === 'job-9', `pendingJob.jobId 应为 job-9，实际 ${out.pendingJob?.jobId}`)
  assert(out.pendingJob?.inputs === pendingInputs, 'pendingInputs 应随 pendingJob 保留')
})

check('迁移：空壳卡（无版本/无文件/无在途）丢弃；有文件无版本保留为普通卡', () => {
  assert(migration.migrateAssetData({ name: '未命名图片', kind: 'image', gen: { prompt: 'x', refs: ['img1'], status: 'idle', versions: [] } }) === null, '纯空壳应丢弃')
  const kept = migration.migrateAssetData({ name: 'f', kind: 'image', storage: 'ws', path: 'assets/images/f.png', gen: { prompt: 'p', refs: [], status: 'succeeded', versions: [] } })
  assert(kept && kept.path === 'assets/images/f.png' && kept.gen === undefined, '有文件无版本应保留为普通媒体卡（生成配置丢弃）')
})

check('迁移：非 gen 数据原样透传；空 jobId 的 pendingJob 残渣剥离', () => {
  const plain = { name: 'p', kind: 'image', storage: 'ws', path: 'a.png' }
  assert(migration.migrateAssetData(plain) === plain, '无 gen 普通卡应原样返回')
  const stripped = migration.migrateAssetData({ name: 'p', kind: 'image', storage: 'ws', path: 'a.png', pendingJob: { jobId: '' } })
  assert(stripped.pendingJob === undefined, 'IPC 在途崩溃残渣（空 jobId）应剥离')
})

check('迁移：migrateCanvasNodes 剔除空壳并保留其余', () => {
  const good = baseNode('good', 'image', { storage: 'ws', path: 'a.png', versions: [{ id: 'v1', storage: 'ws', path: 'a.png', name: 'a.png', prompt: '', createdAt: '1' }], activeVersionId: 'v1' })
  const shell = legacyGen('shell', 'image', { status: 'idle', versions: [] })
  const out = migration.migrateCanvasNodes([good, shell])
  assert(out.length === 1 && out[0].id === 'good', `应只剩 good，实际 ${out.map((n) => n.id).join(',')}`)
})

/* ---------------- 2. 链条三级解析（getCardReferences） ---------------- */

check('第一级：激活版本 inputs.refs 是权威（随版本切换而变）', () => {
  const img1 = fileCard('img1')
  const img2 = fileCard('img2')
  const card = productCard('t', 'image', [snap('img1', 'reference_image')])
  const refs = graph.getCardReferences(card, [img1, img2, card])
  assert(refs.length === 1 && refs[0].sourceNodeId === 'img1' && refs[0].role === 'reference_image', `应从 inputs 派生 img1，实际 ${JSON.stringify(refs)}`)
  // 切到 v2（inputs 指向 img2）：链随版本切换
  const v2 = { ...card.data.versions[0], id: 'v2', inputs: { ...card.data.versions[0].inputs, refs: [snap('img2', 'reference_image')] } }
  const switched = { ...card, data: { ...card.data, versions: [v2, ...card.data.versions], activeVersionId: 'v2' } }
  const refs2 = graph.getCardReferences(switched, [img1, img2, switched])
  assert(refs2[0].sourceNodeId === 'img2', `切版本后链应指向 img2，实际 ${refs2[0].sourceNodeId}`)
})

check('第一级：画布外参考（sourceNodeId 缺省）不画链', () => {
  const card = productCard('t', 'image', [
    snap('img1', 'reference_image'),
    { referenceId: 's:x:reference_image', role: 'reference_image', sourceName: '外部文件.png', storage: 'ws', path: 'inbox/外部文件.png' }
  ])
  const refs = graph.getCardReferences(card, [fileCard('img1'), card])
  assert(refs.length === 1 && refs[0].sourceNodeId === 'img1', `只有画布内条目成链，实际 ${refs.length} 条`)
})

check('第二级：无 inputs 时读迁移 references（legacy 手动链，只读）', () => {
  const img2 = fileCard('img2')
  const card = baseNode('t', 'image', { storage: 'media', path: 't.png', references: [{ id: 't:img2:reference_image', sourceNodeId: 'img2', role: 'reference_image', order: 0 }] })
  const refs = graph.getCardReferences(card, [img2, card])
  assert(refs.length === 1 && refs[0].sourceNodeId === 'img2', `应读 data.references，实际 ${JSON.stringify(refs)}`)
})

check('第三级：legacy refs 无 caps 按历史语义派生（视频首图=first_frame）', () => {
  const img1 = fileCard('img1')
  const img2 = fileCard('img2')
  const vid = fileCard('vid', 'video')
  const target = baseNode('t', 'video', { refs: ['img1', 'vid', 'img2'] })
  const refs = graph.getCardReferences(target, [img1, vid, img2, target])
  assert(refs.length === 3, `应派生 3 条，实际 ${refs.length}`)
  assert(refs[0].role === 'first_frame', `视频第一张图应=first_frame，实际 ${refs[0].role}`)
  assert(refs[1].role === 'reference_video', `视频素材应=reference_video，实际 ${refs[1].role}`)
  assert(refs[2].role === 'reference_image', `第二张图应=reference_image，实际 ${refs[2].role}`)
})

check('第三级：reference_image 专用视频模型按真实 caps 派生，不得变 first_frame', () => {
  const img1 = fileCard('img1')
  const target = baseNode('t', 'video', { refs: ['img1'] })
  const refs = graph.getCardReferences(target, [img1, target], VIDEO_R2V)
  assert(refs[0].role === 'reference_image', `无 first_frame 配额时应派生 reference_image，实际 ${refs[0].role}`)
})

check('第三级：显式 refRoles 优先；损坏条目过滤；普通卡无链', () => {
  const img1 = fileCard('img1')
  const target = baseNode('t', 'video', { refs: ['img1'], refRoles: { img1: 'last_frame' } })
  const refs = graph.getCardReferences(target, [img1, target], VIDEO_FL)
  assert(refs[0].role === 'last_frame', `显式角色应保留，实际 ${refs[0].role}`)
  assert(refs[0].id === 't:img1:last_frame', `稳定 id 应为 t:img1:last_frame，实际 ${refs[0].id}`)
  const corrupted = baseNode('t2', 'image', { references: [{ sourceNodeId: 'img1', role: 'reference_image', order: 0 }, { id: 'bad', sourceNodeId: 'img1', role: 'not_a_role', order: 1 }] })
  const refs2 = graph.getCardReferences(corrupted, [img1, corrupted], IMAGE_I2I)
  assert(refs2.length === 0, `缺 id 与非法 role 的条目都应被过滤，实际 ${refs2.length}`)
  assert(graph.getCardReferences(baseNode('plain', 'image', {}), [], IMAGE_I2I).length === 0, '普通卡无链')
})

/* ---------------- 3. 角色派生与提交校验（assignRefRoles / validateRefSet） ---------------- */

check('assignRefRoles：按 caps 派生角色、同源去重、order 连续', () => {
  const img1 = fileCard('img1')
  const vid = fileCard('vid', 'video')
  const refs = graph.assignRefRoles('new', [img1, vid, img1], 'video', VIDEO_R2V)
  assert(refs.length === 2, `同源去重后应 2 条，实际 ${refs.length}`)
  assert(refs[0].role === 'reference_image' && refs[1].role === 'reference_video', `角色应按 caps 派生，实际 ${refs.map((r) => r.role).join(',')}`)
  assert(refs.every((r, i) => r.order === i), 'order 应连续 0..n')
})

check('validateRefSet：来源缺失 / 类型不符 / 配额 / 首尾依赖 / 互斥模式 / 未产出', () => {
  const img1 = fileCard('img1')
  const doc = baseNode('doc1', 'doc', { storage: 'ws', path: 'a.md' })
  const missing = graph.assignRefRoles('t', [img1], 'image', IMAGE_I2I).map((r) => ({ ...r, sourceNodeId: 'gone' }))
  assert(graph.validateRefSet('image', missing, [img1], IMAGE_I2I).errors.some((e) => e.includes('不存在')), '来源缺失应报错')
  const wrongKind = [{ id: 'x', sourceNodeId: 'doc1', role: 'reference_image', order: 0 }]
  assert(graph.validateRefSet('image', wrongKind, [doc, img1], IMAGE_I2I).errors.some((e) => e.includes('只能使用')), '素材大类与角色不符应报错')
  const empty = fileCard('empty', 'image', { storage: undefined, path: undefined })
  const unproduced = graph.assignRefRoles('t', [empty], 'image', IMAGE_I2I)
  const vUnproduced = graph.validateRefSet('image', unproduced, [empty], IMAGE_I2I)
  assert(vUnproduced.unproduced.length === 1, '未产出应单独留痕')
  const over = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, sourceNodeId: 'img1', role: 'reference_image', order: i }))
  assert(graph.validateRefSet('image', over, [img1], IMAGE_I2I).errors.some((e) => e.includes('超出')), '超出配额应报错')
  // 首尾依赖：只挂尾帧
  const lastOnly = [{ id: 'l', sourceNodeId: 'img1', role: 'last_frame', order: 0 }]
  assert(graph.validateRefSet('video', lastOnly, [img1], VIDEO_FL).errors.some((e) => e.includes('首帧')), '尾帧无首帧应报错')
  // 互斥模式：首帧 + 参考图（声明了两种配额但只有 i2v_first 用法）
  const mixed = [
    { id: 'a', sourceNodeId: 'img1', role: 'first_frame', order: 0 },
    { id: 'b', sourceNodeId: 'img1', role: 'reference_image', order: 1 }
  ]
  assert(graph.validateRefSet('video', mixed, [img1], VIDEO_FIRST_Q).errors.some((e) => e.includes('不属于该模型支持')), '互斥角色组合应报模式不可达')
  const okRefs = graph.assignRefRoles('t', [img1], 'image', IMAGE_I2I)
  assert(graph.validateRefSet('image', okRefs, [img1], IMAGE_I2I).errors.length === 0, '合法组合应零错误')
})

/* ---------------- 4. 上游新鲜度（getReferenceUpdateState） ---------------- */

check('新鲜度：unknown（无 inputs）/ current / changed（上游再生成 / 文件移动）/ missing', () => {
  const upstreamV1 = { id: 'v1', storage: 'media', path: 'u1.png', name: 'u1.png', prompt: '', createdAt: '1' }
  const upstream = baseNode('u', 'image', { storage: 'media', path: 'u1.png', versions: [upstreamV1], activeVersionId: 'v1' })
  const card = productCard('t', 'image', [snap('u', 'reference_image', { sourceVersionId: 'v1', storage: 'media', path: 'u1.png' })])
  assert(graph.getReferenceUpdateState(baseNode('plain', 'image', {}), []) === 'unknown', '无版本卡应 unknown')
  assert(graph.getReferenceUpdateState(card, [upstream, card]) === 'current', '未变化应 current')
  // 上游再生成（activeVersionId 变化）
  const upstream2 = { ...upstream, data: { ...upstream.data, activeVersionId: 'v2', versions: [{ id: 'v2', storage: 'media', path: 'u2.png', name: 'u2.png', prompt: '', createdAt: '2' }, ...upstream.data.versions] } }
  assert(graph.getReferenceUpdateState(card, [upstream2, card]) === 'changed', '上游再生成应 changed')
  // 上游文件移动（同版本但 path 变）
  const upstream3 = { ...upstream, data: { ...upstream.data, path: 'moved.png', versions: [{ ...upstream.data.versions[0], path: 'moved.png' }] } }
  assert(graph.getReferenceUpdateState(card, [upstream3, card]) === 'changed', '上游文件移动应 changed')
  assert(graph.getReferenceUpdateState(card, [card]) === 'missing', '来源删除应 missing')
})

/* ---------------- 5. 血脉（deriveLineage / formatLineageText） ---------------- */

check('血脉：递归祖先 BFS 序、深度分组文本', () => {
  const grand = fileCard('grand')
  const parent = productCard('parent', 'image', [snap('grand', 'reference_image')])
  const me = productCard('me', 'image', [snap('parent', 'reference_image')])
  const entries = graph.deriveLineage('me', [grand, parent, me])
  assert(entries.length === 2, `应有 2 个祖先，实际 ${entries.length}`)
  assert(entries[0].nodeId === 'parent' && entries[0].depth === 1, `第一层应为 parent，实际 ${entries[0].nodeId}`)
  assert(entries[1].nodeId === 'grand' && entries[1].depth === 2, `第二层应为 grand，实际 ${entries[1].nodeId}`)
  const text = graph.formatLineageText(entries)
  assertIncludes(text, 'parent(参考图)', '血脉文本')
  assertIncludes(text, 'grand(参考图)', '血脉文本')
  assert(text.includes('←'), '血脉文本应以 ← 分层')
})

check('血脉：ping-pong 迭代成环合法且不挂死（visited 去重）', () => {
  const a = productCard('a', 'image', [snap('b', 'reference_image')])
  const b = productCard('b', 'image', [snap('a', 'reference_image')])
  const entries = graph.deriveLineage('a', [a, b])
  assert(entries.length === 1 && entries[0].nodeId === 'b', `成环时每个祖先只出现一次，实际 ${JSON.stringify(entries)}`)
})

check('血脉：maxDepth/maxNodes 截断', () => {
  const n0 = productCard('n0', 'image', [])
  let prev = n0
  const nodes = [n0]
  for (let i = 1; i <= 5; i += 1) {
    const node = productCard(`n${i}`, 'image', [snap(prev.id, 'reference_image')])
    nodes.push(node)
    prev = node
  }
  const deep = graph.deriveLineage('n5', nodes, { maxDepth: 2, maxNodes: 8 })
  assert(deep.every((e) => e.depth <= 2) && deep.length === 2, `maxDepth=2 应只到祖父层，实际 ${JSON.stringify(deep.map((e) => e.depth))}`)
  const capped = graph.deriveLineage('n5', nodes, { maxDepth: 5, maxNodes: 2 })
  assert(capped.length <= 2, `maxNodes=2 应截断，实际 ${capped.length}`)
})

/* ---------------- 6. 运行时（jobRuntime：自动链核心） ---------------- */

sharedMod.settingsBridgeRef.current = {
  mediaStatus: { defaultRatio: '16:9', defaultDuration: 5 },
  resolveMediaModel: (kind, override) => {
    if (override) {
      const hit = override.startsWith('prov:') ? { provider: 'prov', model: override.slice(5) } : null
      return hit && ['img-model', 'video-fl'].includes(hit.model) ? hit : null
    }
    return { provider: 'prov', model: kind === 'video' ? 'video-fl' : 'img-model' }
  },
  mediaProviders: [
    {
      id: 'prov',
      label: 'P',
      models: [
        { id: 'img-model', kind: 'image', capabilities: { refQuota: [{ role: 'reference_image', max: 4 }], refModes: ['t2i', 'i2i'], refTotal: 4 } },
        {
          id: 'video-fl',
          kind: 'video',
          capabilities: { refQuota: [{ role: 'first_frame', max: 1 }, { role: 'last_frame', max: 1 }], refModes: ['t2v', 'i2v_first', 'i2v_fl'], refTotal: 2 }
        }
      ]
    }
  ]
}

function runtimeFixture(initialNodes) {
  sharedMod.jobCardIndex.clear()
  const state = {
    nodes: initialNodes,
    nodesById: new Map(),
    workspace: { path: '/ws/main', name: 'main' },
    jobStates: {},
    selectedAssetIds: [],
    injectedAssetIds: [],
    tempAttachments: [],
    undoEntry: null,
    canUndo: false,
    confirm: null,
    resolveOutputLibrary: () => null,
    requestConfirm: (spec) => {
      state.confirm = spec
    }
  }
  const rebuild = () => {
    state.nodesById = new Map(state.nodes.map((n) => [n.id, n]))
  }
  rebuild()
  const toasts = []
  const rt = jobRuntimeMod.createJobRuntime({
    set: (patch) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    get: () => state,
    showToast: (m, a) => toasts.push({ m, a }),
    applyNodes: (fn) => {
      state.nodes = fn(state.nodes)
      rebuild()
    },
    mutateNodeData: (id, fn) => {
      state.nodes = state.nodes.map((n) => (n.id === id ? { ...n, data: fn(n.data) } : n))
      rebuild()
    }
  })
  const bridge = mockMediaBridge()
  window.huabu.media = bridge.api
  return { state, toasts, rt, bridge }
}

function mockMediaBridge() {
  const jobs = new Map()
  let seq = 0
  let handler = null
  const generateCalls = []
  const cancelCalls = []
  const stamp = () => new Date().toISOString()
  const mkJob = (req, jobState, extra = {}) => {
    const jobId = `job-${++seq}`
    const job = {
      jobId,
      provider: req.provider ?? 'prov',
      model: req.model ?? 'img-model',
      kind: req.kind ?? 'image',
      prompt: req.prompt ?? '',
      state: jobState,
      progress: jobState === 'queued' ? 0 : 0.5,
      createdAt: stamp(),
      updatedAt: stamp(),
      ...(req.nodeId ? { nodeId: req.nodeId } : {}),
      ...(req.outputDir ? { outputDir: req.outputDir } : {}),
      ...extra
    }
    jobs.set(jobId, job)
    return job
  }
  const advance = (jobId, patch) => {
    const job = jobs.get(jobId)
    assert(job, `mock 任务不存在：${jobId}`)
    Object.assign(job, patch, { updatedAt: stamp() })
    if (patch.state === 'succeeded' && !job.artifact) {
      job.artifact = { relPath: 'auto/out.png', name: 'out.png', mime: 'image/png', bytes: 10, width: 1024, height: 1024 }
      job.artifactDirRel = '.huabu/media'
    }
    return job
  }
  return {
    jobs,
    generateCalls,
    cancelCalls,
    mkJob,
    advance,
    setHandler: (fn) => {
      handler = fn
    },
    api: {
      generate: async (req) => {
        generateCalls.push(req)
        if (handler) return handler(req, mkJob)
        const job = mkJob(req, 'queued')
        return { ok: true, value: { jobId: job.jobId } }
      },
      jobs: async () => ({ ok: true, value: [...jobs.values()] }),
      cancel: async (jobId) => {
        cancelCalls.push(jobId)
        if (jobs.has(jobId)) advance(jobId, { state: 'cancelled' })
        return { ok: true }
      }
    }
  }
}

check('运行时：画布提交 → 成功写版本 + inputs 定格 → 引用链自动出现；产物卡贴参考来源落位', async () => {
  // 参考来源带一版产物（sourceVersionId 定格的对象）
  const img1 = baseNode('img1', 'image', {
    storage: 'ws',
    path: 'assets/images/img1.png',
    x: 100,
    versions: [{ id: 'v1', storage: 'ws', path: 'assets/images/img1.png', name: 'img1.png', prompt: '', createdAt: '1' }],
    activeVersionId: 'v1'
  })
  img1.x = 100
  img1.y = 80
  img1.width = 240
  img1.height = 230
  const { state, rt, bridge } = runtimeFixture([img1])
  const result = await rt.submitGeneration({ kind: 'image', prompt: 'a cat', params: {}, refs: ['img1'] })
  assert(result.ok, `提交应成功：${result.error}`)
  assert(bridge.generateCalls.length === 1, '应发起一次 IPC 提交')
  const req = bridge.generateCalls[0]
  assert(req.refs.length === 1 && req.refs[0].role === 'reference_image' && req.refs[0].path.includes('img1.png'), `IPC 参考应带角色与还原路径，实际 ${JSON.stringify(req.refs)}`)
  // 新产物卡已 spawn（贴 img1 右侧）
  const product = state.nodes.find((n) => n.id !== 'img1')
  assert(product, '应新建产物卡')
  assert(product.x >= img1.x + img1.width, `产物卡应在参考卡右侧，实际 x=${product.x}`)
  assert(product.data.pendingJob?.jobId, '提交后应绑定 pendingJob')
  assert(state.jobStates[product.id]?.status === 'queued', '运行态应 queued')
  // 事件推进：running → succeeded
  const jobId = product.data.pendingJob.jobId
  rt.handleJobEvent(bridge.advance(jobId, { state: 'running', progress: 0.6 }))
  assert(state.jobStates[product.id]?.status === 'running' && state.jobStates[product.id].progress === 0.6, 'running 事件应更新内存运行态')
  rt.handleJobEvent(bridge.advance(jobId, { state: 'succeeded' }))
  const data = state.nodesById.get(product.id).data
  assert(data.versions?.length === 1, `成功应写一版，实际 ${data.versions?.length}`)
  assert(data.versions[0].inputs?.refs?.[0]?.sourceNodeId === 'img1', `inputs 应定格来源卡，实际 ${JSON.stringify(data.versions[0].inputs?.refs)}`)
  assert(data.versions[0].inputs?.refs?.[0]?.sourceVersionId === 'v1', 'inputs 应定格来源当时版本')
  assert(data.pendingJob === undefined, '成功应解绑 pendingJob')
  assert(state.jobStates[product.id] === undefined, '成功应清运行态')
  // 引用链自动出现（getCardReferences 从激活版本 inputs 派生）
  const chain = graph.getCardReferences(state.nodesById.get(product.id), state.nodes)
  assert(chain.length === 1 && chain[0].sourceNodeId === 'img1', `链应自动指向 img1，实际 ${JSON.stringify(chain)}`)
})

check('运行时：Agent 任务（job.refs 回执 absPath 反查）自动成链；反查不到 = 无链但历史保留', async () => {
  const img1 = fileCard('img1')
  const { state, rt, bridge } = runtimeFixture([img1])
  // Agent 来源任务事件（无人认领）：queued 携带 refs 回执
  const job = bridge.mkJob({ kind: 'image', prompt: 'agent gen' }, 'queued', {
    sourceChatId: 'chat-1',
    refs: [{ role: 'reference_image', path: 'assets/images/img1.png', absPath: '/ws/main/assets/images/img1.png' }]
  })
  rt.handleJobEvent(job)
  const spawned = state.nodes.find((n) => n.id !== 'img1')
  assert(spawned, 'Agent 任务应建卡承接')
  assert(spawned.data.pendingJob?.jobId === job.jobId, '承接卡应绑定 pendingJob')
  assert(spawned.x >= img1.x + img1.width, '承接卡应贴参考来源落位')
  // 成功：inputs 从 job.refs 反查重建 → 链自动出现
  bridge.advance(job.jobId, { state: 'succeeded' })
  rt.handleJobEvent(bridge.jobs.get(job.jobId))
  const data = state.nodesById.get(spawned.id).data
  assert(data.versions?.length === 1, `成功应写一版，实际 ${data.versions?.length}`)
  assert(data.versions[0].inputs?.refs?.[0]?.sourceNodeId === 'img1', `absPath 反查应命中 img1，实际 ${JSON.stringify(data.versions[0].inputs?.refs)}`)
  const chain = graph.getCardReferences(state.nodesById.get(spawned.id), state.nodes)
  assert(chain.length === 1 && chain[0].sourceNodeId === 'img1', 'Agent 生成也自动成链')
  // 画布外参考（inbox 临时文件）：反查不到 → sourceNodeId 缺省、链不画、历史保留
  const job2 = bridge.mkJob({ kind: 'image', prompt: 'ext ref' }, 'queued', {
    sourceChatId: 'chat-1',
    refs: [{ role: 'reference_image', path: 'inbox/外部文件.png', absPath: '/app-data/inbox/外部文件.png' }]
  })
  rt.handleJobEvent(job2)
  const spawned2 = state.nodes.find((n) => n.id !== 'img1' && n.id !== spawned.id)
  assert(spawned2, '第二个 Agent 任务应另建卡')
  bridge.advance(job2.jobId, { state: 'succeeded', artifact: { relPath: 'ext/out2.png', name: 'out2.png', mime: 'image/png', bytes: 5, width: 512, height: 512 }, artifactDirRel: '.huabu/media' })
  rt.handleJobEvent(bridge.jobs.get(job2.jobId))
  const data2 = state.nodesById.get(spawned2.id).data
  assert(data2.versions[0].inputs?.refs?.[0]?.sourceNodeId === undefined, '反查不到的参考不应有 sourceNodeId')
  assert(data2.versions[0].inputs?.refs?.[0]?.sourceName === '外部文件.png', '画布外参考的历史应保留（sourceName）')
  assert(graph.getCardReferences(state.nodesById.get(spawned2.id), state.nodes).length === 0, '画布外参考不画链')
})

check('运行时：失败保留 pendingJob + 运行态，retryGeneration 按定格快照重交', async () => {
  const img1 = fileCard('img1')
  const { state, rt, bridge } = runtimeFixture([img1])
  const result = await rt.submitGeneration({ kind: 'image', prompt: 'fail me', params: {}, refs: ['img1'] })
  assert(result.ok, '提交应成功')
  const product = state.nodes.find((n) => n.id !== 'img1')
  const jobId = product.data.pendingJob.jobId
  rt.handleJobEvent(bridge.advance(jobId, { state: 'failed', error: '网关超时' }))
  const data = state.nodesById.get(product.id).data
  assert(data.pendingJob?.jobId === jobId, '失败应保留 pendingJob（重试与对账都读它）')
  assert(data.pendingJob?.inputs?.prompt === 'fail me', '失败应保留定格快照')
  assert(state.jobStates[product.id]?.status === 'failed' && state.jobStates[product.id].error === '网关超时', '失败态应进内存运行态')
  // 重试：同快照、同目标卡、新任务
  const callsBefore = bridge.generateCalls.length
  await rt.retryGeneration(product.id)
  assert(bridge.generateCalls.length === callsBefore + 1, '重试应发起新提交')
  assert(bridge.generateCalls[callsBefore].prompt === 'fail me', '重试应沿用定格提示词')
  assert(bridge.generateCalls[callsBefore].nodeId === product.id, '重试应写回同目标卡')
})

check('运行时：重启对账——终态收尾去重（同 jobId 只入一版）+ 在途恢复运行态', async () => {
  const img1 = fileCard('img1')
  const { state, rt, bridge } = runtimeFixture([img1])
  const result = await rt.submitGeneration({ kind: 'image', prompt: 'recon', params: {}, refs: ['img1'] })
  assert(result.ok, '提交应成功')
  const product = state.nodes.find((n) => n.id !== 'img1')
  const jobId = product.data.pendingJob.jobId
  bridge.advance(jobId, { state: 'succeeded' })
  // 模拟重启：运行态清空（内存不跨重启），对账按 pendingJob 收尾
  state.jobStates = {}
  await rt.reconcileJobs()
  const data = state.nodesById.get(product.id).data
  assert(data.versions?.length === 1, `对账应补写一版，实际 ${data.versions?.length}`)
  assert(data.pendingJob === undefined, '对账收尾应解绑 pendingJob')
  // 重复终态事件（对账后迟到）：幂等不重复入库
  rt.handleJobEvent(bridge.jobs.get(jobId))
  assert(state.nodesById.get(product.id).data.versions.length === 1, '重复终态不得重复入版')
  // 在途任务：对账恢复运行态
  const result2 = await rt.submitGeneration({ kind: 'image', prompt: 'in-flight', params: {}, refs: [] })
  assert(result2.ok, '第二次提交应成功')
  const product2 = state.nodes.find((n) => n.id !== 'img1' && n.id !== product.id)
  state.jobStates = {}
  await rt.reconcileJobs()
  assert(state.jobStates[product2.id]?.status === 'queued', `在途任务对账应恢复运行态，实际 ${JSON.stringify(state.jobStates[product2.id])}`)
})

check('运行时：先到事件缓冲——快速成功早于 IPC 返回，绑定后 replay 不丢产物', async () => {
  const img1 = fileCard('img1')
  const { state, rt, bridge } = runtimeFixture([img1])
  bridge.setHandler((req, mkJob) => {
    const job = mkJob(req, 'queued')
    // IPC 还没返回，成功事件已到达（handleJobEvent 直接驱动）
    bridge.advance(job.jobId, { state: 'succeeded' })
    rt.handleJobEvent(bridge.jobs.get(job.jobId))
    return { ok: true, value: { jobId: job.jobId } }
  })
  const result = await rt.submitGeneration({ kind: 'image', prompt: 'fast', params: {}, refs: ['img1'] })
  assert(result.ok, '提交应成功')
  const product = state.nodes.find((n) => n.id !== 'img1')
  assert(product?.data.versions?.length === 1, `先到成功事件在绑定后应 replay 落版，实际 ${product?.data.versions?.length}`)
  assert(product?.data.pendingJob === undefined, '落版后应解绑')
})

check('运行时：提交校验失败不发起 IPC（空提示词 / 参考未产出）', async () => {
  const img1 = fileCard('img1')
  const empty = baseNode('empty', 'image', {})
  const { rt, bridge } = runtimeFixture([img1, empty])
  const r1 = await rt.submitGeneration({ kind: 'image', prompt: '  ', params: {}, refs: [] })
  assert(!r1.ok && r1.error.includes('提示词'), `空提示词应被拦：${r1.error}`)
  const r2 = await rt.submitGeneration({ kind: 'image', prompt: 'p', params: {}, refs: ['empty'] })
  assert(!r2.ok && r2.error.includes('还没有产出文件'), `未产出参考应被拦：${r2.error}`)
  assert(bridge.generateCalls.length === 0, '校验失败不得发起任何 IPC')
})

/* ---------------- 7. 节点域（nodeOps：删除清理 jobStates + 撤销恢复绑定） ---------------- */

check('nodeOps：删除清理 jobStates 与索引；undo 恢复任务绑定', () => {
  // 在途生成卡：pendingJob 是 undo 恢复绑定的依据
  const img1 = baseNode('img1', 'image', { storage: 'ws', path: 'assets/images/img1.png', pendingJob: { jobId: 'job-x' } })
  sharedMod.jobCardIndex.clear()
  const state = {
    nodes: [img1],
    nodesById: new Map([[img1.id, img1]]),
    selectedAssetIds: [img1.id],
    injectedAssetIds: [],
    jobStates: { img1: { status: 'running', progress: 0.5 } },
    undoEntry: null,
    canUndo: false
  }
  sharedMod.jobCardIndex.set('job-x', 'img1')
  const toasts = []
  const ops = nodeOpsMod.createNodeOps({
    set: (patch) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    get: () => state,
    showToast: (m, a) => toasts.push({ m, a }),
    applyNodes: (fn) => {
      state.nodes = fn(state.nodes)
      state.nodesById = new Map(state.nodes.map((n) => [n.id, n]))
    }
  })
  ops.removeNodes(['img1'])
  assert(state.nodes.length === 0, '卡片应被移除')
  assert(!sharedMod.jobCardIndex.has('job-x'), '任务索引应清理')
  assert(state.jobStates.img1 === undefined, '运行态应清理')
  assert(state.undoEntry.nodes.length === 1, '撤销缓冲应保留节点')
  ops.undo()
  assert(state.nodes.length === 1, '撤销应恢复卡片')
  assert(sharedMod.jobCardIndex.get('job-x') === 'img1', '撤销应恢复任务绑定（pendingJob.jobId 仍在卡上）')
})

/* ---------------- 汇总 ---------------- */

for (const t of tests) {
  try {
    await t.fn()
    results.push({ name: t.name, ok: true })
    console.log(`  ✓ ${t.name}`)
  } catch (error) {
    results.push({ name: t.name, ok: false, error: String(error?.message ?? error) })
    console.error(`  ✗ ${t.name}\n    ${error?.stack ?? error}`)
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n媒体引用链回归：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.error(`失败 ${failed.length} 项：`)
  for (const f of failed) console.error(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
fs.rmSync(OUT_DIR, { recursive: true, force: true })
