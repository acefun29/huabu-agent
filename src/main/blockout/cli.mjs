#!/usr/bin/env node
/**
 * blockout MVP 引擎 CLI
 *
 * 用法：
 *   node cli.mjs describe --scene <author.json> [--set k=v ...] [--out file.json]
 *   node cli.mjs resolve  --scene <author.json> [--out resolved.json]
 *   node cli.mjs collide  --scene <author.json> [--set k=v ...]
 *   node cli.mjs check    --scene <author.json> [--set k=v ...]      # describe + collide
 *   node cli.mjs render   --scene <author.json> --camera <name> --out shot.png
 *                         [--width 800 --height 600 --ssaa 2] [--set k=v ...]
 *   node cli.mjs selftest                                             # 跑黄金夹具
 *
 * 退出码：0 正常；1 用法/IO；2 解算有 error；3 碰撞有 error
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveScene, describe, collideAll } from './resolve.mjs'
import { renderScene } from './render.mjs'
import { autoViews } from './views.mjs'
import { renderSheet, renderFrameSheet } from './sheet.mjs'
import { resolveShot, checkContinuity } from './motion.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = { _: [], set: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--set') {
      out.set.push(argv[i + 1])
      i += 1
      continue
    }
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const nxt = argv[i + 1]
      if (nxt === undefined || nxt.startsWith('--')) out[k] = true
      else {
        out[k] = nxt
        i += 1
      }
    } else out._.push(a)
  }
  return out
}

/** 镜头 id 列表：跳过 `_` 开头的注释键（author 文件里允许写 _comment 之类的说明） */
const shotIds = (author) => Object.keys(author.shots ?? {}).filter((k) => !k.startsWith('_'))

const round6 = (v) => Math.round(v * 1e6) / 1e6

/** 找 ffmpeg：环境变量 → PATH → 仓库内置 ffmpeg-static（引擎本身零依赖，编码是可选外挂） */
function findFfmpeg() {
  const tries = [process.env.BLOCKOUT_FFMPEG, 'ffmpeg'].filter(Boolean)
  for (const c of tries) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' })
    if (!r.error && r.status === 0) return c
  }
  let dir = resolve('.')
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    if (existsSync(p)) return p
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return null
}

function emit(obj, opts, code = 0) {
  const text = `${JSON.stringify(obj, null, 2)}\n`
  if (typeof opts.out === 'string') writeFileSync(opts.out, text)
  process.stdout.write(text)
  process.exit(code)
}

function loadAuthor(opts) {
  if (!opts.scene) {
    process.stderr.write('缺少 --scene <author.json>\n')
    process.exit(1)
  }
  const author = JSON.parse(readFileSync(String(opts.scene), 'utf8'))
  for (const kv of opts.set ?? []) {
    const m = /^([^=]+)=(.+)$/.exec(kv)
    if (!m) {
      process.stderr.write(`--set 需要 k=v 形式，得到 ${kv}\n`)
      process.exit(1)
    }
    const key = m[1]
    const val = Number(m[2])
    if (!Number.isFinite(val)) {
      process.stderr.write(`--set ${key} 的值必须是非负数字\n`)
      process.exit(1)
    }
    const cur = author.drivers?.[key]
    if (cur === undefined) {
      process.stderr.write(`--set 引用了不存在的驱动参数 ${key}\n`)
      process.exit(1)
    }
    author.drivers[key] = typeof cur === 'object' && cur !== null ? { ...cur, value: val } : val
  }
  return author
}

function runCheck(author) {
  const resolved = resolveScene(author)
  if (!resolved.ok) return { resolved, describeOut: null, collide: null }
  const d = describe(resolved)
  const c = collideAll(resolved)
  return { resolved, describeOut: d, collide: c }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cmd = opts._[0] ?? 'help'

  if (cmd === 'selftest') {
    const r = spawnSync(process.execPath, [join(HERE, 'selftest.mjs')], { stdio: 'inherit' })
    process.exit(r.status ?? 1)
  }

  const author = loadAuthor(opts)

  if (cmd === 'resolve') {
    const resolved = resolveScene(author)
    return emit(
      {
        ok: resolved.ok,
        errors: resolved.errors,
        parts: resolved.parts.map((p) => ({
          id: p.id,
          shape: p.shape,
          params: p.params,
          color: p.color,
          assembly: p.assembly,
          pose: { R: p.pose.R.map(round6), t: p.pose.t.map(round6) },
          worldAabb: { min: p.worldAabb.min.map(round6), max: p.worldAabb.max.map(round6) }
        }))
      },
      opts,
      resolved.ok ? 0 : 2
    )
  }

  if (cmd === 'describe' || cmd === 'check') {
    const { resolved, describeOut, collide } = runCheck(author)
    if (!resolved.ok) return emit({ ok: false, stage: 'resolve', errors: resolved.errors }, opts, 2)
    const payload = { ...describeOut, derivedFrom: resolved.derivedFrom }
    if (cmd === 'check') {
      payload.collisions = collide.results
      payload.errors = collide.errors
      payload.warnings = collide.warnings
      payload.ok = collide.errors.length === 0
    }
    return emit(payload, opts, cmd === 'check' && collide.errors.length > 0 ? 3 : 0)
  }

  if (cmd === 'collide') {
    const { resolved, collide } = runCheck(author)
    if (!resolved.ok) return emit({ ok: false, stage: 'resolve', errors: resolved.errors }, opts, 2)
    return emit(
      { ok: collide.errors.length === 0, checked: collide.results.length, collisions: collide.results, errors: collide.errors, warnings: collide.warnings },
      opts,
      collide.errors.length > 0 ? 3 : 0
    )
  }

  if (cmd === 'sheet') {
    const resolved = resolveScene(author)
    if (!resolved.ok) return emit({ ok: false, stage: 'resolve', errors: resolved.errors }, opts, 2)
    const spec = {
      ...(author.views ?? {}),
      ...(opts.size ? { size: Number(opts.size) } : {}),
      ...(opts.ssaa ? { ssaa: Number(opts.ssaa) } : {}),
      ...(typeof opts.subject === 'string' ? { subject: opts.subject } : {}),
      ...(typeof opts.fit === 'string' ? { fit: opts.fit } : {})
    }
    const t0 = Date.now()
    const out = renderSheet(resolved, spec)
    const target = typeof opts.out === 'string' ? opts.out : 'sheet.png'
    mkdirSync(dirname(resolve(target)), { recursive: true })
    writeFileSync(target, out.png)
    return emit(
      {
        ok: true,
        image: target,
        width: out.width,
        height: out.height,
        bytes: out.png.length,
        ms: Date.now() - t0,
        subject: { id: out.subject.id, reason: out.subject.reason, parts: out.subject.subjectIds, supports: out.subject.supportIds },
        frame: out.frame ? { center: out.frame.center.map(round6), size: out.frame.size.map(round6) } : null,
        cells: out.cells.map((c) => ({ name: c.name, type: c.type, orthoHeight: c.orthoHeight, lens: c.lens, gridStep: c.gridStep }))
      },
      {},
      0
    )
  }

  if (cmd === 'view') {
    const resolved = resolveScene(author)
    if (!resolved.ok) return emit({ ok: false, stage: 'resolve', errors: resolved.errors }, opts, 2)
    const name = typeof opts.view === 'string' ? opts.view : 'front'
    const width = opts.width ? Number(opts.width) : 800
    const height = opts.height ? Number(opts.height) : 600
    const { cameras } = autoViews(resolved, { ...(author.views ?? {}), layout: [name] }, width, height)
    if (!cameras.length) {
      process.stderr.write(`无法为视图 ${name} 自动取景\n`)
      process.exit(1)
    }
    const { camera, meta } = cameras[0]
    const t0 = Date.now()
    const out = renderScene(resolved, { ...camera, width, height }, {
      ssaa: opts.ssaa ? Number(opts.ssaa) : 2,
      gridStep: meta.kind === 'ortho' ? meta.worldPerPx * 100 : 0.1
    })
    const target = typeof opts.out === 'string' ? opts.out : `${name}.png`
    mkdirSync(dirname(resolve(target)), { recursive: true })
    writeFileSync(target, out.png)
    return emit({ ok: true, image: target, view: name, camera, meta, ms: Date.now() - t0 }, {}, 0)
  }

  if (cmd === 'shot') {
    const resolved = resolveScene(author)
    if (!resolved.ok) return emit({ ok: false, stage: 'resolve', errors: resolved.errors }, opts, 2)
    const ids = shotIds(author)
    const id = typeof opts.shot === 'string' ? opts.shot : ids[0]
    if (!id) {
      process.stderr.write('场景里没有 shots 定义\n')
      process.exit(1)
    }
    const result = resolveShot(resolved, id, { width: opts.width ? Number(opts.width) : undefined, height: opts.height ? Number(opts.height) : undefined })

    if (opts.sheet) {
      if (!result.frames.length) return emit({ ok: false, errors: result.errors }, opts, 2)
      // gridStep 要能透传：默认 0.05m 是为"香水瓶"那种尺度定的，换成几十米的道路场景会把地面刷成条纹
      const out = renderFrameSheet(resolved, result, {
        size: opts.size ? Number(opts.size) : 1024,
        ssaa: opts.ssaa ? Number(opts.ssaa) : 2,
        ...(opts.gridStep ? { gridStep: Number(opts.gridStep) } : {})
      })
      const target = typeof opts.out === 'string' ? opts.out : `${id}-keys.png`
      mkdirSync(dirname(resolve(target)), { recursive: true })
      writeFileSync(target, out.png)
      return emit({ ok: result.ok, image: target, width: out.width, height: out.height, bytes: out.png.length, metrics: result.metrics, errors: result.errors, warnings: result.warnings }, {}, result.ok ? 0 : 3)
    }

    if (typeof opts.out === 'string') {
      mkdirSync(dirname(resolve(opts.out)), { recursive: true })
      writeFileSync(opts.out, `${JSON.stringify({ ...result, frames: result.frames }, null, 2)}\n`)
    }
    const summary = {
      ok: result.ok,
      shot: result.shot,
      frames: result.frameCount,
      fps: result.fps,
      durationS: result.durationS,
      intrinsics: result.intrinsics,
      subject: { ids: result.subject.ids.join(', '), aabb: result.subject.aabb },
      firstFrame: result.frames[0] ?? null,
      lastFrame: result.frames[result.frames.length - 1] ?? null,
      corrected: result.corrected ?? false,
      corrections: result.corrections ?? [],
      metrics: result.metrics,
      errors: result.errors,
      warnings: result.warnings,
      ...(typeof opts.out === 'string' ? { writtenTo: opts.out } : {})
    }
    if (opts.frames) summary.allFrames = result.frames
    return emit(summary, {}, result.ok ? 0 : 3)
  }

  if (cmd === 'shots') {
    const resolved = resolveScene(author)
    if (!resolved.ok) return emit({ ok: false, stage: 'resolve', errors: resolved.errors }, opts, 2)
    const ids = shotIds(author)
    const results = ids.map((id) => resolveShot(resolved, id))
    const continuity = checkContinuity(results, { maxJumpM: opts.maxJump ? Number(opts.maxJump) : 0.5, maxTurnDeg: opts.maxTurn ? Number(opts.maxTurn) : 30 })
    return emit(
      {
        ok: results.every((r) => r.ok),
        shots: results.map((r) => ({ id: r.shot, shot: r.shot, ok: r.ok, frames: r.frameCount, durationS: r.durationS, corrected: r.corrected, corrections: r.corrections, metrics: r.metrics, errors: r.errors, warnings: r.warnings })),
        continuity
      },
      opts,
      results.some((r) => !r.ok) ? 3 : 0
    )
  }

  if (cmd === 'video') {
    const resolved = resolveScene(author)
    if (!resolved.ok) return emit({ ok: false, stage: 'resolve', errors: resolved.errors }, opts, 2)
    const ids = shotIds(author)
    const id = typeof opts.shot === 'string' ? opts.shot : ids[0]
    if (!id) {
      process.stderr.write('场景里没有 shots 定义\n')
      process.exit(1)
    }
    const result = resolveShot(resolved, id, { width: opts.width ? Number(opts.width) : undefined, height: opts.height ? Number(opts.height) : undefined })
    if (!result.frames.length) return emit({ ok: false, errors: result.errors }, opts, 2)

    const W = opts.width ? Number(opts.width) : 640
    const H = opts.height ? Number(opts.height) : 360
    const ssaa = opts.ssaa ? Number(opts.ssaa) : 1
    const target = typeof opts.out === 'string' ? opts.out : `${id}.mp4`
    const framesDir = typeof opts.framesDir === 'string' ? opts.framesDir : join(dirname(resolve(target)), `${id}-frames`)
    mkdirSync(framesDir, { recursive: true })

    const t0 = Date.now()
    for (let i = 0; i < result.frames.length; i += 1) {
      const f = result.frames[i]
      const camera = {
        name: `f${i}`,
        type: 'persp',
        eye: f.pos,
        target: f.target,
        up: [f.c2w[1], f.c2w[5], f.c2w[9]],
        lens: f.lens,
        sensorWidth: result.intrinsics.sensorWidth,
        width: W,
        height: H
      }
      const img = renderScene(resolved, camera, { ssaa, gridStep: opts.gridStep ? Number(opts.gridStep) : 0.05, background: [0.12, 0.13, 0.155] })
      writeFileSync(join(framesDir, `f_${String(i).padStart(4, '0')}.png`), img.png)
      if (opts.progress && i % 20 === 0) process.stderr.write(`  渲染 ${i + 1}/${result.frames.length}\n`)
    }
    const renderMs = Date.now() - t0

    const ff = findFfmpeg()
    if (!ff) {
      return emit(
        { ok: false, stage: 'encode', message: '未找到 ffmpeg（可设 BLOCKOUT_FFMPEG，或让 PATH 里有 ffmpeg，或仓库内装 ffmpeg-static）', framesDir, frameCount: result.frames.length, renderMs, metrics: result.metrics },
        opts,
        1
      )
    }
    const args = [
      '-y',
      '-framerate', String(result.fps),
      '-i', join(framesDir, 'f_%04d.png'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', String(opts.crf ?? 20),
      '-movflags', '+faststart',
      target
    ]
    const enc = spawnSync(ff, args, { stdio: 'ignore' })
    const ok = !enc.error && enc.status === 0
    if (ok && !opts.keepFrames) rmSync(framesDir, { recursive: true, force: true })
    return emit(
      {
        ok,
        video: ok ? target : null,
        shot: id,
        frames: result.frames.length,
        fps: result.fps,
        durationS: result.durationS,
        resolution: [W, H],
        renderMs,
        encoder: ff,
        ...(ok ? {} : { error: enc.error ? String(enc.error) : `ffmpeg 退出码 ${enc.status}` }),
        ...(ok ? {} : { framesDir }),
        corrected: result.corrected ?? false,
        corrections: result.corrections ?? [],
        metrics: result.metrics,
        errors: result.errors,
        warnings: result.warnings
      },
      {},
      ok ? 0 : 1
    )
  }

  if (cmd === 'render') {
    const resolved = resolveScene(author)
    if (!resolved.ok) return emit({ ok: false, stage: 'resolve', errors: resolved.errors }, opts, 2)
    const camName = typeof opts.camera === 'string' ? opts.camera : (author.cameras?.[0]?.name ?? null)
    const cam = (author.cameras ?? []).find((c) => c.name === camName)
    if (!cam) {
      process.stderr.write(`场景里没有相机 ${camName}\n`)
      process.exit(1)
    }
    const camera = {
      ...cam,
      width: opts.width ? Number(opts.width) : cam.width ?? 900,
      height: opts.height ? Number(opts.height) : cam.height ?? 620
    }
    const t0 = Date.now()
    const out = renderScene(resolved, camera, {
      ssaa: opts.ssaa ? Number(opts.ssaa) : 2,
      gridStep: opts.gridStep ? Number(opts.gridStep) : 0.1,
      background: cam.background
    })
    const target = typeof opts.out === 'string' ? opts.out : 'blockout.png'
    mkdirSync(dirname(resolve(target)), { recursive: true })
    writeFileSync(target, out.png)
    return emit(
      {
        ok: true,
        image: target,
        width: out.width,
        height: out.height,
        bytes: out.png.length,
        ms: Date.now() - t0,
        stats: out.stats,
        partCount: resolved.parts.length
      },
      {},
      0
    )
  }

  process.stderr.write(
    [
      '用法：',
      '  node cli.mjs describe --scene <author.json> [--set k=v]',
      '  node cli.mjs resolve  --scene <author.json>',
      '  node cli.mjs collide  --scene <author.json>',
      '  node cli.mjs check    --scene <author.json>',
      '  node cli.mjs render   --scene <author.json> --camera <name> --out shot.png [--width 900 --height 620 --ssaa 2]',
      '  node cli.mjs selftest',
      ''
    ].join('\n')
  )
  process.exit(1)
}

main()
