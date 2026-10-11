/**
 * 三视图拼版（contact sheet）—— 一张图交付给 Agent，省 token
 *
 * 组成：
 *  - 2×2 单元格：FRONT / RIGHT / TOP（正交，同尺度）+ 3/4 透视
 *  - 每格：视图名 + 比例尺（米制数字）+ 内容；TOP 格另加 +X/+Y 轴指示
 *  - 页脚：主体判定理由 + 取景框尺寸（数值与图一起给，Agent 不必从像素里量）
 *
 * 全部机位来自 views.mjs 的自动取景，author 里没有任何相机坐标。
 */

import { renderScene, encodePng } from './render.mjs'
import { autoViews, niceStep } from './views.mjs'
import { drawText, fillRect, strokeRect, drawLine } from './font.mjs'

const TEXT = [232, 236, 240]
const DIM = [138, 144, 154]
const LINE = [86, 92, 102]

function drawScaleBar(rgb, W, H, x, y, px, step) {
  const len = Math.max(12, Math.round(px))
  drawLine(rgb, W, H, x, y, x + len, y, TEXT, 2)
  drawLine(rgb, W, H, x, y - 5, x, y + 5, TEXT, 2)
  drawLine(rgb, W, H, x + len, y - 5, x + len, y + 5, TEXT, 2)
  drawText(rgb, W, H, `${step} M`, x + len + 6, y - 4, 1, TEXT)
}

function drawAxes(rgb, W, H, x, y) {
  drawLine(rgb, W, H, x, y, x + 34, y, [220, 120, 110], 2)
  drawText(rgb, W, H, '+X', x + 38, y - 4, 1, [220, 120, 110])
  drawLine(rgb, W, H, x, y, x, y - 34, [130, 200, 140], 2)
  drawText(rgb, W, H, '+Y', x - 4, y - 48, 1, [130, 200, 140])
}

/**
 * 镜头关键帧拼版：从逐帧表里等距取 4 帧渲染，用于"运镜是否符合意图"的视觉自检
 * 机位来自 shot 的逐帧表（不是 views 自动取景），up 由 c2w 反推，故 roll 也正确
 */
export function renderFrameSheet(resolved, shotResult, spec = {}) {
  const size = spec.size ?? 1024
  const cols = 2
  const rows = 2
  const gap = 6
  const footerH = 60
  const cellW = Math.floor((size - gap * (cols + 1)) / cols)
  const cellH = Math.floor((size - gap * (rows + 1)) / rows)
  const W = size
  const H = size + footerH
  const rgb = Buffer.alloc(W * H * 3)
  fillRect(rgb, W, H, 0, 0, W, H, spec.background ?? [16, 17, 20])

  const frames = shotResult.frames
  const picks = [0, Math.floor((frames.length - 1) / 3), Math.floor((2 * (frames.length - 1)) / 3), frames.length - 1]
  const ssaa = spec.ssaa ?? 2
  const cells = []
  for (let i = 0; i < picks.length; i += 1) {
    const f = frames[picks[i]]
    const up = [f.c2w[1], f.c2w[5], f.c2w[9]]
    const camera = {
      name: `kf${i}`,
      type: 'persp',
      eye: f.pos,
      target: f.target,
      up,
      lens: f.lens,
      sensorWidth: shotResult.intrinsics.sensorWidth,
      width: cellW,
      height: cellH
    }
    const out = renderScene(resolved, camera, { ssaa, gridStep: spec.gridStep ?? 0.05, background: (spec.cellBackground ?? [30, 33, 38]).map((v) => v / 255) })
    const col = i % cols
    const row = Math.floor(i / cols)
    const x0 = gap + col * (cellW + gap)
    const y0 = gap + row * (cellH + gap)
    for (let y = 0; y < cellH; y += 1)
      for (let x = 0; x < cellW; x += 1) {
        const s = (y * cellW + x) * 3
        const d = ((y0 + y) * W + (x0 + x)) * 3
        rgb[d] = out.rgb[s]
        rgb[d + 1] = out.rgb[s + 1]
        rgb[d + 2] = out.rgb[s + 2]
      }
    strokeRect(rgb, W, H, x0, y0, cellW, cellH, LINE, 1)
    const fillTxt = f.fill === null ? '' : `  FILL ${Math.round(f.fill * 100)}%`
    drawText(rgb, W, H, `T ${f.t.toFixed(2)}S  F${f.frame}${fillTxt}`, x0 + 8, y0 + 8, 2, TEXT)
    drawText(rgb, W, H, `ROLL ${f.rollDeg.toFixed(1)}`, x0 + 8, y0 + cellH - 20, 1, DIM)
    cells.push({ frame: f.frame, t: f.t, fill: f.fill })
  }

  const m = shotResult.metrics
  const fy = size + 8
  drawText(rgb, W, H, `SHOT ${shotResult.shot}   ${shotResult.frameCount} FRAMES @ ${shotResult.fps}FPS   ${shotResult.durationS}S   LENS ${shotResult.intrinsics.lens}MM`, gap + 2, fy, 1, TEXT)
  drawText(
    rgb,
    W,
    H,
    `FILL ${m.fillRange ? m.fillRange.map((v) => Math.round(v * 100) + '%').join(' -> ') : 'N/A'}   MARGIN ${m.minMarginPx}PX   SPEED ${m.maxSpeedMps}M/S   CLEAR ${m.minClearanceM}M   ROLL ${m.maxRollDeg}`,
    gap + 2,
    fy + 14,
    1,
    DIM
  )
  drawText(
    rgb,
    W,
    H,
    `OUT-OF-FRAME ${m.outOfFrameCount}   COLLISION ${m.collisionCount}   OCCLUSION ${m.occlusionCount}   VIOLATIONS ${shotResult.errors.length}`,
    gap + 2,
    fy + 28,
    1,
    shotResult.errors.length ? [235, 140, 130] : DIM
  )
  const reason = shotResult.warnings.length ? shotResult.warnings[0].message : 'NO WARNINGS'
  drawText(rgb, W, H, reason.replace(/[^\x20-\x7E]/g, ' ').slice(0, 150), gap + 2, fy + 42, 1, DIM)

  return { png: encodePng(rgb, W, H), width: W, height: H, cells, metrics: m }
}

export function renderSheet(resolved, spec = {}) {
  const size = spec.size ?? 1024
  const cols = spec.cols ?? 2
  const rows = spec.rows ?? 2
  const gap = spec.gap ?? 6
  const footerH = spec.footerH ?? 46
  const cellW = Math.floor((size - gap * (cols + 1)) / cols)
  const cellH = Math.floor((size - gap * (rows + 1)) / rows)
  const W = size
  const H = size + footerH

  const { pick, cameras, frame } = autoViews(resolved, spec, cellW, cellH)
  const rgb = Buffer.alloc(W * H * 3)
  fillRect(rgb, W, H, 0, 0, W, H, spec.background ?? [16, 17, 20])

  const cells = []
  const ssaa = spec.ssaa ?? 2
  for (let i = 0; i < cameras.length; i += 1) {
    const { name, title, camera, meta } = cameras[i]
    const step = spec.gridStep && spec.gridStep !== 'auto' ? spec.gridStep : meta.kind === 'ortho' ? niceStep(meta.worldPerPx) : spec.gridStepPersp ?? 0.1
    // renderScene 的背景是 0..1 浮点；sheet 的调色板是 0..255，这里必须换算（曾把白底拉满整格）
    const cellBg = (spec.cellBackground ?? [30, 33, 38]).map((v) => v / 255)
    const out = renderScene(resolved, camera, { ssaa, gridStep: step, background: cellBg })
    const col = i % cols
    const row = Math.floor(i / cols)
    const x0 = gap + col * (cellW + gap)
    const y0 = gap + row * (cellH + gap)
    for (let y = 0; y < cellH; y += 1)
      for (let x = 0; x < cellW; x += 1) {
        const s = (y * cellW + x) * 3
        const d = ((y0 + y) * W + (x0 + x)) * 3
        rgb[d] = out.rgb[s]
        rgb[d + 1] = out.rgb[s + 1]
        rgb[d + 2] = out.rgb[s + 2]
      }
    strokeRect(rgb, W, H, x0, y0, cellW, cellH, LINE, 1)
    drawText(rgb, W, H, title, x0 + 8, y0 + 8, 2, TEXT)
    if (meta.kind === 'ortho') {
      drawScaleBar(rgb, W, H, x0 + 10, y0 + cellH - 20, step / meta.worldPerPx, step)
      if (name === 'top') drawAxes(rgb, W, H, x0 + 46, y0 + cellH - 44)
    } else {
      drawText(rgb, W, H, `DIST ${meta.dist} M`, x0 + 10, y0 + cellH - 20, 1, DIM)
    }
    cells.push({ name, title, type: camera.type, lens: camera.lens ?? null, orthoHeight: camera.orthoHeight ?? null, gridStep: step, meta })
  }

  // 页脚：主体判定理由 + 取景框尺寸（数值随图一起给）
  const fy = size + 8
  const frameTxt = frame
    ? `FRAME ${frame.size.map((v) => Math.round(v * 1000) / 1000).join(' X ')} M   SUBJECT ${pick.id ?? 'NONE'}   FIT ${(spec.fit ?? 'context').toUpperCase()}`
    : 'FRAME N/A'
  drawText(rgb, W, H, frameTxt, gap + 2, fy, 1, TEXT)
  drawText(rgb, W, H, pick.reason.replace(/[^\x20-\x7E]/g, ' '), gap + 2, fy + 14, 1, DIM)
  drawText(rgb, W, H, `PARTS ${resolved.parts.length}   DRIVERS ${Object.keys(resolved.scope ?? {}).length}`, gap + 2, fy + 28, 1, DIM)

  return {
    png: encodePng(rgb, W, H),
    width: W,
    height: H,
    cells,
    subject: pick,
    frame,
    partCount: resolved.parts.length
  }
}
