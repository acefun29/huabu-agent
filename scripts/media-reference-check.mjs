/**
 * 媒体参考引用链（media reference chain）回归锁。
 *
 * 运行：pnpm media-reference:check
 *
 * 用真实模块（TS 临时转译到 out/media-reference-check-tmp，CJS + @shared 别名重定向）驱动：
 * - src/renderer/src/lib/mediaReferenceGraph.ts —— 引用链纯函数（读/写/校验/环检测/新鲜度/链规划）；
 * - src/shared/media.ts —— 角色/配额/模式语义的唯一事实源；
 * - src/renderer/src/types.ts —— 域类型与 KIND_LABEL；
 * - src/renderer/src/store/canvas/nodeOps.ts —— 删除/撤销（deps 全 mock，不导入 React store）；
 * - src/renderer/src/store/canvas/jobRuntime.ts + generationChain.ts —— 运行时
 *   （window.huabu media bridge 与 settings 注入全 mock，事件驱动，不触真实 IPC/计时器）。
 *
 * 覆盖：legacy refs/refRoles 按真实 caps 懒迁移（视频 reference_image 能力不得变 first_frame）、
 * references 权威（含显式空数组）、withGenerateReferences 双视图回写、校验硬错误
 * （缺失/类型/角色/配额/总闸/首尾依赖/互斥模式/未产出）、环检测（自环/两环/长环/diamond）、
 * 链规划（拓扑序/diamond 去重/循环/悬空/目标缺失）、新鲜度（版本/文件落点/顺序/missing 基准）、
 * 删除源保留悬空引用 + undo 自动复活、提交冻结输入、fast terminal-before-IPC race、
 * 重复 terminal、链式拓扑按序提交/复用/取消。nodeOps/shared 的 window 依赖在纯 Node 下自然降级。
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
/** 顺序异步执行：链测试要 await mock bridge，乱序会互相污染（window/jobCardIndex 是模块级） */
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
  'src/renderer/src/store/canvas/shared.ts',
  'src/renderer/src/store/canvas/nodeOps.ts',
  'src/renderer/src/store/canvas/generationChain.ts',
  'src/renderer/src/store/canvas/jobRuntime.ts'
]
transpileAll(SRC_FILES)
// BRIDGE_AVAILABLE 在 shared.js 载入期求值（typeof window），window 桩必须先于导入
globalThis.window = { huabu: { chat: {} } }
const graph = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'lib', 'mediaReferenceGraph.js')))
const nodeOpsMod = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'store', 'canvas', 'nodeOps.js')))
const sharedMod = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'store', 'canvas', 'shared.js')))
const jobRuntimeMod = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'store', 'canvas', 'jobRuntime.js')))
const chainMod = await import(pathToFileURL(path.join(OUT_DIR, 'src', 'renderer', 'src', 'store', 'canvas', 'generationChain.js')))

/* ---------------- 夹具（贴 types.ts 真实形状，不复写实现） ---------------- */

let seq = 0
const baseNode = (id, kind, data) => ({
  id,
  type: 'asset',
  x: 0,
  y: 0,
  width: 320,
  height: 430,
  zIndex: ++seq,
  data: { name: id, kind, ...data }
})
/** 已产出文件卡（storage=media，path 非空） */
const fileCard = (id, kind = 'image', extra = {}) => baseNode(id, kind, { storage: 'media', path: `${id}.${kind === 'video' ? 'mp4' : 'png'}`, ...extra })
/** 生成卡（未产出 = 无 storage/path） */
const genCard = (id, kind, gen = {}, data = {}) =>
  baseNode(id, kind, { gen: { prompt: '', refs: [], params: {}, status: 'idle', progress: 0, versions: [], ...gen }, ...data })
const ref = (sourceNodeId, role, order, id) => ({ id: id ?? `${sourceNodeId}:${role}`, sourceNodeId, role, order })

const capsOf = (modes, quota, total = 0) => ({ modes, quota, total, legacy: false })
/** 图片模型：老语义 maxRefImages=4 → reference_image:4 */
const IMAGE_I2I = capsOf(['t2i', 'i2i'], { reference_image: 4 }, 4)
/** 视频模型：老语义 → 只确定 first_frame:1 */
const VIDEO_FIRST = capsOf(['t2v', 'i2v_first'], { first_frame: 1 }, 1)
/** 视频模型：首尾帧都声明 */
const VIDEO_FL = capsOf(['t2v', 'i2v_first', 'i2v_fl'], { first_frame: 1, last_frame: 1 }, 2)
/** 视频模型：全模态参考（reference_image 专用，没有 first_frame） */
const VIDEO_R2V = capsOf(['t2v', 'r2v'], { reference_image: 3, reference_video: 1, reference_audio: 1 }, 4)
/** 视频模型：声明了两种角色配额但只支持首帧用法（互斥模式校验用） */
const VIDEO_FIRST_Q = capsOf(['i2v_first'], { first_frame: 1, reference_image: 2 }, 3)

/** 按 jobRuntime.buildSubmitPlan 的快照形状定格一条参考 */
const snapOf = (r, source, versionId) => ({
  referenceId: r.id,
  sourceNodeId: r.sourceNodeId,
  role: r.role,
  sourceName: source.data.name,
  ...(versionId ? { sourceVersionId: versionId } : {}),
  storage: source.data.storage,
  path: source.data.path,
  ...(source.data.pathRoot ? { pathRoot: source.data.pathRoot } : {})
})
/** 带一个已定格版本的目标生成卡（inputs.refs 由调用方给） */
const withVersion = (target, refsSnapshot) => {
  const version = {
    id: 'v1',
    storage: 'media',
    path: `${target.id}-out.png`,
    name: `${target.id}-out.png`,
    prompt: 'p',
    inputs: { prompt: 'p', params: {}, provider: 'prov', model: 'm', refs: refsSnapshot, createdAt: 1 },
    createdAt: '2026-01-01'
  }
  return genCard(target.id, target.data.kind, { ...target.data.gen, versions: [version], activeVersionId: 'v1' }, { storage: 'media', path: `${target.id}-out.png` })
}

/* ---------------- 1. legacy 迁移与 references 权威（getGenerateReferences / withGenerateReferences） ---------------- */

check('legacy refs 无 caps 按历史语义派生（视频首图=first_frame，其余按素材大类）', () => {
  const img1 = fileCard('img1')
  const img2 = fileCard('img2')
  const vid = fileCard('vid', 'video')
  const aud = fileCard('aud', 'audio')
  const target = genCard('t', 'video', { refs: ['img1', 'vid', 'aud', 'img2'] })
  const refs = graph.getGenerateReferences(target, [img1, vid, aud, img2, target])
  assert(refs.length === 4, `应派生 4 条，实际 ${refs.length}`)
  assert(refs[0].role === 'first_frame', `视频第一张图应=first_frame，实际 ${refs[0].role}`)
  assert(refs[1].role === 'reference_video', `视频素材应=reference_video，实际 ${refs[1].role}`)
  assert(refs[2].role === 'reference_audio', `音频素材应=reference_audio，实际 ${refs[2].role}`)
  assert(refs[3].role === 'reference_image', `第二张图应=reference_image，实际 ${refs[3].role}`)
  assert(refs[0].order === 0 && refs[3].order === 3, 'order 应按 refs 序保持 0..n')
})

check('legacy refs 按真实 caps 派生：reference_image 专用视频模型不得变 first_frame', () => {
  const img1 = fileCard('img1')
  const img2 = fileCard('img2')
  const target = genCard('t', 'video', { refs: ['img1', 'img2'] })
  const refs = graph.getGenerateReferences(target, [img1, img2, target], VIDEO_R2V)
  assert(refs.every((r) => r.role === 'reference_image'), `无 first_frame 配额时应全派生 reference_image，实际：${refs.map((r) => r.role).join(',')}`)
})

check('caps 派生不出时保留占位角色（供 validate 报角色不支持）', () => {
  const img1 = fileCard('img1')
  const target = genCard('t', 'video', { refs: ['img1'] })
  const none = capsOf(['t2v'], {}, 0)
  const refs = graph.getGenerateReferences(target, [img1, target], none)
  assert(refs[0].role === 'first_frame', `应保留 defaultRefRole 占位，实际 ${refs[0].role}`)
  const validation = graph.validateGenerateReferences(target, [img1, target], none)
  assert(validation.errors.some((e) => e.includes('不接受')), 'validate 应报该角色不被接受')
})

check('显式 refRoles 优先于 caps 派生；稳定 id 同输入恒同', () => {
  const img1 = fileCard('img1')
  const target = genCard('t', 'video', { refs: ['img1'], refRoles: { img1: 'last_frame' } })
  const refs = graph.getGenerateReferences(target, [img1, target], VIDEO_FIRST)
  assert(refs[0].role === 'last_frame', `显式角色应保留，实际 ${refs[0].role}`)
  assert(refs[0].id === 't:img1:last_frame', `稳定 id 应为 t:img1:last_frame，实际 ${refs[0].id}`)
  const again = graph.getGenerateReferences(target, [img1, target], VIDEO_FIRST)
  assert(again[0].id === refs[0].id, '同一输入两次读取 id 必须一致')
})

check('references 权威：显式记录存在时忽略 legacy 残留', () => {
  const img1 = fileCard('img1')
  const img2 = fileCard('img2')
  const target = genCard('t', 'image', { refs: ['img1'], references: [ref('img2', 'reference_image', 0, 't:img2:reference_image')] })
  const refs = graph.getGenerateReferences(target, [img1, img2, target], IMAGE_I2I)
  assert(refs.length === 1 && refs[0].sourceNodeId === 'img2', `应只读 references，实际 ${JSON.stringify(refs.map((r) => r.sourceNodeId))}`)
})

check('边界：显式空数组即权威，不得落回残留 legacy refs', () => {
  const img1 = fileCard('img1')
  const target = genCard('t', 'image', { refs: ['img1'], references: [] })
  const refs = graph.getGenerateReferences(target, [img1, target], IMAGE_I2I)
  assert(refs.length === 0, `references=[] 应权威返回空（用户已清空参考），实际派生 ${refs.length} 条`)
})

check('损坏 references 条目被过滤（缺 id / 非法 role）', () => {
  const img1 = fileCard('img1')
  const target = genCard('t', 'image', {
    references: [
      ref('img1', 'reference_image', 0, 'ok1'),
      { sourceNodeId: 'img1', role: 'reference_image', order: 1 },
      { id: 'bad', sourceNodeId: 'img1', role: 'not_a_role', order: 2 }
    ]
  })
  const refs = graph.getGenerateReferences(target, [img1, target], IMAGE_I2I)
  assert(refs.length === 1 && refs[0].id === 'ok1', `应只保留合法条目，实际 ${refs.length} 条`)
})

check('同源不同角色可共存（references 表达力），legacy 视图取首现身', () => {
  const img1 = fileCard('img1')
  const target = genCard('t', 'video', {
    references: [ref('img1', 'reference_image', 0, 't:img1:reference_image'), ref('img1', 'first_frame', 1, 't:img1:first_frame')]
  })
  const refs = graph.getGenerateReferences(target, [img1, target], VIDEO_FIRST)
  assert(refs.length === 2, `同源两角色都应返回，实际 ${refs.length}`)
  const written = graph.withGenerateReferences(target.data.gen, refs)
  assert(written.refs.length === 1 && written.refs[0] === 'img1', `legacy refs 应按源去重，实际 ${JSON.stringify(written.refs)}`)
  assert(written.refRoles.img1 === 'reference_image', `refRoles 应取首现身角色，实际 ${written.refRoles?.img1}`)
})

check('多值顺序：读取按 order 排序，写回统一重排 0..n 并按 id 去重保序', () => {
  const img1 = fileCard('img1')
  const img2 = fileCard('img2')
  const img3 = fileCard('img3')
  const target = genCard('t', 'image', {
    references: [ref('img3', 'reference_image', 2, 'c'), ref('img1', 'reference_image', 0, 'a'), ref('img2', 'reference_image', 1, 'b')]
  })
  const refs = graph.getGenerateReferences(target, [img1, img2, img3, target], IMAGE_I2I)
  assert(refs.map((r) => r.sourceNodeId).join(',') === 'img1,img2,img3', `应按 order 排序，实际 ${refs.map((r) => r.sourceNodeId).join(',')}`)
  const written = graph.withGenerateReferences(target.data.gen, [refs[2], refs[0], refs[1], refs[0]])
  assert(written.references.length === 3, `重复 id 应去重，实际 ${written.references.length}`)
  assert(written.references.map((r) => r.id).join(',') === 'c,a,b', `去重应保首现顺序，实际 ${written.references.map((r) => r.id).join(',')}`)
  assert(written.references.every((r, i) => r.order === i), '写回应统一重排 order')
  assert(written.refs.join(',') === 'img3,img1,img2', `legacy refs 应按首现源序，实际 ${JSON.stringify(written.refs)}`)
})

check('withGenerateReferences 不改入参（gen 与数组都视为只读）；空列表也回写空 legacy 视图', () => {
  const gen = { prompt: '', refs: ['old'], refRoles: { old: 'reference_image' }, params: {}, status: 'idle', progress: 0, versions: [] }
  const input = [ref('img1', 'reference_image', 5, 'x')]
  const snapshot = JSON.stringify(input)
  const written = graph.withGenerateReferences(gen, input)
  assert(gen.references === undefined && gen.refs.join() === 'old', '入参 gen 不得被改写')
  assert(JSON.stringify(input) === snapshot, '入参数组不得被改写')
  assert(written.references[0].order === 0 && written.refs.join() === 'img1', '返回新对象应完成双视图回写')
  const cleared = graph.withGenerateReferences(gen, [])
  assert(cleared.references.length === 0 && cleared.refs.length === 0 && Object.keys(cleared.refRoles).length === 0, '空列表应清空双视图')
})

check('无 gen / 无参考 → 空数组；返回条目为副本', () => {
  const plain = fileCard('img1')
  assert(graph.getGenerateReferences(plain, [plain]).length === 0, '普通文件卡应返回空')
  const empty = genCard('t', 'image')
  assert(graph.getGenerateReferences(empty, [empty]).length === 0, '无参考的生成卡应返回空')
  const img1 = fileCard('img1')
  const target = genCard('t', 'image', { references: [ref('img1', 'reference_image', 0, 'x')] })
  const refs = graph.getGenerateReferences(target, [img1, target], IMAGE_I2I)
  refs[0].role = 'first_frame'
  assert(target.data.gen.references[0].role === 'reference_image', '返回条目应是副本，外部改动不得穿透')
})

/* ---------------- 2. 校验（validateGenerateReferences） ---------------- */

check('来源缺失：报错不静默丢弃，引用列表不裁剪', () => {
  const target = genCard('t', 'image', { references: [ref('ghost', 'reference_image', 0, 't:ghost:reference_image')] })
  const v = graph.validateGenerateReferences(target, [target], IMAGE_I2I)
  assert(v.errors.length === 1, `应报 1 条错误，实际 ${v.errors.length}`)
  assertIncludes(v.errors[0], '不存在或已被删除')
  assert(v.references.length === 1, '引用列表不得被裁剪')
  assert(v.unproduced.length === 0, '缺失不是未产出')
})

check('素材大类与角色不符：报错（视频充当参考图）', () => {
  const clip = fileCard('clip', 'video')
  const target = genCard('t', 'video', { references: [ref('clip', 'reference_image', 0, 't:clip:reference_image')] })
  const v = graph.validateGenerateReferences(target, [clip, target], VIDEO_R2V)
  assert(v.errors.length === 1, `应报 1 条错误，实际 ${v.errors.length}：${JSON.stringify(v.errors)}`)
  assertIncludes(v.errors[0], '是视频')
  assertIncludes(v.errors[0], '只能使用图片')
})

check('未产出 gen：报 unproduced 且是 errors 子集；纯结构错误为空（可搭链）', () => {
  const upstream = genCard('up', 'image')
  const target = genCard('t', 'image', { references: [ref('up', 'reference_image', 0, 't:up:reference_image')] })
  const v = graph.validateGenerateReferences(target, [upstream, target], IMAGE_I2I)
  assert(v.errors.length === 1, `应恰好 1 条未产出错误，实际 ${JSON.stringify(v.errors)}`)
  assertIncludes(v.errors[0], '还没有产出文件')
  assert(v.unproduced.length === 1 && v.unproduced[0] === v.errors[0], 'unproduced 应为原串子集')
  assert(v.errors.filter((e) => !v.unproduced.includes(e)).length === 0, '未产出不属于结构错误（链式生成应允许）')
})

check('边界：未产出也参与角色配额与模式校验（不得借未产出绕过结构闸）', () => {
  const up1 = genCard('up1', 'image')
  const up2 = genCard('up2', 'image')
  const target = genCard('t', 'video', {
    references: [ref('up1', 'first_frame', 0, 't:up1:first_frame'), ref('up2', 'reference_image', 1, 't:up2:reference_image')]
  })
  const v = graph.validateGenerateReferences(target, [up1, up2, target], VIDEO_FIRST_Q)
  assert(v.unproduced.length === 2, `两条上游都未产出，实际 ${v.unproduced.length}`)
  assert(
    v.errors.some((e) => e.includes('不属于该模型支持的任何用法')),
    `首帧+参考图混用应报模式不可达，实际：${JSON.stringify(v.errors)}`
  )
  assert(v.errors.filter((e) => !v.unproduced.includes(e)).length > 0, '模式/角色错误必须计入结构错误（直接 submit 拦、链也拦）')
})

check('角色配额 0 = 模型不接受该角色', () => {
  const img1 = fileCard('img1')
  const target = genCard('t', 'video', { references: [ref('img1', 'reference_image', 0, 't:img1:reference_image')] })
  const v = graph.validateGenerateReferences(target, [img1, target], VIDEO_FIRST)
  assert(v.errors.some((e) => e.includes('不接受')), `应报角色不接受，实际：${JSON.stringify(v.errors)}`)
})

check('单角色超上限：报 N/max', () => {
  const img1 = fileCard('img1')
  const img2 = fileCard('img2')
  const img3 = fileCard('img3')
  const target = genCard('t', 'image', {
    references: [ref('img1', 'reference_image', 0, 'a'), ref('img2', 'reference_image', 1, 'b'), ref('img3', 'reference_image', 2, 'c')]
  })
  const tight = capsOf(['t2i', 'i2i'], { reference_image: 2 }, 2)
  const v = graph.validateGenerateReferences(target, [img1, img2, img3, target], tight)
  assert(v.errors.some((e) => e.includes('3/2')), `应报 3/2 超上限，实际：${JSON.stringify(v.errors)}`)
})

check('总闸：合计超 refTotal 报错', () => {
  const sources = [1, 2, 3, 4, 5].map((i) => fileCard(`img${i}`))
  const target = genCard('t', 'video', {
    references: [1, 2, 3, 4, 5].map((i, idx) => ref(`img${i}`, 'reference_image', idx, `r${i}`))
  })
  const v = graph.validateGenerateReferences(target, [...sources, target], VIDEO_R2V)
  assert(v.errors.some((e) => e.includes('5 条')), `应报合计超 4 条上限（当前 5 条），实际：${JSON.stringify(v.errors)}`)
})

check('尾帧依赖：只挂尾帧报错；首尾同挂合法', () => {
  const f = fileCard('f')
  const l = fileCard('l')
  const onlyLast = genCard('t1', 'video', { references: [ref('l', 'last_frame', 0, 't1:l:last_frame')] })
  const v1 = graph.validateGenerateReferences(onlyLast, [f, l, onlyLast], VIDEO_FL)
  assert(v1.errors.some((e) => e.includes('尾帧必须与首帧一起提交')), `应报尾帧依赖，实际：${JSON.stringify(v1.errors)}`)
  const both = genCard('t2', 'video', {
    references: [ref('f', 'first_frame', 0, 't2:f:first_frame'), ref('l', 'last_frame', 1, 't2:l:last_frame')]
  })
  const v2 = graph.validateGenerateReferences(both, [f, l, both], VIDEO_FL)
  assert(v2.errors.length === 0, `首尾同挂应无错误，实际：${JSON.stringify(v2.errors)}`)
})

check('互斥模式：首帧与参考类混用报错并提示支持的用法', () => {
  const f = fileCard('f')
  const r = fileCard('r')
  const target = genCard('t', 'video', {
    references: [ref('f', 'first_frame', 0, 't:f:first_frame'), ref('r', 'reference_image', 1, 't:r:reference_image')]
  })
  const v = graph.validateGenerateReferences(target, [f, r, target], VIDEO_FIRST)
  assert(v.errors.some((e) => e.includes('不属于该模型支持的任何用法') && e.includes('首帧图生视频')), `应报模式不可达，实际：${JSON.stringify(v.errors)}`)
})

check('纯文字提交合法：无参考时不产错误', () => {
  const target = genCard('t', 'image')
  const v = graph.validateGenerateReferences(target, [target], IMAGE_I2I)
  assert(v.errors.length === 0 && v.unproduced.length === 0, '空参考不应有错误')
  const noGen = fileCard('plain')
  const v2 = graph.validateGenerateReferences(noGen, [noGen], IMAGE_I2I)
  assert(v2.errors.length === 0, '无 gen 卡不应有错误')
})

/* ---------------- 3. 环检测与链规划 ---------------- */

check('环检测：自环、两节点环、长环', () => {
  assert(graph.wouldCreateReferenceCycle([], 'a', 'a') === true, '自引应直接成环')
  // 两节点环：a 已引 b，再让 b 引 a（source=a 沿上游走能到 target=b）
  const a2 = genCard('a', 'image', { references: [ref('b', 'reference_image', 0, 'a:b:reference_image')] })
  const b2 = genCard('b', 'image')
  assert(graph.wouldCreateReferenceCycle([a2, b2], 'a', 'b') === true, 'b 引 a（a 已引 b）应成环')
  assert(graph.wouldCreateReferenceCycle([a2, b2], 'b', 'a') === false, 'a 引 b 是既有边方向，不该误报')
  // 长环：a→b→c（a 引 b，b 引 c），再让 c 引 a（source=a 走 a→b→c 命中 target）
  const l1 = genCard('l1', 'image', { references: [ref('l2', 'reference_image', 0, 'l1:l2:reference_image')] })
  const l2 = genCard('l2', 'image', { references: [ref('l3', 'reference_image', 0, 'l2:l3:reference_image')] })
  const l3 = genCard('l3', 'image')
  assert(graph.wouldCreateReferenceCycle([l1, l2, l3], 'l1', 'l3') === true, 'l3 引 l1（l1→l2→l3 回到 l3）应成环')
  assert(graph.wouldCreateReferenceCycle([l1, l2, l3], 'l3', 'l1') === false, 'l1 引 l3 是给下游加边，不得误报')
})

check('环检测：diamond 上游闭合才成环，未闭合不误报', () => {
  const g = genCard('g', 'image')
  const m1 = genCard('m1', 'image', { references: [ref('g', 'reference_image', 0, 'm1:g:reference_image')] })
  const m2 = genCard('m2', 'image', { references: [ref('g', 'reference_image', 0, 'm2:g:reference_image')] })
  const t = genCard('t', 'image', {
    references: [ref('m1', 'reference_image', 0, 't:m1:reference_image'), ref('m2', 'reference_image', 1, 't:m2:reference_image')]
  })
  const nodes = [g, m1, m2, t]
  assert(graph.wouldCreateReferenceCycle(nodes, 't', 'g') === true, 'g 引 t（沿 t→m1→g 回到 g）应成环')
  assert(graph.wouldCreateReferenceCycle(nodes, 'g', 't') === false, 't 引 g 是既有上游方向，不得误报')
})

check('链规划：上游拓扑序在前、目标最后，普通文件卡是叶子不进链', () => {
  const leaf = fileCard('leaf')
  const mid = genCard('mid', 'image', { references: [ref('leaf', 'reference_image', 0, 'mid:leaf:reference_image')] })
  const top = genCard('top', 'image', { references: [ref('mid', 'reference_image', 0, 'top:mid:reference_image')] })
  const plan = graph.planGenerationChain('top', [leaf, mid, top])
  assert(plan.errors.length === 0, `不应有错误：${JSON.stringify(plan.errors)}`)
  assert(plan.nodeIds.join(',') === 'mid,top', `应为 [mid,top]（leaf 是现成叶子），实际 ${plan.nodeIds.join(',')}`)
})

check('链规划：diamond 公共上游只出现一次', () => {
  const g = genCard('g', 'image')
  const m1 = genCard('m1', 'image', { references: [ref('g', 'reference_image', 0, 'm1:g:reference_image')] })
  const m2 = genCard('m2', 'image', { references: [ref('g', 'reference_image', 0, 'm2:g:reference_image')] })
  const t = genCard('t', 'image', {
    references: [ref('m1', 'reference_image', 0, 't:m1:reference_image'), ref('m2', 'reference_image', 1, 't:m2:reference_image')]
  })
  const plan = graph.planGenerationChain('t', [g, m1, m2, t])
  assert(plan.errors.length === 0, `diamond 无环不应报错：${JSON.stringify(plan.errors)}`)
  assert(plan.nodeIds.join(',') === 'g,m1,m2,t', `公共上游应去重为一次，实际 ${plan.nodeIds.join(',')}`)
})

check('链规划：循环报循环依赖；目标缺失与悬空引用各自报错', () => {
  const a = genCard('a', 'image', { references: [ref('b', 'reference_image', 0, 'a:b:reference_image')] })
  const b = genCard('b', 'image', { references: [ref('a', 'reference_image', 0, 'b:a:reference_image')] })
  const cyc = graph.planGenerationChain('a', [a, b])
  assert(cyc.errors.some((e) => e.includes('循环依赖')), `应报循环依赖，实际：${JSON.stringify(cyc.errors)}`)
  const missing = graph.planGenerationChain('nope', [a, b])
  assert(missing.errors.length === 1 && missing.errors[0].includes('目标卡片不存在') && missing.nodeIds.length === 0, '目标缺失应报错且链为空')
  const dangling = genCard('d', 'image', { references: [ref('ghost', 'reference_image', 0, 'd:ghost:reference_image')] })
  const v = graph.planGenerationChain('d', [dangling])
  assert(v.errors.some((e) => e.includes('不存在')), `悬空引用应报错，实际：${JSON.stringify(v.errors)}`)
})

/* ---------------- 4. 新鲜度（getReferenceUpdateState） ---------------- */

const TARGET_REF_ID = 't:src:reference_image'
const freshnessFixture = () => {
  const src = fileCard('src')
  const target = genCard('t', 'image', { references: [ref('src', 'reference_image', 0, TARGET_REF_ID)] })
  return { src, target }
}

check('无从比对时 unknown：无 gen / 无激活版本 / 老版本无 inputs', () => {
  const { src } = freshnessFixture()
  assert(graph.getReferenceUpdateState(genCard('x', 'image'), [src]) === 'unknown', '无 gen 应 unknown')
  const fresh = genCard('t', 'image', { references: [ref('src', 'reference_image', 0, TARGET_REF_ID)] })
  assert(graph.getReferenceUpdateState(fresh, [src, fresh]) === 'unknown', '无激活版本应 unknown')
  const noInputs = withVersion(fresh, [])
  delete noInputs.data.gen.versions[0].inputs
  assert(graph.getReferenceUpdateState(noInputs, [src, noInputs]) === 'unknown', '老版本无 inputs 应 unknown')
})

check('当前引用与快照一致 → current', () => {
  const { src, target } = freshnessFixture()
  const snap = snapOf(target.data.gen.references[0], src, undefined)
  const withV = withVersion(target, [snap])
  assert(graph.getReferenceUpdateState(withV, [src, withV]) === 'current', '一致快照应为 current')
})

check('上游再生（activeVersionId 变）→ changed；只改上游提示词不换版本 → current', () => {
  const { target } = freshnessFixture()
  const versionOf = (id, path, prompt) => ({ id, storage: 'media', path, name: path, prompt, createdAt: '' })
  const srcV1 = genCard('src', 'image', { versions: [versionOf('v1', 'src-out.png', 'p')], activeVersionId: 'v1' }, { storage: 'media', path: 'src-out.png' })
  const snap = snapOf(target.data.gen.references[0], srcV1, 'v1')
  const withV = withVersion(target, [snap])
  assert(graph.getReferenceUpdateState(withV, [srcV1, withV]) === 'current', '同版本应 current')
  const promptEdited = genCard('src', 'image', { prompt: '改过的提示词', versions: [versionOf('v1', 'src-out.png', 'p')], activeVersionId: 'v1' }, { storage: 'media', path: 'src-out.png' })
  assert(graph.getReferenceUpdateState(withV, [promptEdited, withV]) === 'current', '只改提示词不得触发 changed')
  const srcV2 = genCard('src', 'image', { versions: [versionOf('v1', 'src-out.png', 'p'), versionOf('v2', 'src-out2.png', 'p2')], activeVersionId: 'v2' }, { storage: 'media', path: 'src-out2.png' })
  assert(graph.getReferenceUpdateState(withV, [srcV2, withV]) === 'changed', '上游激活版本变化应 changed')
})

check('普通文件源移动/改名/清掉路径 → changed', () => {
  const { src, target } = freshnessFixture()
  const snap = snapOf(target.data.gen.references[0], src, undefined)
  const withV = withVersion(target, [snap])
  const renamed = fileCard('src', 'image', { path: 'new-name.png' })
  assert(graph.getReferenceUpdateState(withV, [renamed, withV]) === 'changed', '改名后应 changed')
  const moved = fileCard('src', 'image', { pathRoot: '素材库/新目录' })
  assert(graph.getReferenceUpdateState(withV, [moved, withV]) === 'changed', '换落点目录后应 changed')
  const cleared = baseNode('src', 'image', {})
  assert(graph.getReferenceUpdateState(withV, [cleared, withV]) === 'changed', '源无 path 应 changed')
})

check('角色或顺序变化 → changed', () => {
  const { src, target } = freshnessFixture()
  const src2 = fileCard('src2')
  const snap = snapOf(target.data.gen.references[0], src, undefined)
  const withV = withVersion(target, [snap])
  const roleChanged = genCard('t', 'image', { ...withV.data.gen, references: [ref('src', 'first_frame', 0, 't:src:first_frame')] })
  assert(graph.getReferenceUpdateState(roleChanged, [src, roleChanged]) === 'changed', '改角色应 changed')
  const pair = genCard('t', 'image', { references: [ref('src', 'reference_image', 0, 'r1'), ref('src2', 'reference_image', 1, 'r2')] })
  const pairV = withVersion(pair, [snapOf(pair.data.gen.references[0], src, undefined), snapOf(pair.data.gen.references[1], src2, undefined)])
  assert(graph.getReferenceUpdateState(pairV, [src, src2, pairV]) === 'current', '对调前基线应 current')
  const swapped = genCard('t', 'image', { ...pairV.data.gen, references: [ref('src2', 'reference_image', 0, 'r2'), ref('src', 'reference_image', 1, 'r1')] })
  assert(graph.getReferenceUpdateState(swapped, [src, src2, swapped]) === 'changed', '顺序对调应 changed（快照有序）')
})

check('边界：missing 以当前引用为基准——被移除的快照引用不算 missing', () => {
  const { src, target } = freshnessFixture()
  const src2 = fileCard('src2')
  const pair = genCard('t', 'image', { references: [ref('src', 'reference_image', 0, 'r1'), ref('src2', 'reference_image', 1, 'r2')] })
  const pairV = withVersion(pair, [snapOf(pair.data.gen.references[0], src, undefined), snapOf(pair.data.gen.references[1], src2, undefined)])
  // 用户移除 src2 那条引用，且 src2 卡已从画布删除：快照里的 src2 不该把状态拖成 missing
  const removed = genCard('t', 'image', { ...pairV.data.gen, references: [ref('src', 'reference_image', 0, 'r1')] })
  assert(graph.getReferenceUpdateState(removed, [src, removed]) === 'changed', '用户已移除的引用缺失应 changed（快照多出一条），不是 missing')
  // 反向：快照只有一条，现在多了一条也应 changed
  const singleV = withVersion(genCard('t', 'image', { references: [ref('src', 'reference_image', 0, 'r1')] }), [
    snapOf(ref('src', 'reference_image', 0, 'r1'), src, undefined)
  ])
  const added = genCard('t', 'image', { ...singleV.data.gen, references: [ref('src', 'reference_image', 0, 'r1'), ref('src2', 'reference_image', 1, 'r2')] })
  assert(graph.getReferenceUpdateState(added, [src, src2, added]) === 'changed', '新增引用相对快照应 changed')
})

check('边界：当前引用的源被删 → missing（老版本无快照也报）', () => {
  const { target } = freshnessFixture()
  const noVersion = genCard('t', 'image', { references: [ref('src', 'reference_image', 0, TARGET_REF_ID)] })
  assert(graph.getReferenceUpdateState(noVersion, [target]) === 'missing', '无版本的卡引用悬空也应 missing')
  const withV = withVersion(noVersion, [])
  delete withV.data.gen.versions[0].inputs
  assert(graph.getReferenceUpdateState(withV, [target]) === 'missing', '老版本无 inputs 时引用悬空也应 missing')
})

check('删除源保留悬空引用，undo 复活后回到 current', () => {
  const { src, target } = freshnessFixture()
  const snap = snapOf(target.data.gen.references[0], src, undefined)
  const withV = withVersion(target, [snap])
  const nodesWith = [src, withV]
  const afterDelete = [withV]
  assert(graph.getReferenceUpdateState(withV, afterDelete) === 'missing', '删除源后应 missing')
  const v = graph.validateGenerateReferences(withV, afterDelete, IMAGE_I2I)
  assert(v.errors.some((e) => e.includes('不存在或已被删除')), `删除源后校验应报缺失，实际：${JSON.stringify(v.errors)}`)
  assert(graph.getGenerateReferences(withV, afterDelete, IMAGE_I2I).length === 1, '悬空引用必须保留（撤销可复活）')
  assert(graph.getReferenceUpdateState(withV, nodesWith) === 'current', 'undo 复活后应回到 current')
})

check('边界：gen 源文件落点变化也要比对（版本 id 相同但 path 被清 / 无版本源 path 清）', () => {
  const { target } = freshnessFixture()
  const versionOf = (id, path) => ({ id, storage: 'media', path, name: path, prompt: 'p', createdAt: '' })
  const srcGen = genCard('src', 'image', { versions: [versionOf('v1', 'src-out.png')], activeVersionId: 'v1' }, { storage: 'media', path: 'src-out.png' })
  const snap = snapOf(target.data.gen.references[0], srcGen, 'v1')
  const withV = withVersion(target, [snap])
  const cleared = genCard('src', 'image', { versions: [versionOf('v1', 'src-out.png')], activeVersionId: 'v1' })
  assert(graph.getReferenceUpdateState(withV, [cleared, withV]) === 'changed', '版本同但文件落点被清应 changed')
  const noVerSnap = snapOf(target.data.gen.references[0], fileCard('src'), undefined)
  const withV2 = withVersion(target, [noVerSnap])
  const noVer = genCard('src', 'image')
  assert(graph.getReferenceUpdateState(withV2, [noVer, withV2]) === 'changed', '无版本 gen 源丢 path 应 changed')
})

/* ---------------- 5. nodeOps 删除/撤销（mock store deps，不导入 React store） ---------------- */

function nodeOpsMockStore(initialNodes) {
  sharedMod.jobCardIndex.clear()
  const state = {
    nodes: initialNodes,
    nodesById: new Map(),
    activeGenerateId: null,
    selectedAssetIds: [],
    injectedAssetIds: [],
    tempAttachments: [],
    undoEntry: null,
    canUndo: false,
    confirm: null
  }
  const toasts = []
  const applyNodes = (fn) => {
    state.nodes = fn(state.nodes)
    state.nodesById = new Map(state.nodes.map((n) => [n.id, n]))
  }
  applyNodes((prev) => prev)
  const ops = nodeOpsMod.createNodeOps({
    set: (patch) => Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
    get: () => state,
    showToast: (m, a) => toasts.push({ m, a }),
    applyNodes
  })
  return { state, ops, toasts }
}

check('nodeOps：删除被引用源卡保留悬空引用，undo 自动复活（校验复原）', () => {
  const { state, ops } = nodeOpsMockStore([fileCard('src'), genCard('t', 'image', { references: [ref('src', 'reference_image', 0, 't:src:reference_image')] })])
  ops.requestRemoveNode('src')
  assert(state.nodes.length === 1 && state.canUndo && state.undoEntry?.nodes[0]?.id === 'src', '删除应记入撤销缓冲')
  const dangling = graph.getGenerateReferences(state.nodes[0], state.nodes, IMAGE_I2I)
  assert(dangling.length === 1 && dangling[0].sourceNodeId === 'src', '悬空引用必须保留为占位')
  assert(
    graph.validateGenerateReferences(state.nodes[0], state.nodes, IMAGE_I2I).errors.some((e) => e.includes('不存在或已被删除')),
    '悬空期校验应报缺失'
  )
  ops.undo()
  assert(state.nodes.some((n) => n.id === 'src'), 'undo 应复活源卡')
  assert(graph.validateGenerateReferences(state.nodes[0], state.nodes, IMAGE_I2I).errors.length === 0, '复活后校验应复原')
})

check('nodeOps：createGenerateNode 的 legacy refs 入口规范化（去重/去不存在），不固化 references', () => {
  const { state, ops } = nodeOpsMockStore([fileCard('real')])
  const id = ops.createGenerateNode('image', { x: 0, y: 0 }, ['real', 'real', 'ghost'])
  const created = state.nodes.find((n) => n.id === id)
  assert(created?.data.gen, '应创建生成卡')
  assert(created.data.gen.refs.join() === 'real', `refs 应规范化，实际 ${JSON.stringify(created.data.gen.refs)}`)
  assert(created.data.gen.references === undefined, '创建期不固化 references（按 caps 懒读）')
  assert(state.activeGenerateId === id, '新建生成卡应为当前激活卡')
})

check('nodeOps：删除解除任务绑定、undo 恢复绑定；有版本的生成卡删除走确认', () => {
  const { state, ops } = nodeOpsMockStore([genCard('busy', 'image', { jobId: 'job-1' })])
  sharedMod.jobCardIndex.set('job-1', 'busy')
  ops.removeNodes(['busy'])
  assert(!sharedMod.jobCardIndex.has('job-1'), '删除应解除任务绑定（后续事件由重建承接）')
  ops.undo()
  assert(sharedMod.jobCardIndex.get('job-1') === 'busy', 'undo 应恢复任务绑定')
  const { state: s2, ops: ops2 } = nodeOpsMockStore([
    genCard('done', 'image', {
      versions: [{ id: 'v1', storage: 'media', path: 'o.png', name: 'o.png', prompt: 'p', createdAt: '' }],
      activeVersionId: 'v1'
    }, { storage: 'media', path: 'o.png' })
  ])
  ops2.requestRemoveNode('done')
  assert(s2.nodes.length === 1 && s2.confirm?.danger === true && s2.confirm.title.includes('done'), '有版本的生成卡删除应先弹确认')
})

/* ---------------- 6. 运行时回归（jobRuntime + generationChain：bridge/settings 全 mock，事件驱动） ---------------- */

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
    chainRun: null,
    activeGenerateId: null,
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
      provider: req.provider,
      model: req.model,
      kind: req.kind,
      prompt: req.prompt,
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

async function tickUntil(cond, max = 500) {
  // 先让出一个宏任务：真实事件经 IPC 监听器异步到达，必晚于 submitFrozen 绑定与
  // waitJobTerminal 注册（同步+微任务链）；测试侧保持同一时序，不在注册窗口内插事件
  await new Promise((r) => setImmediate(r))
  for (let i = 0; i < max; i += 1) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  assert(cond(), 'tickUntil 等待超时')
}

const singleCardFixture = () => {
  const src = fileCard('src')
  const target = genCard('t', 'image', {
    prompt: '',
    references: [ref('src', 'reference_image', 0, 't:src:reference_image')],
    params: { ratio: '16:9' }
  })
  return { src, target }
}

const versionOf = (id, path, prompt, inputsRefs = []) => ({
  id,
  storage: 'media',
  path,
  name: path.split('/').pop(),
  prompt,
  inputs: { prompt, params: {}, provider: 'prov', model: 'img-model', refs: inputsRefs, createdAt: 1 },
  createdAt: '2026-01-01'
})

/** 链夹具：L（上游生成卡，有产物）→ T（目标，引用 L 未产出）。stale 版 L 输入已变更必重跑 */
const chainFixture = () => {
  const ghostSnap = { referenceId: 'ghost', sourceNodeId: 'g', role: 'reference_image', sourceName: 'g', storage: 'media', path: 'g.png' }
  const fresh = versionOf('v1', 'l1.png', 'l', [])
  const stale = versionOf('v1', 'l1.png', 'l', [ghostSnap])
  const lFresh = genCard('l', 'image', { prompt: 'l', versions: [fresh], activeVersionId: 'v1' }, { storage: 'media', path: 'l1.png' })
  const lStale = genCard('l', 'image', { prompt: 'l', versions: [stale], activeVersionId: 'v1' }, { storage: 'media', path: 'l1.png' })
  const target = genCard('t', 'image', { prompt: 't', references: [ref('l', 'reference_image', 0, 't:l:reference_image')] })
  return { lFresh, lStale, target }
}

const succeededArtifact = (relPath) => ({
  state: 'succeeded',
  progress: 1,
  artifact: { relPath, name: relPath.split('/').pop(), mime: 'image/png', bytes: 10, width: 1024, height: 1024 },
  artifactDirRel: '.huabu/media'
})

check('运行时：单卡提交冻结输入，终态落版本（快照/参考路径/pathRoot/比例对齐产物）', async () => {
  const { src, target } = singleCardFixture()
  const { state, rt, bridge } = runtimeFixture([src, target])
  await rt.submitGeneration('t', '一只猫')
  const call = bridge.generateCalls[0]
  assert(call, '应发起一次生成 IPC')
  assert(call.provider === 'prov' && call.model === 'img-model' && call.kind === 'image', '模型应按设置解析')
  assert(call.prompt === '一只猫' && call.nodeId === 't' && call.ratio === '16:9', '提示词/节点/比例应透传')
  assert(JSON.stringify(call.refs) === JSON.stringify([{ role: 'reference_image', path: 'src.png' }]), `参考应按角色冻结，实际 ${JSON.stringify(call.refs)}`)
  const queued = state.nodesById.get('t').data.gen
  assert(queued.status === 'queued' && queued.jobId, '提交后应 queued 且绑定 jobId')
  assert(queued.pendingInputs?.refs[0]?.path === 'src.png' && queued.pendingInputs.prompt === '一只猫', '输入快照应在提交时定格')
  const jobId = queued.jobId
  rt.handleJobEvent(bridge.advance(jobId, { state: 'running', progress: 0.5 }))
  assert(state.nodesById.get('t').data.gen.progress === 0.5, 'running 事件应更新进度')
  rt.handleJobEvent(bridge.advance(jobId, succeededArtifact('auto/t-out.png')))
  const done = state.nodesById.get('t')
  const gen = done.data.gen
  assert(gen.status === 'succeeded' && gen.jobId === undefined && gen.pendingInputs === undefined, '终态应解绑任务并释放 pending')
  assert(gen.versions.length === 1, `应落一版，实际 ${gen.versions.length}`)
  const version = gen.versions[0]
  assert(version.path === 'auto/t-out.png' && version.storage === 'media' && version.pathRoot === '.huabu/media', '产物引用应含落盘目录')
  assert(version.inputs.refs[0].path === 'src.png' && version.inputs.prompt === '一只猫' && version.inputs.model === 'img-model', '版本 inputs 应绑定提交时快照')
  assert(gen.params.ratio === '1:1', `比例应按产物 1024x1024 反推，实际 ${gen.params.ratio}`)
  assert(done.data.path === 'auto/t-out.png' && gen.activeVersionId === version.id, '卡片应指向新产物')
})

check('运行时：freeze——提交后编辑源卡与提示词不污染已冻结快照', async () => {
  const { src, target } = singleCardFixture()
  const { state, rt, bridge } = runtimeFixture([src, target])
  await rt.submitGeneration('t', '一只猫')
  const jobId = state.nodesById.get('t').data.gen.jobId
  src.data.path = 'renamed-after-submit.png'
  rt.handleJobEvent(bridge.advance(jobId, { state: 'running', progress: 0.4 }))
  rt.updateGenerate('t', { prompt: '运行中改提示词' })
  rt.handleJobEvent(bridge.advance(jobId, succeededArtifact('auto/t-out.png')))
  const version = state.nodesById.get('t').data.gen.versions[0]
  assert(version.inputs.refs[0].path === 'src.png', `版本 inputs 应是提交时冻结路径，实际 ${version.inputs.refs[0].path}`)
  assert(version.inputs.prompt === '一只猫', '运行中编辑提示词不得改写冻结快照')
  assert(version.prompt === '一只猫', '版本提示词应取任务事实')
})

check('运行时：终态早到（succeeded 事件先于 IPC 返回）——缓冲/绑定/replay 恰好一版', async () => {
  const { src, target } = singleCardFixture()
  const { state, rt, bridge } = runtimeFixture([src, target])
  bridge.setHandler((req, mk) => {
    const job = mk(req, 'queued')
    bridge.advance(job.jobId, succeededArtifact('auto/fast.png'))
    rt.handleJobEvent(bridge.jobs.get(job.jobId))
    return { ok: true, value: { jobId: job.jobId } }
  })
  await rt.submitGeneration('t', 'p')
  const gen = state.nodesById.get('t').data.gen
  assert(gen.status === 'succeeded', `快速终态应已收尾，实际 ${gen.status}`)
  assert(gen.versions.length === 1, `replay 与对账重叠不得重复入库，实际 ${gen.versions.length} 版`)
  assert(gen.versions[0].inputs?.prompt === 'p', 'replay 版本应绑定 pendingInputs')
  assert(gen.versions[0].path === 'auto/fast.png', 'replay 版本应带产物')
})

check('运行时：重复 succeeded 事件幂等（不重复入库、不建新卡）', async () => {
  const { src, target } = singleCardFixture()
  const { state, rt, bridge } = runtimeFixture([src, target])
  await rt.submitGeneration('t', 'p')
  const jobId = state.nodesById.get('t').data.gen.jobId
  rt.handleJobEvent(bridge.advance(jobId, succeededArtifact('auto/t-out.png')))
  rt.handleJobEvent(bridge.advance(jobId, succeededArtifact('auto/t-out.png')))
  assert(state.nodesById.get('t').data.gen.versions.length === 1, '同任务重复终态只入一版')
  assert(state.nodes.length === 2, '无人认领的重复事件不应建卡')
})

check('运行时：IPC 拒绝 → 卡 failed + pendingInputs 释放；运行中取消 → 旧版本保留', async () => {
  const { src, target } = singleCardFixture()
  const seed = versionOf('v1', 'old.png', 'p')
  const withOld = genCard('t', 'image', {
    ...target.data.gen,
    versions: [seed],
    activeVersionId: 'v1'
  }, { storage: 'media', path: 'old.png' })
  const { state, rt, bridge } = runtimeFixture([src, withOld])
  bridge.setHandler(async () => ({ ok: false, error: '余额不足' }))
  await rt.submitGeneration('t', 'p')
  let gen = state.nodesById.get('t').data.gen
  assert(gen.status === 'failed' && gen.error === '余额不足' && gen.pendingInputs === undefined && gen.jobId === undefined, 'IPC 拒绝应失败收尾')
  // 再提交一次走取消路径
  bridge.setHandler(null)
  await rt.submitGeneration('t', 'p')
  const jobId = gen.jobId ?? state.nodesById.get('t').data.gen.jobId
  assert(jobId, '第二次提交应绑定任务')
  await rt.cancelGeneration('t')
  assert(bridge.cancelCalls[0] === jobId, '取消应调 media.cancel(jobId)')
  rt.handleJobEvent(bridge.advance(jobId, { state: 'cancelled', progress: 0 }))
  gen = state.nodesById.get('t').data.gen
  assert(gen.status === 'failed' && gen.error === '已取消', `取消事件应收尾为 failed/已取消，实际 ${gen.status}/${gen.error}`)
  assert(gen.versions.length === 1 && gen.versions[0].id === 'v1', '取消不得动旧版本')
  assert(gen.jobId === undefined && gen.pendingInputs === undefined, '取消后应解绑')
})

check('运行时：failed 事件先于 IPC 返回——快速失败也收尾且带原因', async () => {
  const { src, target } = singleCardFixture()
  const { state, rt, bridge } = runtimeFixture([src, target])
  bridge.setHandler((req, mk) => {
    const job = mk(req, 'queued')
    bridge.advance(job.jobId, { state: 'failed', progress: 0, error: '上游网关 429' })
    rt.handleJobEvent(bridge.jobs.get(job.jobId))
    return { ok: true, value: { jobId: job.jobId } }
  })
  await rt.submitGeneration('t', 'p')
  const gen = state.nodesById.get('t').data.gen
  assert(gen.status === 'failed' && gen.error === '上游网关 429', `快速失败应收尾，实际 ${gen.status}/${gen.error}`)
  assert(gen.versions.length === 0 && gen.pendingInputs === undefined, '失败不得落版本，pending 应释放')
})

check('运行时：产物落素材库（ws 形态）——pathRoot 残留清除、引用换成工作区路径', async () => {
  const { src, target } = singleCardFixture()
  target.data.storage = 'media'
  target.data.path = 'old.png'
  target.data.pathRoot = '.huabu/media'
  const { state, rt, bridge } = runtimeFixture([src, target])
  state.resolveOutputLibrary = () => ({ path: '素材库/海报', name: '海报' })
  await rt.submitGeneration('t', 'p')
  assert(bridge.generateCalls[0].outputDir === '素材库/海报', '落库目标应进请求')
  const jobId = state.nodesById.get('t').data.gen.jobId
  rt.handleJobEvent(bridge.advance(jobId, {
    state: 'succeeded',
    progress: 1,
    artifact: { relPath: 'a.png', name: 'a.png', mime: 'image/png', bytes: 1, width: 512, height: 512 }
  }))
  const done = state.nodesById.get('t')
  assert(done.data.storage === 'ws' && done.data.path === '素材库/海报/a.png', 'ws 产物应落工作区相对路径')
  assert(done.data.pathRoot === undefined, 'media→ws 必须清残留 pathRoot（双前缀陷阱）')
  assert(done.data.gen.versions[0].pathRoot === undefined, '版本同样不带 pathRoot')
})

check('运行时：无主事件——画布来源静默丢弃，Agent 来源建卡承接且同任务只建一张', () => {
  const { state, rt, bridge } = runtimeFixture([])
  rt.handleJobEvent(bridge.mkJob({ provider: 'prov', model: 'img-model', kind: 'image', prompt: 'x' }, 'running'))
  assert(state.nodes.length === 0, '画布来源无主事件不应建卡')
  const agentJob = bridge.mkJob({ provider: 'prov', model: 'img-model', kind: 'image', prompt: 'y' }, 'running', { sourceChatId: 'chat1' })
  rt.handleJobEvent(agentJob)
  assert(state.nodes.length === 1, 'Agent 来源应建卡承接')
  rt.handleJobEvent(agentJob)
  assert(state.nodes.length === 1, '同 jobId 不得重复建卡')
})

check('运行时：载入对账——终态就地收尾、jobs 缺失报任务状态未知', async () => {
  const a = genCard('a', 'image', { prompt: 'p', jobId: 'job-a', status: 'running', progress: 0.2, versions: [versionOf('v1', 'l1.png', 'p')], activeVersionId: 'v1' }, { storage: 'media', path: 'l1.png' })
  const b = genCard('b', 'image', { prompt: 'p', jobId: 'job-b', status: 'running', progress: 0.2 })
  const { state, rt, bridge } = runtimeFixture([a, b])
  bridge.jobs.set('job-a', {
    jobId: 'job-a', provider: 'prov', model: 'img-model', kind: 'image', prompt: 'p',
    state: 'succeeded', progress: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    artifact: { relPath: 'auto/a2.png', name: 'a2.png', mime: 'image/png', bytes: 1, width: 256, height: 256 },
    artifactDirRel: '.huabu/media'
  })
  await rt.reconcileJobs()
  const genA = state.nodesById.get('a').data.gen
  assert(genA.status === 'succeeded' && genA.versions.length === 2 && genA.versions[0].jobId === 'job-a', '终态任务对账应就地入库')
  const genB = state.nodesById.get('b').data.gen
  assert(genB.status === 'failed' && genB.error.includes('任务状态未知'), `jobs 缺失应报任务状态未知，实际 ${genB.error}`)
})

check('运行时：链按拓扑顺序提交，下游吃上游真实捕获产物（不回读 activeVersion）', async () => {
  const { lStale, target } = chainFixture()
  const { state, rt, bridge, toasts } = runtimeFixture([lStale, target])
  await rt.runGenerationChain('t')
  assert(state.confirm?.title?.includes('执行 2 张'), `应确认执行 2 张，实际 ${state.confirm?.title}`)
  state.confirm.onConfirm()
  await tickUntil(() => bridge.generateCalls.length === 1)
  assert(bridge.generateCalls[0].nodeId === 'l' && (bridge.generateCalls[0].refs ?? []).length === 0, '上游先提交且无参考')
  const jobIdL = state.nodesById.get('l').data.gen.jobId
  assert(jobIdL, '上游应绑定任务')
  rt.handleJobEvent(bridge.advance(jobIdL, succeededArtifact('auto/l2.png')))
  await tickUntil(() => bridge.generateCalls.length === 2)
  const callT = bridge.generateCalls[1]
  assert(callT.nodeId === 't', '下游在上游成功后才提交')
  assert(callT.refs[0].path === '.huabu/media/auto/l2.png', `下游应吃捕获产物（含落盘根），实际 ${callT.refs[0].path}`)
  assert(state.nodesById.get('l').data.gen.versions[0].path === 'auto/l2.png', '上游卡片应已指向新产物')
  const jobIdT = state.nodesById.get('t').data.gen.jobId
  rt.handleJobEvent(bridge.advance(jobIdT, succeededArtifact('auto/t2.png')))
  await tickUntil(() => state.chainRun?.status)
  assert(state.chainRun.status === 'succeeded', `链应成功，实际 ${state.chainRun.status}：${state.chainRun.error}`)
  assert(state.chainRun.completedNodeIds.join(',') === 'l,t', `完成序应为 l,t，实际 ${state.chainRun.completedNodeIds.join(',')}`)
  assert(bridge.generateCalls.length === 2, '不应有多余提交')
  const tVersion = state.nodesById.get('t').data.gen.versions[0]
  assert(tVersion.inputs.refs[0].path === 'auto/l2.png', 'T 版本 inputs 应定格捕获产物')
  assert(toasts.some((x) => x.m.includes('生成链完成')), '应有完成提示')
})

check('运行时：链复用——上游没变不重跑（复用就地固定），目标总重跑', async () => {
  const { lFresh, target } = chainFixture()
  const { state, rt, bridge } = runtimeFixture([lFresh, target])
  await rt.runGenerationChain('t')
  assert(state.confirm.title.includes('执行 1 张') && state.confirm.title.includes('复用 1 张'), `应确认执行 1 复用 1，实际 ${state.confirm.title}`)
  state.confirm.onConfirm()
  await tickUntil(() => bridge.generateCalls.length === 1)
  const callT = bridge.generateCalls[0]
  assert(callT.nodeId === 't', '只应提交目标卡')
  assert(callT.refs[0].path === 'l1.png', `下游应引用上游既有产物 v1，实际 ${callT.refs[0].path}`)
  const pending = state.nodesById.get('t').data.gen.pendingInputs
  assert(pending?.refs[0].sourceVersionId === 'v1', `提交快照应记录上游版本 v1，实际 ${pending?.refs[0].sourceVersionId}`)
  rt.handleJobEvent(bridge.advance(state.nodesById.get('t').data.gen.jobId, succeededArtifact('auto/t2.png')))
  await tickUntil(() => state.chainRun?.status)
  assert(state.chainRun.status === 'succeeded' && state.chainRun.completedNodeIds.join(',') === 'l,t', '复用卡也计入完成序')
})

check('运行时：链失败不启动下游，参与卡保留既有结果', async () => {
  const { lStale, target } = chainFixture()
  const { state, rt, bridge } = runtimeFixture([lStale, target])
  await rt.runGenerationChain('t')
  state.confirm.onConfirm()
  await tickUntil(() => bridge.generateCalls.length === 1)
  rt.handleJobEvent(bridge.advance(state.nodesById.get('l').data.gen.jobId, { state: 'failed', progress: 0, error: 'boom' }))
  await tickUntil(() => state.chainRun?.status)
  assert(state.chainRun.status === 'failed' && state.chainRun.error.includes('生成失败'), `链应失败，实际 ${state.chainRun.status}`)
  assert(bridge.generateCalls.length === 1, '下游不得启动')
  assert(state.nodesById.get('l').data.gen.status === 'failed' && state.nodesById.get('l').data.gen.error === 'boom', '上游卡应带失败原因')
  assert(state.nodesById.get('t').data.gen.status === 'idle' && state.nodesById.get('t').data.gen.versions.length === 0, '目标卡保持未动')
})

check('运行时：链运行中取消——停止等待、取消在跑任务、不启动下游', async () => {
  const { lStale, target } = chainFixture()
  const { state, rt, bridge } = runtimeFixture([lStale, target])
  await rt.runGenerationChain('t')
  state.confirm.onConfirm()
  await tickUntil(() => bridge.generateCalls.length === 1)
  const jobIdL = state.nodesById.get('l').data.gen.jobId
  await rt.cancelGeneration('l')
  assert(bridge.cancelCalls[0] === jobIdL, '取消应调 media.cancel')
  rt.handleJobEvent(bridge.advance(jobIdL, { state: 'cancelled', progress: 0 }))
  await tickUntil(() => state.chainRun?.status)
  assert(state.chainRun.status === 'cancelled', `链应取消，实际 ${state.chainRun.status}`)
  assert(bridge.generateCalls.length === 1, '取消后不得启动下游')
  assert(state.nodesById.get('l').data.gen.status === 'failed' && state.nodesById.get('l').data.gen.error === '已取消', '被取消卡应释放为可重试')
})

check('运行时：取消命中 IPC 在途窗口——绑定后补取消真实任务、卡片收尾非 queued、不启动下游', async () => {
  const { lStale, target } = chainFixture()
  const { state, rt, bridge } = runtimeFixture([lStale, target])
  let gate = null
  bridge.setHandler((req, mk) => new Promise((resolve) => { gate = { req, mk, resolve } }))
  await rt.runGenerationChain('t')
  state.confirm.onConfirm()
  await tickUntil(() => gate)
  await rt.cancelGeneration('l')
  assert(bridge.cancelCalls.length === 0, 'jobId 未绑定期无任务可取消')
  const job = gate.mk(gate.req, 'queued')
  gate.resolve({ ok: true, value: { jobId: job.jobId } })
  await tickUntil(() => state.chainRun?.status)
  assert(state.chainRun.status === 'cancelled', `链应取消收尾，实际 ${state.chainRun.status}`)
  assert(bridge.generateCalls.length === 1, '取消后不得启动下游')
  const jobId = state.nodesById.get('l').data.gen.jobId
  assert(jobId && bridge.cancelCalls.includes(jobId), `IPC 返回绑定后应补取消真实任务 ${jobId}，实际取消调用：${JSON.stringify(bridge.cancelCalls)}`)
  rt.handleJobEvent(bridge.advance(jobId, { state: 'cancelled', progress: 0 }))
  const gen = state.nodesById.get('l').data.gen
  assert(gen.status === 'failed' && gen.error === '已取消' && gen.jobId === undefined, `卡片最终应非 queued（failed/已取消），实际 ${gen.status}/${gen.error}`)
})

check('运行时：单卡取消命中 IPC 在途窗口——绑定后补取消真实任务、卡片收尾非 queued', async () => {
  const { src, target } = singleCardFixture()
  const { state, rt, bridge } = runtimeFixture([src, target])
  let gate = null
  bridge.setHandler((req, mk) => new Promise((resolve) => { gate = { req, mk, resolve } }))
  const submitted = rt.submitGeneration('t', 'p')
  await tickUntil(() => gate)
  await rt.cancelGeneration('t')
  const job = gate.mk(gate.req, 'queued')
  gate.resolve({ ok: true, value: { jobId: job.jobId } })
  await submitted
  const jobId = state.nodesById.get('t').data.gen.jobId
  assert(jobId, 'IPC 返回后任务应已绑定')
  assert(bridge.cancelCalls.includes(jobId), `绑定后应补取消真实任务 ${jobId}，实际取消调用：${JSON.stringify(bridge.cancelCalls)}`)
  rt.handleJobEvent(bridge.advance(jobId, { state: 'cancelled', progress: 0 }))
  const gen = state.nodesById.get('t').data.gen
  assert(gen.status === 'failed' && gen.error === '已取消' && gen.jobId === undefined, `卡片最终应非 queued（failed/已取消），实际 ${gen.status}/${gen.error}`)
})

check('运行时：链等待期间切工作区——唤醒后停止且不启动下游（已完成产物保留）', async () => {
  const { lStale, target } = chainFixture()
  const { state, rt, bridge } = runtimeFixture([lStale, target])
  await rt.runGenerationChain('t')
  state.confirm.onConfirm()
  await tickUntil(() => bridge.generateCalls.length === 1)
  const jobIdL = state.nodesById.get('l').data.gen.jobId
  state.workspace = { path: '/ws/other', name: 'other' }
  rt.handleJobEvent(bridge.advance(jobIdL, succeededArtifact('auto/l2.png')))
  await tickUntil(() => state.chainRun?.status)
  assert(state.chainRun.status === 'cancelled' && state.chainRun.error.includes('工作区已切换'), `应按工作区切换收尾，实际 ${state.chainRun.status}：${state.chainRun.error}`)
  assert(bridge.generateCalls.length === 1, '切换后不得继续提交')
  assert(state.nodesById.get('l').data.gen.status === 'succeeded', '已完成产物保留')
})

check('运行时：链等待期间上游切换显示版本——T 仍以冻结产物完成（不重跑不漂移）', async () => {
  const { lStale, target } = chainFixture()
  const { state, rt, bridge } = runtimeFixture([lStale, target])
  await rt.runGenerationChain('t')
  state.confirm.onConfirm()
  await tickUntil(() => bridge.generateCalls.length === 1)
  rt.handleJobEvent(bridge.advance(state.nodesById.get('l').data.gen.jobId, succeededArtifact('auto/l2.png')))
  await tickUntil(() => bridge.generateCalls.length === 2)
  const callT = bridge.generateCalls[1]
  assert(callT.refs[0].path === '.huabu/media/auto/l2.png', 'T 请求应已冻结捕获产物')
  const capturedId = state.nodesById.get('l').data.gen.versions[0].id
  // T 等待期间：上游又生成/切换显示版本（模拟并发操作）
  const lGen = state.nodesById.get('l').data.gen
  lGen.versions = [{ ...lGen.versions[0], id: 'v3', path: 'l3.png', name: 'l3.png' }, ...lGen.versions]
  lGen.activeVersionId = 'v3'
  rt.handleJobEvent(bridge.advance(state.nodesById.get('t').data.gen.jobId, succeededArtifact('auto/t2.png')))
  await tickUntil(() => state.chainRun?.status)
  assert(state.chainRun.status === 'succeeded', `链应完成，实际 ${state.chainRun.status}：${state.chainRun.error}`)
  assert(bridge.generateCalls.length === 2, '等待期间的上游切换不得触发重跑')
  const tVersion = state.nodesById.get('t').data.gen.versions[0]
  assert(tVersion.inputs.refs[0].path === 'auto/l2.png' && tVersion.inputs.refs[0].sourceVersionId === capturedId, 'T 版本 inputs 应定格提交时刻的上游产物')
})

check('运行时：链互斥——运行中不能再开链，链上卡不能单卡提交', async () => {
  const { lStale, target } = chainFixture()
  const { state, rt, bridge, toasts } = runtimeFixture([lStale, target])
  await rt.runGenerationChain('t')
  state.confirm.onConfirm()
  await tickUntil(() => bridge.generateCalls.length === 1)
  await rt.runGenerationChain('t')
  assert(toasts.some((x) => x.m.includes('已有一条生成链在运行')), '第二条链应被拒')
  await rt.submitGeneration('t', 'x')
  assert(toasts.some((x) => x.m.includes('正在生成链中执行')), '链上卡单卡提交应被拒')
  // 收尾：跑完链，防悬挂等待
  rt.handleJobEvent(bridge.advance(state.nodesById.get('l').data.gen.jobId, succeededArtifact('auto/l2.png')))
  await tickUntil(() => bridge.generateCalls.length === 2)
  rt.handleJobEvent(bridge.advance(state.nodesById.get('t').data.gen.jobId, succeededArtifact('auto/t2.png')))
  await tickUntil(() => state.chainRun?.status)
  assert(state.chainRun.status === 'succeeded', '收尾应成功')
})

check('运行时：legacy refs/refRoles patch 经 updateGenerate 按真实 caps 懒迁移（video-fl 派生 first_frame）', () => {
  const src = fileCard('src')
  const target = genCard('t', 'video', { prompt: 'p', params: { model: 'prov:video-fl' } })
  const { state, rt } = runtimeFixture([src, target])
  rt.updateGenerate('t', { refs: ['src'] })
  const gen = state.nodesById.get('t').data.gen
  assert(Array.isArray(gen.references) && gen.references.length === 1, 'patch 后应重建 references（权威层）')
  assert(gen.references[0].role === 'first_frame', `首图应按 video-fl caps 派生 first_frame，实际 ${gen.references[0]?.role}`)
  assert(gen.references[0].id === 't:src:first_frame', '稳定 id 应为 t:src:first_frame')
})

check('运行时：链上终态早到（succeeded 先于 IPC 返回）——链继续、下游提交、目标完成', async () => {
  const { lStale, target } = chainFixture()
  const { state, rt, bridge } = runtimeFixture([lStale, target])
  bridge.setHandler((req, mk) => {
    const job = mk(req, 'queued')
    bridge.advance(job.jobId, succeededArtifact('auto/fast.png'))
    rt.handleJobEvent(bridge.jobs.get(job.jobId))
    return { ok: true, value: { jobId: job.jobId } }
  })
  await rt.runGenerationChain('t')
  state.confirm.onConfirm()
  await tickUntil(() => state.chainRun?.status)
  assert(state.chainRun.status === 'succeeded', `链应成功（上游实际已出图），实际 ${state.chainRun.status}：${state.chainRun.error}`)
  assert(bridge.generateCalls.length === 2, '下游应继续提交')
})

/* ---------------- 顺序执行与汇总 ---------------- */

for (const { name, fn } of tests) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`PASS ${name}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, pass: false, detail: message })
    console.log(`FAIL ${name} — ${message}`)
  }
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const r of failed) console.error(`FAILED: ${r.name} — ${r.detail}`)
}
// 强制退出：链等待的兜底 timer（最长 30 分钟）不应拖住 check 进程
process.exit(failed.length > 0 ? 1 : 0)
