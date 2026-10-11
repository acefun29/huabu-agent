/**
 * 运镜解算（C1–C5）—— 意图进、机位出
 *
 * 决策（2026-10-09 评审）：
 *  1. **只做改机位**：构图变化一律靠移动相机反解距离，焦距在本版是每镜头常量。
 *     `zoom_in/out`、`dolly_zoom`（需要改焦距）本版未实现 → validate 报「尚未实现」。
 *  2. **space 给足自由度**：world / camera / subject 三种参考系全部实现，且**每个动作可覆盖**，
 *     由 Agent 用数据选择怎么运镜。
 *  3. **aimMode:'free' 允许但防滥用**：必须填 `aim.reason`，关键帧 ≤ 8，输出恒带 warning。
 *
 * 两条状态机同时推进：**eye 状态**（dolly/truck/pedestal/orbit/crane/push）与
 * **target 状态**（pan/tilt）各自演化，每段从段首状态施加自己的增量 → 语义清晰、可叠加。
 * 全部闭式解 + 固定迭代次数 → 同输入逐字节同输出。
 */

import { v3 } from './geom.mjs'
import { compileField } from './expr.mjs'
import { coverageStats } from './render.mjs'

/* ────────── 常量与工具 ────────── */

const EASE = {
  linear: (u) => u,
  easeIn: (u) => u * u,
  easeOut: (u) => 1 - (1 - u) * (1 - u),
  easeInOut: (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)),
  // C2 连续（加速度也连续）→ 采样出的急动最低；段与段之间想不"顿"就用它
  smooth: (u) => u * u * u * (u * (u * 6 - 15) + 10)
}

const POSITION_MOVES = new Set([
  'dolly_in', 'dolly_out', 'truck_left', 'truck_right', 'pedestal_up', 'pedestal_down',
  'orbit_left', 'orbit_right', 'crane_up', 'crane_down', 'push_axis', 'rail'
])
const AIM_MOVES = new Set(['pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'roll_move'])
const UNIMPLEMENTED_MOVES = new Set(['zoom_in', 'zoom_out', 'dolly_zoom', 'whip_pan'])

const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI
const round = (v, n = 6) => Math.round(v * 10 ** n) / 10 ** n
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 确定性哈希 → 0..1（整数运算，跨引擎逐位一致，不用 Math.random） */
function hashUnit(seed, i, salt) {
  let h = Math.imul(seed | 0, 374761393) + Math.imul(i | 0, 668265263) + Math.imul(salt | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

const smootherstep = (t) => t * t * (3 - 2 * t)

/** 一维 value noise：在整数节点上取值、节点间平滑插值 → **时间连贯** */
function valueNoise(seed, x, salt) {
  const i0 = Math.floor(x)
  const f = x - i0
  const a = hashUnit(seed, i0, salt) * 2 - 1
  const b = hashUnit(seed, i0 + 1, salt) * 2 - 1
  return a + (b - a) * smootherstep(f)
}

/**
 * 手持偏移：三个八度的时间连贯噪声（不是逐帧白噪声）。
 *
 * 早期实现每帧取独立随机数 → 24fps 下变成 12Hz 高频振动：实测逐帧位移中位数 0.014m，
 * 而镜头本身的运动只有 0.002m/帧 —— 相机在"抖"而不是"手持"。夹具 F2 锁这条。
 */
function handheldOffset(mod, t) {
  const amp = mod.amplitudeM ?? 0.003
  const f0 = mod.frequencyHz ?? 1
  const seed = mod.seed ?? 1
  const OCTAVES = [
    [1, 1],
    [2.3, 0.45],
    [4.7, 0.2]
  ]
  const out = [0, 0, 0]
  for (let axis = 0; axis < 3; axis += 1) {
    let v = 0
    for (let o = 0; o < OCTAVES.length; o += 1) {
      const [fmul, amul] = OCTAVES[o]
      v += valueNoise(seed + axis * 101, t * f0 * fmul, o + 1) * amul
    }
    out[axis] = v * amp * (axis === 2 ? 0.6 : 1)
  }
  return out
}

function rotateAbout(v, axis, ang) {
  const a = v3.norm(axis)
  const c = Math.cos(ang)
  const s = Math.sin(ang)
  return v3.add(
    v3.add(v3.mul(v, c), v3.mul(v3.cross(a, v), s)),
    v3.mul(a, v3.dot(a, v) * (1 - c))
  )
}

/* ────────── 相机内参 ────────── */

function intrinsics(camera, cellW, cellH) {
  const lens = camera.lens ?? 45
  const sensor = camera.sensorWidth ?? 36
  const fit = cellW >= cellH ? cellW : cellH
  const f = (lens / sensor) * fit
  return { lens, sensor, fx: f, fy: f, cx: cellW / 2, cy: cellH / 2, width: cellW, height: cellH }
}

/* ────────── 相机基与投影 ────────── */

function cameraBasis(eye, target, upWorld) {
  const forward = v3.norm(v3.sub(target, eye))
  let right = v3.cross(forward, upWorld)
  if (v3.len(right) < 1e-9) right = v3.cross(forward, [0, 1, 0])
  right = v3.norm(right)
  const up = v3.cross(right, forward)
  return { forward, right, up }
}

/** 世界点 → 屏幕（针孔）；返回深度与是否在相机前方 */
function projectPoint(p, eye, basis, intr) {
  const d = v3.sub(p, eye)
  const z = v3.dot(d, basis.forward) // 沿视线为正
  return {
    x: intr.cx + (intr.fx * v3.dot(d, basis.right)) / z,
    y: intr.cy - (intr.fy * v3.dot(d, basis.up)) / z,
    depth: z,
    behind: z <= 1e-6
  }
}

function boxCorners(aabb) {
  const out = []
  for (const sx of [0, 1])
    for (const sy of [0, 1])
      for (const sz of [0, 1]) out.push([sx ? aabb.max[0] : aabb.min[0], sy ? aabb.max[1] : aabb.min[1], sz ? aabb.max[2] : aabb.min[2]])
  return out
}

/** 量出主体在画面里的占屏比；mode: fill-height | fill-width | fit */
function measureFraming(corners, eye, basis, intr, mode) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let behind = 0
  for (const c of corners) {
    const s = projectPoint(c, eye, basis, intr)
    if (s.behind) {
      behind += 1
      continue
    }
    minX = Math.min(minX, s.x)
    maxX = Math.max(maxX, s.x)
    minY = Math.min(minY, s.y)
    maxY = Math.max(maxY, s.y)
  }
  if (behind === corners.length) return { value: Infinity, behind, bbox: null, onscreen: false }
  const w = maxX - minX
  const h = maxY - minY
  const value =
    mode === 'fill-width' ? w / intr.width : mode === 'fit' ? Math.max(w / intr.width, h / intr.height) : h / intr.height
  // 主体是否与画面相交：完全在画外时比例是无意义的（甩镜时会放大成上千 %），必须标出来
  const onscreen = maxX > 0 && minX < intr.width && maxY > 0 && minY < intr.height
  return { value, behind, bbox: { minX, minY, maxX, maxY, w, h }, onscreen }
}

/**
 * C2：构图反解距离（只改机位，焦距固定）
 * 固定点迭代：按"量出的比例 / 目标比例"缩放距离，4 次即收敛（投影尺寸 ≈ C/d）
 */
function solveDistance(state, corners, framing, intr, iterations = 4) {
  const mode = framing.mode ?? 'fill-height'
  const target = mode === 'fit' ? 1 - (framing.margin ?? 0.1) : framing.fill
  let eye = state.eye.slice()
  for (let i = 0; i < iterations; i += 1) {
    const basis = cameraBasis(eye, state.target, state.upWorld)
    const m = measureFraming(corners, eye, basis, intr, mode)
    if (!Number.isFinite(m.value) || m.value <= 1e-6) break
    const cur = v3.len(v3.sub(eye, state.target))
    if (cur < 1e-6) break
    const next = Math.max(0.02, cur * (m.value / target))
    const dir = v3.norm(v3.sub(eye, state.target))
    eye = v3.add(state.target, v3.mul(dir, next))
    if (Math.abs(next - cur) < 1e-9) break
  }
  return eye
}

/* ────────── 朝向 ────────── */

function c2wFrom(eye, target, upWorld, rollDeg = 0) {
  let { forward, right, up } = cameraBasis(eye, target, upWorld)
  if (Math.abs(rollDeg) > 1e-12) {
    const a = rad(rollDeg)
    right = rotateAbout(right, forward, a)
    up = rotateAbout(up, forward, a)
  }
  // OpenGL 约定：相机看向 −Z
  const f = v3.neg(forward)
  return [
    right[0], up[0], f[0], eye[0],
    right[1], up[1], f[1], eye[1],
    right[2], up[2], f[2], eye[2],
    0, 0, 0, 1
  ]
}

function quatFromC2W(m) {
  // 旋转部分取自 c2w 的左上 3×3（行主序）
  const r00 = m[0], r01 = m[1], r02 = m[2]
  const r10 = m[4], r11 = m[5], r12 = m[6]
  const r20 = m[8], r21 = m[9], r22 = m[10]
  const tr = r00 + r11 + r22
  let q
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4]
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2
    q = [s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s]
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2
    q = [(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s]
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2
    q = [(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s]
  }
  return q.map((v) => round(v, 6))
}

/* ────────── 参考系（space 自由度） ────────── */

function spaceBasis(space, state, ctx) {
  const forward = v3.norm(v3.sub(state.target, state.eye))
  const worldUp = state.upWorld
  if (space === 'world') return { forward, right: [1, 0, 0], up: worldUp, axisFwd: [0, 1, 0] }
  if (space === 'subject') {
    const yaw = ctx.subjectYaw ?? 0
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    return { forward, right: [c, s, 0], up: worldUp, axisFwd: [-s, c, 0] }
  }
  // camera（默认）：以当前视线为基准
  const right = v3.norm(v3.cross(forward, worldUp))
  const up = v3.norm(v3.cross(right, forward))
  return { forward, right, up, axisFwd: forward }
}

/**
 * 每个动作的参考系：显式 `space` 优先；未给时按动作的**本质语义**取默认——
 * 环绕/升降/摇移的旋转轴本质是世界竖直轴（三脚架的 pan 轴、摇臂的升降都是铅垂的），
 * 若继承相机参考系，倾斜俯拍时会绕"相机的上轴"旋转，把相机甩到主体下方（实测踩过）。
 * 平移类（truck/push）与俯仰（tilt）则天然相对相机，沿用相机 `space`。
 */
const WORLD_AXIS_MOVES = new Set(['orbit_left', 'orbit_right', 'crane_up', 'crane_down', 'pedestal_up', 'pedestal_down', 'pan_left', 'pan_right'])
function moveSpace(mv, shot) {
  if (mv.space) return mv.space
  if (WORLD_AXIS_MOVES.has(mv.type)) return 'world'
  return shot.camera.space ?? 'camera'
}

/* ────────── 段增量 ────────── */

/**
 * 复合动作：`{ t, parallel: [子动作...] }` —— 同一时间段内并行施加多个增量。
 * 这是"螺旋升降环绕""边推边摇""俯冲"这类高难度镜头的基础（顺序分段做不出来）。
 * 组自身的 `ease` 作用于全部子动作（子动作各自的 ease 在组内被忽略，避免二义性）。
 */
function applyDelta(state, mv, k, shot, ctx) {
  if (Array.isArray(mv.parallel)) {
    let st = state
    for (const sub of mv.parallel) st = applyDelta(st, { ...sub, t: mv.t, ease: mv.ease ?? sub.ease }, k, shot, ctx)
    return st
  }
  return applySingle(state, mv, k, shot, ctx)
}

function applySingle(state, mv, k, shot, ctx) {
  const next = { ...state, eye: state.eye.slice(), target: state.target.slice() }
  const basis = spaceBasis(moveSpace(mv, shot), state, ctx)
  const amount = (mv.amount ?? 0) * k
  const angle = rad((mv.deg ?? 0) * k)

  switch (mv.type) {
    case 'hold':
      break
    case 'dolly_in':
      next.eye = v3.add(next.eye, v3.mul(basis.forward, amount))
      break
    case 'dolly_out':
      next.eye = v3.add(next.eye, v3.mul(basis.forward, -amount))
      break
    case 'truck_left':
      next.eye = v3.add(next.eye, v3.mul(basis.right, -amount))
      break
    case 'truck_right':
      next.eye = v3.add(next.eye, v3.mul(basis.right, amount))
      break
    case 'pedestal_up':
      next.eye = v3.add(next.eye, v3.mul(basis.up, amount))
      break
    case 'pedestal_down':
      next.eye = v3.add(next.eye, v3.mul(basis.up, -amount))
      break
    case 'push_axis': {
      const axis = mv.axis ?? 'X'
      const vec = axis === 'Y' ? basis.axisFwd : axis === 'Z' ? basis.up : basis.right
      next.eye = v3.add(next.eye, v3.mul(vec, amount))
      break
    }
    case 'orbit_left':
    case 'orbit_right': {
      const sgn = mv.type === 'orbit_left' ? 1 : -1
      const v = v3.sub(next.eye, next.target)
      next.eye = v3.add(next.target, rotateAbout(v, basis.up, sgn * angle))
      break
    }
    case 'crane_up':
    case 'crane_down': {
      const sgn = mv.type === 'crane_up' ? 1 : -1
      const v = v3.sub(next.eye, next.target)
      const dist = v3.len(v)
      next.eye = v3.add(next.target, rotateAbout(v, basis.right, sgn * angle))
      const grown = dist + (mv.radiusDelta ?? 0) * k
      next.eye = v3.add(next.target, v3.mul(v3.norm(v3.sub(next.eye, next.target)), grown))
      break
    }
    case 'pan_left':
    case 'pan_right': {
      const sgn = mv.type === 'pan_left' ? 1 : -1
      const v = v3.sub(next.target, next.eye)
      next.target = v3.add(next.eye, rotateAbout(v, basis.up, sgn * angle))
      break
    }
    case 'tilt_up':
    case 'tilt_down': {
      const sgn = mv.type === 'tilt_up' ? 1 : -1
      const v = v3.sub(next.target, next.eye)
      next.target = v3.add(next.eye, rotateAbout(v, basis.right, sgn * angle))
      break
    }
    case 'roll_move':
      next.rollDeg = (next.rollDeg ?? 0) + (mv.deg ?? 0) * k
      break
    default:
      if (UNIMPLEMENTED_MOVES.has(mv.type)) break
      throw new Error(`未知动作 ${mv.type}`)
  }

  // 构图段：按目标比例反解机位（只改机位，焦距不变）
  // 注意：这里只处理 start-only 语义；per-frame 由采样循环统一逐帧反解（见 resolveShot）
  if (mv.framing && (mv.framing.fill !== undefined || mv.framing.mode)) {
    const lockPerFrame = (shot.camera.framing.lock ?? 'per-frame') === 'per-frame'
    if (!lockPerFrame && k >= 1) {
      const f = mv.framing.fill
      const fill = Array.isArray(f) ? f[1] : isNum(f) ? f : shot.camera.framing.fill
      next.eye = solveDistance(next, ctx.subjectCorners, { ...shot.camera.framing, fill }, ctx.intr)
    }
  }
  return next
}

/* ────────── 时间重映射：flow（段间速度连续，消除"刹停再起步"） ────────── */

/**
 * "机械感"的头号来源是**段与段之间速度归零**：每个动作各自 easeInOut，而 easeInOut 在
 * u=0/1 处导数为 0（easeIn/easeOut/smooth/smootherstep 同理）→ 两段相连，相机必然
 * 完全刹停再起步。实测 hero 在 3.4s（推近结束/环绕开始）交界两侧速度 0.00 m/s。
 *
 * `timing: { mode: 'flow' }` 改为**一条时间曲线管整条镜头**：以各段结束时刻为节点、
 * 累计进度 (0,1,2,…) 为节点值，用**单调三次 Hermite**（Fritsch–Carlson 限幅，
 * 保证段内不过冲、不反向）连成 C1 曲线。于是：
 *   · 每个动作仍在它声明的 `t` 完成（节点值精确命中）→ **路径与拍点不变**；
 *   · 内部交界处速度不再归零，只有首尾与 hold 处才静止；
 *   · 首/尾若本来就是 hold，节点斜率为 0 → 自然地从静止起、到静止收（不需要额外规则）；
 *   · 单段镜头（无内部交界）没有可平滑的东西 → 自动退回逐段 ease（`loop.turntable`
 *     这种 `ease:'linear'` 的匀速环绕不受影响）。
 * 已知边界：交界处**方向**仍是拐角（本引擎暂无跨段混合）；要真弧线用 `parallel` 复合动作。
 * 甩镜等需要"骤然启停"的镜头不要用 flow——它会把骤起骤停也抹平。
 */
const stillSegment = (mv) => mv.type === 'hold' || (Array.isArray(mv.parallel) && mv.parallel.every(stillSegment))

/** PCHIP（Fritsch–Carlson）节点导数：节点值单调 → 段内单调且不过冲 */
function pchipSlopes(T, V) {
  const n = T.length
  const h = []
  const d = []
  for (let i = 0; i < n - 1; i += 1) {
    h[i] = Math.max(T[i + 1] - T[i], 1e-9)
    d[i] = (V[i + 1] - V[i]) / h[i]
  }
  const m = new Array(n).fill(0)
  if (n < 2) return m
  if (n === 2) return [d[0], d[0]]
  for (let i = 1; i < n - 1; i += 1) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0
    else {
      const w1 = 2 * h[i] + h[i - 1]
      const w2 = h[i] + 2 * h[i - 1]
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    }
  }
  const edge = (dA, dB, hA, hB) => {
    let s = ((2 * hA + hB) * dA - hA * dB) / (hA + hB)
    if (s * dA <= 0) s = 0
    else if (dA * dB <= 0 && Math.abs(s) > Math.abs(3 * dA)) s = 3 * dA
    return s
  }
  m[0] = edge(d[0], d[1], h[0], h[1])
  m[n - 1] = edge(d[n - 2], d[n - 3], h[n - 2], h[n - 3])
  return m
}

/**
 * 构造 flow 时间曲线；不适用时返回 null（调用方退回逐段 ease）。
 * `progress(i, u)` 返回**第 i 段内部的进度**（0→1），语义与原来的 `EASE[mv.ease](u)` 完全一致。
 */
function buildTimingProfile(moves, timing) {
  if ((timing?.mode ?? 'per-move') !== 'flow' || moves.length < 3) return null
  const T = [0]
  const V = [0]
  for (const mv of moves) {
    T.push(mv.t ?? T[T.length - 1])
    V.push(V[V.length - 1] + (stillSegment(mv) ? 0 : 1))
  }
  const m = pchipSlopes(T, V)
  return {
    mode: 'flow',
    progress(i, u) {
      const b = i + 1
      const h = Math.max(T[b] - T[b - 1], 1e-9)
      const u2 = u * u
      const u3 = u2 * u
      const p =
        (2 * u3 - 3 * u2 + 1) * V[b - 1] + (u3 - 2 * u2 + u) * h * m[b - 1] + (-2 * u3 + 3 * u2) * V[b] + (u3 - u2) * h * m[b]
      return p - V[b - 1]
    }
  }
}

/**
 * 构图比例的时间曲线：把各段 `framing.fill` 的过渡串起来，
 * 供 per-frame 锁定时**每一帧**反解距离（主体恒定占屏，环绕时相机自动补偿）
 */
function fillAt(moves, t, initial, profile = null) {
  let cur = initial
  let prevT = 0
  for (let i = 0; i < moves.length; i += 1) {
    const mv = moves[i]
    const end = mv.t ?? prevT
    const framingMove = Array.isArray(mv.parallel) ? mv.parallel.find((s) => s.framing?.fill !== undefined) : mv.framing?.fill !== undefined ? mv : null
    const f = framingMove?.framing?.fill
    if (f === undefined) {
      if (t >= end) prevT = end
      else return cur
      continue
    }
    const from = Array.isArray(f) ? f[0] : f
    const to = Array.isArray(f) ? f[1] : f
    const val = (u) => from + (to - from) * u
    if (t >= end) {
      cur = val(1)
      prevT = end
      continue
    }
    const span = Math.max(end - prevT, 1e-9)
    const u = Math.min(Math.max((t - prevT) / span, 0), 1)
    // 必须施加该段的 ease：否则"用 framing.fill 表达的推轨"会静默变成匀速（实测踩过——
    // 两条缓动曲线急动完全相同，才暴露出这里漏了 ease）
    // flow 模式下改用全局时间曲线：构图推轨与机位走同一条曲线，段间同样不归零
    const e = profile ? profile.progress(i, u) : (EASE[framingMove.ease ?? mv.ease ?? 'easeInOut'] ?? EASE.easeInOut)(u)
    return val(e)
  }
  return cur
}

/** 是否还有"非 C2 连续"的缓动（段间加速度跳变 = 转动卡顿的主因） */
const ABRUPT_EASES = new Set([undefined, 'easeIn', 'easeOut', 'easeInOut'])
function hasAbruptEase(shot) {
  const walk = (mvs) => mvs.some((mv) => (Array.isArray(mv.parallel) ? walk(mv.parallel) : ABRUPT_EASES.has(mv.ease)))
  return walk(shot.moves ?? [])
}

/** 把非 C2 缓动升级为 smooth（保持时长与幅度，只改曲线形状 → 不动创作意图） */
function upgradeEase(shot) {
  const mapOne = (mv) => {
    if (Array.isArray(mv.parallel)) return { ...mv, parallel: mv.parallel.map(mapOne) }
    return ABRUPT_EASES.has(mv.ease) ? { ...mv, ease: 'smooth' } : mv
  }
  return { ...shot, moves: (shot.moves ?? []).map(mapOne) }
}

/* ────────── 取景解算的稳定化（消除"每帧自动变焦"造成的泵动） ────────── */

/** 某个机位下测得的构图比例（不渲染，只投影 8 个包围盒角点） */
function framingFillOf(eye, target, upWorld, subjectCorners, intr, mode) {
  const basis = cameraBasis(eye, target, upWorld)
  const m = measureFraming(subjectCorners, eye, basis, intr, mode)
  return Number.isFinite(m.value) ? m.value : null
}

/** 零相位对称高斯低通：边界镜像（线性段可被精确保持），首尾帧钉住 */
function smoothSeries(series, sigmaFrames) {
  const n = series.length
  if (!(sigmaFrames > 0.5) || n < 5) return series.slice()
  const half = Math.max(1, Math.ceil(sigmaFrames * 3))
  const k = []
  for (let j = -half; j <= half; j += 1) k.push(Math.exp(-(j * j) / (2 * sigmaFrames * sigmaFrames)))
  const sum = k.reduce((a, b) => a + b, 0)
  const out = series.slice()
  for (let i = 1; i < n - 1; i += 1) {
    let acc = 0
    for (let j = -half; j <= half; j += 1) {
      let idx = i + j
      if (idx < 0) idx = -idx // 镜像：不把端点值"刷"进内部（否则线性段会被压弯）
      if (idx > n - 1) idx = 2 * (n - 1) - idx
      acc += series[idx] * k[j + half]
    }
    out[i] = acc / sum
  }
  return out
}

/**
 * `lock:'per-frame'` 的语义是"把主体占屏比例钉死"，数学上等价于**每帧自动变焦**：
 * 主体投影一变（自身旋转、摇到画面边缘、带倾斜），机位就前后补偿。
 * 实测 turntable 纯环绕时半径来回 4~5 次（±2cm，约 1Hz），而构图总共只漂 2%。
 *
 * R1 无效锁定降级（**必须有证据才动手**，全部满足才降级）：
 *     ① 没有任何动作声明 `framing.fill`（声明了就是作者要的推轨，逐帧锁定在真干活）；
 *     ② 相机到主体的距离**本来就不变**（半径波动 <1mm，即动作本身不改变距离）；
 *     ③ 逐帧锁定确实在**泵动**（半径反向 ≥3 次）——这是"机械感"的直接证据；
 *     ④ 不逐帧锁定时构图漂移 ≤8%（降级的代价可以忽略）。
 *     满足则降级为"只解一次"（= start-only），并用 `framing.keepPerFrame: true` 可拒绝。
 * R2 零相位低通：对解出的半径序列做 σ = `framing.smooth` 秒的高斯平滑，杀掉 1Hz 泵动
 *     又不会把构图拖后（对称核无相位延迟）；单调推轨几乎不受影响（0.25Hz 仅衰减 ~7%）。
 *     σ 同时受 `时长/12` 上限约束——1s 的短镜头不该被按 5s 镜头的尺度平滑（会把
 *     fill 轨迹本身压弯）。副作用：fill 约束被轻微放宽（残余误差 ≈ 剩余摆幅/半径，
 *     典型 <1%），这正是"钉死构图"与"不泵动"之间不可避免的取舍。
 */
function stabilizeFraming(samples, { cam, moves, lockPerFrame, dur, dt, framingMode, subjectCorners, intr, upWorld }) {
  const raw = samples.map((s) => s.raw)
  if (!lockPerFrame || !cam.framing) return { eyes: samples.map((s) => s.eye), notes: [] }
  const notes = []
  const targetFill = Array.isArray(cam.framing.fill) ? cam.framing.fill[0] : cam.framing.fill
  const declaresFill = (mvs) => mvs.some((m) => (Array.isArray(m.parallel) ? declaresFill(m.parallel) : m.framing?.fill !== undefined))
  // R1：机位到主体的距离是否本来就不变？
  const r0 = v3.len(v3.sub(raw[0], samples[0].st.target))
  let rSpread = 0
  for (const s of samples) rSpread = Math.max(rSpread, Math.abs(v3.len(v3.sub(s.raw, s.st.target)) - r0))
  if (rSpread < 1e-3 && !declaresFill(moves) && isNum(targetFill) && cam.framing.keepPerFrame !== true) {
    const countTurns = (xs) => {
      let turns = 0
      let last = 0
      for (let i = 1; i < xs.length; i += 1) {
        const d = xs[i] - xs[i - 1]
        if (Math.abs(d) <= 1e-3) continue
        const s = Math.sign(d)
        if (last !== 0 && s !== last) turns += 1
        last = s
      }
      return turns
    }
    const lockTurns = countTurns(samples.map((s) => v3.len(v3.sub(s.eye, s.st.target))))
    const fills = samples.map((s) => framingFillOf(s.raw, s.st.target, upWorld, subjectCorners, intr, framingMode)).filter((v) => v !== null)
    const drift = fills.length > 1 ? (Math.max(...fills) - Math.min(...fills)) / Math.max(targetFill, 1e-6) : 0
    if (lockTurns >= 3 && drift <= 0.08) {
      notes.push({
        code: 'framing-static-lock',
        detail: `相机到主体距离全程不变（波动 ${round(rSpread * 1000, 2)}mm）、动作本身不声明 framing.fill，但逐帧锁定让半径来回 ${lockTurns} 次、构图只漂 ${round(drift * 100, 1)}% → 降级为"只解一次"（start-only），消除无收益的机位泵动；要强制保留请写 framing.keepPerFrame: true`
      })
      return { eyes: raw, notes }
    }
  }
  // R2：半径序列低通
  const smoothS = Math.min(cam.framing.smooth ?? 0.25, dur / 12)
  if (!(smoothS > 0)) return { eyes: samples.map((s) => s.eye), notes }
  const radii = samples.map((s) => v3.len(v3.sub(s.eye, s.st.target)))
  const smoothed = smoothSeries(radii, smoothS / Math.max(dt, 1e-9))
  let moved = 0
  for (let i = 0; i < samples.length; i += 1) moved = Math.max(moved, Math.abs(smoothed[i] - radii[i]))
  const eyes = samples.map((s, i) => {
    const d = v3.sub(s.eye, s.st.target)
    const len = v3.len(d)
    if (len < 1e-9) return s.eye
    return v3.add(s.st.target, v3.mul(v3.mul(d, 1 / len), smoothed[i]))
  })
  // 修正量太小就不留痕，免得每个镜头都刷一条噪音
  if (moved >= 0.002)
    notes.push({ code: 'framing-smooth', detail: `取景解算半径做 ${round(smoothS, 3)}s 零相位低通：峰值修正 ${round(moved * 100, 2)}cm（消除"每帧自动变焦"的泵动）` })
  return { eyes, notes }
}

/* ────────── 单帧成形（采样与自动纠错共用） ────────── */

function finalizeFrame({ t, frame, eye, aimTarget, rollDeg, resolved, intr, subjectCorners, subjectIds, upWorld, covRes, framingMode, light = false }) {
  const c2w = c2wFrom(eye, aimTarget, upWorld, rollDeg)
  const basis = cameraBasis(eye, aimTarget, upWorld)
  const measured = measureFraming(subjectCorners, eye, basis, intr, framingMode)
  let clearance = Infinity
  let nearest = null
  for (const p of resolved.parts) {
    if (p.shape === 'plane') continue
    const d = pointToAabbDistance(eye, p.worldAabb)
    if (d < clearance) {
      clearance = d
      nearest = p.id
    }
  }
  const coverage =
    !light && covRes > 0
      ? coverageStats(resolved, { type: 'persp', eye, target: aimTarget, up: upWorld, lens: intr.lens, sensorWidth: intr.sensor, width: intr.width, height: intr.height }, subjectIds, { width: covRes })
      : null
  let inFramePct = null
  if (measured.bbox) {
    const bb = measured.bbox
    const ix = Math.max(0, Math.min(bb.maxX, intr.width) - Math.max(bb.minX, 0))
    const iy = Math.max(0, Math.min(bb.maxY, intr.height) - Math.max(bb.minY, 0))
    const area = Math.max((bb.maxX - bb.minX) * (bb.maxY - bb.minY), 1e-9)
    inFramePct = (ix * iy) / area
  }
  const marginPx = measured.bbox
    ? Math.min(measured.bbox.minX, measured.bbox.minY, intr.width - measured.bbox.maxX, intr.height - measured.bbox.maxY)
    : -Infinity
  return {
    // 逐帧表是下游数据契约（Plücker/深度/导出都从这里取），只做 9 位小数收敛，
    // **不能用显示精度**：量化到 1e-6 会把"精确 15°"和"恒定 0.5m/s"这类不变量破坏掉
    t: round(t, 9),
    frame,
    pos: eye.map((v) => round(v, 9)),
    target: aimTarget.map((v) => round(v, 9)),
    quat: quatFromC2W(c2w),
    c2w: c2w.map((v) => round(v, 9)),
    lens: intr.lens,
    fovDeg: round(2 * deg(Math.atan(intr.height / 2 / intr.fy)), 4),
    rollDeg: round(rollDeg, 6),
    fill: measured.bbox && measured.onscreen ? round(measured.value, 6) : null,
    onScreen: Boolean(measured.onscreen),
    marginPx: Number.isFinite(marginPx) ? round(marginPx, 2) : null,
    clearanceM: Number.isFinite(clearance) ? round(clearance, 4) : null,
    nearestSolid: nearest,
    frameCoveragePct: coverage ? round(coverage.frameCoverage * 100, 3) : null,
    subjectVisiblePct: coverage ? round(coverage.subjectVisible * 100, 2) : null,
    subjectInFramePct: inFramePct === null ? null : round(inFramePct * 100, 2),
    subjectBBoxPx: measured.bbox
      ? { minX: round(measured.bbox.minX, 2), minY: round(measured.bbox.minY, 2), maxX: round(measured.bbox.maxX, 2), maxY: round(measured.bbox.maxY, 2) }
      : null,
    __eye: eye,
    __aim: aimTarget,
    __roll: rollDeg
  }
}

const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/** 从 AABB 指向外的方向（用于把相机推出几何体/推到安全距离外） */
function pushDirection(eye, aabb) {
  const c = [0, 1, 2].map((i) => (aabb.min[i] + aabb.max[i]) / 2)
  const d = [eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]]
  if (Math.hypot(...d) > 1e-6) return v3.norm(d)
  // 相机正好在中心：沿最短的半轴退出（确定性）
  const half = [0, 1, 2].map((i) => Math.min(eye[i] - aabb.min[i], aabb.max[i] - eye[i]))
  let axis = 0
  for (let i = 1; i < 3; i += 1) if (half[i] < half[axis]) axis = i
  const dir = [0, 0, 0]
  dir[axis] = 1
  return dir
}

/** 参数类修复：按比例缩放所有修饰器幅度（抖动超限时用） */
function scaleModifiers(shot, k) {
  return {
    ...shot,
    modifiers: (shot.modifiers ?? []).map((m) => (m.type === 'handheld' ? { ...m, amplitudeM: (m.amplitudeM ?? 0.003) * k } : m))
  }
}

/** 参数类修复：按比例缩放所有动作幅度（速度/角速度超限时用，保持路径形状只放慢/放小） */
function scaleMoves(shot, k) {
  const scaleOne = (mv) => {
    if (Array.isArray(mv.parallel)) return { ...mv, parallel: mv.parallel.map(scaleOne) }
    const out = { ...mv }
    if (isNum(out.amount)) out.amount *= k
    if (isNum(out.deg)) out.deg *= k
    if (isNum(out.radiusDelta)) out.radiusDelta *= k
    return out
  }
  const out = { ...shot, moves: (shot.moves ?? []).map(scaleOne) }
  if (shot.loop?.mode === 'turntable') out.loop = { ...shot.loop, revolutions: (shot.loop.revolutions ?? 1) * k }
  return out
}

/* ────────── C1：解算逐帧表 ────────── */

export function resolveShot(resolved, shotId, opts = {}) {
  const errors = []
  const warnings = []
  const shots = resolved.shots ?? {}
  const shot = shots[shotId]
  if (!shot) return { ok: false, errors: [{ level: 'error', code: 'shot/missing', message: `场景里没有镜头 ${shotId}` }], warnings, frames: [] }

  // ── C8 校验：禁止项与滥用防护 ──
  const cam = shot.camera ?? {}
  if (cam.pos || cam.eye || cam.target === undefined) {
    if (cam.pos || cam.eye) errors.push({ level: 'error', code: 'shot/forbidden', message: '禁止写相机绝对坐标 camera.pos/eye：请改用目标锚点 + 构图意图（framing/orbit）' })
  }
  for (const mv of shot.moves ?? []) {
    if (UNIMPLEMENTED_MOVES.has(mv.type)) warnings.push({ level: 'warn', code: 'shot/unimplemented', message: `动作 ${mv.type} 需要改焦距，本版只做改机位，已跳过` })
  }
  const timingMode = shot.timing?.mode ?? 'per-move'
  if (timingMode !== 'per-move' && timingMode !== 'flow')
    errors.push({ level: 'error', code: 'shot/timing-mode', message: `shot.timing.mode 只能是 'per-move'（默认，逐段缓动）或 'flow'（段间速度连续），收到 ${JSON.stringify(shot.timing.mode)}` })
  if (cam.aimMode === 'free') {
    const reason = cam.aim?.reason
    if (typeof reason !== 'string' || reason.trim().length < 4)
      errors.push({ level: 'error', code: 'shot/aim-reason', message: "aimMode:'free' 必须填写 aim.reason（说明为什么 look-at 不够用）" })
    const keys = cam.aim?.keys
    if (!Array.isArray(keys) || keys.length === 0) errors.push({ level: 'error', code: 'shot/aim-keys', message: "aimMode:'free' 必须提供 aim.keys" })
    else if (keys.length > 8) errors.push({ level: 'error', code: 'shot/aim-keys', message: `aimMode:'free' 的关键帧上限为 8，当前 ${keys.length}（请改用 look-at + aimOffset）` })
    warnings.push({ level: 'warn', code: 'shot/aim-free', message: `镜头 ${shotId} 使用 aimMode:'free'（理由：${cam.aim?.reason ?? '未填'}）——朝向不可由目标锁定校验，请人工复核` })
  }
  if (errors.length) return { ok: false, errors, warnings, frames: [] }

  const W = cam.resolution?.[0] ?? opts.width ?? 960
  const H = cam.resolution?.[1] ?? opts.height ?? 540
  const intr = intrinsics(cam, W, H)
  const fps = shot.fps ?? 24
  const duration = shot.durationS ?? 5

  // 主体与参考系
  const byId = new Map(resolved.parts.map((p) => [p.id, p]))
  const subjectRe = shot.subject && shot.subject !== 'auto' ? new RegExp(`^${String(shot.subject).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`) : null
  const subjectParts = (subjectRe ? resolved.parts.filter((p) => subjectRe.test(p.id)) : resolved.parts.filter((p) => p.shape !== 'plane'))
  if (!subjectParts.length) return { ok: false, errors: [{ level: 'error', code: 'shot/subject', message: `主体 ${shot.subject} 没有匹配到部件` }], warnings, frames: [] }
  const subjMn = [Infinity, Infinity, Infinity]
  const subjMx = [-Infinity, -Infinity, -Infinity]
  for (const p of subjectParts)
    for (let i = 0; i < 3; i += 1) {
      subjMn[i] = Math.min(subjMn[i], p.worldAabb.min[i])
      subjMx[i] = Math.max(subjMx[i], p.worldAabb.max[i])
    }
  const subjectAabb = { min: subjMn, max: subjMx }
  const subjectCorners = boxCorners(subjectAabb)
  const subjectCenter = [0, 1, 2].map((i) => (subjMn[i] + subjMx[i]) / 2)
  // subject 参考系：取主体所属装配体的 yaw（本场景实例只有 yaw）
  const assemblyId = subjectParts[0].assembly
  const inst = (resolved.instances ?? []).find((x) => x.id === assemblyId)
  const subjectYaw = inst ? Math.atan2(inst.pose.R[3], inst.pose.R[0]) : 0
  const ctx = { subjectCorners, intr, subjectYaw }

  // 初始状态
  const targetCfg = cam.target ?? {}
  const anchorName = targetCfg.anchor ?? 'center'
  // 缺省（或显式 'subject'）都表示"锁主体"；只有给了部件 id 才去查锚点
  const anchorWorld = !targetCfg.at || targetCfg.at === 'subject' ? subjectCenter : anchorWorldOf(byId, targetCfg.at, anchorName)
  const offset = targetCfg.offset ? targetCfg.offset.map((v) => (typeof v === 'string' ? compileField(v, 'shot.target.offset').value(resolved.scope) : v)) : [0, 0, 0]
  const targetPoint = v3.add(anchorWorld, offset)
  const azimuth = cam.orbit?.azimuthDeg ?? 32
  const elevation = cam.orbit?.elevationDeg ?? 22
  const dir = [Math.sin(rad(azimuth)) * Math.cos(rad(elevation)), -Math.cos(rad(azimuth)) * Math.cos(rad(elevation)), Math.sin(rad(elevation))]
  const radiusGuess = cam.orbit?.radius && isNum(cam.orbit.radius) ? cam.orbit.radius : Math.max(...[0, 1, 2].map((i) => subjMx[i] - subjMn[i])) * 4 + 0.5

  let state = {
    eye: v3.add(targetPoint, v3.mul(v3.norm(dir), radiusGuess)),
    target: targetPoint,
    rollDeg: 0,
    upWorld: [0, 0, 1]
  }
  if (cam.framing) state.eye = solveDistance(state, subjectCorners, cam.framing, intr)

  // 采样：见下方 buildFrames（可重采样以支持自动纠错）

  // ── 采样（可重复调用：自动纠错改参数后要重采样） ──
  const nFrames = Math.max(2, Math.round(duration * fps) + 1)
  const lockPerFrame = (cam.framing?.lock ?? 'per-frame') === 'per-frame'
  const subjectIds = subjectParts.map((p) => p.id)
  const covRes = opts.coverageRes ?? 128
  const framingMode = cam.framing?.mode ?? 'fill-height'

  const buildFrames = (spec) => {
    const moves = [...(spec.moves ?? [])]
    const dur = spec.durationS ?? duration
    if (spec.loop?.mode === 'turntable') {
      moves.length = 0
      moves.push({ t: dur, type: 'orbit_left', deg: -360 * (spec.loop.revolutions ?? 1), ease: 'linear' })
    }
    // flow 时间曲线：段间速度不再归零（见 buildTimingProfile）
    const profile = buildTimingProfile(moves, spec.timing)
    const dt = nFrames > 1 ? dur / (nFrames - 1) : dur
    // A 趟：先拿到整条机位序列（含 per-frame 取景反解），才能对它做时间平滑
    const samples = []
    for (let i = 0; i < nFrames; i += 1) {
      const t = (dur * i) / (nFrames - 1)
      const st = sampleState(state, moves, t, spec, ctx, profile)
      let eye = st.eye
      // per-frame 锁定：每一帧按当前目标构图比例反解机位（环绕/平移时相机自动补偿，主体恒定占屏）
      if (lockPerFrame && cam.framing) {
        const fill = fillAt(moves, t, cam.framing.fill, profile)
        eye = solveDistance({ ...st, eye }, subjectCorners, { ...cam.framing, fill }, intr)
      }
      samples.push({ t, st, eye, raw: st.eye })
    }
    const stabilized = stabilizeFraming(samples, { cam, moves, lockPerFrame, dur, dt, framingMode, subjectCorners, intr, upWorld: state.upWorld })
    // B 趟：成形
    const out = []
    for (let i = 0; i < nFrames; i += 1) {
      const { t, st } = samples[i]
      let eye = stabilized.eyes[i]
      const target = st.target
      for (const mod of spec.modifiers ?? []) if (mod.type === 'handheld') eye = v3.add(eye, handheldOffset(mod, t))
      let aimTarget = target
      let rollDeg
      if (cam.aimMode === 'free') {
        const kf = evaluateAimKeys(cam.aim.keys, t, dur)
        const basis = cameraBasis(eye, target, state.upWorld)
        let v = basis.forward
        v = rotateAbout(v, state.upWorld, rad(kf.yawDeg ?? 0))
        v = rotateAbout(v, v3.norm(v3.cross(v, state.upWorld)), rad(kf.pitchDeg ?? 0))
        aimTarget = v3.add(eye, v)
        rollDeg = kf.rollDeg ?? 0
      } else {
        const off = cam.aimOffsetDeg ?? [0, 0]
        if (off[0] || off[1]) {
          const basis = cameraBasis(eye, target, state.upWorld)
          let v = basis.forward
          v = rotateAbout(v, state.upWorld, rad(off[0]))
          v = rotateAbout(v, v3.norm(v3.cross(v, state.upWorld)), rad(off[1]))
          aimTarget = v3.add(eye, v)
        }
        rollDeg = cam.roll === 'level' || cam.roll === undefined ? levelRoll(eye, aimTarget, state.upWorld, st.rollDeg) : (st.rollDeg ?? 0) + (isNum(cam.roll) ? cam.roll : 0)
      }
      out.push(finalizeFrame({ t, frame: Math.round(t * fps), eye, aimTarget, rollDeg, resolved, intr, subjectCorners, subjectIds, upWorld: state.upWorld, covRes, framingMode }))
    }
    return { frames: out, notes: stabilized.notes }
  }

  let working = shot
  let built = buildFrames(working)
  let frames = built.frames
  const corrections = []

  // ── 自动纠错：**只修执行质量**（抖动、转动卡顿），不改创作意图 ──
  // 构图/路径/速度属于意图：镜头没照到主体、相机穿模、超速——改了就是掩盖设计错误，
  // 一律只报错。要引擎替你改这些，必须显式 opt-in（autofix: { aim/clearance/speed: true }）。
  if (shot.autofix !== false) {
    const af = typeof shot.autofix === 'object' && shot.autofix !== null ? shot.autofix : {}
    const maxPasses = af.maxPasses ?? 3
    for (let pass = 1; pass <= maxPasses; pass += 1) {
      const probe = evaluateMetrics(frames, resolved, subjectParts, intr, working, ctx)
      const errs = probe.violations.filter((v) => v.level === 'error')
      if (!errs.length) break
      const details = []
      let next = working
      const quality = errs.filter((e) => e.code === 'motion/jerk' || e.code === 'motion/angular-jerk')

      /* ── A. 执行质量：抖动（修饰器幅度） / 转动卡顿（缓动不连续、轨迹毛刺） ── */
      if (quality.length) {
        const limits = []
        if (working.constraints?.maxJerk !== undefined) limits.push(working.constraints.maxJerk / Math.max(probe.maxJerkMps3, 1e-9))
        if (working.constraints?.maxAngularJerk !== undefined) limits.push(working.constraints.maxAngularJerk / Math.max(probe.maxAngularJerkDegS3, 1e-9))
        // A1 修饰器幅度过大 → 缩幅（jerk 与幅度近似成正比，闭式比例）
        if ((working.modifiers ?? []).length && limits.length) {
          const k = clampNum(Math.min(...limits) * 0.85, 0.05, 1)
          next = scaleModifiers(next, k)
          details.push(`修饰器幅度 ×${round(k, 3)}（急动 ${probe.maxJerkMps3} m/s³、角急动 ${probe.maxAngularJerkDegS3} °/s³）`)
        } else if (hasAbruptEase(working)) {
          // A2 缓动不是 C2 → 升级为 smooth（段间加速度跳变是"顿一下"的主因）
          next = upgradeEase(next)
          details.push('缓动升级为 smooth（smootherstep，C2 连续）以消除段间加速度跳变')
        } else {
          // A3 仍超限 → 对轨迹做轻量平滑（5 抽二项式，端点保持）
          const W = [1, 4, 6, 4, 1]
          const n = frames.length
          const smoothed = frames.map((f, i) => {
            if (i === 0 || i === n - 1) return f
            const pos = [0, 0, 0]
            const tgt = [0, 0, 0]
            for (let k = -2; k <= 2; k += 1) {
              const j = Math.min(n - 1, Math.max(0, i + k))
              for (let a = 0; a < 3; a += 1) {
                pos[a] += frames[j].__eye[a] * W[k + 2]
                tgt[a] += frames[j].__aim[a] * W[k + 2]
              }
            }
            return finalizeFrame({
              t: f.t,
              frame: f.frame,
              eye: pos.map((v) => v / 16),
              aimTarget: tgt.map((v) => v / 16),
              rollDeg: f.__roll,
              resolved,
              intr,
              subjectCorners,
              subjectIds,
              upWorld: state.upWorld,
              covRes,
              framingMode
            })
          })
          frames = smoothed
          corrections.push({ pass, code: 'path-smooth', detail: `轨迹 5 抽二项式平滑（急动 ${probe.maxJerkMps3} m/s³、角急动 ${probe.maxAngularJerkDegS3} °/s³ 超限）` })
          continue
        }
      }

      /* ── B. 意图类修复：默认不做，必须显式 opt-in（会改变创作意图） ── */
      if (af.speed === true) {
        const speedErrs = errs.filter((e) => e.code === 'motion/speed' || e.code === 'motion/angular-speed')
        if (speedErrs.length) {
          const limits = []
          if (working.constraints?.maxSpeed !== undefined) limits.push(working.constraints.maxSpeed / Math.max(probe.maxSpeedMps, 1e-9))
          if (working.constraints?.maxAngularSpeed !== undefined) limits.push(working.constraints.maxAngularSpeed / Math.max(probe.maxAngularSpeedDegS, 1e-9))
          if (limits.length) {
            const k = clampNum(Math.min(...limits) * 0.95, 0.05, 1)
            next = scaleMoves(next, k)
            details.push(`[opt-in] 动作幅度 ×${round(k, 3)}`)
          }
        }
      }
      if (details.length) {
        working = next
        built = buildFrames(working)
        frames = built.frames
        corrections.push({ pass, code: 'param-scale', detail: details.join('；') })
        continue
      }

      // 逐帧类 opt-in：推离几何（af.clearance）/ 瞄准钳回主体（af.aim）
      const solids = resolved.parts.filter((p) => p.shape !== 'plane')
      const needClear = af.clearance === true ? working.constraints?.minClearance : undefined
      const keep = af.aim === true ? working.constraints?.keepInFrame : undefined
      const inFrameMin = af.aim === true ? working.constraints?.coverage?.inFrameMin : undefined
      const autoAim = af.aim === true && (Boolean(keep) || inFrameMin !== undefined)
      const marginPx = keep?.marginPx ?? 0
      let touched = 0
      for (const f of frames) {
        let eye = f.__eye.slice()
        let aim = f.__aim.slice()
        let roll = f.__roll
        let dirty = false
        if (needClear !== undefined) {
          let worst = null
          for (const p of solids) {
            const d = pointToAabbDistance(eye, p.worldAabb)
            if (d < needClear && (!worst || d < worst.d)) worst = { d, p }
          }
          if (worst) {
            const deficit = needClear - worst.d + 0.002
            eye = v3.add(eye, v3.mul(pushDirection(eye, worst.p.worldAabb), deficit))
            dirty = true
            corrections.push({ pass, code: 'clearance-push', frame: f.frame, part: worst.p.id, detail: `净距 ${round(worst.d, 4)} → ${needClear}m，外推 ${round(deficit, 4)}m` })
          }
        }
        if (autoAim && (f.onScreen === false || (inFrameMin !== undefined && f.subjectInFramePct < inFrameMin) || (keep && f.marginPx !== null && f.marginPx < marginPx))) {
          // 在"当前朝向 → 直指主体"之间二分最小修正角，恰好让主体回到画内
          const dAim = v3.norm(v3.sub(aim, eye))
          const dSub = v3.norm(v3.sub(subjectCenter, eye))
          const okAt = (u) => {
            const d = v3.norm(v3.add(v3.mul(dAim, 1 - u), v3.mul(dSub, u)))
            const cand = finalizeFrame({ t: f.t, frame: f.frame, eye, aimTarget: v3.add(eye, d), rollDeg: roll, resolved, intr, subjectCorners, subjectIds, upWorld: state.upWorld, covRes, framingMode, light: true })
            const inOk = inFrameMin === undefined || cand.subjectInFramePct >= inFrameMin
            const marginOk = !keep || (cand.marginPx !== null && cand.marginPx >= marginPx)
            return inOk && marginOk
          }
          if (!okAt(0) && okAt(1)) {
            let lo = 0
            let hi = 1
            for (let it = 0; it < 18; it += 1) {
              const mid = (lo + hi) / 2
              if (okAt(mid)) hi = mid
              else lo = mid
            }
            aim = v3.add(eye, v3.norm(v3.add(v3.mul(dAim, 1 - hi), v3.mul(dSub, hi))))
            dirty = true
            corrections.push({ pass, code: 'aim-clamp', frame: f.frame, detail: `主体不在画内 → 朝向向主体修正 ${round(deg(Math.acos(clampNum(v3.dot(v3.norm(v3.sub(aim, eye)), dAim), -1, 1))), 2)}°` })
          }
        }
        if (dirty) {
          frames[frames.indexOf(f)] = finalizeFrame({ t: f.t, frame: f.frame, eye, aimTarget: aim, rollDeg: roll, resolved, intr, subjectCorners, subjectIds, upWorld: state.upWorld, covRes, framingMode })
          touched += 1
        }
      }
      if (touched) continue
      break
    }
  }

  // ── C4/C5：几何安全与指标（在纠错后的最终帧上算） ──
  // 引擎自己动的开关（取景锁定降级/平滑）也要留痕——Agent 必须能看到引擎做了什么
  for (const n of built.notes) if (!corrections.some((c) => c.code === n.code)) corrections.push({ pass: 0, ...n })
  const metrics = evaluateMetrics(frames, resolved, subjectParts, intr, working, ctx)
  const allErrors = [...errors, ...metrics.violations.filter((v) => v.level === 'error')]
  const allWarnings = [...warnings, ...metrics.violations.filter((v) => v.level === 'warn')]
  // 逐帧表对外只保留契约字段（__ 开头是自动纠错用的内部精确值）
  const cleanFrames = frames.map(({ __eye, __aim, __roll, ...rest }) => rest)

  return {
    ok: allErrors.length === 0,
    shot: shotId,
    fps,
    durationS: duration,
    frameCount: frames.length,
    intrinsics: { lens: intr.lens, sensorWidth: intr.sensor, fx: round(intr.fx, 3), fy: round(intr.fy, 3), width: W, height: H, fovDeg: frames[0].fovDeg },
    subject: { ids: subjectParts.map((p) => p.id), aabb: subjectAabb, yawDeg: round(deg(subjectYaw), 3) },
    frames: cleanFrames,
    /** 自动纠错留痕：改了什么、在第几趟、影响哪一帧 —— Agent 必须能看到引擎动了什么 */
    corrections,
    corrected: corrections.length > 0,
    metrics,
    errors: allErrors,
    warnings: allWarnings
  }
}

/** 世界坐标下的锚点：R·local + t */
function anchorWorldOf(byId, partId, anchorName) {
  const p = byId.get(partId)
  if (!p) throw new Error(`shot.target.at 指向不存在的部件 ${partId}`)
  const a = p.mesh.aabb
  const cx = (a.min[0] + a.max[0]) / 2
  const cy = (a.min[1] + a.max[1]) / 2
  const cz = (a.min[2] + a.max[2]) / 2
  let local
  switch (anchorName) {
    case 'center': local = [cx, cy, cz]; break
    case 'base_center': local = [cx, cy, a.min[2]]; break
    case 'top_center': local = [cx, cy, a.max[2]]; break
    case 'bbox_min': local = a.min.slice(); break
    case 'bbox_max': local = a.max.slice(); break
    default: {
      const m = /^face\(([+-])([XYZ])\)$/.exec(anchorName)
      if (!m) throw new Error(`未知锚点 ${anchorName}`)
      const idx = 'XYZ'.indexOf(m[2])
      local = [cx, cy, cz]
      local[idx] = m[1] === '+' ? a.max[idx] : a.min[idx]
    }
  }
  const R = p.pose.R
  return [
    R[0] * local[0] + R[1] * local[1] + R[2] * local[2] + p.pose.t[0],
    R[3] * local[0] + R[4] * local[1] + R[5] * local[2] + p.pose.t[1],
    R[6] * local[0] + R[7] * local[1] + R[8] * local[2] + p.pose.t[2]
  ]
}

/** level：把相机的 right 向量约束到水平面内 → 反解需要施加的 roll 修正 */
function levelRoll(eye, target, upWorld, extraRoll) {
  const { right } = cameraBasis(eye, target, upWorld)
  // right 已由 cross(forward, upWorld) 得到 → 天然水平（z=0），故 level 时 roll 只需叠加额外值
  void right
  return extraRoll ?? 0
}

function evaluateAimKeys(keys, t, duration) {
  const sorted = [...keys].sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
  let prev = { t: 0, yawDeg: 0, pitchDeg: 0, rollDeg: 0 }
  for (const k of sorted) {
    const kt = (k.t ?? 0) <= 1 && duration > 1 && !Number.isInteger(k.t) ? k.t * duration : k.t ?? 0
    if (t <= kt) {
      const span = kt - prev.t
      const u = span > 1e-9 ? (t - prev.t) / span : 1
      return {
        yawDeg: (prev.yawDeg ?? 0) + ((k.yawDeg ?? prev.yawDeg ?? 0) - (prev.yawDeg ?? 0)) * u,
        pitchDeg: (prev.pitchDeg ?? 0) + ((k.pitchDeg ?? prev.pitchDeg ?? 0) - (prev.pitchDeg ?? 0)) * u,
        rollDeg: (prev.rollDeg ?? 0) + ((k.rollDeg ?? prev.rollDeg ?? 0) - (prev.rollDeg ?? 0)) * u
      }
    }
    prev = { ...prev, ...k, t: kt }
  }
  return { yawDeg: prev.yawDeg ?? 0, pitchDeg: prev.pitchDeg ?? 0, rollDeg: prev.rollDeg ?? 0 }
}

function sampleState(init, moves, t, shot, ctx, profile = null) {
  let st = { ...init, eye: init.eye.slice(), target: init.target.slice() }
  let prevT = 0
  for (let i = 0; i < moves.length; i += 1) {
    const mv = moves[i]
    const end = mv.t ?? prevT
    if (t >= end) {
      st = applyDelta(st, mv, 1, shot, ctx)
      prevT = end
      continue
    }
    const span = Math.max(end - prevT, 1e-9)
    const u = Math.min(Math.max((t - prevT) / span, 0), 1)
    const e = profile ? profile.progress(i, u) : (EASE[mv.ease ?? 'easeInOut'] ?? EASE.easeInOut)(u)
    return applyDelta(st, mv, e, shot, ctx)
  }
  return st
}

/* ────────── 镜头间连续性 ────────── */

/** 相邻镜头的机位/朝向跳变量：防"跳轴"与意外跳切（默认只 warn） */
export function checkContinuity(results, opts = {}) {
  const maxJumpM = opts.maxJumpM ?? 0.5
  const maxTurnDeg = opts.maxTurnDeg ?? 30
  const issues = []
  for (let i = 1; i < results.length; i += 1) {
    const prev = results[i - 1]
    const cur = results[i]
    if (!prev.frames?.length || !cur.frames?.length) continue
    const a = prev.frames[prev.frames.length - 1]
    const b = cur.frames[0]
    const jump = v3.len(v3.sub(b.pos, a.pos))
    const fa = v3.norm(v3.sub(a.target, a.pos))
    const fb = v3.norm(v3.sub(b.target, b.pos))
    const turn = deg(Math.acos(Math.min(1, Math.max(-1, v3.dot(fa, fb)))))
    const parts = []
    if (jump > maxJumpM) parts.push(`机位跳变 ${round(jump, 3)}m`)
    if (turn > maxTurnDeg) parts.push(`朝向跳变 ${round(turn, 1)}°`)
    if (parts.length)
      issues.push({
        level: 'warn',
        code: 'continuity/jump',
        message: `镜头 ${prev.shot} → ${cur.shot}：${parts.join('、')}（阈值 ${maxJumpM}m / ${maxTurnDeg}°）`
      })
  }
  return issues
}

/* ────────── C5：指标与违规 ────────── */

function pointToAabbDistance(p, aabb) {
  const dx = Math.max(aabb.min[0] - p[0], 0, p[0] - aabb.max[0])
  const dy = Math.max(aabb.min[1] - p[1], 0, p[1] - aabb.max[1])
  const dz = Math.max(aabb.min[2] - p[2], 0, p[2] - aabb.max[2])
  return Math.hypot(dx, dy, dz)
}

const insideAabb = (p, a) => p[0] > a.min[0] && p[0] < a.max[0] && p[1] > a.min[1] && p[1] < a.max[1] && p[2] > a.min[2] && p[2] < a.max[2]

/** 线段与 AABB 相交（slab 法）→ 用于视线遮挡判定 */
function segmentHitsAabb(p0, p1, aabb) {
  let tmin = 0
  let tmax = 1
  for (let i = 0; i < 3; i += 1) {
    const d = p1[i] - p0[i]
    if (Math.abs(d) < 1e-12) {
      if (p0[i] < aabb.min[i] || p0[i] > aabb.max[i]) return false
      continue
    }
    let t1 = (aabb.min[i] - p0[i]) / d
    let t2 = (aabb.max[i] - p0[i]) / d
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return false
  }
  return true
}

export function evaluateMetrics(frames, resolved, subjectParts, intr, shot, ctx) {
  const cons = shot.constraints ?? {}
  const violations = []
  const subjectIds = new Set(subjectParts.map((p) => p.id))
  const others = resolved.parts.filter((p) => !subjectIds.has(p.id))
  const solid = resolved.parts.filter((p) => p.shape !== 'plane')

  let minMarginPx = Infinity
  let minFill = Infinity
  let maxFill = -Infinity
  let maxRoll = 0
  let minClearance = Infinity
  let minClearanceFrame = null
  let maxSpeed = 0
  let maxAngular = 0
  let maxJerk = 0
  let maxAngularJerk = 0
  let prevAngular = null
  const outOfFrame = []
  const collisions = []
  const occlusions = []
  let offScreenCount = 0
  let minFrameCoverage = Infinity
  let maxFrameCoverage = -Infinity
  let minVisible = Infinity
  let minVisibleAt = null
  let minInFrame = Infinity
  let minInFrameAt = null

  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i]
    if (f.subjectBBoxPx && f.onScreen !== false) {
      const margin = Math.min(f.subjectBBoxPx.minX, f.subjectBBoxPx.minY, intr.width - f.subjectBBoxPx.maxX, intr.height - f.subjectBBoxPx.maxY)
      minMarginPx = Math.min(minMarginPx, margin)
      if (cons.keepInFrame) {
        const need = cons.keepInFrame.marginPx ?? 0
        if (margin < need - 1e-6) outOfFrame.push({ frame: f.frame, t: f.t, marginPx: round(margin, 2), required: need })
      }
    } else if (f.onScreen === false && cons.keepInFrame) {
      // 主体完全在画外是最严重的出画：不能因为"量不出余量"就漏报（余量记 null）
      outOfFrame.push({ frame: f.frame, t: f.t, marginPx: null, required: cons.keepInFrame.marginPx ?? 0, offScreen: true })
    }
    if (f.onScreen === false) offScreenCount += 1
    if (f.fill !== null) {
      minFill = Math.min(minFill, f.fill)
      maxFill = Math.max(maxFill, f.fill)
    }
    maxRoll = Math.max(maxRoll, Math.abs(f.rollDeg ?? 0))
    // 覆盖/可见类指标只在"主体在画内"的帧上统计：主体在画外时三个量天然为 0/极小，
    // 那是**出画**问题，由宽限窗口逻辑判（否则甩镜会被误报成"被挡住"）。见 E23。
    const measurable = f.onScreen !== false
    if (measurable && f.frameCoveragePct !== null && f.frameCoveragePct !== undefined) {
      minFrameCoverage = Math.min(minFrameCoverage, f.frameCoveragePct)
      maxFrameCoverage = Math.max(maxFrameCoverage, f.frameCoveragePct)
    }
    if (measurable && f.subjectVisiblePct !== null && f.subjectVisiblePct !== undefined && f.subjectVisiblePct < minVisible) {
      minVisible = f.subjectVisiblePct
      minVisibleAt = { frame: f.frame, t: f.t, visiblePct: f.subjectVisiblePct }
    }
    if (measurable && f.subjectInFramePct !== null && f.subjectInFramePct !== undefined && f.subjectInFramePct < minInFrame) {
      minInFrame = f.subjectInFramePct
      minInFrameAt = { frame: f.frame, t: f.t, inFramePct: f.subjectInFramePct }
    }
    for (const p of solid) {
      if (insideAabb(f.pos, p.worldAabb)) {
        collisions.push({ frame: f.frame, t: f.t, part: p.id })
        break
      }
      const d = pointToAabbDistance(f.pos, p.worldAabb)
      if (d < minClearance) {
        minClearance = d
        minClearanceFrame = { frame: f.frame, t: f.t, part: p.id, clearanceM: round(d, 4) }
      }
    }
    if (cons.noOcclusion) {
      const hit = others.find((p) => p.shape !== 'plane' && segmentHitsAabb(f.pos, f.target, p.worldAabb))
      if (hit) occlusions.push({ frame: f.frame, t: f.t, occluder: hit.id })
    }
    if (i > 0) {
      const dt = frames[i].t - frames[i - 1].t
      if (dt > 1e-9) {
        const sp = v3.len(v3.sub(f.pos, frames[i - 1].pos)) / dt
        maxSpeed = Math.max(maxSpeed, sp)
        const a = v3.norm(v3.sub(f.target, f.pos))
        const b = v3.norm(v3.sub(frames[i - 1].target, frames[i - 1].pos))
        const ang = deg(Math.acos(Math.min(1, Math.max(-1, v3.dot(a, b))))) / dt
        maxAngular = Math.max(maxAngular, ang)
        if (i > 1 && prevAngular !== null) {
          // 角急动 = 角速度的变化率 → 直接对应"转动卡顿"（顿一下、抖一下）
          maxAngularJerk = Math.max(maxAngularJerk, Math.abs(ang - prevAngular) / Math.max(dt, 1e-9))
        }
        prevAngular = ang
        if (i > 1) {
          const dtPrev = frames[i - 1].t - frames[i - 2].t
          const spPrev = dtPrev > 1e-9 ? v3.len(v3.sub(frames[i - 1].pos, frames[i - 2].pos)) / dtPrev : sp
          maxJerk = Math.max(maxJerk, Math.abs(sp - spPrev) / Math.max(dt, 1e-9))
        }
      }
    }
  }

  // ── 构图类：连续违规区间 + 宽限窗口 ──
  // 甩镜/急摇**本来就会短暂离开画面**（这是运镜意图，不是缺陷）；真正的错误是
  // 「离开后不回来」或「整段都没照到主体」。所以按"连续区间时长 + 结束时是否在画内"判定。
  const cov = cons.coverage
  const graceS = cov?.graceS ?? cons.keepInFrame?.graceS ?? 0
  const requireAtEnd = cov?.requireAtEnd ?? cons.keepInFrame?.requireAtEnd ?? true
  const subjectIssue = (f) => {
    if (cons.keepInFrame) {
      const need = cons.keepInFrame.marginPx ?? 0
      if (f.onScreen === false) return true
      return f.marginPx !== null && f.marginPx < need - 1e-6
    }
    if (cov && cov.inFrameMin !== undefined) return f.onScreen === false || (f.subjectInFramePct ?? 0) < cov.inFrameMin
    return false
  }
  const wantsSubjectCheck = Boolean(cons.keepInFrame) || (cov && cov.inFrameMin !== undefined)
  if (wantsSubjectCheck) {
    let run = null
    const runs = []
    for (const f of frames) {
      if (subjectIssue(f)) {
        if (!run) run = { from: f, to: f, offScreenAny: f.onScreen === false }
        else {
          run.to = f
          run.offScreenAny = run.offScreenAny || f.onScreen === false
        }
      } else if (run) {
        runs.push(run)
        run = null
      }
    }
    if (run) runs.push(run)
    const lastFrame = frames[frames.length - 1]
    for (const r of runs) {
      const dur = r.to.t - r.from.t
      const endsShot = r.to.frame === lastFrame.frame
      const fatal = dur > graceS + 1e-9 || (endsShot && requireAtEnd)
      const where = r.offScreenAny ? '（含主体完全在画外的帧）' : ''
      violations.push({
        level: fatal ? 'error' : 'warn',
        code: r.offScreenAny ? 'motion/subject-off-screen' : 'motion/out-of-frame',
        message: fatal
          ? endsShot && requireAtEnd
            ? `主体出画且**镜头结束时仍未回到画内**：连续 ${round(dur, 2)}s（帧 ${r.from.frame}–${r.to.frame}）${where}`
            : `主体出画连续 ${round(dur, 2)}s > 宽限 ${graceS}s（帧 ${r.from.frame}–${r.to.frame}）${where}`
          : `主体出画 ${round(dur, 2)}s，在宽限 ${graceS}s 内（甩镜允许，帧 ${r.from.frame}–${r.to.frame}）${where}`,
        frames: [{ frame: r.from.frame, t: r.from.t, offScreen: r.from.onScreen === false }]
      })
    }
  }
  if (cons.noCollision && collisions.length)
    violations.push({ level: 'error', code: 'motion/camera-collision', message: `相机进入几何体 ${collisions.length} 帧（如 ${collisions[0].part}）——这是路径设计错误，请改轨迹而不是让引擎偷推机位`, frames: collisions.slice(0, 8) })
  if (cons.minClearance !== undefined && minClearance < cons.minClearance - 1e-6)
    violations.push({ level: 'error', code: 'motion/clearance', message: `相机最近净距 ${round(minClearance, 4)}m < 要求 ${cons.minClearance}m（帧 ${minClearanceFrame?.frame}，最近 ${minClearanceFrame?.part}）——这是路径设计错误` })
  if (cons.maxSpeed !== undefined && maxSpeed > cons.maxSpeed + 1e-6)
    violations.push({ level: 'error', code: 'motion/speed', message: `相机峰值速度 ${round(maxSpeed, 3)}m/s > 上限 ${cons.maxSpeed}m/s——这是运镜意图问题，请改动作幅度/时长` })
  if (cons.levelHorizon && maxRoll > 0.05)
    violations.push({ level: 'error', code: 'motion/roll', message: `地平线偏离 ${round(maxRoll, 3)}° > 0.05°` })
  // 覆盖面与可见度：镜头覆盖面 + 主体有多少部分真的被覆盖/可见
  if (cov) {
    if (cov.frameMin !== undefined && minFrameCoverage < cov.frameMin)
      violations.push({ level: 'error', code: 'motion/coverage-low', message: `主体占画面最小 ${round(minFrameCoverage, 2)}% < 要求 ${cov.frameMin}%` })
    if (cov.frameMax !== undefined && maxFrameCoverage > cov.frameMax)
      violations.push({ level: 'error', code: 'motion/coverage-high', message: `主体占画面最大 ${round(maxFrameCoverage, 2)}% > 上限 ${cov.frameMax}%` })
    if (cov.visibleMin !== undefined && minVisible < cov.visibleMin)
      violations.push({ level: 'error', code: 'motion/subject-occluded', message: `主体可见比例最低 ${round(minVisible, 2)}% < 要求 ${cov.visibleMin}%（帧 ${minVisibleAt?.frame}，被别的几何体挡住）——请改机位或重排场景`, frames: minVisibleAt ? [minVisibleAt] : [] })
  }
  if (cons.maxAngularSpeed !== undefined && maxAngular > cons.maxAngularSpeed + 1e-6)
    violations.push({ level: 'error', code: 'motion/angular-speed', message: `相机峰值角速度 ${round(maxAngular, 1)}°/s > 上限 ${cons.maxAngularSpeed}°/s——这是运镜意图问题（甩镜应显式放宽或改动作）` })
  if (cons.maxJerk !== undefined && maxJerk > cons.maxJerk + 1e-6)
    violations.push({ level: 'error', code: 'motion/jerk', message: `相机峰值急动 ${round(maxJerk, 2)}m/s³ > 上限 ${cons.maxJerk}（**执行质量**问题：抖动或段间顿挫，可由 autofix 修复）` })
  if (cons.maxAngularJerk !== undefined && maxAngularJerk > cons.maxAngularJerk + 1e-6)
    violations.push({ level: 'error', code: 'motion/angular-jerk', message: `相机峰值角急动 ${round(maxAngularJerk, 1)}°/s³ > 上限 ${cons.maxAngularJerk}（**执行质量**问题：转动卡顿，可由 autofix 修复）` })
  if (cons.noOcclusion && occlusions.length)
    violations.push({ level: 'warn', code: 'motion/occlusion', message: `视线被遮挡 ${occlusions.length} 帧（如 ${occlusions[0].occluder}）`, frames: occlusions.slice(0, 8) })
  for (const m of shot.modifiers ?? []) {
    if (m.type === 'handheld') violations.push({ level: 'warn', code: 'motion/modifier', message: `手持修饰器生效（seed=${m.seed ?? 1}, 幅度 ${m.amplitudeM ?? 0.003}m）` })
  }

  // ── 机位半径的"泵动"：per-frame 取景锁定 = 每帧自动变焦，半径反复进出 = 机械感 ──
  // 用**主体世界包围盒中心**算半径，而不是瞄准点（甩镜时 aim 会大幅偏离，会污染判定）
  const subjC = [0, 1, 2].map((i) => {
    let mn = Infinity
    let mx = -Infinity
    for (const p of subjectParts) {
      mn = Math.min(mn, p.worldAabb.min[i])
      mx = Math.max(mx, p.worldAabb.max[i])
    }
    return (mn + mx) / 2
  })
  const radii = subjectParts.length ? frames.map((f) => v3.len(v3.sub(f.pos, subjC))) : []
  let radialReversals = 0
  let lastSign = 0
  for (let i = 1; i < radii.length; i += 1) {
    const d = radii[i] - radii[i - 1]
    if (Math.abs(d) <= 1e-3) continue // 1mm 死区：滤掉数值噪声
    const s = Math.sign(d)
    if (lastSign !== 0 && s !== lastSign) radialReversals += 1
    lastSign = s
  }
  const radiusRange = radii.length ? [round(Math.min(...radii), 4), round(Math.max(...radii), 4)] : null
  const radialExcursionM = radii.length ? Math.max(...radii) - Math.min(...radii) : 0
  if (cons.maxRadialReversals !== undefined && radialReversals > cons.maxRadialReversals)
    violations.push({
      level: 'error',
      code: 'motion/radial-reversals',
      message: `机位半径来回 ${radialReversals} 次 > 上限 ${cons.maxRadialReversals}（摆幅 ${round(radialExcursionM * 100, 1)}cm）：相机在前后泵动——这是运镜意图问题，请改成单调推轨或用位移驱动（dolly_in amount）而不是每帧反解构图`
    })
  else if (radialReversals >= 3 && radialExcursionM >= 0.01)
    violations.push({
      level: 'warn',
      code: 'motion/radial-hunting',
      message: `机位半径来回 ${radialReversals} 次（摆幅 ${round(radialExcursionM * 100, 1)}cm）：相机在反复进退，正是"机械感/呼吸感"的主因。多数来自 lock:'per-frame' 的每帧取景反解（= 每帧自动变焦）——用 framing.smooth 平滑，或对纯环绕/纯摇镜改 lock:'start-only'`
    })

  return {
    timingMode: shot.timing?.mode ?? 'per-move',
    framingLock: shot.camera?.framing?.lock ?? null,
    framingSmoothS: shot.camera?.framing?.smooth ?? null,
    radialReversals,
    radiusRange,
    radialExcursionM: round(radialExcursionM, 4),
    fillRange: Number.isFinite(minFill) ? [round(minFill, 4), round(maxFill, 4)] : null,
    maxRollDeg: round(maxRoll, 4),
    minClearanceM: Number.isFinite(minClearance) ? round(minClearance, 4) : null,
    minClearanceAt: minClearanceFrame,
    frameCoverageRange: Number.isFinite(minFrameCoverage) ? [round(minFrameCoverage, 2), round(maxFrameCoverage, 2)] : null,
    minSubjectVisiblePct: Number.isFinite(minVisible) ? round(minVisible, 2) : null,
    minSubjectVisibleAt: minVisibleAt,
    minSubjectInFramePct: Number.isFinite(minInFrame) ? round(minInFrame, 2) : null,
    minSubjectInFrameAt: minInFrameAt,
    maxSpeedMps: round(maxSpeed, 4),
    maxAngularSpeedDegS: round(maxAngular, 3),
    maxJerkMps3: round(maxJerk, 3),
    maxAngularJerkDegS3: round(maxAngularJerk, 1),
    outOfFrameCount: outOfFrame.length,
    offScreenCount,
    collisionCount: collisions.length,
    occlusionCount: occlusions.length,
    violations
  }
}
