/**
 * MVP 黄金夹具（selftest）—— 设计规范 §9 要求的"引擎自身必须被夹具锁死"
 *
 * 运行：node .huabu/skills/blockout-shot/engine/mvp/selftest.mjs
 * 退出码 0 = 全部通过
 *
 * 覆盖两类最容易悄悄错的东西：
 *  A. 表达式求值器：白名单、未知引用、除零、非法函数、优先级
 *  B. 凸体碰撞：与解析解对照（球-球 / 盒-盒 / 盒-球），含分离、接触、穿透三种情形
 *  C. 位姿与包围盒：平移/旋转后的世界 AABB
 */

import { compileField, compileVec3, ExprError } from './expr.mjs'
import { createPart, gapBetween, worldAabb, makePose, meshAabb } from './geom.mjs'
import { resolveScene } from './resolve.mjs'
import * as viewsMod from './views.mjs'
import * as motionMod from './motion.mjs'

let pass = 0
let fail = 0
const EPS = 1e-4

function check(name, fn) {
  try {
    const detail = fn()
    pass += 1
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (e) {
    fail += 1
    console.log(`FAIL ${name} — ${e instanceof Error ? e.message : String(e)}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const near = (a, b, eps = EPS) => Math.abs(a - b) <= eps

/* ────────── A. 表达式 ────────── */

const scope = { L: 4.5, W: 1.85, wheelR: 0.33, ride: 0.1, H: 0.75 }

check('A1 数字直通', () => {
  const f = compileField(2.5, 'test')
  assert(f.kind === 'num' && f.value(scope) === 2.5, '数字应直通')
})

check('A2 引用与优先级：$L*0.32 + $W/2', () => {
  const f = compileField('$L*0.32 + $W/2', 'test')
  const want = 4.5 * 0.32 + 1.85 / 2
  assert(near(f.value(scope), want), `期望 ${want}，得到 ${f.value(scope)}`)
  assert(f.refs.join(',') === 'L,W', `refs 应为 L,W，得到 ${f.refs.join(',')}`)
})

check('A3 函数白名单：clamp/lerp/min/max/round', () => {
  assert(near(compileField('clamp($ride, 0.05, 0.2)', 't').value(scope), 0.1), 'clamp')
  assert(near(compileField('lerp(0, 10, 0.25)', 't').value(scope), 2.5), 'lerp')
  assert(near(compileField('max(1, min(3, 2))', 't').value(scope), 2), 'min/max 嵌套')
  assert(near(compileField('round($L/3, 2)', 't').value(scope), 1.5), 'round 带位数')
})

check('A4 一元负号与括号：-$L*($W-1)', () => {
  const f = compileField('-$L*($W-1)', 't')
  assert(near(f.value(scope), -4.5 * 0.85), '一元负号')
})

check('A5 未知引用必须报错（编译期 refs + 求值期抛错）', () => {
  const f = compileField('$nope*2', 't')
  assert(f.refs.includes('nope'), 'refs 应含 nope')
  let threw = false
  try {
    f.value(scope)
  } catch (e) {
    threw = e instanceof ExprError
  }
  assert(threw, '引用不存在应抛 ExprError')
})

check('A6 除零报错而不是 Infinity', () => {
  let threw = false
  try {
    compileField('$L/0', 't').value(scope)
  } catch (e) {
    threw = e instanceof ExprError
  }
  assert(threw, '除零应抛错')
})

check('A7 禁用函数 pow/sin/cos/random 必须编译失败', () => {
  for (const bad of ['pow($L,2)', 'sin($L)', 'cos(1)', 'random()']) {
    let threw = false
    try {
      compileField(bad, 't')
    } catch {
      threw = true
    }
    assert(threw, `${bad} 应当被拒绝`)
  }
})

check('A8 宿主求值/属性访问必须失败', () => {
  for (const bad of ['process.exit(1)', 'this.x', '$a.$b', 'constructor']) {
    let threw = false
    try {
      compileField(bad, 't')
    } catch {
      threw = true
    }
    assert(threw, `${bad} 应当被拒绝`)
  }
})

check('A9 vec3 表达式', () => {
  const v = compileVec3(['$L*$wheelR', '$W/2', '0'], 't')
  const got = v.value(scope)
  assert(near(got[0], 4.5 * 0.33) && near(got[1], 0.925) && got[2] === 0, `得到 ${got.join(',')}`)
  assert(v.refs.join(',') === 'L,wheelR,W', `refs 应为 L,wheelR,W，得到 ${v.refs.join(',')}`)
})

/* ────────── B. 凸体碰撞（与解析解对照） ────────── */

const sphere = (r, t, id = `s${r}`) => createPart({ id, shape: 'sphere', params: { radius: r }, pose: makePose(t) })
const box = (s, t, id = `b${s[0]}`) => createPart({ id, shape: 'box', params: { size: s }, pose: makePose(t) })
const cyl = (r, h, t, id = 'c') => createPart({ id, shape: 'cylinder', params: { radius: r, height: h }, pose: makePose(t) })

check('B1 球-球 分离：中心距 5、半径 1 → gap=3', () => {
  const g = gapBetween(sphere(1, [0, 0, 0]), sphere(1, [5, 0, 0]))
  assert(near(g.gap, 3, 1e-3), `期望 3，得到 ${g.gap}`)
  assert(g.separated === true, '应判定为分离')
})

check('B2 球-球 穿透：中心距 1.5、半径 1 → gap<0 且 |gap|≈0.5', () => {
  const g = gapBetween(sphere(1, [0, 0, 0]), sphere(1, [1.5, 0, 0]))
  assert(g.separated === false, '应判定为穿透/接触')
  assert(near(g.gap, -0.5, 0.12), `期望约 -0.5，得到 ${g.gap}`)
  assert(g.approx === true, '穿透深度应标注 approx')
})

check('B3 球-球 相切：中心距 2 → gap≈0', () => {
  const g = gapBetween(sphere(1, [0, 0, 0]), sphere(1, [2, 0, 0]))
  assert(Math.abs(g.gap) < 1e-2, `期望约 0，得到 ${g.gap}`)
})

check('B4 盒-盒 轴对齐分离：边长 2、中心距 3 → gap=1', () => {
  const g = gapBetween(box([2, 2, 2], [0, 0, 0]), box([2, 2, 2], [3, 0, 0]))
  assert(near(g.gap, 1, 1e-3), `期望 1，得到 ${g.gap}`)
})

check('B5 盒-盒 斜向分离：中心距 (3,4,0) → 逐轴间隙 (1,2,0) → gap=sqrt(1+4)', () => {
  const g = gapBetween(box([2, 2, 2], [0, 0, 0]), box([2, 2, 2], [3, 4, 0]))
  assert(near(g.gap, Math.sqrt(5), 1e-2), `期望 ${Math.sqrt(5)}，得到 ${g.gap}`)
})

check('B6 盒-球 分离：盒半边长 1、球 r=0.5、球心 (2,0,0) → gap=0.5', () => {
  const g = gapBetween(box([2, 2, 2], [0, 0, 0]), sphere(0.5, [2, 0, 0]))
  assert(near(g.gap, 0.5, 1e-3), `期望 0.5，得到 ${g.gap}`)
})

check('B7 盒-球 相切：盒半边长 1、球 r=0.5、球心 (1.5,0,0) → gap≈0', () => {
  const g = gapBetween(box([2, 2, 2], [0, 0, 0]), sphere(0.5, [1.5, 0, 0]))
  assert(Math.abs(g.gap) < 5e-3, `期望约 0，得到 ${g.gap}`)
})

check('B7b 盒-球 分离：球心 (2.5,0,0) → gap = 2.5-1-0.5 = 1', () => {
  const g = gapBetween(box([2, 2, 2], [0, 0, 0]), sphere(0.5, [2.5, 0, 0]))
  assert(near(g.gap, 1, 1e-3), `期望 1，得到 ${g.gap}`)
})

check('B8 圆柱-盒 穿透：圆柱底面 z=0.2 已进入盒内 → gap = 0.2-1 = -0.8', () => {
  const g = gapBetween(box([2, 2, 2], [0, 0, 0]), cyl(0.5, 2, [0, 0, 1.2]))
  assert(g.separated === false, '应判定为穿透')
  assert(near(g.gap, -0.8, 0.02), `期望约 -0.8，得到 ${g.gap}`)
})

check('B8b 圆柱-盒 分离：圆柱轴心 z=2.2 → 底面 1.2 → gap = 0.2', () => {
  const g = gapBetween(box([2, 2, 2], [0, 0, 0]), cyl(0.5, 2, [0, 0, 2.2]))
  assert(near(g.gap, 0.2, 5e-3), `期望 0.2，得到 ${g.gap}`)
})

check('B9 圆柱-盒 侧向分离：圆柱轴侧移 2.5 → gap = 2.5-1-0.5 = 1', () => {
  const g = gapBetween(box([2, 2, 2], [0, 0, 0]), cyl(0.5, 2, [2.5, 0, 0]))
  assert(near(g.gap, 1, 5e-3), `期望 1，得到 ${g.gap}`)
})

/* ────────── C. 位姿 / 包围盒 ────────── */

check('C1 平移后的世界 AABB', () => {
  const p = createPart({ id: 'b', shape: 'box', params: { size: [2, 4, 6] }, pose: makePose([10, 0, 3]) })
  const a = worldAabb(p)
  assert(near(a.min[0], 9) && near(a.max[2], 6), `得到 min=${a.min} max=${a.max}`)
})

check('C2 绕 Z 旋转 90°：尺寸互换', () => {
  const p = createPart({ id: 'b', shape: 'box', params: { size: [4, 2, 1] }, pose: makePose([0, 0, 0], 90) })
  const a = worldAabb(p)
  const sx = a.max[0] - a.min[0]
  const sy = a.max[1] - a.min[1]
  assert(near(sx, 2, 1e-6) && near(sy, 4, 1e-6), `旋转后应为 2×4，得到 ${sx}×${sy}`)
})

check('C3 plane 厚度为 0 合法', () => {
  const p = createPart({ id: 'g', shape: 'plane', params: { size: [10, 10] }, pose: makePose([0, 0, 0]) })
  const a = meshAabb(p.mesh.vertices)
  assert(near(a.max[2] - a.min[2], 0), '平面厚度应为 0')
})

/* ────────── D. 自动取景（纯参数导出粗模图） ────────── */

const miniScene = {
  version: 2,
  drivers: { H: 1, W: 1, D: 1 },
  defs: {
    table: { parts: [{ id: 'top', shape: 'box', size: [4, 4, '$D*0.1'], at: { anchor: 'base_center', to: 'ground', offset: [0, 0, '$H'] } }] },
    thing: { parts: [{ id: 'cube', shape: 'box', size: ['$W', '$W', '$W'], at: { rest: 'ground' } }] }
  },
  scene: [
    { use: 'table', id: 'table', at: {} },
    { use: 'thing', id: 'thing', at: { to: { ref: 'table/top', anchor: 'face(+Z)' }, offset: [0, 0, 0] } }
  ]
}

check('D1 主体自动判定：被支撑的装配体优先', () => {
  const r = resolveScene(miniScene)
  assert(r.ok, `解算失败：${JSON.stringify(r.errors)}`)
  const { pickSubject } = viewsMod
  const p = pickSubject(r, {})
  assert(p.id === 'thing', `应判定 thing 为主体，得到 ${p.id}`)
  assert(p.supportIds.includes('table'), '应识别出支撑者是 table')
})

check('D2 裁剪窗：支撑物包围盒被裁到窗口内（不撑爆画框）', () => {
  const r = resolveScene(miniScene)
  const { autoViews, expandBox, intersectBox } = viewsMod
  const subjBox = { min: [-0.5, -0.5, 1], max: [0.5, 0.5, 2], center: [0, 0, 1.5], size: [1, 1, 1] }
  const win = expandBox(subjBox, 0.75)
  assert(near(win.size[0], 2.5), `外扩后应为 1+2*0.75=2.5，得到 ${win.size[0]}`)
  const big = { min: [-10, -10, 0.9], max: [10, 10, 1.0] }
  const clipped = intersectBox(big, win)
  assert(near(clipped.size[0], 2.5), `裁到窗口内应为 2.5，得到 ${clipped.size[0]}`)
  const full = autoViews(r, { fit: 'scene' }, 512, 512)
  const ctx = autoViews(r, { fit: 'context', contextRadius: 0.75 }, 512, 512)
  assert(full.frame.size[0] > ctx.frame.size[0], `context 取景应比 scene 更紧：${ctx.frame.size[0]} vs ${full.frame.size[0]}`)
})

check('D3 正交取景：单 1m 立方体、margin=0 → orthoHeight=1（front/top）', () => {
  const r = resolveScene(miniScene)
  const { autoViews } = viewsMod
  const one = {
    parts: [
      createPart({ id: 'thing/cube', shape: 'box', params: { size: [1, 1, 1] }, pose: makePose([0, 0, 0.5]), assembly: 'thing' })
    ],
    scope: {},
    instances: []
  }
  const { cameras } = autoViews(one, { subject: 'thing/*', fit: 'subject', marginRatio: 0, layout: ['front', 'top'] }, 512, 512)
  const front = cameras.find((c) => c.name === 'front')
  const top = cameras.find((c) => c.name === 'top')
  assert(near(front.meta.orthoHeight, 1, 1e-6), `front orthoHeight 应为 1，得到 ${front.meta.orthoHeight}`)
  assert(near(top.meta.orthoHeight, 1, 1e-6), `top orthoHeight 应为 1，得到 ${top.meta.orthoHeight}`)
  assert(near(front.camera.target[2], 0.5), `目标应在几何中心 z=0.5，得到 ${front.camera.target[2]}`)
})

check('D4 宽扁物体：正交高度按宽高比补偿（不裁掉左右）', () => {
  const one = {
    parts: [createPart({ id: 'a/wide', shape: 'box', params: { size: [4, 1, 1] }, pose: makePose([0, 0, 0]), assembly: 'a' })],
    scope: {},
    instances: []
  }
  const { cameras } = viewsMod.autoViews(one, { subject: 'a/*', fit: 'subject', marginRatio: 0, layout: ['front'] }, 512, 512)
  assert(near(cameras[0].meta.orthoHeight, 4, 1e-6), `4m 宽在 1:1 单元格里应得 4，得到 ${cameras[0].meta.orthoHeight}`)
  const wide = viewsMod.autoViews(one, { subject: 'a/*', fit: 'subject', marginRatio: 0, layout: ['front'] }, 1024, 512)
  assert(near(wide.cameras[0].meta.orthoHeight, 2, 1e-6), `2:1 单元格里应得 2，得到 ${wide.cameras[0].meta.orthoHeight}`)
})

check('D5 比例尺步长落在可读像素区间', () => {
  const { niceStep } = viewsMod
  for (const wpp of [0.0002, 0.0005, 0.002, 0.01, 0.05, 0.3]) {
    const step = niceStep(wpp)
    const px = step / wpp
    assert(px >= 40 && px <= 300, `worldPerPx=${wpp} → step=${step} (${Math.round(px)}px) 超出可读区间`)
  }
})

/* ────────── E. 运镜解算（只改机位 / space 自由度 / free 防滥用） ────────── */

/** 夹具场景：边长 S 的立方体立于地面；镜头默认从 −Y 平视 */
function shotScene({ camera = {}, moves = [], constraints = {}, durationS = 1, fps = 24, loop, modifiers, subject = 'thing/*' } = {}) {
  return {
    version: 2,
    drivers: { S: 1 },
    defs: { thing: { parts: [{ id: 'cube', shape: 'box', size: ['$S', '$S', '$S'], at: { rest: 'ground' } }] } },
    scene: [{ use: 'thing', id: 'thing', at: {} }],
    shots: {
      s1: {
        subject,
        durationS,
        fps,
        camera: {
          target: { at: 'subject', anchor: 'center' },
          orbit: { azimuthDeg: 0, elevationDeg: 0 },
          framing: { mode: 'fill-height', fill: 0.5, lock: 'per-frame' },
          lens: 45,
          sensorWidth: 36,
          resolution: [960, 540],
          roll: 'level',
          space: 'camera',
          ...camera
        },
        ...(moves.length ? { moves } : {}),
        ...(loop ? { loop } : {}),
        ...(modifiers ? { modifiers } : {}),
        constraints
      }
    }
  }
}

const runShot = (author, id = 's1') => {
  const r = resolveScene(author)
  if (!r.ok) throw new Error(`解算失败：${JSON.stringify(r.errors)}`)
  return { resolved: r, shot: motionMod.resolveShot(r, id) }
}

check('E1 构图反解（只改机位）：单位立方体 fill-height 0.5 → 解析距离', () => {
  const { shot } = runShot(shotScene())
  assert(shot.ok, `解算失败：${JSON.stringify(shot.errors)}`)
  const f = shot.frames[0]
  const H = 540
  const fy = (45 / 36) * 960
  const expected = 0.5 + fy / (0.5 * H) // 近面距离 d−0.5；bbox 高 = fy/(d−0.5)
  const center = [0, 0, 0.5]
  const d = Math.hypot(f.pos[0] - center[0], f.pos[1] - center[1], f.pos[2] - center[2])
  assert(near(d, expected, 0.01), `期望 ${expected.toFixed(4)}，得到 ${d.toFixed(4)}`)
  assert(near(f.fill, 0.5, 0.005), `实测占屏比应为 0.5，得到 ${f.fill}`)
})

check('E2 转台（loop.turntable）：360°/24 帧 → 每帧精确 15°，首末重合', () => {
  const { shot } = runShot(shotScene({ loop: { mode: 'turntable', revolutions: 1 } }))
  assert(shot.ok, `解算失败：${JSON.stringify(shot.errors)}`)
  assert(shot.frames.length === 25, `1s@24fps 应有 25 帧，得到 ${shot.frames.length}`)
  const c = shot.frames[0].target
  const az = (p) => Math.atan2(p[0] - c[0], -(p[1] - c[1]))
  for (let i = 1; i < shot.frames.length; i += 1) {
    let delta = az(shot.frames[i].pos) - az(shot.frames[i - 1].pos)
    while (delta > Math.PI) delta -= 2 * Math.PI
    while (delta < -Math.PI) delta += 2 * Math.PI
    assert(near((delta * 180) / Math.PI, -15, 1e-6), `第 ${i} 帧方位增量应为 -15°，得到 ${((delta * 180) / Math.PI).toFixed(6)}`)
  }
  const first = shot.frames[0].pos
  const last = shot.frames[shot.frames.length - 1].pos
  assert(Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) < 1e-6, '转台首末帧机位应重合')
})

check('E3 dolly_in 用构图比例表达：末帧实测占屏比 = 目标值 ±2%', () => {
  const { shot } = runShot(shotScene({ moves: [{ t: 1, type: 'dolly_in', framing: { fill: [0.5, 0.8] }, ease: 'linear' }] }))
  assert(shot.ok, `解算失败：${JSON.stringify(shot.errors)}`)
  const last = shot.frames[shot.frames.length - 1]
  assert(Math.abs(last.fill - 0.8) < 0.02, `末帧占屏比应≈0.8，得到 ${last.fill}`)
  assert(shot.metrics.fillRange[0] >= 0.49, `起始占屏比应≈0.5，得到 ${shot.metrics.fillRange[0]}`)
})

check('E4 roll:level → 逐帧地平线零偏离（相机 right 向量 z 分量≈0）', () => {
  const { shot } = runShot(shotScene({ moves: [{ t: 1, type: 'orbit_left', deg: 120, ease: 'linear' }] }))
  for (const f of shot.frames) {
    assert(Math.abs(f.c2w[8]) < 1e-6, `right.z 应为 0，得到 ${f.c2w[8]}`)
    assert(Math.abs(f.rollDeg) < 1e-6, `rollDeg 应为 0，得到 ${f.rollDeg}`)
  }
  assert(shot.metrics.maxRollDeg < 0.05, 'maxRollDeg 应≈0')
})

check('E5 相机穿模：轨迹穿过墙体 → noCollision 报出帧号与部件 id', () => {
  const author = shotScene({
    camera: { framing: { mode: 'fill-height', fill: 0.5, lock: 'start-only' } },
    moves: [{ t: 1, type: 'dolly_in', amount: 4, ease: 'linear' }],
    constraints: { noCollision: true }
  })
  // 在相机与主体之间插入一堵 0.5m 厚的墙
  author.defs.wall = { parts: [{ id: 'slab', shape: 'box', size: [3, 0.5, 3], at: { rest: 'ground', offset: [0, -2.5, 0] } }] }
  author.scene.push({ use: 'wall', id: 'wall', at: {} })
  const { resolved, shot } = runShot(author)
  void resolved
  assert(shot.metrics.collisionCount > 0, `应检测到穿模，实际 ${shot.metrics.collisionCount}`)
  const v = shot.errors.find((e) => e.code === 'motion/camera-collision')
  assert(v && v.frames.length > 0, '应报出穿模帧号')
  assert(v.message.includes('wall/slab'), `应指出穿模部件，得到：${v.message}`)
})

check('E6 主体出画只报错（默认不自动改机位）；显式 opt-in 才钳回画内', () => {
  const cam = { aimOffsetDeg: [30, 0], framing: { mode: 'fill-height', fill: 0.5, lock: 'per-frame' } }
  const cons = { keepInFrame: { marginPx: 16 } }

  const r = runShot(shotScene({ camera: cam, constraints: cons })).shot
  assert(r.frames[0].onScreen === false, '该镜头主体应确实不在画内')
  assert(
    r.errors.some((e) => e.code === 'motion/out-of-frame' || e.code === 'motion/subject-off-screen'),
    `构图问题必须报错，得到 ${JSON.stringify(r.errors.map((e) => e.code))}`
  )
  assert(!r.corrected, '默认纠错不该碰构图（corrections 应为空）')

  const au = shotScene({ camera: cam, constraints: cons })
  au.shots.s1.autofix = { aim: true }
  const r2 = runShot(au).shot
  assert(r2.corrections.some((c) => c.code === 'aim-clamp'), 'opt-in aim 之后才允许改机位')
})

check('E23 甩镜宽限：中途离开画面是 warn，结束时回不来才是 error', () => {
  const whip = (back) =>
    shotScene({
      durationS: 2,
      camera: { framing: { mode: 'fill-height', fill: 0.5, lock: 'start-only' } },
      moves: [
        { t: 0.3, type: 'pan_left', deg: 85, ease: 'smooth' },
        { t: 0.9, type: 'hold' },
        { t: 1.7, type: 'pan_right', deg: back, ease: 'smooth' },
        { t: 2.0, type: 'hold' }
      ],
      constraints: { coverage: { inFrameMin: 60, graceS: 1.5, requireAtEnd: true } }
    })
  const ok = runShot(whip(85)).shot
  assert(ok.frames[ok.frames.length - 1].onScreen !== false, '回摆充分时结尾应回到画内')
  assert(ok.errors.length === 0, `中途离开在宽限内不应报 error，得到 ${JSON.stringify(ok.errors.map((e) => e.code))}`)
  assert(ok.warnings.some((w) => w.code === 'motion/subject-off-screen'), '应有一条 warn 记录甩镜期间离开画面')

  const bad = runShot(whip(55)).shot
  assert(
    bad.errors.some((e) => e.code === 'motion/subject-off-screen'),
    `回摆不足、结尾不在画内 → 必须 error，得到 ${JSON.stringify(bad.errors.map((e) => e.code))}`
  )
})

check('E24 抖动属执行质量：autofix 自动缩修饰器幅度', () => {
  const sc = shotScene({
    modifiers: [{ type: 'handheld', amplitudeM: 0.06, frequencyHz: 3, seed: 5 }],
    constraints: { maxJerk: 4 }
  })
  const r = runShot(sc).shot
  assert(r.corrections.some((c) => c.code === 'param-scale' && c.detail.includes('修饰器')), `应缩修饰器幅度，得到 ${JSON.stringify(r.corrections)}`)
  assert(r.metrics.maxJerkMps3 <= 4 * 1.3, `急动应收敛到上限附近，得到 ${r.metrics.maxJerkMps3}`)
})

check('E25 转动卡顿属执行质量：autofix 升级缓动/平滑轨迹，角急动必须下降', () => {
  const mk = (autofix) => {
    const sc = shotScene({
      durationS: 2,
      camera: { framing: { mode: 'fill-height', fill: 0.5, lock: 'start-only' } },
      moves: [
        { t: 0.6, type: 'pan_left', deg: 60, ease: 'easeIn' },
        { t: 1.2, type: 'hold' },
        { t: 1.8, type: 'pan_right', deg: 60, ease: 'easeOut' }
      ],
      constraints: { maxAngularJerk: 300 }
    })
    sc.shots.s1.autofix = autofix
    return sc
  }
  const off = runShot(mk(false)).shot
  assert(off.errors.some((e) => e.code === 'motion/angular-jerk'), `关掉纠错应报角急动，实测 ${off.metrics.maxAngularJerkDegS3}°/s³`)
  const on = runShot(mk(true)).shot
  assert(on.corrections.length > 0, '开纠错应有留痕')
  assert(
    on.metrics.maxAngularJerkDegS3 < off.metrics.maxAngularJerkDegS3,
    `角急动应下降：${on.metrics.maxAngularJerkDegS3} vs ${off.metrics.maxAngularJerkDegS3}`
  )
})

check('E20 角速度超限只报错（速度是意图）；显式 opt-in 才缩动作幅度', () => {
  const mk = () =>
    shotScene({
      durationS: 1,
      camera: { framing: { mode: 'fill-height', fill: 0.5, lock: 'start-only' } },
      moves: [{ t: 0.25, type: 'pan_left', deg: 170, ease: 'linear' }],
      constraints: { maxAngularSpeed: 200 }
    })
  const r = runShot(mk()).shot
  assert(r.errors.some((e) => e.code === 'motion/angular-speed'), '应报角速度超限')
  assert(!r.corrected, '默认不自动缩动作幅度')
  const au = mk()
  au.shots.s1.autofix = { speed: true }
  const r2 = runShot(au).shot
  assert(r2.metrics.maxAngularSpeedDegS <= 200 * 1.05, `opt-in 后应收敛，得到 ${r2.metrics.maxAngularSpeedDegS}`)
  assert(r2.corrections.some((c) => c.code === 'param-scale'), '应留痕 param-scale')
})

check('E21 净距不足只报错（路径是意图）；opt-in clearance 才推离', () => {
  const mk = () =>
    shotScene({
      camera: { framing: { mode: 'fill-height', fill: 0.8, lock: 'start-only' } },
      constraints: { minClearance: 3.0 }
    })
  const r = runShot(mk()).shot
  assert(r.errors.some((e) => e.code === 'motion/clearance'), '应报净距不足')
  assert(!r.corrected, '默认不推机位')
  const au = mk()
  au.shots.s1.autofix = { clearance: true }
  const r2 = runShot(au).shot
  assert(r2.corrections.some((c) => c.code === 'clearance-push'), `opt-in 后应推离，得到 ${JSON.stringify(r2.corrections)}`)
  assert(r2.metrics.minClearanceM >= 3.0 - 1e-3, `opt-in 后净距达标，得到 ${r2.metrics.minClearanceM}`)
})

check('E17 覆盖面指标：占画面比例 / 主体在画内比例 / 可见比例', () => {
  const { shot } = runShot(shotScene())
  const f = shot.frames[0]
  assert(f.frameCoveragePct > 1 && f.frameCoveragePct < 100, `frameCoveragePct 应在 1~100，得到 ${f.frameCoveragePct}`)
  assert(f.subjectInFramePct === 100, `主体完全在画内应为 100%，得到 ${f.subjectInFramePct}`)
  assert(f.subjectVisiblePct > 99, `无遮挡时可见比例应≈100%，得到 ${f.subjectVisiblePct}`)
  assert(shot.metrics.frameCoverageRange && shot.metrics.minSubjectVisiblePct > 99, 'metrics 应汇总覆盖指标')
})

check('E18 遮挡会拉低主体可见比例', () => {
  const author = shotScene()
  // 相机在 −Y，主体是原点 1m 立方体；在两者之间插一块挡板（挡住一部分而非全部）
  author.defs.wall = { parts: [{ id: 'slab', shape: 'box', size: [0.7, 0.05, 0.7], at: { rest: 'ground', offset: [0.1, -1.5, 0.5] } }] }
  author.scene.push({ use: 'wall', id: 'wall', at: {} })
  const { shot } = runShot(author)
  assert(shot.metrics.minSubjectVisiblePct < 95, `可见比例应被遮挡拉低，得到 ${shot.metrics.minSubjectVisiblePct}`)
})

check('E19 手持修饰器必须时间连贯（不是逐帧白噪声）', () => {
  const mk = (seed) => runShot(shotScene({ modifiers: [{ type: 'handheld', amplitudeM: 0.012, frequencyHz: 1.6, seed }] })).shot
  const a = mk(3)
  const steps = []
  for (let i = 1; i < a.frames.length; i += 1) {
    const p = a.frames[i].pos
    const q = a.frames[i - 1].pos
    steps.push([p[0] - q[0], p[1] - q[1], p[2] - q[2]])
  }
  // 判据：相邻两步的方向相关性。白噪声≈0（逐帧乱跳）；时间连贯噪声>0.5（速度是连续的）
  let dot = 0
  let n = 0
  for (let i = 1; i < steps.length; i += 1) {
    const l1 = Math.hypot(...steps[i - 1])
    const l2 = Math.hypot(...steps[i])
    if (l1 < 1e-9 || l2 < 1e-9) continue
    dot += (steps[i - 1][0] * steps[i][0] + steps[i - 1][1] * steps[i][1] + steps[i - 1][2] * steps[i][2]) / (l1 * l2)
    n += 1
  }
  const corr = dot / Math.max(n, 1)
  assert(corr > 0.5, `相邻步方向相关性应 >0.5（时间连贯），得到 ${corr.toFixed(3)}`)
  assert(JSON.stringify(mk(3).frames) === JSON.stringify(a.frames), '同 seed 仍须逐字节一致')
  assert(JSON.stringify(mk(8).frames) !== JSON.stringify(a.frames), '不同 seed 应不同')
})

check('E22 用 framing.fill 表达的推轨必须遵守分段 ease（曾静默走线性）', () => {
  const mk = (ease) => runShot(shotScene({ durationS: 2, moves: [{ t: 2, type: 'dolly_in', framing: { fill: [0.5, 0.8] }, ease }] })).shot
  const at = (s, u) => s.frames[Math.round(u * (s.frames.length - 1))].fill
  const lin = mk('linear')
  const eio = mk('easeInOut')
  const sm = mk('smooth')
  assert(near(at(lin, 0.25), 0.575, 0.012), `linear 在 25% 应≈0.575，得到 ${at(lin, 0.25)}`)
  assert(at(eio, 0.25) < at(lin, 0.25) - 0.02, `easeInOut 起步应更慢：${at(eio, 0.25)} vs ${at(lin, 0.25)}`)
  assert(at(eio, 0.75) > at(lin, 0.75) + 0.02, `easeInOut 收尾应更快：${at(eio, 0.75)} vs ${at(lin, 0.75)}`)
  assert(at(sm, 0.25) < at(eio, 0.25), `smooth 起步应比 easeInOut 更慢：${at(sm, 0.25)} vs ${at(eio, 0.25)}`)
})

check('E7 匀速：1m / 2s（ease linear, start-only 锁定）→ 逐帧速度恒 0.5 m/s', () => {
  const cam = { framing: { mode: 'fill-height', fill: 0.5, lock: 'start-only' } }
  const { shot } = runShot(shotScene({ durationS: 2, camera: cam, moves: [{ t: 2, type: 'truck_right', amount: 1, ease: 'linear' }] }))
  assert(near(shot.metrics.maxSpeedMps, 0.5, 1e-3), `峰值速度应为 0.5，得到 ${shot.metrics.maxSpeedMps}`)
  for (let i = 1; i < shot.frames.length; i += 1) {
    const a = shot.frames[i - 1].pos
    const b = shot.frames[i].pos
    const dt = shot.frames[i].t - shot.frames[i - 1].t
    const sp = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt
    assert(near(sp, 0.5, 1e-6), `第 ${i} 帧速度应为 0.5，得到 ${sp}`)
  }
})

check('E8 space 自由度：同为 truck_left，world 与 camera 结果不同且各自可预测', () => {
  const cam = (space) => ({ space, framing: { mode: 'fill-height', fill: 0.5, lock: 'start-only' } })
  const w = runShot(shotScene({ camera: cam('world'), moves: [{ t: 1, type: 'truck_left', amount: 1, ease: 'linear' }] })).shot
  const c = runShot(shotScene({ camera: cam('camera'), moves: [{ t: 1, type: 'truck_left', amount: 1, ease: 'linear' }] })).shot
  // 默认机位在 −Y 看向 +Y：world 参考系下 truck_left 沿世界 −X；camera 参考系下沿相机自身左侧（同样是 −X）
  const dw = w.frames[0].pos[0] - w.frames[w.frames.length - 1].pos[0]
  const dc = c.frames[0].pos[0] - c.frames[c.frames.length - 1].pos[0]
  assert(near(dw, 1, 1e-6), `world 位移应为 +1m（朝 −X），得到 ${dw}`)
  assert(near(dc, 1, 1e-6), `camera 位移应为 +1m，得到 ${dc}`)
  // 环绕后两者必须分道扬镳：orbit 会让 camera 参考系的"左"跟着转
  const w2 = runShot(shotScene({ camera: cam('world'), moves: [{ t: 1, type: 'orbit_left', deg: 90, ease: 'linear' }, { t: 2, type: 'truck_left', amount: 1, ease: 'linear' }], durationS: 2 })).shot
  const c2 = runShot(shotScene({ camera: cam('camera'), moves: [{ t: 1, type: 'orbit_left', deg: 90, ease: 'linear' }, { t: 2, type: 'truck_left', amount: 1, ease: 'linear' }], durationS: 2 })).shot
  const wDelta = [0, 1, 2].map((i) => w2.frames[w2.frames.length - 1].pos[i] - w2.frames[24].pos[i])
  const cDelta = [0, 1, 2].map((i) => c2.frames[c2.frames.length - 1].pos[i] - c2.frames[24].pos[i])
  assert(Math.hypot(...wDelta) > 0.9 && Math.hypot(...cDelta) > 0.9, '两种参考系都应产生 1m 位移')
  const diff = Math.hypot(wDelta[0] - cDelta[0], wDelta[1] - cDelta[1], wDelta[2] - cDelta[2])
  assert(diff > 0.5, `环绕后 world 与 camera 参考系的位移方向应明显不同，差值 ${diff.toFixed(3)}`)
})

check('E16 parallel 复合动作：同一段内同时环绕与下降（螺旋），而非顺序两段', () => {
  const cam = { framing: { mode: 'fill-height', fill: 0.5, lock: 'start-only' }, space: 'world' }
  const par = runShot(shotScene({ durationS: 2, camera: cam, moves: [{ t: 2, parallel: [{ type: 'orbit_left', deg: 180 }, { type: 'pedestal_down', amount: 0.5 }] }] })).shot
  const seq = runShot(shotScene({ durationS: 2, camera: cam, moves: [{ t: 1, type: 'orbit_left', deg: 180 }, { t: 2, type: 'pedestal_down', amount: 0.5 }] })).shot
  const az = (f, c) => Math.atan2(f.pos[0] - c[0], -(f.pos[1] - c[1]))
  const c = par.frames[0].target
  const mid = Math.floor(par.frames.length / 2)
  // 并行：中点已经同时转了一半、降了一半
  const azMid = (az(par.frames[mid], c) * 180) / Math.PI
  const dzMid = par.frames[mid].pos[2] - par.frames[0].pos[2]
  assert(near(azMid, 90, 3), `并行中点方位应≈90°，得到 ${azMid.toFixed(2)}`)
  assert(near(dzMid, -0.25, 0.03), `并行中点应已下降≈0.25m，得到 ${dzMid.toFixed(4)}`)
  // 顺序：中点（t=1s）只完成了环绕，还没开始下降
  const c2 = seq.frames[0].target
  const dzSeq = seq.frames[Math.floor(seq.frames.length / 2)].pos[2] - seq.frames[0].pos[2]
  assert(Math.abs(dzSeq) < 0.02, `顺序分段中点不应有下降，得到 ${dzSeq.toFixed(4)}`)
  // 终点：组内子动作按声明顺序施加相同增量 → 终点与顺序分段**一致**，差别只在路径与节奏
  const endPar = par.frames[par.frames.length - 1].pos
  const endSeq = seq.frames[seq.frames.length - 1].pos
  const diff = Math.hypot(endPar[0] - endSeq[0], endPar[1] - endSeq[1], endPar[2] - endSeq[2])
  assert(diff < 1e-9, `并行与顺序的终点应一致（只改路径不改终点），差值 ${diff}`)
})

check('E15 per-frame 构图锁定会把平移"吃"成弧线（主体恒定占屏的代价）', () => {
  const cam = { framing: { mode: 'fill-height', fill: 0.5, lock: 'per-frame' } }
  const { shot } = runShot(shotScene({ camera: cam, moves: [{ t: 1, type: 'truck_right', amount: 1, ease: 'linear' }] }))
  // ① 占屏比全程恒定（这才是 per-frame 锁定的不变量；距离会随朝向微调，故不能断言距离恒定）
  for (const f of shot.frames) assert(near(f.fill, 0.5, 0.005), `占屏应恒定 0.5，得到 ${f.fill}`)
  // ② 路径不再是直线：中间帧到首末连线的最大偏离应明显非零（直线平移被约束拉成弧线）
  const a = shot.frames[0].pos
  const b = shot.frames[shot.frames.length - 1].pos
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const abLen = Math.hypot(...ab)
  let maxDev = 0
  for (const f of shot.frames) {
    const ap = [f.pos[0] - a[0], f.pos[1] - a[1], f.pos[2] - a[2]]
    const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (abLen * abLen)
    const proj = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]
    maxDev = Math.max(maxDev, Math.hypot(f.pos[0] - proj[0], f.pos[1] - proj[1], f.pos[2] - proj[2]))
  }
  assert(maxDev > 0.005, `路径应偏离直线（弧线），实际最大偏离 ${maxDev.toFixed(5)}`)
  // ③ 因此实际位移小于动作声明的 1m
  const d = Math.hypot(...[0, 1, 2].map((i) => shot.frames[shot.frames.length - 1].pos[i] - shot.frames[0].pos[i]))
  assert(d < 0.999 && d > 0.9, `位移应被约束"吃掉"一点（0.9~0.999），得到 ${d.toFixed(4)}`)
})

check('E9 手持修饰器确定性：同 seed 逐字节相同，换 seed 不同', () => {
  const mk = (seed) => JSON.stringify(runShot(shotScene({ modifiers: [{ type: 'handheld', amplitudeM: 0.01, frequencyHz: 1, seed }] })).shot.frames)
  assert(mk(7) === mk(7), '同 seed 必须逐字节相同')
  assert(mk(7) !== mk(8), '不同 seed 应产生不同结果')
})

check('E10 free 朝向防滥用：缺 reason / 缺 keys / 关键帧超限 都必须 error', () => {
  const base = { aimMode: 'free' }
  const noReason = runShot(shotScene({ camera: base })).shot
  assert(!noReason.ok && noReason.errors.some((e) => e.code === 'shot/aim-reason'), '缺 reason 应 error')
  const withReason = runShot(shotScene({ camera: { ...base, aim: { reason: '模拟手持甩镜', keys: [{ t: 0, yawDeg: 0 }] } } })).shot
  assert(withReason.ok, `填了 reason 与 keys 应通过：${JSON.stringify(withReason.errors)}`)
  assert(withReason.warnings.some((w) => w.code === 'shot/aim-free'), 'free 模式必须恒定带 warning')
  const tooMany = runShot(shotScene({ camera: { ...base, aim: { reason: '测试', keys: Array.from({ length: 9 }, (_, i) => ({ t: i / 9, yawDeg: i })) } } })).shot
  assert(!tooMany.ok && tooMany.errors.some((e) => e.code === 'shot/aim-keys'), '关键帧超 8 应 error')
})

check('E11 禁止项：写 camera.pos / eye 直接 error', () => {
  const { shot } = runShot(shotScene({ camera: { pos: [1, 2, 3] } }))
  assert(!shot.ok && shot.errors.some((e) => e.code === 'shot/forbidden'), '写绝对坐标应 error')
})

check('E12 未实现动作：zoom_in 明确报「尚未实现」而不是静默', () => {
  const { shot } = runShot(shotScene({ moves: [{ t: 1, type: 'zoom_in', factor: 1.4 }] }))
  assert(shot.warnings.some((w) => w.code === 'shot/unimplemented' && w.message.includes('zoom_in')), '应报未实现')
})

check('E13 镜头连续性：大跳变报警', () => {
  const a = runShot(shotScene()).shot
  const b = runShot(shotScene({ camera: { orbit: { azimuthDeg: 180, elevationDeg: 0 } } })).shot
  const issues = motionMod.checkContinuity([a, b], { maxJumpM: 0.5, maxTurnDeg: 30 })
  assert(issues.length === 1 && issues[0].code === 'continuity/jump', `应报 1 条跳变，得到 ${JSON.stringify(issues)}`)
})

check('E14 目标锚点：target.at 指向具体部件与锚点', () => {
  const author = shotScene()
  author.shots.s1.camera.target = { at: 'thing/cube', anchor: 'top_center' }
  const { shot } = runShot(author)
  assert(shot.ok, `解算失败：${JSON.stringify(shot.errors)}`)
  assert(near(shot.frames[0].target[2], 1, 1e-6), `目标应在立方体顶面 z=1，得到 ${shot.frames[0].target[2]}`)
})

console.log(`\n${pass}/${pass + fail} 项通过`)
if (fail > 0) process.exitCode = 1
