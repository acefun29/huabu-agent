#!/usr/bin/env node
/**
 * 画布性能基准（性能优化方案阶段 0 / 阶段 6 验收）。
 *
 * 连到正在运行的 dev 窗口（真实 Electron 渲染进程），在专用 perf-bench 工作区里：
 *   1. 写入真实 BMP 位图（解码成本真实，不靠假图）；
 *   2. 经 window.__huabuCanvas.bench 铺 50 图片卡 + 10 生成卡；
 *   3. CDP Input.dispatchMouseEvent 驱动四个场景：平移 / 缩放 / 拖卡 / 流式输出中平移
 *      （流式用 bench.stream 模拟，不耗模型额度）；
 *   4. 采集 window.__huabuPerf 的 FPS / 最大帧间隙 / longtask / 组件渲染计数；
 *   5. 报告写 out/perf-report-<label>-<时间戳>.json。
 *
 * 前置（PowerShell）：
 *   $env:REMOTE_DEBUGGING_PORT='9222'; $env:HUABU_NO_DEVTOOLS='1'; pnpm dev
 *   node scripts/perf-bench.mjs --label baseline
 * HUABU_NO_DEVTOOLS 很重要：detached DevTools 本身会拖累帧率，污染测量。
 *
 * 用法：
 *   node scripts/perf-bench.mjs [--port 9222] [--label baseline] [--ms 4000] [--scenario all|pan|zoom|drag|stream-pan]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { connectRendererPage, installHelpers, sleep } from './lib/cdp.mjs'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = readArg('port', '9222')
const LABEL = readArg('label', 'run')
const SCENARIO = readArg('scenario', 'all')
const DURATION_MS = Number(readArg('ms', '4000'))

const BENCH_WORKSPACE = 'perf-bench'
const BENCH_IMAGE_COUNT = 10
const BENCH_PER_IMAGE = 5
const BENCH_GENS = 10

/* ------------------------------------------------------------------ */
/* 真实位图：无压缩 BMP（3 字节/像素），1024×768 渐变 + 噪声 ≈ 2.3MB/张  */
/* ------------------------------------------------------------------ */

function makeBmp(width, height, seed) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const dataSize = rowSize * height
  const buf = Buffer.alloc(54 + dataSize)
  buf.write('BM', 0)
  buf.writeUInt32LE(54 + dataSize, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(dataSize, 34)
  let s = seed >>> 0
  const rnd = () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 0xffffffff
  }
  for (let y = 0; y < height; y += 1) {
    const rowStart = 54 + y * rowSize
    for (let x = 0; x < width; x += 1) {
      // 渐变 + 噪声：像素间差异大，解码/缩放成本接近真实照片（不会被纯色优化掉）
      const b = (x * 255) / width + rnd() * 60
      const g = (y * 255) / height + rnd() * 60
      const r = ((x + y) * 127) / (width + height) + rnd() * 60
      const o = rowStart + x * 3
      buf[o] = Math.min(255, b) | 0
      buf[o + 1] = Math.min(255, g) | 0
      buf[o + 2] = Math.min(255, r) | 0
    }
  }
  return buf
}

/* ------------------------------------------------------------------ */
/* CDP 输入驱动                                                          */
/* ------------------------------------------------------------------ */

// 基线（优化前）渲染进程可能忙到一次派发要等很久：输入派发统一放宽到 120s，宁可慢也要测完
const mouse = (session, params) => session.send('Input.dispatchMouseEvent', params, { timeout: 120_000 })

/** 中键按住画圆平移 */
async function drivePan(session, vp, ms) {
  const cx = Math.round(vp.w * 0.5)
  const cy = Math.round(vp.h * 0.55)
  await mouse(session, { type: 'mousePressed', x: cx, y: cy, button: 'middle', buttons: 4, clickCount: 1 })
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < ms) {
    const a = i * 0.16
    i += 1
    await mouse(session, {
      type: 'mouseMoved',
      x: cx + Math.round(Math.sin(a) * 220),
      y: cy + Math.round(Math.cos(a * 0.7) * 140),
      button: 'none',
      buttons: 4
    })
    await sleep(16)
  }
  await mouse(session, { type: 'mouseReleased', x: cx, y: cy, button: 'middle', buttons: 0, clickCount: 1 })
  await sleep(250)
}

/** 滚轮缩放（周期性放大/缩小，避免顶到 SCALE_MAX 后空转） */
async function driveZoom(session, vp, ms) {
  const cx = Math.round(vp.w * 0.5)
  const cy = Math.round(vp.h * 0.45)
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < ms) {
    const dir = Math.floor(i / 24) % 2 === 0 ? -1 : 1
    i += 1
    await mouse(session, { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: dir * 100 })
    await sleep(25)
  }
  await sleep(250)
}

/** 左键拖一张卡片画圈 */
async function driveDrag(session, from, ms) {
  await mouse(session, { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < ms) {
    const a = i * 0.2
    i += 1
    await mouse(session, {
      type: 'mouseMoved',
      x: from.x + Math.round(Math.sin(a) * 160),
      y: from.y + Math.round(Math.cos(a * 0.8) * 110),
      button: 'none',
      buttons: 1
    })
    await sleep(16)
  }
  await mouse(session, { type: 'mouseReleased', x: from.x, y: from.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
}

/* ------------------------------------------------------------------ */
/* 主流程                                                                */
/* ------------------------------------------------------------------ */

const evalp = (session, expression, opts) => session.evaluate(expression, opts)

async function waitFor(session, expression, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await evalp(session, expression)
    if (value) return value
    await sleep(300)
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * rAF 只在可见页面跑：窗口被最小化/遮挡时 visibilityState=hidden，测出来全是 0。
 * win32 下尝试用 Win32 ShowWindow(SW_RESTORE) 把窗口拉回前台；其它平台直接报错提示手动处理。
 */
async function ensureWindowVisible(session) {
  let visibility = await evalp(session, 'document.visibilityState')
  if (visibility !== 'visible' && process.platform === 'win32') {
    // 最小化(SW_MINIMIZE)再还原(SW_RESTORE)：被遮挡的窗口走 SetForegroundWindow 会被前台锁拦，
    // 先收进任务栏再放出來则必然回到 Z 序顶部，遮挡解除
    const script =
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; " +
      'public class Win { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); ' +
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }\'; ' +
      "Get-Process | Where-Object { $_.MainWindowTitle -like '*Huabu*' } | ForEach-Object { " +
      '[Win]::ShowWindow($_.MainWindowHandle, 6) | Out-Null; Start-Sleep -Milliseconds 300; ' +
      '[Win]::ShowWindow($_.MainWindowHandle, 9) | Out-Null; [Win]::SetForegroundWindow($_.MainWindowHandle) | Out-Null }'
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', timeout: 15_000, windowsHide: true })
    } catch {
      /* 恢复失败就走下面的显式报错 */
    }
    await sleep(1000)
    visibility = await evalp(session, 'document.visibilityState')
  }
  if (visibility !== 'visible') {
    throw new Error(`窗口不可见（visibilityState=${visibility}）：rAF 被节流，测量无意义。请把 Huabu 窗口恢复到前台后重跑`)
  }
}

async function main() {
  console.log(`[bench] 连接 CDP 端口 ${PORT} …`)
  const { session, page } = await connectRendererPage({ port: PORT })
  try {
    await installHelpers(session)
    await ensureWindowVisible(session)

    if (!(await evalp(session, 'Boolean(window.__huabuPerf)'))) {
      throw new Error('window.__huabuPerf 不存在：需要 dev 构建（pnpm dev），生产构建不含探针')
    }

    // 1. 确保专用工作区（不碰用户真实画布；切换前 store 会自动落盘旧画布）
    await waitFor(session, 'Boolean(window.__huabuCanvas?.state?.().booted)', '应用启动')
    let state = await evalp(session, 'window.__huabuCanvas.state()')
    if (state.workspace?.name !== BENCH_WORKSPACE) {
      // recents 不在探针 state() 里：直接问主进程；已存在则打开，否则新建
      const exists = await evalp(
        session,
        `(async () => { const r = await window.huabu.workspace.state(); return r.recents.some(x => x.name === ${JSON.stringify(BENCH_WORKSPACE)}) })()`,
        { awaitPromise: true }
      )
      if (exists) {
        const path = await evalp(
          session,
          `(async () => { const r = await window.huabu.workspace.state(); return r.recents.find(x => x.name === ${JSON.stringify(BENCH_WORKSPACE)}).path })()`,
          { awaitPromise: true }
        )
        await evalp(session, `window.__huabuCanvas.actions.openWorkspace(${JSON.stringify(path)})`)
      } else {
        await evalp(session, `window.__huabuCanvas.actions.createWorkspace(${JSON.stringify(BENCH_WORKSPACE)})`)
      }
      await waitFor(
        session,
        `window.__huabuCanvas.state().workspace?.name === ${JSON.stringify(BENCH_WORKSPACE)}`,
        '切换到基准工作区'
      )
    }
    state = await evalp(session, 'window.__huabuCanvas.state()')
    const wsPath = state.workspace.path
    console.log(`[bench] 工作区：${wsPath}`)

    // 2. 写入真实 BMP（工作区 bench/ 目录）
    const benchDir = resolve(wsPath, 'bench')
    mkdirSync(benchDir, { recursive: true })
    const relImages = []
    for (let i = 0; i < BENCH_IMAGE_COUNT; i += 1) {
      const rel = `bench/bench-${i}.bmp`
      writeFileSync(resolve(wsPath, rel.replace(/\//g, '\\')), makeBmp(1024, 768, 0x9e3779b9 + i * 7919))
      relImages.push(rel)
    }
    console.log(`[bench] 已写入 ${BENCH_IMAGE_COUNT} 张 1024×768 BMP（≈2.3MB/张）`)

    // 3. 清掉上次失败可能遗留的 bench 卡片，复位视口并铺卡
    await evalp(
      session,
      '(function(){ const ids = window.__huabuCanvas.state().nodes.filter(n => String(n.data.name).startsWith("bench-")).map(n => n.id); if (ids.length) window.__huabuCanvas.actions.removeNodes(ids) })()'
    )
    await evalp(session, 'window.__huabuCanvas.actions.setView({ x: 0, y: 0, scale: 1 })')
    const plantedIds = await evalp(
      session,
      `window.__huabuCanvas.bench.plant(${JSON.stringify({ images: relImages, perImage: BENCH_PER_IMAGE, gens: BENCH_GENS })})`
    )
    console.log(`[bench] 已铺 ${plantedIds.length} 张卡片（${BENCH_IMAGE_COUNT * BENCH_PER_IMAGE} 图 + ${BENCH_GENS} 生成）`)
    await sleep(1200) // 等图片解码进场

    const vp = await evalp(session, '({ w: innerWidth, h: innerHeight })')

    // 拖卡目标：视口内、离中心最近的图片卡中心（屏幕坐标）
    const nodes = (await evalp(session, 'window.__huabuCanvas.state().nodes')).filter((n) => !n.data.gen)
    const view = await evalp(session, 'window.__huabuCanvas.state().view')
    const canvasRect = await evalp(
      session,
      '(() => { const r = document.querySelector("[data-testid=\\"canvas\\"]").getBoundingClientRect(); return { l: r.left, t: r.top } })()'
    )
    let target = null
    let bestDist = Infinity
    for (const n of nodes) {
      const sx = canvasRect.l + view.x + (n.x + n.width / 2) * view.scale
      const sy = canvasRect.t + view.y + (n.y + n.height / 2) * view.scale
      if (sx < 100 || sy < 100 || sx > vp.w - 100 || sy > vp.h - 120) continue
      const d = (sx - vp.w / 2) ** 2 + (sy - vp.h / 2) ** 2
      if (d < bestDist) {
        bestDist = d
        target = { x: Math.round(sx), y: Math.round(sy) }
      }
    }
    if (!target) target = { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) }
    // 验证目标点确实压在卡片上（没命中宁可报错，不产出误导性的空报告）
    const hitNode = await evalp(
      session,
      `Boolean(document.elementFromPoint(${target.x}, ${target.y})?.closest('.canvas-node'))`
    )
    if (!hitNode) {
      throw new Error(`拖拽目标 (${target.x},${target.y}) 未命中任何 .canvas-node，请检查节点坐标计算`)
    }

    // 4. 场景（每场前都确认窗口可见：中途被遮挡的测量没有意义）
    const scenarios = []
    const runScenario = async (name, drive) => {
      if (SCENARIO !== 'all' && SCENARIO !== name) return
      await ensureWindowVisible(session)
      await evalp(session, 'window.__huabuPerf.begin()')
      await drive()
      const report = await evalp(session, `window.__huabuPerf.end(${JSON.stringify(name)})`)
      scenarios.push(report)
      console.log(
        `[bench] ${name.padEnd(10)} avg=${String(report.avgFps).padStart(5)}fps min=${String(report.minWindowFps).padStart(5)}fps ` +
          `maxGap=${String(report.maxFrameGapMs).padStart(4)}ms longtask=${report.longtaskCount}(${report.longtaskTotalMs}ms) ` +
          `renders=${JSON.stringify(report.renders)}`
      )
    }

    await runScenario('pan', () => drivePan(session, vp, DURATION_MS))
    await runScenario('zoom', () => driveZoom(session, vp, DURATION_MS))
    await runScenario('drag', () => driveDrag(session, target, DURATION_MS))
    await runScenario('stream-pan', async () => {
      await evalp(session, 'window.__huabuCanvas.bench.streamStart(20)')
      await sleep(500)
      await drivePan(session, vp, DURATION_MS)
      await evalp(session, 'window.__huabuCanvas.bench.streamStop()')
    })

    // 5. 清理：移除基准卡片、复位视口（等一拍让自动保存落盘）
    await evalp(session, `window.__huabuCanvas.actions.removeNodes(${JSON.stringify(plantedIds)})`)
    await evalp(session, 'window.__huabuCanvas.actions.setView({ x: 0, y: 0, scale: 1 })')
    await sleep(1200)

    const report = {
      label: LABEL,
      at: new Date().toISOString(),
      viewport: vp,
      durationMs: DURATION_MS,
      planted: { images: BENCH_IMAGE_COUNT * BENCH_PER_IMAGE, gens: BENCH_GENS },
      scenarios,
      notes: [
        'dev 构建含 React.StrictMode：renders 计数约为真实提交的 2 倍（前后对比仍有效）',
        '图片为真实 BMP 解码；生成卡片为 idle 态'
      ]
    }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17)
    const outPath = join(process.cwd(), 'out', `perf-report-${LABEL}-${stamp}.json`)
    mkdirSync(join(process.cwd(), 'out'), { recursive: true })
    writeFileSync(outPath, JSON.stringify(report, null, 2))
    console.log(`[bench] 报告：${outPath}`)
  } finally {
    session.close()
  }
}

main().catch((error) => {
  console.error(`[bench] 失败：${error.message}`)
  process.exitCode = 1
})
