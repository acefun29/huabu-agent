/**
 * 自动取景（auto-framing）—— 让粗模图**完全由场景数据导出**，零手调相机坐标
 *
 * 设计目标（用户诉求）：
 *  1. 粗模图纯参数生成：author 里只声明"看什么 / 怎么裁"，机位由引擎按几何解算
 *  2. 按模型位置智能截取：自动判定主体装配体 → 自动选正交三视图的尺度与中心 → 自动决定 3/4 视角距离
 *
 * 取景规则：
 *  - 主体判定：优先「被别的装配体支撑着的那个装配体」（即摆在上面的东西），
 *    多个候选时取 AABB 体积最小者；都没有则取最小的非平面装配体
 *  - fit: subject（只框主体）/ context（主体 + 直接支撑它的东西，默认）/ scene（全部非平面件）
 *  - 正交视图：把 fit 集合的世界 AABB 投影到视平面，按单元格宽高比取尺度，四周留 marginRatio
 *  - 3/4 透视：以 AABB 外接球为基准反解距离，保证完整入画
 */

import { v3 } from './geom.mjs'

const VIEW_DEFS = {
  front: { dir: [0, 1, 0], up: [0, 0, 1], title: 'FRONT' },
  back: { dir: [0, -1, 0], up: [0, 0, 1], title: 'BACK' },
  left: { dir: [1, 0, 0], up: [0, 0, 1], title: 'LEFT' },
  right: { dir: [-1, 0, 0], up: [0, 0, 1], title: 'RIGHT' },
  top: { dir: [0, 0, -1], up: [0, 1, 0], title: 'TOP' },
  bottom: { dir: [0, 0, 1], up: [0, 1, 0], title: 'BOTTOM' }
}

const patternToRe = (p) => new RegExp(`^${String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

export function aabbOfParts(parts) {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (const p of parts)
    for (let i = 0; i < 3; i += 1) {
      mn[i] = Math.min(mn[i], p.worldAabb.min[i])
      mx[i] = Math.max(mx[i], p.worldAabb.max[i])
    }
  return { min: mn, max: mx, center: [0, 1, 2].map((i) => (mn[i] + mx[i]) / 2), size: [0, 1, 2].map((i) => mx[i] - mn[i]) }
}

const xyOverlap = (a, b) => a.min[0] < b.max[0] && a.max[0] > b.min[0] && a.min[1] < b.max[1] && a.max[1] > b.min[1]
const volume = (a) => a.size[0] * a.size[1] * a.size[2]

const boxFrom = (min, max) => ({
  min,
  max,
  center: [0, 1, 2].map((i) => (min[i] + max[i]) / 2),
  size: [0, 1, 2].map((i) => max[i] - min[i])
})

/** 以 a 为中心按各轴尺寸外扩 ratio 倍，得到"裁剪窗" */
export function expandBox(a, ratio) {
  const pad = a.size.map((s) => s * ratio)
  return boxFrom(
    a.min.map((v, i) => v - pad[i]),
    a.max.map((v, i) => v + pad[i])
  )
}

export function intersectBox(a, b) {
  const min = [0, 1, 2].map((i) => Math.max(a.min[i], b.min[i]))
  const max = [0, 1, 2].map((i) => Math.min(a.max[i], b.max[i]))
  if (min.some((v, i) => v > max[i])) return null
  return boxFrom(min, max)
}

export function unionBoxes(boxes) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const b of boxes)
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], b.min[i])
      max[i] = Math.max(max[i], b.max[i])
    }
  return boxFrom(min, max)
}

/**
 * 判定主体：被支撑的装配体优先，体积最小的胜出
 * @returns {{id:string, reason:string, subjectIds:string[], supportIds:string[], fitIds:string[]}}
 */
export function pickSubject(resolved, spec = {}) {
  const parts = resolved.parts
  const explicit = spec.subject && spec.subject !== 'auto' ? patternToRe(spec.subject) : null
  if (explicit) {
    const hit = parts.filter((p) => explicit.test(p.id))
    if (!hit.length) return { id: null, reason: `subject 模式 ${spec.subject} 没有匹配到任何部件`, subjectIds: [], supportIds: [], fitIds: [] }
    const contextParts = spec.context ? parts.filter((p) => patternToRe(spec.context).test(p.id)) : []
    const supportIds = contextParts.map((p) => p.id)
    const fit = spec.fit === 'subject' ? hit : spec.fit === 'scene' ? parts.filter((p) => p.shape !== 'plane') : [...hit, ...contextParts]
    return {
      id: spec.subject,
      reason: `显式指定 subject=${spec.subject}（fit=${spec.fit ?? 'context'}）`,
      subjectIds: hit.map((p) => p.id),
      supportIds,
      fitIds: [...new Set(fit.map((p) => p.id))],
      subjectParts: hit,
      contextParts
    }
  }

  // 按装配体聚合（平面件不参与主体判定）
  const byAssembly = new Map()
  for (const p of parts) {
    if (p.shape === 'plane') continue
    const key = p.assembly ?? p.id
    if (!byAssembly.has(key)) byAssembly.set(key, [])
    byAssembly.get(key).push(p)
  }
  const groups = [...byAssembly.entries()].map(([id, ps]) => ({ id, parts: ps, aabb: aabbOfParts(ps) }))
  if (!groups.length) return { id: null, reason: '场景里没有非平面装配体', subjectIds: [], supportIds: [], fitIds: [] }

  // 支撑关系：|A.top − B.bottom| < tol 且 XY 有重叠 → B 支撑 A
  const tol = 0.02
  const supports = new Map() // 被支撑者 → 支撑者列表
  for (const a of groups)
    for (const b of groups) {
      if (a === b) continue
      if (Math.abs(a.aabb.min[2] - b.aabb.max[2]) <= tol && xyOverlap(a.aabb, b.aabb)) {
        if (!supports.has(a.id)) supports.set(a.id, [])
        supports.get(a.id).push(b.id)
      }
    }

  const supported = groups.filter((g) => supports.has(g.id))
  const pool = supported.length ? supported : groups
  pool.sort((x, y) => volume(x.aabb) - volume(y.aabb))
  const picked = pool[0]
  const supportIds = supports.get(picked.id) ?? []
  const reason = supported.length
    ? `自动判定：${picked.id} 被 ${supportIds.join('、')} 支撑（摆在上面的那个），且体积最小`
    : `自动判定：无支撑关系，取体积最小的装配体 ${picked.id}`

  const subjectParts = picked.parts
  const contextParts = groups.filter((g) => supportIds.includes(g.id)).flatMap((g) => g.parts)
  const fit =
    spec.fit === 'subject' ? subjectParts : spec.fit === 'scene' ? parts.filter((p) => p.shape !== 'plane') : [...subjectParts, ...contextParts]
  return {
    id: picked.id,
    reason,
    subjectIds: subjectParts.map((p) => p.id),
    supportIds,
    fitIds: [...new Set(fit.map((p) => p.id))],
    subjectParts,
    contextParts
  }
}

/** 选一个"好看"的刻度步长，使像素间距落在 [minPx, maxPx] */
export function niceStep(worldPerPx, minPx = 60, maxPx = 160) {
  const candidates = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50]
  for (const c of candidates) {
    const px = c / worldPerPx
    if (px >= minPx && px <= maxPx) return c
  }
  // 都不合适：取最接近的
  let best = candidates[0]
  let bestErr = Infinity
  for (const c of candidates) {
    const px = c / worldPerPx
    const err = Math.abs(px - (minPx + maxPx) / 2)
    if (err < bestErr) {
      bestErr = err
      best = c
    }
  }
  return best
}

/**
 * 生成一组自动取景相机。
 * @param resolved resolveScene 产物
 * @param spec     author.views（见 templates/perfume-on-table.author.json）
 * @param cellW/cellH 单元格像素尺寸（正交尺度与透视距离都按它算）
 */
export function autoViews(resolved, spec = {}, cellW = 512, cellH = 512) {
  const pick = pickSubject(resolved, spec)
  const byId = new Map(resolved.parts.map((p) => [p.id, p]))
  const fitParts = pick.fitIds.map((id) => byId.get(id)).filter(Boolean)
  if (!fitParts.length) return { pick, cameras: [], frame: null }

  /**
   * 取景框（智能截取的核心）：
   *  - subject：只框主体
   *  - context（默认）：以主体为中心按 contextRadius 外扩成"裁剪窗"，只纳入**落在窗内**的支撑物，
   *    并把支撑物的包围盒裁到窗口内 —— 这样既能看到"它摆在什么上面"，又不会被整张桌子的尺寸撑爆画框
   *  - scene：全部非平面件
   */
  const fitMode = spec.fit ?? 'context'
  let frame
  let clippedContext = []
  if (fitMode === 'subject') {
    frame = aabbOfParts(pick.subjectParts)
  } else if (fitMode === 'scene') {
    frame = aabbOfParts(resolved.parts.filter((p) => p.shape !== 'plane'))
  } else {
    const subjectBox = aabbOfParts(pick.subjectParts)
    const window = expandBox(subjectBox, spec.contextRadius ?? 0.75)
    const boxes = [subjectBox]
    for (const p of pick.contextParts ?? []) {
      const clipped = intersectBox(p.worldAabb, window)
      if (clipped) {
        boxes.push(clipped)
        clippedContext.push(p.id)
      }
    }
    frame = unionBoxes(boxes)
  }
  const margin = spec.marginRatio ?? 0.15
  const list = Array.isArray(spec.layout) && spec.layout.length ? spec.layout : ['front', 'right', 'top', 'threequarter']
  const cameras = []

  for (const name of list) {
    if (name === 'threequarter' || name === 'hero') {
      const az = ((spec.threeQuarter?.azimuthDeg ?? 35) * Math.PI) / 180
      const el = ((spec.threeQuarter?.elevationDeg ?? 22) * Math.PI) / 180
      const lens = spec.threeQuarter?.lens ?? 45
      const sensor = spec.threeQuarter?.sensorWidth ?? 36
      const radius = (Math.hypot(...frame.size) / 2) * (1 + margin)
      const fit = Math.max(cellW, cellH)
      const f = (lens / sensor) * fit
      const halfY = Math.atan(cellH / 2 / f)
      const halfX = Math.atan(cellW / 2 / f)
      const dist = radius / Math.sin(Math.min(halfX, halfY))
      const d = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)]
      const eye = v3.add(frame.center, v3.mul(d, dist))
      cameras.push({
        name,
        title: `3/4 PERSP  AZ ${Math.round(spec.threeQuarter?.azimuthDeg ?? 35)} EL ${Math.round(spec.threeQuarter?.elevationDeg ?? 22)}`,
        camera: {
          name,
          type: 'persp',
          lens,
          sensorWidth: sensor,
          eye: eye.map((v) => Math.round(v * 1e6) / 1e6),
          target: frame.center.map((v) => Math.round(v * 1e6) / 1e6),
          up: [0, 0, 1],
          width: cellW,
          height: cellH
        },
        meta: { kind: 'persp', dist: Math.round(dist * 1e4) / 1e4, boundingRadius: Math.round(radius * 1e4) / 1e4 }
      })
      continue
    }
    const def = VIEW_DEFS[name]
    if (!def) continue
    const fwd = v3.norm(def.dir)
    const up = v3.norm(def.up)
    const right = v3.norm(v3.cross(fwd, up))
    const u = v3.cross(right, fwd)
    // 把 8 个角投影到视平面
    let minR = Infinity
    let maxR = -Infinity
    let minU = Infinity
    let maxU = -Infinity
    for (const sx of [0, 1])
      for (const sy of [0, 1])
        for (const sz of [0, 1]) {
          const p = [frame.min[0] + sx * frame.size[0], frame.min[1] + sy * frame.size[1], frame.min[2] + sz * frame.size[2]]
          const r = v3.dot(p, right)
          const v = v3.dot(p, u)
          minR = Math.min(minR, r); maxR = Math.max(maxR, r)
          minU = Math.min(minU, v); maxU = Math.max(maxU, v)
        }
    const wWorld = maxR - minR
    const hWorld = maxU - minU
    // 正交高度需同时容纳高度与换算后的宽度
    const orthoHeight = Math.max(hWorld, (wWorld * cellH) / cellW) * (1 + margin)
    const dist = Math.max(...frame.size, 0.1) * 4 + 1
    const eye = v3.sub(frame.center, v3.mul(fwd, dist))
    cameras.push({
      name,
      title: def.title,
      camera: {
        name,
        type: 'ortho',
        eye: eye.map((v) => Math.round(v * 1e6) / 1e6),
        target: frame.center.map((v) => Math.round(v * 1e6) / 1e6),
        up: def.up,
        orthoHeight: Math.round(orthoHeight * 1e6) / 1e6,
        width: cellW,
        height: cellH
      },
      meta: {
        kind: 'ortho',
        orthoHeight: Math.round(orthoHeight * 1e4) / 1e4,
        worldPerPx: orthoHeight / cellH,
        span: { right: [Math.round(minR * 1e4) / 1e4, Math.round(maxR * 1e4) / 1e4], up: [Math.round(minU * 1e4) / 1e4, Math.round(maxU * 1e4) / 1e4] }
      }
    })
  }
  return { pick, cameras, frame, fitMode, clippedContext }
}
