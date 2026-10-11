/**
 * MVP 渲染器 —— 纯 JS 软光栅化 + 自写 PNG 编码（零依赖）
 *
 * 为什么不用 GPU/WebGL（见 docs/blockout-plan-review.md §2.6）：
 *  640×360～1080p 量级下 CPU 路径够用，且**跨机器逐字节确定**、可脱离 Electron 做黄金图回归；
 *  WebGL2 的瓶颈在回读与编码，且无法直接 readPixels 深度附件，还要面对软件回退被收紧的问题。
 *
 * 输出：RGB PNG（1024px 级），含
 *  - flat 着色（面法线 + 固定光照），几何形体读得清
 *  - z-buffer 深度（1/z 插值，透视正确）
 *  - 逐像素世界坐标（用于米制网格）
 *  - object-ID 缓冲 → 物体轮廓描边 + 接触处压暗（廉价"接触阴影"）
 *  - 2× SSAA 超采样降采样（抗锯齿）
 */

import zlib from 'node:zlib'

/* ────────── PNG 编码（IHDR/IDAT/IEND，8bit RGB） ────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

export function encodePng(rgb, width, height) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none（deterministic）
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const idat = zlib.deflateSync(raw, { level: 6 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ────────── 相机 ────────── */

function lookAt(eye, target, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1
    return [a[0] / l, a[1] / l, a[2] / l]
  }
  const f = norm(sub(target, eye))
  let s = cross(f, up)
  if (Math.hypot(...s) < 1e-9) s = cross(f, [0, 0, 1])
  s = norm(s)
  const u = cross(s, f)
  return [
    s[0], s[1], s[2], -dot(s, eye),
    u[0], u[1], u[2], -dot(u, eye),
    -f[0], -f[1], -f[2], dot(f, eye),
    0, 0, 0, 1
  ]
}

const xform4 = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]
]

const hexToRgb = (hex) => {
  const h = String(hex).replace('#', '')
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/* ────────── 主渲染 ────────── */

/**
 * @param {object} resolved resolveScene() 的产物
 * @param {object} camera   {name, type:'persp', eye, target, up, lens, sensorWidth, width, height, near}
 * @param {object} opts     {ssaa, background, gridPart, gridStep}
 */
export function renderScene(resolved, camera, opts = {}) {
  const ssaa = opts.ssaa ?? 2
  const W = (camera.width ?? 800) * ssaa
  const H = (camera.height ?? 600) * ssaa
  const near = camera.near ?? 0.02
  const lens = camera.lens ?? 50
  const sensor = camera.sensorWidth ?? 36
  const fit = W >= H ? W : H
  const fx = (lens / sensor) * fit
  const cx = W / 2
  const cy = H / 2

  const eye = camera.eye
  const view = lookAt(eye, camera.target, camera.up ?? [0, 0, 1])
  const isOrtho = camera.type === 'ortho'
  /** 正交：世界单位 → 像素（orthoHeight = 映射到画面高度的世界尺度） */
  const ppu = isOrtho ? H / (camera.orthoHeight ?? 1) : 0
  const lightDir = (() => {
    const l = opts.light ?? [0.45, -0.75, 0.7]
    const n = Math.hypot(...l) || 1
    return [l[0] / n, l[1] / n, l[2] / n]
  })()

  const color = new Float32Array(W * H * 3)
  const depth = new Float32Array(W * H).fill(-Infinity) // 存 1/z：越大越近
  const ids = new Int32Array(W * H).fill(-1)
  const wpos = new Float32Array(W * H * 3)
  /** 朝上的水平面像素（用于接触压暗）：不只地板，桌面/台面同样需要 */
  const topBuf = new Uint8Array(W * H)
  const bg = opts.background ?? [0.09, 0.1, 0.12]
  for (let i = 0; i < W * H; i += 1) {
    color[i * 3] = bg[0]
    color[i * 3 + 1] = bg[1]
    color[i * 3 + 2] = bg[2]
  }

  const parts = resolved.parts
  let tris = 0
  let drawn = 0

  for (let pi = 0; pi < parts.length; pi += 1) {
    const part = parts[pi]
    const base = hexToRgb(part.color)
    const V = part.mesh.vertices.map((v) => {
      // 世界 → 相机
      const w = [
        part.pose.R[0] * v[0] + part.pose.R[1] * v[1] + part.pose.R[2] * v[2] + part.pose.t[0],
        part.pose.R[3] * v[0] + part.pose.R[4] * v[1] + part.pose.R[5] * v[2] + part.pose.t[1],
        part.pose.R[6] * v[0] + part.pose.R[7] * v[1] + part.pose.R[8] * v[2] + part.pose.t[2]
      ]
      const c = xform4(view, w)
      return { w, c }
    })
    for (const t of part.mesh.triangles) {
      tris += 1
      const A = V[t[0]]
      const B = V[t[1]]
      const C = V[t[2]]
      // 近平面：MVP 直接丢弃跨平面的三角形（场景尺度下影响可忽略）
      if (A.c[2] > -near || B.c[2] > -near || C.c[2] > -near) continue
      const proj = (c) => {
        const z = -c[2]
        if (isOrtho) return [cx + c[0] * ppu, cy - c[1] * ppu, z]
        return [cx + (fx * c[0]) / z, cy - (fx * c[1]) / z, z]
      }
      const pa = proj(A.c)
      const pb = proj(B.c)
      const pc = proj(C.c)
      const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1])
      if (Math.abs(area) < 1e-9) continue
      const inv = 1 / area
      // 面法线（世界）+ 双面翻转
      const e1 = [B.w[0] - A.w[0], B.w[1] - A.w[1], B.w[2] - A.w[2]]
      const e2 = [C.w[0] - A.w[0], C.w[1] - A.w[1], C.w[2] - A.w[2]]
      let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
      const nl = Math.hypot(...n) || 1
      n = [n[0] / nl, n[1] / nl, n[2] / nl]
      const mid = [(A.w[0] + B.w[0] + C.w[0]) / 3, (A.w[1] + B.w[1] + C.w[1]) / 3, (A.w[2] + B.w[2] + C.w[2]) / 3]
      const viewVec = [eye[0] - mid[0], eye[1] - mid[1], eye[2] - mid[2]]
      if (n[0] * viewVec[0] + n[1] * viewVec[1] + n[2] * viewVec[2] < 0) n = [-n[0], -n[1], -n[2]]
      const lambert = Math.max(0, n[0] * lightDir[0] + n[1] * lightDir[1] + n[2] * lightDir[2])
      const shade = 0.32 + 0.68 * lambert
      const col = [base[0] * shade, base[1] * shade, base[2] * shade]

      const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])))
      const maxX = Math.min(W - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])))
      const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])))
      const maxY = Math.min(H - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])))
      // 深度键统一为「越大越近」：透视用 1/距离；正交用 −距离（c[2] 为负，越近越大）
      const ka = isOrtho ? -pa[2] : 1 / pa[2]
      const kb = isOrtho ? -pb[2] : 1 / pb[2]
      const kc = isOrtho ? -pc[2] : 1 / pc[2]
      // 属性插值权重：透视需 1/z 校正；正交用朴素重心坐标
      const qa = isOrtho ? 1 : 1 / pa[2]
      const qb = isOrtho ? 1 : 1 / pb[2]
      const qc = isOrtho ? 1 : 1 / pc[2]

      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const px = x + 0.5
          const py = y + 0.5
          const w0 = (pb[0] - pa[0]) * (py - pa[1]) - (px - pa[0]) * (pb[1] - pa[1])
          const w1 = (pc[0] - pb[0]) * (py - pb[1]) - (px - pb[0]) * (pc[1] - pb[1])
          const w2 = (pa[0] - pc[0]) * (py - pc[1]) - (px - pc[0]) * (pa[1] - pc[1])
          if (area > 0 ? w0 < 0 || w1 < 0 || w2 < 0 : w0 > 0 || w1 > 0 || w2 > 0) continue
          const b0 = w1 * inv
          const b1 = w2 * inv
          const b2 = w0 * inv
          const qsum = b0 * qa + b1 * qb + b2 * qc
          const key = isOrtho ? b0 * ka + b1 * kb + b2 * kc : qsum
          const idx = y * W + x
          if (key <= depth[idx]) continue
          depth[idx] = key
          ids[idx] = pi
          topBuf[idx] = n[2] > 0.85 ? 1 : 0
          const invq = 1 / qsum
          wpos[idx * 3] = (b0 * A.w[0] * qa + b1 * B.w[0] * qb + b2 * C.w[0] * qc) * invq
          wpos[idx * 3 + 1] = (b0 * A.w[1] * qa + b1 * B.w[1] * qb + b2 * C.w[1] * qc) * invq
          wpos[idx * 3 + 2] = (b0 * A.w[2] * qa + b1 * B.w[2] * qb + b2 * C.w[2] * qc) * invq
          color[idx * 3] = col[0]
          color[idx * 3 + 1] = col[1]
          color[idx * 3 + 2] = col[2]
          drawn += 1
        }
      }
    }
  }

  /* 后处理：米制网格（仅对水平平面）+ 物体描边 + 接触压暗 */
  const gridStep = opts.gridStep ?? 0.1
  for (let i = 0; i < W * H; i += 1) {
    const id = ids[i]
    if (id < 0) continue
    const part = parts[id]
    if (part.shape === 'plane') {
      const x = wpos[i * 3]
      const y = wpos[i * 3 + 1]
      const line = (v, step) => {
        const f = Math.abs(v / step - Math.round(v / step))
        return f < 0.012 / step
      }
      if (line(x, gridStep) || line(y, gridStep)) {
        const strong = line(x, gridStep * 5) || line(y, gridStep * 5)
        const k = strong ? 0.55 : 0.78
        color[i * 3] *= k
        color[i * 3 + 1] *= k
        color[i * 3 + 2] *= k
      }
    }
  }
  const outline = new Uint8Array(W * H)
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      const i = y * W + x
      const id = ids[i]
      if (id < 0) continue
      if (ids[i - 1] !== id || ids[i + 1] !== id || ids[i - W] !== id || ids[i + W] !== id) outline[i] = 1
    }
  }
  // 接触压暗：朝上的水平面上，靠近**其他物体**的像素按距离压暗（廉价接触阴影，解决"悬空感"）
  const contact = new Float32Array(W * H).fill(1)
  const R = Math.max(4, Math.round(ssaa * 7))
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x
      if (!topBuf[i]) continue
      const own = ids[i]
      let best = Infinity
      for (let dy = -R; dy <= R; dy += 2) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -R; dx <= R; dx += 2) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const j = yy * W + xx
          if (ids[j] >= 0 && ids[j] !== own) {
            const d = Math.hypot(dx, dy)
            if (d < best) best = d
          }
        }
      }
      if (best <= R) {
        const t = Math.min(1, best / Math.max(R, 1))
        contact[i] = 0.68 + 0.32 * t
      }
    }
  }

  /* SSAA 降采样 + 描边合成 → RGB8 */
  const outW = camera.width ?? 800
  const outH = camera.height ?? 600
  const rgb = Buffer.alloc(outW * outH * 3)
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let edge = 0
      for (let sy = 0; sy < ssaa; sy += 1) {
        for (let sx = 0; sx < ssaa; sx += 1) {
          const i = (y * ssaa + sy) * W + (x * ssaa + sx)
          const c = contact[i]
          r += color[i * 3] * c
          g += color[i * 3 + 1] * c
          b += color[i * 3 + 2] * c
          edge += outline[i]
        }
      }
      const n = ssaa * ssaa
      const e = edge / n
      const k = 1 - 0.85 * e
      const o = (y * outW + x) * 3
      rgb[o] = Math.max(0, Math.min(255, Math.round((r / n) * k * 255)))
      rgb[o + 1] = Math.max(0, Math.min(255, Math.round((g / n) * k * 255)))
      rgb[o + 2] = Math.max(0, Math.min(255, Math.round((b / n) * k * 255)))
    }
  }

  return {
    width: outW,
    height: outH,
    rgb,
    png: encodePng(rgb, outW, outH),
    // keepIds：把 object-ID 缓冲交出来（供"主体可见度/遮挡率"像素统计用）
    ...(opts.keepIds ? { ids, idWidth: W, idHeight: H, partCount: parts.length } : {}),
    stats: { triangles: tris, pixelWrites: drawn, ssaa }
  }
}

/**
 * 像素级覆盖统计：主体在画面里占多少、有多少被挡住
 * 同一机位渲染两遍 —— 全场（判断遮挡）与"只有主体"（得到主体自身轮廓）
 * @returns {{frameCoverage:number, subjectVisible:number, subjectPixels:number, silhouettePixels:number}}
 */
export function coverageStats(resolved, camera, subjectIds, opts = {}) {
  const width = opts.width ?? 192
  const height = opts.height ?? Math.round((width * (camera.height ?? 9)) / (camera.width ?? 16))
  const cam = { ...camera, width, height }
  const subjectSet = new Set(subjectIds)
  const full = renderScene(resolved, cam, { ssaa: 1, keepIds: true })
  let subjectPixels = 0
  for (let i = 0; i < full.ids.length; i += 1) {
    const id = full.ids[i]
    if (id >= 0 && subjectSet.has(resolved.parts[id]?.id)) subjectPixels += 1
  }
  const only = { ...resolved, parts: resolved.parts.filter((p) => subjectSet.has(p.id)) }
  const alone = renderScene(only, cam, { ssaa: 1, keepIds: true })
  let silhouettePixels = 0
  for (let i = 0; i < alone.ids.length; i += 1) if (alone.ids[i] >= 0) silhouettePixels += 1
  const total = width * height
  return {
    frameCoverage: subjectPixels / total,
    // 可见度 = 全场里属于主体的像素 / 只有主体时它的轮廓像素（被别的几何体挡住的部分会掉下来）
    subjectVisible: silhouettePixels > 0 ? subjectPixels / silhouettePixels : 0,
    subjectPixels,
    silhouettePixels
  }
}
