import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { readFile, readdir, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 视频文件 → Agent 可消费的关键帧序列（视频理解 M1/M2，T13 抽帧探针覆盖）。
 *
 * 设计约束（都有出处，不是偏好）：
 *
 * 1. **零 electron 依赖**：只用 child_process/fs/crypto，和 artifactImage 一样可被
 *    `pnpm probe:video-frames` 镜像转译后在纯 Node 语境跑（探针另用 nativeImage 校验产物）。
 * 2. **失败走返回值不走异常**：read_media / skim_video / read_video_frames 的 execute 里
 *    不能抛 —— 抽帧挂在会话工具链上，一次解码事故不能炸掉整个会话。
 * 3. **帧预算 8 不是拍脑袋**：每帧 base64 都会成为独立的 HistoryImageSlot（history.ts），
 *    回放缩略上限 HISTORY_IMAGE_LIMIT=24；且多帧必然把 toolResult 那行 JSONL 推过
 *    SESSION_LINE_LIMIT=512KB（host.ts 软顶后整行会被跳过）。8 帧 @768px 是两道闸的折中。
 *    帧字节总量另有一道 VIDEO_FRAMES_TOTAL_BUDGET 闸（两遍法降档 + 尾部丢帧）：
 *    8 帧 @768px JPEG q4 的 base64 总量通常 0.6-1.6MB，会顶穿单行软顶，会话文件
 *    超 24MB 后这些行被整行跳过时连文本元数据一起丢，必须在抽帧层管住。
 * 4. **定点 seek 而不是全片解码**：每帧一次 `-ss <t> -i -frames:v 1`（关键帧定位 + 少量
 *    前向解码），长视频不会比短视频慢多少；场景切换扫描是唯一全解操作，仅 ≤120s 整段抽取做。
 * 5. **感知去重用 ffmpeg 自己当解码器（M2）**：16x16 灰度 rawvideo 走 stdout 管道回来算
 *    aHash，不引图像解码库；静态视频自动稀疏到下限（TimeChat-Online 的量化结论：
 *    流式视频 ~80% 视觉 token 天然冗余），动态视频保持满额覆盖。
 */

/** read_media 默认帧预算（决策依据见头注 3；探针断言用） */
export const VIDEO_MAX_FRAMES = 8

/** read_media 默认帧最长边：视频帧是"看懂内容"不是"看清细节"，768 比 1024 省 ~40% token */
export const VIDEO_FRAME_MAX_EDGE = 768

/**
 * 单次抽取的帧 JPEG 字节总量预算（base64 编码前的原始字节）：会话 JSONL 的单行软顶
 * SESSION_LINE_LIMIT=512KB（host.ts）× base64 膨胀 3/4 ≈ 384KB —— 整条 toolResult
 * 的全部帧 base64 要压回单行上限内，否则会话文件超 24MB 后回放整行跳过（见头注 3）。
 */
export const VIDEO_FRAMES_TOTAL_BUDGET = 384 * 1024

/** 送进 ffmpeg 前的源文件闸门：>2GB 的视频定点 seek 也没救，直接拒 */
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024

/** 超过此时长不做场景切换扫描（那是唯一的全片解码操作） */
const SCENE_SCAN_MAX_DURATION_SEC = 120

/** 场景切换阈值：ffmpeg scene 滤镜的 0-1 分数，0.4 是"明显切镜"的经验值 */
const SCENE_THRESHOLD = 0.4

/** 场景帧最多占预算一半：切镜再多也要给均匀采样留全覆盖的余地 */
const SCENE_FRAME_QUOTA_DIVISOR = 2

/** 合并去重的最小间距：两个时间点靠得比这近就只留一个（只管场景帧 vs 其它帧） */
const MERGE_MIN_GAP_SEC = 1

/** 去重哈希的采样边长：16x16 灰度 = 256 bit aHash */
const AHASH_SIZE = 16

/** aHash 汉明距离 ≤ 此值视为近重复帧。8/256 bit ≈ 3%：实测校准（1280x720 夹具）——
 *  纯色视频帧间距离恒为 0（必剔），mandelbrot 连续缩放相邻帧最小 11（必留），
 *  testsrc2 亮度近似静态（0-7，会被剔——它本来就该剔）。动态夹具必须选亮度真变的源。 */
const AHASH_DUP_DISTANCE = 8

/** 去重后帧数下限：静态视频稀疏到 maxFrames/2 就停，绝不能稀疏到"没帧可看" */
const DEDUP_MIN_KEEP_DIVISOR = 2

/** 帧缓存目录总量的软顶：超出按最旧先逐出（每视频 ~0.5-1MB，512MB ≈ 数百个视频） */
export const VIDEO_CACHE_MAX_BYTES = 512 * 1024 * 1024

const FRAME_SPAWN_TIMEOUT_MS = 20_000
const EXTRACTION_BUDGET_MS = 60_000

/** 缓存清单版本：抽取算法变了要旧缓存失效，递增它。v3：新增帧体积预算两遍法（降档/丢帧） */
const CACHE_VERSION = 3

export interface VideoFrame {
  data: string
  mimeType: 'image/jpeg'
  /** 帧在源视频里的时间点（秒），回答引用 MM:SS 的依据 */
  ptsSec: number
}

export interface VideoFrameSet {
  frames: VideoFrame[]
  durationSec: number
  /** 本次是否命中磁盘缓存（命中则一次 ffmpeg 都没起） */
  cached: boolean
  /** 帧集合是否包含场景切换帧（false = 纯均匀采样） */
  sceneEnhanced: boolean
  /** 感知去重是否真的剔掉了重复帧（true = 静态/低动态内容被稀疏） */
  deduped: boolean
}

export type VideoFrameFailure = 'video-too-large' | 'probe-failed' | 'extract-failed' | 'timeout' | 'bad-range'
export type VideoFrameResult =
  | { ok: true; value: VideoFrameSet }
  | { ok: false; code: VideoFrameFailure; error: string }

export interface ExtractVideoFramesOptions {
  cacheDir?: string | null
  /** 区间抽取起点（秒）：缺省 0（整段） */
  t1?: number
  /** 区间抽取终点（秒）：缺省视频末尾 */
  t2?: number
  /** 帧最长边（px），默认 VIDEO_FRAME_MAX_EDGE */
  maxEdge?: number
  /** 帧数预算，默认 VIDEO_MAX_FRAMES */
  maxFrames?: number
  /**
   * 帧字节总量预算（JPEG 原始字节，base64 前）：第一遍抽完若超预算，按面积比例降
   * maxEdge 重抽一遍，仍超则从尾部丢帧（保底 ≥2 帧）。缺省 VIDEO_FRAMES_TOTAL_BUDGET。
   */
  maxTotalBytes?: number
}

/** 惰性取 ffmpeg-static 的二进制路径（CJS 字符串导出）。顶层 import 会让"包缺失"变成整个主进程的启动崩溃，这里收敛成 null */
function loadFfmpegStaticPath(): string | null {
  try {
    // 运行态是 CJS（electron-vite main 输出 / 探针 transpileModule），require 可直接用；
    // mod?.default 兜底模块被 interop 包了一层的情况
    const mod = require('ffmpeg-static') as string | { default?: string } | null
    if (typeof mod === 'string') return mod
    return typeof mod?.default === 'string' ? mod.default : null
  } catch {
    return null
  }
}

/** ffmpeg-static 导出的二进制路径，打包态映射到 asar.unpacked */
export function resolveFfmpegBinary(): string | null {
  const raw = loadFfmpegStaticPath()
  if (!raw) return null
  // 打包后 index.js 仍在 asar 里可 require，但它拼出的二进制路径落在 asar 内 ——
  // 子进程无法执行 asar 里的文件；electron-builder asarUnpack 的落点就是下面这行映射
  if (raw.includes('app.asar')) {
    const unpacked = raw.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    if (unpacked !== raw && existsSync(unpacked)) return unpacked
  }
  return existsSync(raw) ? raw : null
}

/** 秒 → MM:SS（≥1h 用 H:MM:SS）：给模型与用户共用的可引用时间点格式 */
export function formatMediaTime(sec: number): string {
  const total = Math.max(0, Math.round(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * 模型/用户给的时间点 → 秒。接受 number、纯秒数字符串（"90"）、"MM:SS"、"H:MM:SS"，
 * 允许小数秒。read_video_frames 的入参解析用（我们要求模型用 MM:SS 引用，就得收得起这个格式）。
 */
export function parseMediaTime(input: unknown): number | null {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return input
  if (typeof input !== 'string') return null
  const parts = input.trim().split(':')
  if (!parts[0] || parts.length > 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  for (let i = 0; i < nums.length - 1; i++) {
    if (!Number.isInteger(nums[i])) return null // 小数只允许出现在最后一段（秒）
  }
  const [a = 0, b = 0, c = 0] = nums
  if (parts.length === 1) return a
  if (parts.length === 2) return a * 60 + b
  return a * 3600 + b * 60 + c
}

interface FfmpegRun {
  code: number
  stderr: string
  stdout: Buffer
  timedOut: boolean
}

function runFfmpeg(ffmpegPath: string, args: string[], timeoutMs: number): Promise<FfmpegRun> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let timedOut = false
    // showinfo 对长视频能刷出 MB 级 stderr；stdout 是 rawvideo/无输出。各留尾部即可
    const drainStderr = (chunk: Buffer | string) => {
      stderr += String(chunk)
      if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024)
    }
    const drainStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= 1024 * 1024) stdoutChunks.push(chunk)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stderr.on('data', drainStderr)
    child.stdout.on('data', drainStdout)
    child.on('error', (error) => {
      clearTimeout(timer)
      drainStderr(`\n${String(error)}`)
      resolve({ code: -1, stderr, stdout: Buffer.concat(stdoutChunks), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stderr, stdout: Buffer.concat(stdoutChunks), timedOut })
    })
  })
}

/** 用 `ffmpeg -i`（无输出，退出码非 0 属预期）从 stderr 探时长，不为此引 ffprobe */
async function probeDurationSec(ffmpegPath: string, absPath: string): Promise<number | null> {
  // 必须走异步 runFfmpeg：同步 exec（execFileSync）会冻结主进程事件循环，所有 IPC/UI
  // 停摆最长 20s；异步化后调用方只是串行 await，事件循环不被阻塞
  const run = await runFfmpeg(ffmpegPath, ['-hide_banner', '-i', absPath], FRAME_SPAWN_TIMEOUT_MS)
  const m = run.stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/)
  if (!m) return null
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(sec) && sec > 0 ? sec : null
}

/** 均匀采样取"区间中点"而不是端点：t=0 常是黑场，t=duration 会 seek 到文件尾 */
function uniformMidpoints(startSec: number, endSec: number, count: number): number[] {
  const span = endSec - startSec
  return Array.from({ length: count }, (_, i) => startSec + (span * (i + 0.5)) / count)
}

/**
 * 场景切换扫描：全片过一遍 scene 滤镜（唯一的全解操作），从 showinfo 的 stderr 收 pts_time。
 * 任何失败都静默降级 —— 场景帧是增强项，不该连累均匀采样。
 */
async function scanSceneTimes(ffmpegPath: string, absPath: string, durationSec: number): Promise<number[]> {
  const run = await runFfmpeg(
    ffmpegPath,
    ['-hide_banner', '-i', absPath, '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, '-f', 'null', '-'],
    Math.max(FRAME_SPAWN_TIMEOUT_MS, durationSec * 1000)
  )
  if (run.timedOut || run.code !== 0) return []
  const times: number[] = []
  for (const m of run.stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) {
    const t = Number(m[1])
    if (Number.isFinite(t) && t >= 0 && t <= durationSec) times.push(t)
  }
  return times.sort((a, b) => a - b)
}

export interface MergedFrameTimes {
  /** 合并后的时间点（升序，≤budget） */
  times: number[]
  /** 其中来自场景切换检测的时间点（在 times 的语境里，供选帧优先级用） */
  sceneTimes: number[]
}

/**
 * 场景帧 + 均匀帧合并。间距规则只管"场景帧 vs 其它帧"（切镜点常落在均匀网格附近，
 * 留两份是浪费）；均匀帧之间不做间距过滤 —— 短视频的网格间距天然是 span/候选数，
 * 再过滤就会把满额覆盖误杀成一半（t13 探针抓到过这个 bug）。场景帧挤占预算时，
 * 均匀帧改为等距取整补位，保覆盖率。
 */
export function mergeFrameTimes(
  sceneTimes: number[],
  uniformTimes: number[],
  budget: number
): MergedFrameTimes {
  const sceneQuota = Math.max(1, Math.floor(budget / SCENE_FRAME_QUOTA_DIVISOR))
  const sceneKept: number[] = []
  for (const t of sceneTimes.slice(0, sceneQuota)) {
    if (sceneKept.every((k) => Math.abs(k - t) >= MERGE_MIN_GAP_SEC)) sceneKept.push(t)
  }
  if (sceneKept.length === 0) {
    return { times: [...uniformTimes].sort((a, b) => a - b).slice(0, budget), sceneTimes: [] }
  }
  const candidates = uniformTimes.filter((u) => sceneKept.every((k) => Math.abs(u - k) >= MERGE_MIN_GAP_SEC))
  const slots = Math.max(0, budget - sceneKept.length)
  const uniformSelected: number[] = []
  if (slots > 0 && candidates.length > 0) {
    if (candidates.length <= slots) {
      uniformSelected.push(...candidates)
    } else {
      // 等距取整：从候选里按索引均分取样，两头必中，覆盖不失锚点
      for (let i = 0; i < slots; i++) {
        uniformSelected.push(candidates[Math.round((i * (candidates.length - 1)) / (slots - 1))])
      }
    }
  }
  return {
    times: [...sceneKept, ...uniformSelected].sort((a, b) => a - b).slice(0, budget),
    sceneTimes: sceneKept
  }
}

/** 16x16 灰度 → 256 bit aHash 的十六进制串（64 字符）。像素 > 均值记 1。 */
export function computeAHash(gray: Buffer): string {
  if (gray.length < AHASH_SIZE * AHASH_SIZE) return ''
  let sum = 0
  for (let i = 0; i < AHASH_SIZE * AHASH_SIZE; i++) sum += gray[i]
  const mean = sum / (AHASH_SIZE * AHASH_SIZE)
  let hex = ''
  for (let i = 0; i < AHASH_SIZE * AHASH_SIZE; i += 4) {
    let nibble = 0
    for (let b = 0; b < 4; b++) if (gray[i + b] > mean) nibble |= 1 << b
    hex += nibble.toString(16)
  }
  return hex
}

/** 两个 aHash 的汉明距离（长度不等或空 → Infinity，视为"不相似"，别误杀） */
export function aHashDistance(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1)
  }
  return dist
}

export interface HashedCandidate {
  t: number
  hash: string
}

/**
 * 感知去重选帧（纯函数，t13 用合成哈希直测）：按时间序保留非重复帧；
 * 与已保留帧距离 ≤ AHASH_DUP_DISTANCE 的剔除，剔除后不足下限（maxFrames/2，至少 2）
 * 时按原顺序回填 —— 静态视频稀疏到下限即停，动态视频保持满额。
 */
export function selectDistinctFrames(candidates: HashedCandidate[], maxFrames: number): { times: number[]; deduped: boolean } {
  const floor = Math.max(2, Math.floor(maxFrames / DEDUP_MIN_KEEP_DIVISOR))
  const kept: HashedCandidate[] = []
  const dropped: HashedCandidate[] = []
  for (const c of candidates) {
    if (kept.some((k) => aHashDistance(k.hash, c.hash) <= AHASH_DUP_DISTANCE)) dropped.push(c)
    else kept.push(c)
  }
  while (kept.length < floor && dropped.length > 0) {
    kept.push(dropped.shift()!)
  }
  const times = kept.slice(0, maxFrames).map((k) => k.t).sort((a, b) => a - b)
  return { times, deduped: dropped.length > 0 && kept.length < candidates.length }
}

/** 抽一帧 16x16 灰度 rawvideo（走 stdout 管道），算 aHash；失败返回空串交由后续兜底 */
async function hashFrame(ffmpegPath: string, absPath: string, t: number): Promise<string> {
  const run = await runFfmpeg(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', absPath, '-frames:v', '1',
      '-vf', `scale=${AHASH_SIZE}:${AHASH_SIZE}`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    FRAME_SPAWN_TIMEOUT_MS
  )
  if (run.timedOut || run.code !== 0 || run.stdout.length < AHASH_SIZE * AHASH_SIZE) return ''
  return computeAHash(run.stdout.subarray(0, AHASH_SIZE * AHASH_SIZE))
}

interface CacheManifest {
  version: number
  durationSec: number
  sceneEnhanced: boolean
  deduped: boolean
  /** 本份缓存的磁盘字节数（JPEG 之和），LRU 清理的记账依据 */
  totalBytes: number
  frames: Array<{ file: string; ptsSec: number }>
}

function cacheKey(absPath: string, stat: { mtimeMs: number; size: number }, opts: ExtractVideoFramesOptions): string {
  // 源文件身份（路径+mtime+大小）× 抽取参数（版本+区间+边长+帧数+体积预算）变了，缓存必须失效
  return createHash('sha1')
    .update(
      `${CACHE_VERSION}:${opts.t1 ?? 0}:${opts.t2 ?? 'end'}:${opts.maxEdge ?? VIDEO_FRAME_MAX_EDGE}:${opts.maxFrames ?? VIDEO_MAX_FRAMES}:${opts.maxTotalBytes ?? VIDEO_FRAMES_TOTAL_BUDGET}:${absPath}:${stat.mtimeMs}:${stat.size}`
    )
    .digest('hex')
}

function readCache(cacheDir: string, key: string): VideoFrameSet | null {
  const dir = join(cacheDir, key)
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  let manifest: CacheManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CacheManifest
  } catch {
    return null
  }
  if (manifest.version !== CACHE_VERSION || !Array.isArray(manifest.frames) || manifest.frames.length === 0) return null
  const frames: VideoFrame[] = []
  for (const f of manifest.frames) {
    const p = join(dir, f.file)
    if (!existsSync(p)) return null // 缺一张就当整份失效，宁可重抽
    frames.push({ data: readFileSync(p).toString('base64'), mimeType: 'image/jpeg', ptsSec: f.ptsSec })
  }
  return { frames, durationSec: manifest.durationSec, cached: true, sceneEnhanced: manifest.sceneEnhanced, deduped: manifest.deduped }
}

/**
 * 帧缓存 LRU：总量超软顶时按目录 mtime 最旧先逐出。靠 manifest.totalBytes 记账，
 * 不做递归 du（大目录逐帧 stat 是 O(帧数) 的文件系统往返，记账一次写清更省）。
 * 全程 fs/promises：清理跑在主进程里，同步 IO 会冻结事件循环（同 probeDurationSec）。
 * 清理失败静默 —— 缓存膨胀只是磁盘问题，不该影响抽帧结果。
 */
export async function pruneVideoFrameCache(cacheDir: string, maxBytes: number = VIDEO_CACHE_MAX_BYTES): Promise<{ evicted: number }> {
  let entries: Array<{ dir: string; mtimeMs: number; bytes: number }>
  try {
    entries = await Promise.all(
      (await readdir(cacheDir))
        .filter((name) => !name.endsWith('.tmp'))
        .map(async (name) => {
          const dir = join(cacheDir, name)
          let bytes = 0
          try {
            const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as CacheManifest
            bytes = manifest.totalBytes ?? 0
          } catch {
            bytes = 0
          }
          return { dir, mtimeMs: (await stat(dir)).mtimeMs, bytes }
        })
    )
  } catch {
    return { evicted: 0 }
  }
  let total = entries.reduce((acc, e) => acc + e.bytes, 0)
  if (total <= maxBytes) return { evicted: 0 }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let evicted = 0
  try {
    for (const e of entries) {
      if (total <= maxBytes) break
      await rm(e.dir, { recursive: true, force: true })
      total -= e.bytes
      evicted += 1
    }
  } catch {
    // 逐出中途失败：返回已逐出数，不抛 —— 缓存问题不连累抽帧主链路
  }
  return { evicted }
}

/**
 * 抽取关键帧主入口：均匀采样为底、场景切换增强（≤120s 整段）、aHash 感知去重、
 * `.huabu/vframes/` 磁盘缓存 + LRU 清理。所有失败都收敛成 `{ ok:false, code }`，不抛异常。
 */
export async function extractVideoFrames(absPath: string, opts: ExtractVideoFramesOptions = {}): Promise<VideoFrameResult> {
  const ffmpegPath = resolveFfmpegBinary()
  if (!ffmpegPath) return { ok: false, code: 'probe-failed', error: '内置 ffmpeg 二进制缺失（ffmpeg-static 未安装或打包缺失）' }

  const maxEdge = Math.min(1024, Math.max(64, Math.round(opts.maxEdge ?? VIDEO_FRAME_MAX_EDGE)))
  const maxFrames = Math.min(24, Math.max(1, Math.round(opts.maxFrames ?? VIDEO_MAX_FRAMES)))
  const maxTotalBytes = Math.max(1, Math.round(opts.maxTotalBytes ?? VIDEO_FRAMES_TOTAL_BUDGET))

  let stat: { mtimeMs: number; size: number }
  try {
    stat = statSync(absPath)
  } catch (error) {
    return { ok: false, code: 'probe-failed', error: String(error) }
  }
  if (stat.size > MAX_VIDEO_BYTES) {
    return { ok: false, code: 'video-too-large', error: `视频 ${stat.size}B 超过 ${MAX_VIDEO_BYTES}B 上限` }
  }

  const key = cacheKey(absPath, stat, opts)
  if (opts.cacheDir) {
    const hit = readCache(opts.cacheDir, key)
    if (hit) return { ok: true, value: hit }
  }

  const durationSec = await probeDurationSec(ffmpegPath, absPath)
  if (durationSec === null) {
    return { ok: false, code: 'probe-failed', error: 'ffmpeg 无法读取该视频的时长（格式不支持或文件损坏）' }
  }

  const rangeStart = Math.min(Math.max(opts.t1 ?? 0, 0), durationSec)
  const rangeEnd = Math.min(Math.max(opts.t2 ?? durationSec, rangeStart + 0.05), durationSec)
  if (rangeEnd - rangeStart < 0.1) {
    return { ok: false, code: 'bad-range', error: `抽取区间过短：[${rangeStart.toFixed(2)}, ${rangeEnd.toFixed(2)}]s` }
  }
  const wholeVideo = rangeStart <= 0.01 && rangeEnd >= durationSec - 0.01

  // 候选 = 均匀网格（预算翻倍，给去重留替换余量）+ 场景帧（仅整段短视频做全解扫描）
  const candidateBudget = Math.min(24, maxFrames * 2)
  const uniform = uniformMidpoints(rangeStart, rangeEnd, candidateBudget)
  let sceneTimes: number[] = []
  if (wholeVideo && durationSec <= SCENE_SCAN_MAX_DURATION_SEC) {
    sceneTimes = await scanSceneTimes(ffmpegPath, absPath, durationSec)
  }
  const merged = mergeFrameTimes(sceneTimes, uniform, candidateBudget)

  // 候选多而预算少时先按时间等距收紧到 maxFrames 个，再对它们做哈希去重。
  // 场景帧必进候选（跨步取样会把它跳掉——那正是场景检测要保的东西），只跨均匀部分。
  let candidates = merged.times
  if (candidates.length > maxFrames) {
    const sceneSet = new Set(merged.sceneTimes)
    const rest = candidates.filter((t) => !sceneSet.has(t))
    const slots = Math.max(0, maxFrames - merged.sceneTimes.length)
    const strided: number[] = []
    if (slots > 0 && rest.length > 0) {
      if (rest.length <= slots) {
        strided.push(...rest)
      } else {
        for (let i = 0; i < slots; i++) {
          strided.push(rest[Math.round((i * (rest.length - 1)) / (slots - 1))])
        }
      }
    }
    candidates = [...new Set([...merged.sceneTimes, ...strided])].sort((a, b) => a - b)
  }

  const deadline = Date.now() + EXTRACTION_BUDGET_MS
  const hashed: HashedCandidate[] = []
  for (const t of candidates) {
    if (Date.now() > deadline - 10_000) break // 哈希与抽帧共享总预算，给收尾留足余量
    const hash = await hashFrame(ffmpegPath, absPath, t)
    if (hash) hashed.push({ t, hash })
  }
  // 哈希全军覆没（超时/异常）时退回不做去重的候选集 —— 去重是优化项，不是闸门
  const selection = hashed.length >= Math.min(2, candidates.length)
    ? selectDistinctFrames(hashed, maxFrames)
    : { times: candidates.slice(0, maxFrames), deduped: false }
  if (selection.times.length === 0) return { ok: false, code: 'extract-failed', error: '没有可抽时间点' }

  // 抽进临时目录、成功后原子改名进缓存位；没有缓存目录（如探针）就落系统临时目录，
  // 结果只走内存，临时目录用完即删
  const baseDir = opts.cacheDir ?? join(tmpdir(), 'huabu-vframes')
  const workDir = join(baseDir, `${key}.tmp`)
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })

  // 单遍抽取：同一批时间点（selection.times，两遍法之间完全不变）用给定最长边抽 JPEG。
  // 帧必须先读进内存再做缓存提交 —— rename 会把 workDir 挪走，之后再读就找不到了。
  const extractPass = async (
    edge: number
  ): Promise<{ extracted: Array<{ file: string; ptsSec: number }>; frames: VideoFrame[]; totalBytes: number }> => {
    const passExtracted: Array<{ file: string; ptsSec: number }> = []
    for (const t of selection.times) {
      if (Date.now() > deadline - 5_000) break // 留 5s 给收尾，别在最后一帧上超时
      const file = `frame_${String(passExtracted.length).padStart(2, '0')}.jpg`
      const outPath = join(workDir, file)
      const run = await runFfmpeg(
        ffmpegPath,
        [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-ss', t.toFixed(3),
          '-i', absPath,
          '-frames:v', '1',
          // 长边 ≤edge 等比缩放：w/h 框住取小、保持宽高比、强制偶数（部分编码器要求）
          '-vf', `scale=w=${edge}:h=${edge}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
          '-q:v', '4',
          outPath
        ],
        FRAME_SPAWN_TIMEOUT_MS
      )
      if (run.timedOut) break
      if (run.code === 0 && existsSync(outPath) && statSync(outPath).size > 0) {
        passExtracted.push({ file, ptsSec: t })
      }
      // 单帧失败（seek 落在坏区/流尾）跳过继续：只要凑够 ≥2 帧结果就可用
    }
    let passTotalBytes = 0
    const passFrames: VideoFrame[] = passExtracted.map((f) => {
      const buf = readFileSync(join(workDir, f.file))
      passTotalBytes += buf.length
      return { data: buf.toString('base64'), mimeType: 'image/jpeg', ptsSec: f.ptsSec }
    })
    return { extracted: passExtracted, frames: passFrames, totalBytes: passTotalBytes }
  }

  let chosen = await extractPass(maxEdge)

  if (chosen.extracted.length < 2) {
    const timedOutOverall = Date.now() >= deadline
    rmSync(workDir, { recursive: true, force: true })
    return {
      ok: false,
      code: timedOutOverall ? 'timeout' : 'extract-failed',
      error: `只抽到 ${chosen.extracted.length} 帧（目标 ${selection.times.length}），视频可能损坏或编码不受支持`
    }
  }

  // 两遍法体积预算：第一遍超预算且还有降档空间时，按 sqrt(预算/实际总量) 缩最长边重抽一遍
  //（JPEG 字节 ∝ 像素数，像素 ∝ 边长²，sqrt 一步到位）；时间点选择逻辑完全不变，只是 JPEG 更小。
  // 降不出更小的边（maxEdge 已 ≤256）就不白跑第二遍，直接走尾部丢帧。
  if (chosen.totalBytes > maxTotalBytes) {
    const scale = Math.sqrt(maxTotalBytes / chosen.totalBytes)
    const reducedEdge = Math.max(256, Math.floor(maxEdge * scale))
    if (reducedEdge < maxEdge) {
      const second = await extractPass(reducedEdge)
      if (second.extracted.length >= 2) chosen = second // 二遍撞上 deadline 只抽出 <2 帧时保第一遍
    }
  }

  // 二遍后仍超预算：从尾部丢帧（丢的是最晚的时间点），保底 ≥2 帧 —— 行上限优先于满额覆盖
  while (chosen.frames.length > 2 && chosen.totalBytes > maxTotalBytes) {
    const last = chosen.frames.pop()!
    chosen.extracted.pop()
    chosen.totalBytes -= Buffer.byteLength(last.data, 'base64')
  }

  if (opts.cacheDir) {
    const finalDir = join(opts.cacheDir, key)
    try {
      const manifest: CacheManifest = {
        version: CACHE_VERSION,
        durationSec,
        sceneEnhanced: merged.sceneTimes.length > 0,
        deduped: selection.deduped,
        totalBytes: chosen.totalBytes,
        frames: chosen.extracted
      }
      writeFileSync(join(workDir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
      rmSync(finalDir, { recursive: true, force: true })
      renameSync(workDir, finalDir)
    } catch {
      rmSync(workDir, { recursive: true, force: true }) // 缓存写失败不影响本次结果
    }
    await pruneVideoFrameCache(opts.cacheDir) // 记账后再清理，超软顶逐出最旧
  } else {
    rmSync(workDir, { recursive: true, force: true })
  }

  return {
    ok: true,
    value: {
      frames: chosen.frames,
      durationSec,
      cached: false,
      sceneEnhanced: merged.sceneTimes.length > 0,
      deduped: selection.deduped
    }
  }
}
