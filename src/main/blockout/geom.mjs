/**
 * MVP 几何模块 —— 图元网格 / 解析支撑函数 / 凸体 GJK 距离
 *
 * 设计要点（docs/blockout-param-design.md §3, §6）：
 *  - 图元既有「渲染用三角网格」，也有「解析支撑函数 support(dir)」；
 *    碰撞不重算网格、不建 BVH、不做布尔 CSG —— blockout 是凸部件并集，部件两两算即可。
 *  - 位姿只允许刚体变换（旋转 + 平移，无缩放）：缩放一律通过尺寸参数表达，
 *    这样 support 的变换才是 R·support(Rᵀd) + t（无逆矩阵缩放问题）。
 *  - 旋转统一为「ZYX 欧拉角的 Z 分量（yaw）+ 可选整体朝向」，MVP 只支持绕 Z 旋转。
 *  - 碰撞输出**有符号间隙** gap：>0 分离、≈0 接触、<0 穿透。
 *    分离时用 GJK 距离（精确）；穿透时用候选方向下界并标 approx:true（MVP 的诚实取舍）。
 */

/* ────────── 向量 / 矩阵 ────────── */

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]),
  len2: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  norm: (a) => {
    const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    return l < 1e-12 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l]
  },
  neg: (a) => [-a[0], -a[1], -a[2]],
  eq: (a, b, tol = 1e-9) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol && Math.abs(a[2] - b[2]) < tol
}

/** 绕 Z 轴 yaw（度） → 3x3 行主序 */
export function yawMatrix(deg) {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

export const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export function matApply(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2]
  ]
}

export function matTranspose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

export function makePose(t = [0, 0, 0], yawDeg = 0) {
  return { R: yawMatrix(yawDeg), t: t.slice() }
}

export const posePoint = (pose, p) => v3.add(matApply(pose.R, p), pose.t)

/* ────────── 图元：参数归一 ────────── */

export const SHAPES = ['box', 'plane', 'wedge', 'prism', 'cylinder', 'cone', 'sphere', 'ellipsoid', 'capsule']

/** 参数默认值与校验；返回规范化后的几何参数（都是数字） */
export function normalizeShape(shape, p) {
  const scalar = (label, v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`图元 ${shape} 的 ${label} 必须是正数，得到 ${JSON.stringify(v)}`)
    return v
  }
  const num = (k, d) => {
    const v = p[k]
    if (v === undefined) {
      if (d === undefined) throw new Error(`图元 ${shape} 缺少参数 ${k}`)
      return d
    }
    return scalar(k, v)
  }
  const vec = (k, n) => {
    const s = p[k]
    if (!Array.isArray(s) || s.length !== n) throw new Error(`图元 ${shape} 需要 ${k}[${n}]`)
    return s.map((v, i) => scalar(`${k}[${i}]`, v))
  }
  switch (shape) {
    case 'box':
    case 'wedge':
      return { size: vec('size', 3) }
    case 'plane':
      return { size: [scalar('size[0]', p.size?.[0]), scalar('size[1]', p.size?.[1])] }
    case 'prism':
      return { sides: Math.max(3, Math.round(p.sides ?? 6)), radius: num('radius'), height: num('height') }
    case 'cylinder':
      return { radius: num('radius'), height: num('height'), segments: Math.max(6, Math.round(p.segments ?? 24)) }
    case 'cone':
      return { radius: num('radius'), height: num('height'), segments: Math.max(6, Math.round(p.segments ?? 24)) }
    case 'sphere':
      return { radius: num('radius'), segments: Math.max(8, Math.round(p.segments ?? 20)), rings: Math.max(4, Math.round(p.rings ?? 10)) }
    case 'ellipsoid': {
      const s = p.size
      if (!Array.isArray(s) || s.length !== 3) throw new Error('ellipsoid 需要 size[3]')
      // 逐元素校验：早期写成 num('size', v)，num 是「按键名取 p[k]」，于是每次取到的都是整个数组 → 该分支必然抛错
      return { size: s.map((v, i) => scalar(`size[${i}]`, v)), segments: Math.max(8, Math.round(p.segments ?? 20)), rings: Math.max(4, Math.round(p.rings ?? 10)) }
    }
    case 'capsule':
      return { radius: num('radius'), height: num('height'), segments: Math.max(6, Math.round(p.segments ?? 16)), rings: Math.max(2, Math.round(p.rings ?? 4)) }
    default:
      throw new Error(`MVP 不支持的图元：${shape}（支持 ${SHAPES.join('/')}）`)
  }
}

/* ────────── 图元：网格生成（局部空间，几何中心在原点，Z 为轴） ────────── */

function boxMesh(hx, hy, hz) {
  const v = []
  for (const sz of [-1, 1]) for (const sy of [-1, 1]) for (const sx of [-1, 1]) v.push([sx * hx, sy * hy, sz * hz])
  // 顶点编号 bit2=sx bit1=sy bit0=sz
  const idx = (sx, sy, sz) => (sz > 0 ? 4 : 0) + (sy > 0 ? 2 : 0) + (sx > 0 ? 1 : 0)
  const tris = [
    [idx(-1, -1, 1), idx(1, -1, 1), idx(1, 1, 1)], [idx(-1, -1, 1), idx(1, 1, 1), idx(-1, 1, 1)], // +Z
    [idx(1, -1, -1), idx(-1, -1, -1), idx(-1, 1, -1)], [idx(1, -1, -1), idx(-1, 1, -1), idx(1, 1, -1)], // -Z
    [idx(1, -1, 1), idx(1, -1, -1), idx(1, 1, -1)], [idx(1, -1, 1), idx(1, 1, -1), idx(1, 1, 1)], // +X
    [idx(-1, -1, -1), idx(-1, -1, 1), idx(-1, 1, 1)], [idx(-1, -1, -1), idx(-1, 1, 1), idx(-1, 1, -1)], // -X
    [idx(-1, 1, 1), idx(1, 1, 1), idx(1, 1, -1)], [idx(-1, 1, 1), idx(1, 1, -1), idx(-1, 1, -1)], // +Y
    [idx(-1, -1, -1), idx(1, -1, -1), idx(1, -1, 1)], [idx(-1, -1, -1), idx(1, -1, 1), idx(-1, -1, 1)] // -Y
  ]
  return { vertices: v, triangles: tris }
}

function ringMesh(radius, height, segments, opts = {}) {
  const { pointed = false, capTop = true, capBottom = true } = opts
  const v = []
  const hz = height / 2
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2
    v.push([Math.cos(a) * radius, Math.sin(a) * radius, -hz])
  }
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2
    v.push([Math.cos(a) * radius, Math.sin(a) * radius, hz])
  }
  const topCenter = v.push([0, 0, pointed ? hz : hz]) - 1
  const bottomCenter = v.push([0, 0, -hz]) - 1
  const tris = []
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments
    const b0 = i
    const b1 = j
    const t0 = segments + i
    const t1 = segments + j
    if (pointed) tris.push([b0, b1, topCenter])
    else tris.push([b0, b1, t1], [b0, t1, t0])
  }
  if (capTop && !pointed) for (let i = 0; i < segments; i += 1) tris.push([segments + i, segments + ((i + 1) % segments), topCenter])
  if (capBottom) for (let i = 0; i < segments; i += 1) tris.push([(i + 1) % segments, i, bottomCenter])
  return { vertices: v, triangles: tris }
}

function prismMesh(sides, radius, height) {
  const v = []
  const hz = height / 2
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * Math.PI * 2 + Math.PI / sides
    v.push([Math.cos(a) * radius, Math.sin(a) * radius, -hz])
  }
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * Math.PI * 2 + Math.PI / sides
    v.push([Math.cos(a) * radius, Math.sin(a) * radius, hz])
  }
  const tc = v.push([0, 0, hz]) - 1
  const bc = v.push([0, 0, -hz]) - 1
  const tris = []
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides
    tris.push([i, j, sides + j], [i, sides + j, sides + i])
    tris.push([sides + i, sides + j, tc])
    tris.push([j, i, bc])
  }
  return { vertices: v, triangles: tris }
}

function sphereMesh(rx, ry, rz, segments, rings) {
  const v = []
  const tris = []
  const at = (i, j) => {
    const phi = (j / rings) * Math.PI
    const theta = (i / segments) * Math.PI * 2
    return [rx * Math.sin(phi) * Math.cos(theta), ry * Math.sin(phi) * Math.sin(theta), rz * Math.cos(phi)]
  }
  for (let j = 0; j <= rings; j += 1) for (let i = 0; i < segments; i += 1) v.push(at(i, j))
  const id = (i, j) => j * segments + (i % segments)
  for (let j = 0; j < rings; j += 1)
    for (let i = 0; i < segments; i += 1) {
      const a = id(i, j)
      const b = id(i + 1, j)
      const c = id(i + 1, j + 1)
      const d = id(i, j + 1)
      if (j !== 0) tris.push([a, b, d])
      if (j !== rings - 1) tris.push([b, c, d])
    }
  return { vertices: v, triangles: tris }
}

function capsuleMesh(radius, height, segments, rings) {
  const v = []
  const tris = []
  const hz = height / 2
  const half = Math.max(0, Math.floor(rings))
  for (let j = 0; j <= half; j += 1) {
    const phi = (j / half) * (Math.PI / 2)
    const r = Math.cos(phi) * radius
    const z = hz + Math.sin(phi) * radius
    for (let i = 0; i < segments; i += 1) {
      const a = (i / segments) * Math.PI * 2
      v.push([Math.cos(a) * r, Math.sin(a) * r, z])
    }
  }
  for (let j = 0; j <= half; j += 1) {
    const phi = (j / half) * (Math.PI / 2)
    const r = Math.cos(phi) * radius
    const z = -hz - Math.sin(phi) * radius
    for (let i = 0; i < segments; i += 1) {
      const a = (i / segments) * Math.PI * 2
      v.push([Math.cos(a) * r, Math.sin(a) * r, z])
    }
  }
  const topRows = half + 1
  const idxTop = (i, j) => j * segments + (i % segments)
  const idxBot = (i, j) => topRows * segments + j * segments + (i % segments)
  for (let j = 0; j < half; j += 1)
    for (let i = 0; i < segments; i += 1) {
      tris.push([idxTop(i, j), idxTop(i + 1, j), idxTop(i, j + 1)])
      tris.push([idxTop(i + 1, j), idxTop(i + 1, j + 1), idxTop(i, j + 1)])
      tris.push([idxBot(i, j), idxBot(i, j + 1), idxBot(i + 1, j)])
      tris.push([idxBot(i + 1, j), idxBot(i, j + 1), idxBot(i + 1, j + 1)])
    }
  // 中间柱体
  const ringTop = v.length
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2
    v.push([Math.cos(a) * radius, Math.sin(a) * radius, hz])
  }
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2
    v.push([Math.cos(a) * radius, Math.sin(a) * radius, -hz])
  }
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments
    tris.push([ringTop + i, ringTop + j, ringTop + segments + j], [ringTop + i, ringTop + segments + j, ringTop + segments + i])
  }
  return { vertices: v, triangles: tris }
}

export function buildMesh(shape, params) {
  switch (shape) {
    case 'box':
      return boxMesh(params.size[0] / 2, params.size[1] / 2, params.size[2] / 2)
    case 'plane':
      return boxMesh(params.size[0] / 2, params.size[1] / 2, 0)
    case 'wedge': {
      // 沿 Y 拉伸的直角三角形：+X 侧为竖直面（屋脊/车头/坡）
      const [w, d, h] = params.size
      const hx = w / 2
      const hy = d / 2
      const hz = h / 2
      const v = [
        [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz],
        [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz]
      ]
      const tris = [
        [0, 2, 1], [3, 4, 5],          // ±Y 侧三角
        [0, 1, 4], [0, 4, 3],          // -Z 底
        [1, 2, 5], [1, 5, 4],          // +X 竖直面
        [2, 0, 3], [2, 3, 5]           // 斜面
      ]
      return { vertices: v, triangles: tris }
    }
    case 'prism':
      return prismMesh(params.sides, params.radius, params.height)
    case 'cylinder':
      return ringMesh(params.radius, params.height, params.segments, { capTop: true, capBottom: true })
    case 'cone':
      return ringMesh(params.radius, params.height, params.segments, { pointed: true, capBottom: true })
    case 'sphere':
      return sphereMesh(params.radius, params.radius, params.radius, params.segments, params.rings)
    case 'ellipsoid':
      return sphereMesh(params.size[0] / 2, params.size[1] / 2, params.size[2] / 2, params.segments, params.rings)
    case 'capsule':
      return capsuleMesh(params.radius, params.height, params.segments, params.rings)
    default:
      throw new Error(`MVP 无法生成网格：${shape}`)
  }
}

export function meshAabb(vertices) {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (const p of vertices)
    for (let i = 0; i < 3; i += 1) {
      if (p[i] < mn[i]) mn[i] = p[i]
      if (p[i] > mx[i]) mx[i] = p[i]
    }
  return { min: mn, max: mx }
}

export function worldAabb(part) {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (const v of part.mesh.vertices) {
    const p = posePoint(part.pose, v)
    for (let i = 0; i < 3; i += 1) {
      if (p[i] < mn[i]) mn[i] = p[i]
      if (p[i] > mx[i]) mx[i] = p[i]
    }
  }
  return { min: mn, max: mx }
}

/* ────────── 部件构造 ────────── */

/**
 * 构造一个已解算的部件（渲染与碰撞共用的最小表示）。
 * pose 只含刚体变换：R（3x3 行主序）+ t；无缩放（缩放一律走尺寸参数）。
 */
export function createPart({ id, shape, params: rawParams, color = '#9aa3ad', pose, assembly = null, meta = {} }) {
  const params = normalizeShape(shape, rawParams)
  const mesh = buildMesh(shape, params)
  const aabb = meshAabb(mesh.vertices)
  const part = {
    id,
    shape,
    params,
    color,
    pose: pose ?? makePose([0, 0, 0], 0),
    mesh: { ...mesh, aabb },
    assembly,
    meta
  }
  // 世界包围盒随部件一起产出：取景/度量/碰撞都直接消费它，避免各处重复计算
  part.worldAabb = worldAabb(part)
  return part
}

/* ────────── 解析支撑函数 ────────── */

/** 局部空间支撑函数：返回 shape 上沿 d 最远的点（d 无需归一） */
export function localSupport(shape, params, d) {
  switch (shape) {
    case 'box':
    case 'wedge': {
      if (shape === 'box') {
        const h = [params.size[0] / 2, params.size[1] / 2, params.size[2] / 2]
        return [d[0] >= 0 ? h[0] : -h[0], d[1] >= 0 ? h[1] : -h[1], d[2] >= 0 ? h[2] : -h[2]]
      }
      const mesh = buildMesh('wedge', params)
      let best = mesh.vertices[0]
      let bv = -Infinity
      for (const v of mesh.vertices) {
        const s = v3.dot(v, d)
        if (s > bv) {
          bv = s
          best = v
        }
      }
      return best
    }
    case 'plane': {
      const h = [params.size[0] / 2, params.size[1] / 2]
      return [d[0] >= 0 ? h[0] : -h[0], d[1] >= 0 ? h[1] : -h[1], 0]
    }
    case 'prism': {
      let best = null
      let bv = -Infinity
      const sides = params.sides
      for (let i = 0; i < sides; i += 1) {
        const a = (i / sides) * Math.PI * 2 + Math.PI / sides
        for (const z of [-params.height / 2, params.height / 2]) {
          const p = [Math.cos(a) * params.radius, Math.sin(a) * params.radius, z]
          const s = v3.dot(p, d)
          if (s > bv) {
            bv = s
            best = p
          }
        }
      }
      return best
    }
    case 'cylinder': {
      const rad = Math.hypot(d[0], d[1])
      const z = (d[2] >= 0 ? 1 : -1) * (params.height / 2)
      if (rad < 1e-12) return [0, 0, z]
      return [(d[0] / rad) * params.radius, (d[1] / rad) * params.radius, z]
    }
    case 'cone': {
      const apex = [0, 0, params.height / 2]
      const rad = Math.hypot(d[0], d[1])
      if (rad < 1e-12) return d[2] >= 0 ? apex : [0, 0, -params.height / 2]
      const rim = [(d[0] / rad) * params.radius, (d[1] / rad) * params.radius, -params.height / 2]
      return v3.dot(apex, d) >= v3.dot(rim, d) ? apex : rim
    }
    case 'sphere': {
      const l = v3.len(d)
      if (l < 1e-12) return [params.radius, 0, 0]
      return v3.mul(d, params.radius / l)
    }
    case 'ellipsoid': {
      const h = [params.size[0] / 2, params.size[1] / 2, params.size[2] / 2]
      const w = [h[0] * d[0], h[1] * d[1], h[2] * d[2]]
      const l = v3.len(w)
      if (l < 1e-12) return [h[0], 0, 0]
      return [(h[0] * w[0]) / l, (h[1] * w[1]) / l, (h[2] * w[2]) / l]
    }
    case 'capsule': {
      const l = v3.len(d)
      const dn = l < 1e-12 ? [0, 0, 1] : v3.mul(d, 1 / l)
      const end = dn[2] >= 0 ? [0, 0, params.height / 2] : [0, 0, -params.height / 2]
      return v3.add(end, v3.mul(dn, params.radius))
    }
    default:
      throw new Error(`MVP 无支撑函数：${shape}`)
  }
}

export function worldSupport(part, dWorld) {
  const dLocal = matApply(matTranspose(part.pose.R), dWorld)
  return posePoint(part.pose, localSupport(part.shape, part.params, dLocal))
}

/* ────────── GJK 距离（凸-凸） ────────── */

function closestPtTriangle(a, b, c) {
  const ab = v3.sub(b, a)
  const ac = v3.sub(c, a)
  const ap = v3.neg(a)
  const d1 = v3.dot(ab, ap)
  const d2 = v3.dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return { point: a, region: [0] }
  const bp = v3.neg(b)
  const d3 = v3.dot(ab, bp)
  const d4 = v3.dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return { point: b, region: [1] }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3)
    return { point: v3.add(a, v3.mul(ab, t)), region: [0, 1] }
  }
  const cp = v3.neg(c)
  const d5 = v3.dot(ab, cp)
  const d6 = v3.dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return { point: c, region: [2] }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6)
    return { point: v3.add(a, v3.mul(ac, t)), region: [0, 2] }
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return { point: v3.add(b, v3.mul(v3.sub(c, b), t)), region: [1, 2] }
  }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return { point: v3.add(a, v3.add(v3.mul(ab, v), v3.mul(ac, w))), region: [0, 1, 2] }
}

function reduceSimplex(simplex) {
  if (simplex.length === 1) return { v: simplex[0], simplex: [simplex[0]] }
  if (simplex.length === 2) {
    const [a, b] = simplex
    const ab = v3.sub(b, a)
    const denom = v3.dot(ab, ab)
    if (denom < 1e-18) return { v: a, simplex: [a] }
    const t = -v3.dot(a, ab) / denom
    if (t <= 0) return { v: a, simplex: [a] }
    if (t >= 1) return { v: b, simplex: [b] }
    return { v: v3.add(a, v3.mul(ab, t)), simplex: [a, b] }
  }
  if (simplex.length === 3) {
    const { point, region } = closestPtTriangle(simplex[0], simplex[1], simplex[2])
    return { v: point, simplex: region.map((i) => simplex[i]) }
  }
  // 四面体：先判原点是否在内部（→ 相交），否则取最近面
  const [a, b, c, d] = simplex
  const O = [0, 0, 0]
  const sameSide = (p1, p2, x, y, z) => {
    const n = v3.cross(v3.sub(y, x), v3.sub(z, x))
    return v3.dot(n, v3.sub(p1, x)) * v3.dot(n, v3.sub(p2, x)) >= -1e-12
  }
  if (sameSide(O, d, a, b, c) && sameSide(O, b, a, c, d) && sameSide(O, c, a, d, b) && sameSide(O, a, b, d, c))
    return { v: [0, 0, 0], simplex, contains: true }
  const faces = [
    [a, b, c],
    [a, c, d],
    [a, d, b],
    [b, d, c]
  ]
  let best = null
  for (const f of faces) {
    const { point } = closestPtTriangle(f[0], f[1], f[2])
    const l2 = v3.len2(point)
    if (!best || l2 < best.l2) best = { l2, point, face: f }
  }
  return { v: best.point, simplex: best.face }
}

/**
 * GJK 距离：返回两凸体之间的最小距离（0 表示接触或穿透）。
 * supportA/supportB: (dir) => 世界空间支撑点
 */
export function gjkDistance(supportA, supportB, seedDir) {
  const supportDiff = (d) => v3.sub(supportA(d), supportB(v3.neg(d)))
  let dir = seedDir && v3.len2(seedDir) > 1e-12 ? v3.norm(seedDir) : [1, 0, 0]
  let simplex = [supportDiff(dir)]
  let v = simplex[0]
  let contains = false
  for (let iter = 0; iter < 64; iter += 1) {
    if (v3.len2(v) < 1e-18) {
      contains = true
      break
    }
    const d = v3.neg(v)
    const p = supportDiff(d)
    // 收敛判据：新支撑点在方向 d 上的投影不再更靠近原点
    if (v3.dot(p, d) - v3.dot(v, d) <= 1e-10 * Math.max(1, v3.len(d))) break
    simplex.push(p)
    if (simplex.length > 4) simplex = simplex.slice(1)
    const r = reduceSimplex(simplex)
    simplex = r.simplex
    v = r.v
    if (r.contains) {
      contains = true
      break
    }
  }
  return { distance: contains ? 0 : v3.len(v), contains, closest: v }
}

const CANDIDATE_DIRS = (() => {
  const out = []
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    if (x === 0 && y === 0 && z === 0) continue
    out.push(v3.norm([x, y, z]))
  }
  return out
})()

/** 沿方向 d 的分离量：>0 表示沿 d 可分离，且该值是真实间隙的下界 */
function separationAlong(a, b, d) {
  const sa = worldSupport(a, v3.neg(d))
  const sb = worldSupport(b, d)
  return v3.dot(d, v3.sub(sa, sb))
}

/**
 * 两个部件的碰撞查询。
 * 返回 { gap, separated, approx, axis }：
 *  - gap > 0：分离，值为间隙（GJK 精确距离与候选方向下界的较大者）
 *  - gap ≈ 0：接触
 *  - gap < 0：穿透，|gap| 为穿透深度**下界**（approx:true）
 */
export function gapBetween(a, b) {
  const centerA = posePoint(a.pose, [
    (a.mesh.aabb.min[0] + a.mesh.aabb.max[0]) / 2,
    (a.mesh.aabb.min[1] + a.mesh.aabb.max[1]) / 2,
    (a.mesh.aabb.min[2] + a.mesh.aabb.max[2]) / 2
  ])
  const centerB = posePoint(b.pose, [
    (b.mesh.aabb.min[0] + b.mesh.aabb.max[0]) / 2,
    (b.mesh.aabb.min[1] + b.mesh.aabb.max[1]) / 2,
    (b.mesh.aabb.min[2] + b.mesh.aabb.max[2]) / 2
  ])
  const seed = v3.sub(centerB, centerA)
  const res = gjkDistance((d) => worldSupport(a, d), (d) => worldSupport(b, d), seed)
  let bestAxis = null
  let bestSep = -Infinity
  for (const d of CANDIDATE_DIRS) {
    const s = separationAlong(a, b, d)
    if (s > bestSep) {
      bestSep = s
      bestAxis = d
    }
  }
  const separated = !res.contains && res.distance > 1e-7
  if (separated) return { gap: Math.max(res.distance, bestSep), separated: true, approx: false, axis: bestAxis }
  // GJK 距离为 0 但沿最优候选方向并未相交 → 恰好接触，间隙记 0（不是穿透）
  if (!res.contains && bestSep >= -1e-6) return { gap: 0, separated: true, approx: false, axis: bestAxis }
  return { gap: Math.min(0, bestSep), separated: false, approx: true, axis: bestAxis }
}
