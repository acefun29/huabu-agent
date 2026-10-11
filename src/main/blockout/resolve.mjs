/**
 * MVP 解算层 —— author JSON → resolved parts（设计规范 §1 的两阶段产物）
 *
 * author 层（Agent 写）：drivers + 表达式尺寸 + 锚点/关系 + 组合（mirror/array）
 * resolved 层（引擎算）：具体图元 + 绝对位姿 + 世界包围盒 + 碰撞间隙
 *
 * 纪律：
 *  - 解算顺序固定：drivers → defs 内 parts（按声明序，可用已解算兄弟件的锚点）→ scene 实例（可用已放置实例的锚点）
 *  - 锚点/关系全部闭式求解，无迭代、无随机 → 同输入逐字节同输出
 *  - 碰撞默认「安静」：只报未声明的跨装配体穿透 + 声明为 clear 的间隙被违反（见规范 §6.2）
 */

import { compileField, compileVec3 } from './expr.mjs'
import { SHAPES, createPart, worldAabb, makePose, posePoint, matApply, gapBetween, v3 } from './geom.mjs'

const SCALAR_KEYS = ['radius', 'height', 'sides', 'segments', 'rings']
const ANCHOR_RE = /^(center|base_center|top_center|bbox_min|bbox_max|face\([+-][XYZ]\)|cap\([+-]Z\)|corner\([+-][XYZ][+-][XYZ][+-][XYZ]\))$/

/* ────────── 参数编译 ────────── */

function compileParams(shape, raw, where) {
  const out = { src: {}, refs: [] }
  const vecDims = shape === 'plane' ? 2 : ['box', 'wedge', 'ellipsoid'].includes(shape) ? 3 : 0
  if (vecDims > 0) {
    const f = compileVec3(raw.size, `${where}.size`, vecDims)
    if (!f) throw new Error(`${where}: 图元 ${shape} 必须提供 size`)
    const arr = f.src
    const items = arr.map((v, i) => compileField(v, `${where}.size[${i}]`))
    out.size = { refs: f.refs, value: (scope) => items.map((it) => it.value(scope)) }
    out.src.size = arr
  }
  for (const k of SCALAR_KEYS) {
    if (raw[k] === undefined) continue
    const f = compileField(raw[k], `${where}.${k}`)
    out[k] = f
    out.src[k] = raw[k]
    out.refs.push(...f.refs)
  }
  out.allRefs = [...new Set([...(out.size?.refs ?? []), ...out.refs])]
  return out
}

/* ────────── 锚点 ────────── */

/** 局部 AABB 上的锚点（局部坐标） */
export function localAnchor(part, name) {
  const a = part.mesh.aabb
  const cx = (a.min[0] + a.max[0]) / 2
  const cy = (a.min[1] + a.max[1]) / 2
  const cz = (a.min[2] + a.max[2]) / 2
  const mid = [cx, cy, cz]
  const face = (axis, sign) => {
    const p = mid.slice()
    p[axis] = sign > 0 ? a.max[axis] : a.min[axis]
    return p
  }
  switch (name) {
    case 'center': return mid
    case 'base_center': return [cx, cy, a.min[2]]
    case 'top_center': return [cx, cy, a.max[2]]
    case 'bbox_min': return a.min.slice()
    case 'bbox_max': return a.max.slice()
    case 'cap(+Z)': return [cx, cy, a.max[2]]
    case 'cap(-Z)': return [cx, cy, a.min[2]]
    default: break
  }
  let m = /^face\(([+-])([XYZ])\)$/.exec(name)
  if (m) return face('XYZ'.indexOf(m[2]), m[1] === '+' ? 1 : -1)
  m = /^corner\(([+-])([XYZ])([+-])([XYZ])([+-])([XYZ])\)$/.exec(name)
  if (m) {
    const p = mid.slice()
    p['XYZ'.indexOf(m[2])] = m[1] === '+' ? a.max['XYZ'.indexOf(m[2])] : a.min['XYZ'.indexOf(m[2])]
    p['XYZ'.indexOf(m[4])] = m[3] === '+' ? a.max['XYZ'.indexOf(m[4])] : a.min['XYZ'.indexOf(m[4])]
    p['XYZ'.indexOf(m[6])] = m[5] === '+' ? a.max['XYZ'.indexOf(m[6])] : a.min['XYZ'.indexOf(m[6])]
    return p
  }
  throw new Error(`未知锚点：${name}`)
}

export const anchorWorld = (part, name) => posePoint(part.pose, localAnchor(part, name))

/* ────────── 组合（mirror / array） ────────── */

function expandCombines(combine, where) {
  let variants = [{ labels: [], offset: [0, 0, 0], mirrorAxis: null }]
  for (const op of combine ?? []) {
    const next = []
    const labels = op.labels
    if (!Array.isArray(labels) || labels.length === 0) throw new Error(`${where}: combine 的 ${op.op} 必须提供 labels（杜绝自动生成的不可读 ID）`)
    if (op.op === 'array') {
      const count = Math.round(op.count ?? labels.length)
      if (count !== labels.length) throw new Error(`${where}: array count(${count}) 与 labels(${labels.length}) 不一致`)
      const axis = 'XYZ'.indexOf(op.along ?? 'X')
      if (axis < 0) throw new Error(`${where}: array.along 必须是 X/Y/Z`)
      const step = op.step
      if (typeof step !== 'number' || !Number.isFinite(step)) throw new Error(`${where}: array.step 必须是数字（MVP 不支持表达式 step）`)
      const centered = op.centered !== false
      for (let i = 0; i < count; i += 1) {
        const raw = centered ? (i - (count - 1) / 2) * step : i * step
        for (const base of variants) {
          const off = base.offset.slice()
          off[axis] += raw
          next.push({ labels: [...base.labels, labels[i]], offset: off, mirrorAxis: base.mirrorAxis })
        }
      }
    } else if (op.op === 'mirror') {
      const axis = 'XYZ'.indexOf(op.axis ?? 'Y')
      if (axis < 0) throw new Error(`${where}: mirror.axis 必须是 X/Y/Z`)
      if (labels.length !== 2) throw new Error(`${where}: mirror 需要恰好 2 个 labels（正/负侧）`)
      for (const base of variants) {
        for (let s = 0; s < 2; s += 1) {
          const off = base.offset.slice()
          const mirror = base.mirrorAxis ? base.mirrorAxis.slice() : [1, 1, 1]
          if (s === 1) {
            off[axis] = -off[axis]
            mirror[axis] = -mirror[axis]
          }
          next.push({ labels: [...base.labels, labels[s]], offset: off, mirrorAxis: mirror })
        }
      }
    } else {
      throw new Error(`${where}: MVP 不支持的组合算子 ${op.op}（支持 array / mirror）`)
    }
    variants = next
  }
  return variants
}

/* ────────── 放置求解 ────────── */

function applyRest(pose, part, offset) {
  // rest：把局部 AABB 的 x/y 中心对到 offset.x/y，最低点对到 offset.z
  const a = part.mesh.aabb
  const cx = (a.min[0] + a.max[0]) / 2
  const cy = (a.min[1] + a.max[1]) / 2
  const worldLow = posePoint(pose, [cx, cy, a.min[2]])[2]
  return { R: pose.R, t: [offset[0] - cx, offset[1] - cy, pose.t[2] + (offset[2] - worldLow)] }
}

/* ────────── 主解算 ────────── */

/**
 * 解算入口：任何内部异常都转成结构化 errors（Agent 要的是可读的失败原因，不是栈）
 */
export function resolveScene(author) {
  try {
    return resolveSceneInner(author)
  } catch (e) {
    return {
      ok: false,
      errors: [{ level: 'error', code: 'resolve/failed', message: e instanceof Error ? e.message : String(e) }],
      warnings: [],
      notes: [],
      parts: [],
      instances: [],
      derivedFrom: {},
      scope: {},
      declaredRelations: author?.relations ?? []
    }
  }
}

function resolveSceneInner(author) {
  const errors = []
  const warnings = []
  const notes = []

  if (author?.version !== 2) errors.push({ level: 'error', code: 'scene/version', message: '当前 MVP 只接受 version:2 的 author 场景' })
  const scope = {}
  const derivedFrom = {}
  for (const [k, v] of Object.entries(author.drivers ?? {})) {
    const raw = typeof v === 'object' && v !== null ? v.value : v
    try {
      // 驱动参数本身也可以是表达式（只能引用**前面**已定义的驱动，禁止前向引用/环）
      const f = compileField(raw, `drivers.${k}`)
      const value = f.value(scope)
      scope[k] = value
      derivedFrom[k] = []
      for (const ref of f.refs) if (derivedFrom[ref]) derivedFrom[ref].push(`drivers.${k}`)
    } catch (e) {
      errors.push({ level: 'error', code: 'drivers/value', message: `驱动参数 ${k} 无法求值：${e instanceof Error ? e.message : String(e)}` })
    }
  }
  if (errors.length) return { ok: false, errors, warnings, parts: [], instances: [] }

  const parts = []
  const instances = []
  /** 已放置实例的部件索引：`instanceId/partId` → part */
  const index = new Map()

  const buildParts = (assemblyId, def, instanceId, instancePose, instanceLabel) => {
    const local = []
    const localIndex = new Map()
    for (const raw of def.parts ?? []) {
      if (!raw.id) throw new Error(`${assemblyId}: part 缺少 id`)
      const where = `${assemblyId}/${raw.id}`
      const shape = raw.shape
      if (!SHAPES.includes(shape)) throw new Error(`${where}: MVP 不支持的图元 ${shape}`)
      const paramsC = compileParams(shape, raw, where)
      const combineOps = (raw.combine ?? []).map((op) => {
        if (op.op !== 'array' || typeof op.step !== 'string') return op
        const f = compileField(op.step, `${where}.combine.step`)
        for (const ref of f.refs) if (derivedFrom[ref]) derivedFrom[ref].push(`${instanceId}/${raw.id}.combine`)
        return { ...op, step: f.value(scope) }
      })
      const variants = expandCombines(combineOps, where)
      const yawDeg = raw.at?.yawDeg ?? 0
      const offset = raw.at?.offset !== undefined ? compileVec3(raw.at.offset, `${where}.offset`) : null
      const anchorName = raw.at?.anchor ?? (raw.at?.rest ? null : 'center')
      if (anchorName && !ANCHOR_RE.test(anchorName)) throw new Error(`${where}: 未知锚点 ${anchorName}`)

      for (const variant of variants) {
        const partId = variant.labels.length ? `${raw.id}.${variant.labels.join('_')}` : raw.id
        const params = {}
        for (const k of Object.keys(paramsC.src)) {
          if (k === 'size') params.size = paramsC.size.value(scope)
          else params[k] = paramsC[k].value(scope)
        }
        const part = createPart({
          id: `${instanceId}/${partId}`,
          shape,
          params,
          color: raw.color ?? '#9aa3ad',
          assembly: instanceId
        })
        for (const ref of paramsC.allRefs) if (derivedFrom[ref]) derivedFrom[ref].push(`${instanceId}/${partId}.params`)
        const basePose = makePose([0, 0, 0], yawDeg)
        const off = offset ? offset.value(scope) : [0, 0, 0]
        let pose
        const to = raw.at?.to
        if (raw.at?.rest) {
          pose = applyRest(basePose, part, off)
        } else if (to === 'ground' || to === undefined) {
          const a = localAnchor(part, anchorName ?? 'center')
          const worldAnchor = matApply(basePose.R, a)
          pose = { R: basePose.R, t: [off[0] - worldAnchor[0], off[1] - worldAnchor[1], off[2] - worldAnchor[2]] }
        } else if (to && typeof to === 'object' && to.ref) {
          const target = localIndex.get(to.ref) ?? index.get(to.ref)
          if (!target) throw new Error(`${where}: at.to.ref 指向了尚未解算的部件 ${to.ref}`)
          const targetAnchor = anchorWorld(target, to.anchor ?? 'center')
          const a = localAnchor(part, anchorName ?? 'center')
          const worldAnchor = matApply(basePose.R, a)
          pose = {
            R: basePose.R,
            t: [
              targetAnchor[0] + off[0] - worldAnchor[0],
              targetAnchor[1] + off[1] - worldAnchor[1],
              targetAnchor[2] + off[2] - worldAnchor[2]
            ]
          }
        } else {
          throw new Error(`${where}: at 缺少可用的 to`)
        }
        // 组合偏移（装配体局部坐标系）与镜像
        const shifted = { R: pose.R, t: v3.add(pose.t, variant.offset) }
        if (variant.mirrorAxis) {
          const m = variant.mirrorAxis
          const R = pose.R.slice()
          // 镜像：沿轴翻转（仅支持轴对齐镜像；MVP 下 yaw 为 0 时精确）
          const flip = (p) => [p[0] * m[0], p[1] * m[1], p[2] * m[2]]
          const cols = [
            [R[0], R[3], R[6]],
            [R[1], R[4], R[7]],
            [R[2], R[5], R[8]]
          ].map((c) => flip(c))
          // 行列式变负 → 保持右手系：整体再翻转一次 X 列
          const Rm = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]]
          const det =
            Rm[0] * (Rm[4] * Rm[8] - Rm[5] * Rm[7]) - Rm[1] * (Rm[3] * Rm[8] - Rm[5] * Rm[6]) + Rm[2] * (Rm[3] * Rm[7] - Rm[4] * Rm[6])
          const Rf = det < 0 ? [-Rm[0], -Rm[1], -Rm[2], Rm[3], Rm[4], Rm[5], Rm[6], Rm[7], Rm[8]] : Rm
          shifted.R = Rf
        }
        // 两步必须分开：① 装配体局部坐标系内解算（兄弟件引用发生在这一层）
        //                ② 整体套用实例位姿得到世界位姿
        // 混成一步会让实例平移被叠加两次（早期版本的 bug：香水被抬到 2 倍桌面高度）
        const localPose = { R: shifted.R, t: shifted.t }
        const localPart = { ...part, pose: localPose }
        localIndex.set(partId, localPart)
        part.pose = { R: mul3(instancePose.R, shifted.R), t: posePoint(instancePose, shifted.t) }
        part.meta.rawId = partId
        part.meta.labels = variant.labels
        part.meta.localAt = raw.at ?? null
        part.meta.localPose = localPose
        part.worldAabb = worldAabb(part)
        part.relations = raw.relations ?? []
        local.push(part)
        index.set(`${instanceId}/${partId}`, part)
        parts.push(part)
      }
    }
    return local
  }

  const defs = author.defs ?? {}
  for (const entry of author.scene ?? []) {
    const instanceId = entry.id ?? entry.use
    if (!instanceId) throw new Error('scene 条目缺少 id')
    const def = entry.use ? defs[entry.use] : { parts: [entry] }
    if (entry.use && !def) throw new Error(`scene 引用了不存在的 def：${entry.use}`)
    // 实例自身的放置：参考已放置实例的锚点
    let instancePose = makePose([0, 0, 0], entry.at?.yawDeg ?? 0)
    const off = entry.at?.offset !== undefined ? compileVec3(entry.at.offset, `${instanceId}.at.offset`).value(scope) : [0, 0, 0]
    const to = entry.at?.to
    if (to && typeof to === 'object' && to.ref) {
      const target = index.get(to.ref)
      if (!target) throw new Error(`scene/${instanceId}: at.to.ref 指向尚未放置的 ${to.ref}`)
      const p = anchorWorld(target, to.anchor ?? 'center')
      instancePose = { R: instancePose.R, t: [p[0] + off[0], p[1] + off[1], p[2] + off[2]] }
    } else {
      instancePose = { R: instancePose.R, t: off.slice() }
    }
    // 装配体内部先按局部坐标解算，再整体套用实例位姿
    buildParts(entry.use ?? 'inline', def, instanceId, instancePose, entry)
    instances.push({ id: instanceId, def: entry.use ?? 'inline', pose: instancePose })
  }

  return {
    ok: !errors.some((e) => e.level === 'error'),
    errors,
    warnings,
    notes,
    parts,
    instances,
    derivedFrom,
    scope,
    declaredRelations: author.relations ?? [],
    shots: author.shots ?? {}
  }
}

function mul3(a, b) {
  const o = new Array(9)
  for (let r = 0; r < 3; r += 1)
    for (let c = 0; c < 3; c += 1) {
      let s = 0
      for (let k = 0; k < 3; k += 1) s += a[r * 3 + k] * b[k * 3 + c]
      o[r * 3 + c] = s
    }
  return o
}

/* ────────── 碰撞与意图关系 ────────── */

const patternToRe = (p) => new RegExp(`^${String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

function matchPair(spec, a, b) {
  const reA = patternToRe(spec.a)
  const reB = patternToRe(spec.b)
  return (reA.test(a) && reB.test(b)) || (reA.test(b) && reB.test(a))
}

const isPlane = (p) => p.shape === 'plane'

/** 平面（地面/台面）不参与 GJK：用竖直间隙代替 */
function planeGap(part, plane) {
  const pa = part.worldAabb
  const fa = plane.worldAabb
  const overlapXY = pa.min[0] < fa.max[0] && pa.max[0] > fa.min[0] && pa.min[1] < fa.max[1] && pa.max[1] > fa.min[1]
  if (!overlapXY) return { gap: Math.max(pa.min[2] - fa.max[2], fa.min[2] - pa.max[2]), approx: true, separated: true }
  return { gap: pa.min[2] - fa.max[2], approx: true, separated: pa.min[2] > fa.max[2] }
}

export function collideAll(resolved) {
  const { parts } = resolved
  const declared = resolved.declaredRelations ?? []
  const results = []
  const errors = []
  const warnings = []

  for (let i = 0; i < parts.length; i += 1)
    for (let j = i + 1; j < parts.length; j += 1) {
      const A = parts[i]
      const B = parts[j]
      const spec = declared.find((s) => matchPair(s, A.id, B.id))
      const mode = spec?.mode ?? 'default'
      const sameAssembly = A.assembly === B.assembly && A.assembly !== null

      if (mode === 'ignore' || mode === 'attach') {
        results.push({ a: A.id, b: B.id, mode, checked: false })
        continue
      }
      // 默认安静：同装配体内部不查（并集建模的正常重叠）；跨装配体只查穿透
      if (mode === 'default' && sameAssembly) continue

      let g
      if (isPlane(A) || isPlane(B)) {
        if (mode === 'default') continue
        g = planeGap(isPlane(A) ? B : A, isPlane(A) ? A : B)
      } else {
        const raw = gapBetween(A, B)
        g = { gap: raw.gap, approx: raw.approx, separated: raw.separated }
      }
      const entry = { a: A.id, b: B.id, mode, gap: round(g.gap, 4), approx: g.approx, checked: true }
      let ok = true
      switch (mode) {
        case 'default':
          ok = g.gap >= -1e-6
          if (!ok) errors.push({ level: 'error', code: 'collide/penetration', message: `${A.id} ↔ ${B.id} 跨装配体穿透 ${Math.abs(g.gap).toFixed(3)}m（未声明）` })
          break
        case 'touch':
          ok = Math.abs(g.gap) <= (spec.tol ?? 0.005)
          if (!ok) errors.push({ level: 'error', code: 'collide/touch', message: `${A.id} ↔ ${B.id} 未接触，间隙 ${g.gap.toFixed(3)}m（要求 ±${spec.tol ?? 0.005}）` })
          break
        case 'embed':
          ok = g.gap <= 1e-6 && Math.abs(g.gap) <= (spec.maxDepth ?? 0.05)
          if (!ok)
            errors.push({
              level: 'error',
              code: 'collide/embed',
              message:
                g.gap > 0
                  ? `${A.id} ↔ ${B.id} 声明为嵌入却分离 ${g.gap.toFixed(3)}m`
                  : `${A.id} ↔ ${B.id} 嵌入过深 ${Math.abs(g.gap).toFixed(3)}m > maxDepth ${spec.maxDepth ?? 0.05}`
            })
          break
        case 'clear':
          ok = g.gap >= (spec.minGap ?? 0)
          if (!ok) errors.push({ level: 'error', code: 'collide/clear', message: `${A.id} ↔ ${B.id} 间隙 ${g.gap.toFixed(3)}m < 要求 ${spec.minGap ?? 0}m` })
          break
      }
      entry.ok = ok
      // 默认模式只在**出问题**时输出，声明过的模式一律留痕（保持结果表干净）
      if (mode !== 'default' || !ok) results.push(entry)
    }

  // 沉地检查（只报"低于 z=0"，不自动判定悬空 —— 悬空是意图，交给 relations 声明）
  for (const p of parts) {
    if (isPlane(p)) continue
    const minZ = p.worldAabb.min[2]
    if (minZ < -0.02) warnings.push({ level: 'warn', code: 'geo/sunken', message: `${p.id} 沉入地面 ${(-minZ).toFixed(3)}m` })
  }
  return { results, errors, warnings }
}

const round = (v, n = 6) => {
  const p = 10 ** n
  return Math.round(v * p) / p
}

/* ────────── 描述（回显给 Agent 的数字表） ────────── */

export function describe(resolved) {
  const rows = resolved.parts.map((p) => {
    const a = p.worldAabb
    return {
      id: p.id,
      shape: p.shape,
      size: [round(a.max[0] - a.min[0], 4), round(a.max[1] - a.min[1], 4), round(a.max[2] - a.min[2], 4)],
      worldAabb: { min: a.min.map((v) => round(v, 4)), max: a.max.map((v) => round(v, 4)) },
      center: [0, 1, 2].map((i) => round((a.min[i] + a.max[i]) / 2, 4)),
      minZ: round(a.min[2], 4),
      color: p.color,
      assembly: p.assembly,
      labels: p.meta.labels ?? []
    }
  })
  return {
    ok: resolved.ok,
    driverCount: Object.keys(resolved.scope).length,
    partCount: rows.length,
    instances: resolved.instances.map((i) => i.id),
    parts: rows,
    derivedFrom: resolved.derivedFrom
  }
}
