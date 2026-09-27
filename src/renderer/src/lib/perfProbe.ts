/**
 * DEV-only 性能探针（性能优化方案阶段 0）。
 *
 * 挂载 window.__huabuPerf，提供：
 * - begin()/end(label)：圈定一个测量窗口，返回 FPS / 最大帧间隙 / longtask / 渲染计数增量；
 * - snapshot()：全量计数（不圈窗口）。
 *
 * 组件渲染计数通过 bumpRender(key) 自增（生产构建下是空操作，调用点无需条件包裹）。
 * 采集方式刻意全部基于浏览器原生能力（rAF 时间戳 + PerformanceObserver），
 * 这样 bench 脚本（scripts/perf-bench.mjs）只需 evaluate 两个调用就能拿到完整报告。
 */

const DEV = import.meta.env.DEV

let installed = false

interface LongtaskRecord {
  /** 相对探针安装时刻的 ms */
  at: number
  duration: number
}

const state = {
  /** 测量窗口内的 rAF 时间戳；仅在 begin()..end() 之间收集 */
  frameTimes: [] as number[],
  collecting: false,
  longtasks: [] as LongtaskRecord[],
  renders: {} as Record<string, number>,
}

/** 圈窗口时的基线（end 用它算增量） */
let baseline: { frames: number; renders: Record<string, number>; longtaskIndex: number; at: number } | null = null

export interface PerfWindowReport {
  label: string
  durationMs: number
  frames: number
  avgFps: number
  /** 500ms 窗口 FPS 的最小值（掉帧比平均值敏感得多） */
  minWindowFps: number
  /** 相邻 rAF 的最大间隙：一次 >100ms 的卡顿在这里无处遁形 */
  maxFrameGapMs: number
  longtaskCount: number
  longtaskTotalMs: number
  longtasks: LongtaskRecord[]
  renders: Record<string, number>
}

function begin(): boolean {
  if (baseline) return false
  state.frameTimes = []
  baseline = {
    frames: 0,
    renders: { ...state.renders },
    longtaskIndex: state.longtasks.length,
    at: performance.now()
  }
  state.collecting = true
  return true
}

function end(label: string): PerfWindowReport | null {
  if (!baseline) return null
  state.collecting = false
  const now = performance.now()
  const durationMs = now - baseline.at
  const times = state.frameTimes.slice()
  const frames = times.length
  const avgFps = durationMs > 0 ? (frames * 1000) / durationMs : 0

  // 500ms 窗口 FPS
  const windowFps: number[] = []
  let winStart = 0
  for (let i = 1; i <= times.length; i += 1) {
    const atWindowEnd = i === times.length || times[i] - times[winStart] >= 500
    if (atWindowEnd) {
      const span = times[i - 1] - times[winStart]
      if (span > 0) windowFps.push(((i - winStart) * 1000) / span)
      winStart = i
    }
  }

  let maxFrameGapMs = 0
  for (let i = 1; i < times.length; i += 1) {
    const gap = times[i] - times[i - 1]
    if (gap > maxFrameGapMs) maxFrameGapMs = gap
  }

  const longtasks = state.longtasks.slice(baseline.longtaskIndex)
  const renderDelta: Record<string, number> = {}
  for (const [key, value] of Object.entries(state.renders)) {
    const delta = value - (baseline.renders[key] ?? 0)
    if (delta > 0) renderDelta[key] = delta
  }

  const report: PerfWindowReport = {
    label,
    durationMs: Math.round(durationMs),
    frames,
    avgFps: Math.round(avgFps * 10) / 10,
    minWindowFps: windowFps.length > 0 ? Math.round(Math.min(...windowFps) * 10) / 10 : 0,
    maxFrameGapMs: Math.round(maxFrameGapMs),
    longtaskCount: longtasks.length,
    longtaskTotalMs: Math.round(longtasks.reduce((sum, t) => sum + t.duration, 0)),
    longtasks,
    renders: renderDelta
  }
  baseline = null
  state.frameTimes = []
  return report
}

function snapshot() {
  return { renders: { ...state.renders }, longtaskCount: state.longtasks.length }
}

/** 组件渲染计数：dev 下自增，生产构建为空操作 */
export function bumpRender(key: string): void {
  if (!DEV || !installed) return
  state.renders[key] = (state.renders[key] ?? 0) + 1
}

/** 幂等安装；main.tsx 在 React 挂载前调用一次（内部含 DEV 守卫） */
export function installPerfProbe(): void {
  if (!DEV || installed) return
  installed = true

  const t0 = performance.now()
  const frame = () => {
    if (state.collecting) state.frameTimes.push(performance.now())
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      state.longtasks.push({ at: Math.round(entry.startTime - t0), duration: Math.round(entry.duration) })
    }
  })
  observer.observe({ entryTypes: ['longtask'] })

  ;(window as unknown as Record<string, unknown>)['__huabuPerf'] = { begin, end, snapshot }
}
