/**
 * 视频抽帧探针（视频理解 M1 / 架构计划 T13 的机器证据）。
 *
 * 运行：pnpm probe:video-frames
 *
 * 为什么要在 electron 里跑：抽帧产物要过 nativeImage 校验"回回来的 JPEG 解得开、
 * 尺寸真被压到 VIDEO_FRAME_MAX_EDGE 内"，纯 Node 自检锁不住这一层；探针与
 * t7 同一骨架（镜像转译 src 模块 + check/assert + 结果落盘）。
 *
 * 夹具零入库：视频全部用 ffmpeg-static 自带的 ffmpeg 以 lavfi 现场生成 ——
 * testsrc2（匀速渐变，均匀采样夹具）与 testsrc2+smptehdbars concat（3s 处硬切镜，
 * 场景检测夹具），符合仓库"夹具运行时生成、不提交二进制"的惯例。
 *
 * 覆盖：ffmpeg 二进制解析（含 asar.unpacked 映射的 dev 路径） / formatMediaTime 与
 *      parseMediaTime 互逆 / mergeFrameTimes 纯函数边界 / aHash·汉明距离·
 *      selectDistinctFrames 纯函数（合成哈希） / 均匀采样（帧数、时间戳升序且在时长内、
 *      JPEG 可解回、最长边 ≤768） / 区间抽取（t1/t2/maxEdge 生效） / 静态视频感知去重 /
 *      场景切换增强（切镜边界附近必有帧） / 磁盘缓存命中（二次调用零 spawn） /
 *      缓存 LRU 逐出 / 超大文件守卫 / 损坏文件收敛为失败码不抛异常。
 *
 * 不需要任何 API Key：全程不碰网络。
 * 结果同时写到 stdout 与 out/t13-video-frames-result.json（Windows 上 electron.exe
 * 是 GUI 子系统程序，stdout 不保证被父终端捕获）。
 */
const { app, nativeImage } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 't13-probe-tmp')
const FIXTURE = path.join(PROJECT_ROOT, 'out', 't13-fixture-tmp')
const CACHE = path.join(PROJECT_ROOT, 'out', 't13-cache-tmp')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 't13-video-frames-result.json')

/** 与 src/main/media/videoFrames.ts 常量同值（探针侧独立写死才有意义） */
const VIDEO_MAX_FRAMES = 8
const VIDEO_FRAME_MAX_EDGE = 768
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024

const results = []
/** 必须 await：check 若不同步等 promise，异步分支会"空跑通过"，整份自检就废了 */
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail: typeof detail === 'string' ? detail : '' })
    console.log(`PASS ${name}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}
function flush(startedAt) {
  mkdir(path.join(PROJECT_ROOT, 'out'))
  const pass = results.filter((r) => r.pass).length
  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify({ startedAt, pass, total: results.length, verdict: pass === results.length ? 'PASS' : 'FAIL', results }, null, 2),
    'utf8'
  )
}

/** 镜像目录结构转译，保留相对 require */
function transpileToTmp(relSources) {
  fs.rmSync(TMP, { recursive: true, force: true })
  for (const rel of relSources) {
    const source = path.join(PROJECT_ROOT, rel)
    const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: source,
      reportDiagnostics: true
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    assert(errors.length === 0, `${rel} 转译失败：${errors.map((d) => d.messageText).join('; ')}`)
    const target = path.join(TMP, rel).replace(/\.ts$/, '.js')
    mkdir(path.dirname(target))
    fs.writeFileSync(target, outputText)
  }
}

const startedAt = new Date().toISOString()

void app
  .whenReady()
  .then(async () => {
    transpileToTmp([path.join('src', 'main', 'media', 'videoFrames.ts')])
    const videoFrames = require(path.join(TMP, 'src', 'main', 'media', 'videoFrames.js'))

    // ---- 夹具：全部 ffmpeg lavfi 现场生成，不做任何入库二进制 ----
    const ffmpegPath = require('ffmpeg-static')
    assert(typeof ffmpegPath === 'string' && fs.existsSync(ffmpegPath), `ffmpeg-static 二进制缺失：${ffmpegPath}`)
    const runFfmpeg = (args) => execFileSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })

    fs.rmSync(FIXTURE, { recursive: true, force: true })
    fs.rmSync(CACHE, { recursive: true, force: true })
    mkdir(FIXTURE)
    mkdir(CACHE)

    // 动态夹具：6 秒 mandelbrot（连续缩放，16x16 灰度下相邻帧 aHash 距离 ≥11，
    // 去重不会误伤；testsrc2 亮度近似静态、会被诚实去重，不能当"动态"靶子）。
    // 1280x720 是为了让默认 768px / 区间 384px 的降缩放断言真的在测"缩"。
    // mandelbrot 是无限源，用 -t 6 截断输出时长。
    const motionMp4 = path.join(FIXTURE, 'motion.mp4')
    runFfmpeg(['-f', 'lavfi', '-i', 'mandelbrot=size=1280x720:rate=10', '-t', '6', '-pix_fmt', 'yuv420p', motionMp4])
    // 场景夹具：3 秒 mandelbrot + 3 秒 SMPTE 彩条，3s 处一次硬切镜（两段分开生成再 concat）
    const mb3 = path.join(FIXTURE, 'mb3.mp4')
    const bars3 = path.join(FIXTURE, 'bars3.mp4')
    runFfmpeg(['-f', 'lavfi', '-i', 'mandelbrot=size=640x480:rate=10', '-t', '3', '-pix_fmt', 'yuv420p', mb3])
    runFfmpeg(['-f', 'lavfi', '-i', 'smptehdbars=duration=3:size=640x480:rate=10', '-pix_fmt', 'yuv420p', bars3])
    const scenesMp4 = path.join(FIXTURE, 'scenes.mp4')
    runFfmpeg(['-i', mb3, '-i', bars3, '-filter_complex', '[0:v][1:v]concat=n=2:v=1[outv]', '-map', '[outv]', '-pix_fmt', 'yuv420p', scenesMp4])
    // 静态夹具：6 秒纯色（所有帧像素级一致，感知去重的靶子）
    const staticMp4 = path.join(FIXTURE, 'static.mp4')
    runFfmpeg(['-f', 'lavfi', '-i', 'color=c=0x2a2e36:s=320x240:d=6:r=10', '-pix_fmt', 'yuv420p', staticMp4])
    // 损坏夹具 / 超大稀疏夹具
    const brokenMp4 = path.join(FIXTURE, 'broken.mp4')
    fs.writeFileSync(brokenMp4, 'fake video bytes')
    const hugeMp4 = path.join(FIXTURE, 'huge.mp4')
    const hugeFd = fs.openSync(hugeMp4, 'w')
    fs.ftruncateSync(hugeFd, MAX_VIDEO_BYTES + 1) // 稀疏文件：只有 stat 尺寸需要成立
    fs.closeSync(hugeFd)

    await check('工具契约：resolveFfmpegBinary 指到真实存在的二进制', async () => {
      const resolved = videoFrames.resolveFfmpegBinary()
      assert(typeof resolved === 'string' && fs.existsSync(resolved), `resolveFfmpegBinary=${resolved}`)
      return resolved
    })

    await check('formatMediaTime / parseMediaTime 互逆 + 容错', async () => {
      assert(videoFrames.formatMediaTime(0) === '00:00', `0s=${videoFrames.formatMediaTime(0)}`)
      assert(videoFrames.formatMediaTime(65) === '01:05', `65s=${videoFrames.formatMediaTime(65)}`)
      assert(videoFrames.formatMediaTime(3671) === '1:01:11', `3671s=${videoFrames.formatMediaTime(3671)}`)
      const p = videoFrames.parseMediaTime
      assert(p(90) === 90, 'number 秒')
      assert(p('90') === 90, '纯秒字符串')
      assert(p('01:30') === 90, 'MM:SS')
      assert(p('1:01:11') === 3671, 'H:MM:SS')
      assert(p('01:30.5') === 90.5, '小数秒')
      assert(p('') === null && p('abc') === null && p('1:2:3:4') === null, '乱格式该拒')
      assert(p('-5') === null && p('1.5:30') === null, '负数/分钟位小数该拒')
      assert(p(undefined) === null && p(null) === null && p({}) === null, '非字符串非数字该拒')
      return '三档格式 + 8 种容错'
    })

    await check('mergeFrameTimes：无场景帧 ⇒ 纯均匀满额 8 帧（间距规则不误杀均匀网格）', async () => {
      const uniform = Array.from({ length: 8 }, (_, i) => (6 * (i + 0.5)) / 8)
      const merged = videoFrames.mergeFrameTimes([], uniform, 8)
      assert(merged.sceneTimes.length === 0, '没有场景帧却报了 sceneTimes')
      assert(merged.times.length === 8, `无场景时该有满额均匀帧：${merged.times.length}`)
      // 6s/8 帧的网格间距是 0.75s —— 均匀帧之间不做 ≥1s 过滤（那是场景帧专用的去重规则）
      assert(merged.times[0] <= 0.5 && merged.times[merged.times.length - 1] >= 5.5, '首尾帧没锚住视频两端')
      return `${merged.times.length} 帧满额覆盖`
    })

    await check('mergeFrameTimes：超密场景按间距去重，预算内与均匀帧互补', async () => {
      // 8 个切镜挤在 1.4 秒内，彼此间距该折叠到只剩 1 个场景帧，再由均匀帧补满预算
      const dense = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4]
      const uniform = Array.from({ length: 8 }, (_, i) => (6 * (i + 0.5)) / 8)
      const merged = videoFrames.mergeFrameTimes(dense, uniform, 8)
      assert(merged.sceneTimes.length === 1 && merged.sceneTimes[0] === 0, `密场景该只留首个切镜：${JSON.stringify(merged.sceneTimes)}`)
      assert(merged.times.length <= 8, `超预算：${merged.times.length}`)
      assert(merged.times.includes(0), '密场景的第一个切镜点没被保留')
      const uniq = new Set(merged.times.map((t) => t.toFixed(3)))
      assert(uniq.size === merged.times.length, '合并后出现重复时间点')
      return `密 8 切镜 + 均匀网格收敛为 ${merged.times.length} 帧`
    })

    await check('aHash / 汉明距离 / selectDistinctFrames 纯函数（合成哈希直测）', async () => {
      const zero = videoFrames.computeAHash(Buffer.alloc(256, 0))
      assert(zero === '0'.repeat(64), `全零灰度哈希不对：${zero}`)
      const half = Buffer.concat([Buffer.alloc(128, 255), Buffer.alloc(128, 0)])
      assert(videoFrames.computeAHash(half) === 'f'.repeat(32) + '0'.repeat(32), '半亮半暗哈希不对')
      assert(videoFrames.aHashDistance(zero, zero) === 0, '相同哈希距离应为 0')
      assert(videoFrames.aHashDistance(zero, videoFrames.computeAHash(half)) === 128, '互补哈希距离应为 128')
      assert(!Number.isFinite(videoFrames.aHashDistance('', zero)), '空哈希该返回 Infinity（不误杀）')
      // 4 个互不相似 + 4 个与首个全同 → 剔 4 个重复；floor=4 恰好不再回填
      const a = 'f'.repeat(64)
      const b = '0'.repeat(63) + '1'
      const c = '5'.repeat(64)
      const d = 'a'.repeat(64)
      const mixed = [
        { t: 0, hash: a }, { t: 1, hash: b }, { t: 2, hash: a }, { t: 3, hash: c },
        { t: 4, hash: a }, { t: 5, hash: d }, { t: 6, hash: a }, { t: 7, hash: a }
      ]
      const sel = videoFrames.selectDistinctFrames(mixed, 8)
      assert(sel.times.length === 4, `该剔到 4 帧：${sel.times.length}`)
      assert(sel.deduped === true, '剔了帧却没标记 deduped')
      // 全同静态 → 剔到 1 后回填到 floor(=4)：稀疏但不归零
      const statics = Array.from({ length: 8 }, (_, i) => ({ t: i, hash: a }))
      const selStatic = videoFrames.selectDistinctFrames(statics, 8)
      assert(selStatic.times.length === 4, `静态该稀疏到 4：${selStatic.times.length}`)
      // 全不同 → 满额 8，deduped=false
      const distinct = [a, b, c, d, '3'.repeat(64), '6'.repeat(64), '9'.repeat(64), 'c'.repeat(64)]
      const selFull = videoFrames.selectDistinctFrames(distinct.map((h, i) => ({ t: i, hash: h })), 8)
      assert(selFull.times.length === 8 && selFull.deduped === false, '互不相似该保持满额')
      return '剔重/静态稀疏/动态满额三态全对'
    })

    const first = await videoFrames.extractVideoFrames(motionMp4, { cacheDir: CACHE })
    await check('动态夹具首次抽取 ⇒ 满额 8 帧、时长正确、cached=false、deduped=false', async () => {
      assert(first.ok === true, `抽取失败：${JSON.stringify(first)}`)
      assert(first.value.cached === false, '首次调用不该命中缓存')
      assert(Math.abs(first.value.durationSec - 6) < 0.6, `时长=${first.value.durationSec}`)
      assert(first.value.frames.length === VIDEO_MAX_FRAMES, `帧数=${first.value.frames.length}`)
      assert(first.value.deduped === false, '动态内容（testsrc2 持续运动）不该被误去重')
      return `时长 ${first.value.durationSec}s / ${first.value.frames.length} 帧`
    })

    await check('帧产物 ⇒ 全部可解回的真 JPEG，1280 源真降到 768，时间戳升序且在时长内', async () => {
      assert(first.ok === true, '前置抽取失败')
      let prev = -1
      for (const [i, frame] of first.value.frames.entries()) {
        assert(frame.mimeType === 'image/jpeg', `帧${i} mimeType=${frame.mimeType}`)
        const image = nativeImage.createFromBuffer(Buffer.from(frame.data, 'base64'))
        assert(!image.isEmpty(), `帧${i} base64 解不回图片`)
        const { width, height } = image.getSize()
        assert(Math.max(width, height) <= VIDEO_FRAME_MAX_EDGE, `帧${i} 最长边 ${Math.max(width, height)} > ${VIDEO_FRAME_MAX_EDGE}`)
        assert(Math.max(width, height) === VIDEO_FRAME_MAX_EDGE, `帧${i} 1280 源该真缩到 ${VIDEO_FRAME_MAX_EDGE}：${Math.max(width, height)}`)
        assert(frame.ptsSec > prev, `帧${i} 时间戳未升序：${frame.ptsSec} ≤ ${prev}`)
        assert(frame.ptsSec >= 0 && frame.ptsSec <= first.value.durationSec, `帧${i} 时间点越界：${frame.ptsSec}`)
        prev = frame.ptsSec
      }
      const edges = first.value.frames.map((f) => f.ptsSec.toFixed(2)).join('s, ')
      return `${first.value.frames.length} 帧 @ ${edges}s`
    })

    await check('二次调用 ⇒ 磁盘缓存命中（零 spawn，时间戳与首抽一致）', async () => {
      const second = await videoFrames.extractVideoFrames(motionMp4, { cacheDir: CACHE })
      assert(second.ok === true && second.value.cached === true, `未命中缓存：${JSON.stringify(second.ok ? second.value.cached : second.code)}`)
      assert(second.value.frames.length === first.value.frames.length, '缓存帧数与首抽不一致')
      assert(
        second.value.frames.every((f, i) => Math.abs(f.ptsSec - first.value.frames[i].ptsSec) < 1e-6),
        '缓存时间戳与首抽不一致'
      )
      return `${second.value.frames.length} 帧，manifest + JPEG 全复用`
    })

    await check('场景夹具 ⇒ sceneEnhanced，且 3s 切镜边界附近必有帧', async () => {
      const out = await videoFrames.extractVideoFrames(scenesMp4, { cacheDir: CACHE })
      assert(out.ok === true, `场景夹具抽取失败：${JSON.stringify(out.code && out.error)}`)
      assert(out.value.sceneEnhanced === true, 'concat 硬切镜没被场景扫描捕获')
      // 帧数下限对齐去重下限（4）：mandelbrot 段帧距可能压线被剔，切镜帧本身必留（对断言真正重要的）
      assert(out.value.frames.length >= 4 && out.value.frames.length <= VIDEO_MAX_FRAMES, `帧数=${out.value.frames.length}`)
      const nearCut = out.value.frames.some((f) => Math.abs(f.ptsSec - 3) <= 1)
      assert(nearCut, `切镜边界附近没有帧：${out.value.frames.map((f) => f.ptsSec).join(', ')}`)
      return `${out.value.frames.length} 帧含切镜帧 @${out.value.frames.map((f) => f.ptsSec.toFixed(1)).join('s,')}s`
    })

    await check('区间抽取 ⇒ t1/t2/maxEdge/maxFrames 全部生效，帧都落在区间内', async () => {
      const out = await videoFrames.extractVideoFrames(motionMp4, { cacheDir: CACHE, t1: 2, t2: 5, maxEdge: 384, maxFrames: 4 })
      assert(out.ok === true, `区间抽取失败：${JSON.stringify(out.ok ? out.value.frames.length : out.code)}`)
      assert(out.value.frames.length === 4, `帧数=${out.value.frames.length}`)
      assert(out.value.frames.every((f) => f.ptsSec >= 2 && f.ptsSec <= 5), `帧越出 [2,5]：${out.value.frames.map((f) => f.ptsSec).join(',')}`)
      for (const [i, f] of out.value.frames.entries()) {
        const image = nativeImage.createFromBuffer(Buffer.from(f.data, 'base64'))
        assert(!image.isEmpty(), `帧${i} 解不回`)
        const { width, height } = image.getSize()
        assert(Math.max(width, height) === 384, `帧${i} 1280 源该缩到 384：${Math.max(width, height)}`)
      }
      return `4 帧 @ ${out.value.frames.map((f) => f.ptsSec.toFixed(1)).join('s,')}s`
    })

    await check('静态视频 ⇒ 感知去重稀疏到下限（8→4），标记 deduped', async () => {
      const out = await videoFrames.extractVideoFrames(staticMp4, { cacheDir: CACHE })
      assert(out.ok === true, `静态抽取失败：${JSON.stringify(out.ok ? '' : out.code)}`)
      assert(out.value.deduped === true, '纯色视频没触发感知去重')
      assert(out.value.frames.length === 4, `该稀疏到下限 4：${out.value.frames.length}`)
      assert(out.value.frames.length >= 2, '稀疏不能归零')
      return `8 候选 → ${out.value.frames.length} 帧`
    })

    await check('缓存 LRU ⇒ 超软顶按 mtime 最旧先逐出，未超不动', async () => {
      const dir = path.join(FIXTURE, 'cache-lru')
      const mk = (name, bytes, ageHours) => {
        const d = path.join(dir, name)
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ version: 2, totalBytes: bytes, frames: [] }))
        const t = new Date(Date.now() - ageHours * 3600_000)
        fs.utimesSync(d, t, t)
      }
      mk('a', 100, 3)
      mk('b', 100, 2)
      mk('c', 100, 1)
      const r1 = videoFrames.pruneVideoFrameCache(dir, 250)
      assert(r1.evicted === 1 && !fs.existsSync(path.join(dir, 'a')), `该只逐出最旧 a：evicted=${r1.evicted}`)
      assert(fs.existsSync(path.join(dir, 'b')) && fs.existsSync(path.join(dir, 'c')), '不该动 b/c')
      const r0 = videoFrames.pruneVideoFrameCache(dir, 250)
      assert(r0.evicted === 0, `未超顶不该逐出：${r0.evicted}`)
      const r2 = videoFrames.pruneVideoFrameCache(dir, 150)
      assert(r2.evicted === 1 && !fs.existsSync(path.join(dir, 'b')), `该逐出次旧 b：evicted=${r2.evicted}`)
      assert(fs.existsSync(path.join(dir, 'c')), '最新的 c 不该被逐')
      return '两轮逐出全按 mtime 最旧先，幂等'
    })

    await check('超大视频 ⇒ 解码前拒绝（video-too-large，不起 ffmpeg）', async () => {
      const out = await videoFrames.extractVideoFrames(hugeMp4, { cacheDir: CACHE })
      assert(out.ok === false && out.code === 'video-too-large', `结果=${JSON.stringify(out.ok ? out.value.frames.length : out.code)}`)
      return '> 2GB 拦在探测之前'
    })

    await check('损坏视频 ⇒ 收敛为 probe-failed 而不是抛异常（不能炸会话）', async () => {
      const out = await videoFrames.extractVideoFrames(brokenMp4, { cacheDir: CACHE })
      assert(out.ok === false, '损坏文件居然抽取成功')
      assert(out.code === 'probe-failed', `code=${out.code}`)
      return out.code
    })

    const pass = results.filter((r) => r.pass).length
    const allPass = pass === results.length
    console.log(`\n================ probe:video-frames ${pass}/${results.length} ${allPass ? 'PASS' : 'FAIL'} ================`)
    flush(startedAt)
    fs.rmSync(TMP, { recursive: true, force: true })
    fs.rmSync(FIXTURE, { recursive: true, force: true })
    fs.rmSync(CACHE, { recursive: true, force: true })
    app.exit(allPass ? 0 : 2)
  })
  .catch((error) => {
    console.log(`ERROR ${error && error.stack ? error.stack : error}`)
    results.push({ name: '夹具/运行', pass: false, detail: String(error && error.stack ? error.stack : error) })
    flush(startedAt)
    app.exit(3)
  })
