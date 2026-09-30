/**
 * read_media 分支探针（架构计划 T7 的机器证据）。
 *
 * 运行：pnpm probe:read-media
 *
 * 为什么要在 electron 里跑：read_media 的成败取决于 `nativeImage` 的真解码与真缩放，
 * 纯 Node 自检（asset-path:check）只能锁住路径判定那一半。这个探针把 src 下的
 * 三个模块转译出来真调一遍 `execute`，夹具是磁盘上真的 PNG（nativeImage 现造），
 * 断言的是"回回来的图块能被解回去、而且确实被缩小了"，不是字符串长得像对的。
 *
 * 覆盖：无工作区 / 空参数 / 越界 / 不存在 / 文本转交 read / 视频抽帧失败收敛 /
 *      视频在无视觉模型下不回帧 / 视频真夹具成功路径（8 图块 + 时间戳清单） /
 *      音频不解码 /
 *      模型无视觉不回图块 / 成功回图块并缩放 / 裸文件名按根优先级 / inbox 放行 /
 *      损坏文件不抛异常 / 超大文件在解码前拒。
 *
 * 不需要任何 API Key：全程不碰网络，只测工具本身。
 * 结果同时写到 stdout 与 out/t7-read-media-result.json（Windows 上 electron.exe
 * 是 GUI 子系统程序，stdout 不保证被父终端捕获）。
 */
const { app, nativeImage } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 't7-probe-tmp')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 't7-read-media-result.json')

/** 与 src/main/agent/readMediaTool.ts 里的 MAX_IMAGE_BYTES 同值（探针侧独立写死才有意义） */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024
const MAX_EDGE = 1024

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

/** 镜像目录结构转译，保留 '../../shared/assets' 这类相对 require */
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

/** 真的 PNG 夹具：nativeImage 造位图再导 PNG，尺寸本身就是"读到的是哪张图"的指纹 */
function writePng(absPath, width, height) {
  const bitmap = Buffer.alloc(width * height * 4)
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = 40
    bitmap[i + 1] = 120
    bitmap[i + 2] = 200
    bitmap[i + 3] = 255
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height })
  assert(!image.isEmpty(), `夹具位图解码为空：${absPath}`)
  mkdir(path.dirname(absPath))
  fs.writeFileSync(absPath, image.toPNG())
  return absPath
}

const fwd = (p) => p.split(path.sep).join('/')
function imageBlocks(out) {
  return (out?.content ?? []).filter((block) => block?.type === 'image')
}
function textOf(out) {
  return (out?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

const startedAt = new Date().toISOString()

void app
  .whenReady()
  .then(async () => {
    transpileToTmp([
      path.join('src', 'shared', 'assets.ts'),
      path.join('src', 'main', 'media', 'artifactImage.ts'),
      path.join('src', 'main', 'media', 'videoFrames.ts'),
      path.join('src', 'main', 'agent', 'readMediaTool.ts')
    ])
    const { createReadMediaTool } = require(path.join(TMP, 'src', 'main', 'agent', 'readMediaTool.js'))
    const { MEDIA_ROOT_REL } = require(path.join(TMP, 'src', 'shared', 'assets.js'))

    // ---- 夹具：工作区 + 工作区之外的 inbox（临时上传的真实形态）+ 一处"根外的私密度子"----
    const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huabu-t7-'))
    const wsRoot = path.join(parent, 'ws')
    const inboxRoot = path.join(parent, 'inbox')
    const outsideRoot = path.join(parent, 'outside')
    const mediaRel = MEDIA_ROOT_REL.split('/')
    const wsAbs = (...seg) => path.join(wsRoot, ...seg)
    const mediaAbs = (...seg) => path.join(wsRoot, ...mediaRel, ...seg)

    const bigArtifact = writePng(mediaAbs('big.png'), 1600, 1200)
    writePng(mediaAbs('dup.png'), 1600, 1200) // 与工作区根那张同名、不同尺寸
    writePng(wsAbs('dup.png'), 60, 40)
    const uploadPng = writePng(path.join(inboxRoot, '2026-09-24', 'upload.png'), 80, 80)
    const smallPng = writePng(wsAbs('assets', 'images', 'small.png'), 80, 80)
    const outsidePng = writePng(path.join(outsideRoot, 'private.png'), 80, 80)
    // 与 <ws> 只差一个后缀的兄弟目录，里面放一张**真存在**的图：
    // 夹具必须存在，否则"前缀相似"那条会被 existsSync 顺手挡掉，等于没测
    writePng(path.join(parent, 'ws-evil', 'secret.png'), 80, 80)
    mkdir(wsAbs('notes'))
    fs.writeFileSync(wsAbs('notes', 'doc.txt'), 'hello\n')
    fs.writeFileSync(wsAbs('clip.mp4'), 'fake video bytes')
    // 真视频夹具：ffmpeg-static 自带二进制以 lavfi 现场生成（夹具零入库，与 t13 同惯例）。
    // 用 mandelbrot：亮度真变化，不会被 M2 感知去重剔帧（testsrc2 亮度近似静态、会被剔到下限）
    const realMp4 = wsAbs('real.mp4')
    execFileSync(require('ffmpeg-static'), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'mandelbrot=size=320x240:rate=10',
      '-t', '6', '-pix_fmt', 'yuv420p', realMp4
    ])
    fs.writeFileSync(wsAbs('notes', 'tone.wav'), 'fake audio bytes')
    fs.writeFileSync(wsAbs('assets', 'images', 'broken.png'), 'this is not a png')
    const hugePath = mediaAbs('huge.png')
    const hugeFd = fs.openSync(hugePath, 'w')
    fs.ftruncateSync(hugeFd, MAX_IMAGE_BYTES + 1) // 稀疏文件：只有 stat 尺寸需要成立
    fs.closeSync(hugeFd)

    const roots = {
      workspaceDir: fwd(wsRoot),
      mediaDir: fwd(mediaAbs()),
      inboxDir: fwd(inboxRoot)
    }
    assert(roots.mediaDir.endsWith(MEDIA_ROOT_REL), `产物根夹具拼错：${roots.mediaDir}`)
    assert(fs.existsSync(outsidePng) && !outsidePng.startsWith(roots.workspaceDir), '根外夹具没建在工作区之外')

    let vision = true
    const tool = createReadMediaTool({ roots: () => roots, supportsImageInput: () => vision })
    const call = (p) => tool.execute('probe-1', typeof p === 'string' ? { path: p } : p)

    await check('工具契约：name / parameters / description 齐备', async () => {
      assert(tool.name === 'read_media', `name=${tool.name}`)
      assert(typeof tool.execute === 'function', 'execute 不是函数')
      assert(tool.parameters && typeof tool.parameters === 'object', 'parameters 缺失（pi 靠它生成 schema）')
      assert(/图片/.test(String(tool.description)), 'description 没说明用途')
      return `${tool.name} / ${tool.label}`
    })

    await check('无工作区 ⇒ 明确报没有工作区，不猜路径', async () => {
      const orphan = createReadMediaTool({ roots: () => null, supportsImageInput: () => true })
      const out = await orphan.execute('probe-0', { path: bigArtifact })
      assert(out.details.reason === 'no-workspace', `reason=${out.details.reason}`)
      assert(imageBlocks(out).length === 0, '无工作区还回了图块')
      return out.details.reason
    })

    await check('空参数 ⇒ no-path（不把空串当相对路径去拼工作区根）', async () => {
      const missing = await call({})
      assert(missing.details.reason === 'no-path', `缺参数 reason=${missing.details.reason}`)
      const blank = await call('   ')
      assert(blank.details.reason === 'no-path', `空白串 reason=${blank.details.reason}`)
      return '缺省与空白两种都拒'
    })

    await check('越界写法 ⇒ 全拒且零图块（含"折叠后落在根外但文件真实存在"那条）', async () => {
      const escapes = [
        `${roots.workspaceDir}/assets/../../../Windows/win.ini`,
        `${roots.workspaceDir}/../outside/private.png`, // 折叠后 = 根外真实存在的文件：最狠的一条
        '../outside/private.png',
        '/etc/passwd',
        'D:\\Windows\\system32\\config.sam',
        `${roots.workspaceDir}-evil/secret.png` // 前缀相似但不同目录
      ]
      for (const raw of escapes) {
        const out = await call(raw)
        assert(out.details.reason === 'not-found-or-out-of-scope', `放行了一条越界：${raw} ⇒ ${JSON.stringify(out.details)}`)
        assert(imageBlocks(out).length === 0, `越界分支回了图块：${raw}`)
        assert(!String(out.details.absPath).startsWith(fwd(outsideRoot)), `定位到了根外文件：${out.details.absPath}`)
      }
      // 反向对照：工作区内的 .. 折叠合法，且必须报折叠后的干净路径
      // （折叠结果 = ws/assets/images/small.png；folded 请求里 images/.. 归一后命中它）
      const folded = await call(`${roots.workspaceDir}/assets/images/../images/small.png`)
      assert(folded.details.absPath === fwd(smallPng), `合法折叠被拒或路径没归一：${JSON.stringify(folded.details)}`)
      assert(folded.details.decoded === true, '合法折叠没读到图')
      return `${escapes.length} 种越界全拒 + 1 种合法折叠放行`
    })

    await check('文件不存在 ⇒ 文案给出允许的根与自纠指引', async () => {
      const out = await call('assets/images/没有这个文件.png')
      assert(out.details.reason === 'not-found-or-out-of-scope', `reason=${out.details.reason}`)
      const text = textOf(out)
      assert(text.includes(roots.workspaceDir), '没提示工作区根')
      assert(text.includes(roots.inboxDir), '没提示临时上传根')
      assert(text.includes('绝对路径'), '没提示改用引用清单里的绝对路径')
      return '含三根清单 + 自纠指引'
    })

    await check('文本文件 ⇒ 转交 read，不另起一套截断', async () => {
      const out = await call(wsAbs('notes', 'doc.txt'))
      assert(out.details.ok === true, JSON.stringify(out.details))
      assert(out.details.handedOff === 'read', `没指到 read：${JSON.stringify(out.details)}`)
      assert(imageBlocks(out).length === 0, '文本分支回了图块')
      assert(/read/.test(textOf(out)), '文案没提 read')
      return out.details.handedOff
    })

    await check('视频（假字节夹具）⇒ 抽帧失败收敛为 video-decode-failed（不炸会话）', async () => {
      const video = await call('clip.mp4')
      assert(video.details.kind === 'video' && video.details.decoded === false, JSON.stringify(video.details))
      assert(video.details.reason === 'video-decode-failed', `reason=${video.details.reason}`)
      assert(imageBlocks(video).length === 0, '抽帧失败不该回图块')
      assert(/抽取失败/.test(textOf(video)) && /MP4/.test(textOf(video)), '文案没给"重新导出 MP4"的自纠指引')
      return video.details.reason
    })

    await check('视频在无视觉模型下 ⇒ 不抽帧不回图块（帧就是图片块，协议层会丢）', async () => {
      vision = false
      const out = await call('clip.mp4')
      vision = true
      assert(out.details.kind === 'video' && out.details.decoded === false, JSON.stringify(out.details))
      assert(out.details.reason === 'model-no-vision', `reason=${out.details.reason}`)
      assert(imageBlocks(out).length === 0, '声明不视觉还塞图块')
      assert(/视觉/.test(textOf(out)), '没提示换成支持视觉的模型')
      return out.details.reason
    })

    await check('视频（真夹具）⇒ 抽帧成功：8 图块 + 时间戳清单 + 引用约束', async () => {
      const out = await call('real.mp4')
      assert(out.details.ok === true && out.details.decoded === true, JSON.stringify(out.details))
      assert(out.details.kind === 'video' && out.details.frames === 8, `details=${JSON.stringify(out.details)}`)
      assert(out.details.durationSec > 5 && out.details.durationSec < 7, `时长=${out.details.durationSec}`)
      const blocks = imageBlocks(out)
      assert(blocks.length === out.details.frames, `图块数 ${blocks.length} ≠ details.frames ${out.details.frames}`)
      for (const b of blocks) {
        assert(b.mimeType === 'image/jpeg', `mimeType=${b.mimeType}`)
        assert(!nativeImage.createFromBuffer(Buffer.from(b.data, 'base64')).isEmpty(), '帧 base64 解不回图片')
      }
      const text = textOf(out)
      assert(/帧1=00:00/.test(text) && /帧8=00:0[56]/.test(text), `缺帧时间戳清单：${text.slice(0, 200)}`)
      assert(/标注时间点/.test(text), '缺"引用画面标注时间点"约束')
      assert(/均匀采样|场景切换/.test(text), '没说明采样策略')
      return `${blocks.length} 图块 / 时长 ${out.details.durationSec}s / cached=${out.details.cached}`
    })

    await check('音频 ⇒ 只给文件信息并明说没有转写能力（不靠猜声音）', async () => {
      const audio = await call('notes/tone.wav')
      assert(audio.details.kind === 'audio' && audio.details.decoded === false, JSON.stringify(audio.details))
      assert(imageBlocks(audio).length === 0, '音频分支回了图块')
      assert(/ASR|转写/.test(textOf(audio)), '音频文案没说明没有语音转写')
      return 'audio 明说读不了'
    })

    await check('当前模型无视觉 ⇒ 不回图块（协议层会丢，回了就是假象）', async () => {
      vision = false
      const out = await call(bigArtifact)
      vision = true
      assert(out.details.decoded === false && out.details.reason === 'model-no-vision', JSON.stringify(out.details))
      assert(imageBlocks(out).length === 0, '声明不视觉还塞图块')
      const text = textOf(out)
      assert(/视觉/.test(text) && /模型/.test(text), '没提示换成支持视觉的模型')
      assert(out.details.absPath === fwd(bigArtifact), `没回定位到的真实路径：${out.details.absPath}`)
      return out.details.reason
    })

    await check('超大图片 ⇒ 解码前就拒（主进程内存不交给一张 25MB）', async () => {
      const out = await call(hugePath)
      assert(out.details.decoded === false && out.details.reason === 'too-large', JSON.stringify(out.details))
      assert(imageBlocks(out).length === 0, '超大图回了图块')
      return `> ${MAX_IMAGE_BYTES / 1024 / 1024}MB 拦在解码之前`
    })

    await check('损坏图片 ⇒ 报解码失败而不是抛异常（不能炸掉会话）', async () => {
      const out = await call('assets/images/broken.png')
      assert(out.details.decoded === false && out.details.reason === 'decode-failed', JSON.stringify(out.details))
      assert(imageBlocks(out).length === 0, '解码失败还回了图块')
      return out.details.reason
    })

    const ok = await call(bigArtifact)
    await check('成功路径 ⇒ 文本 + 图块，且图块是能解回去的真 JPEG', async () => {
      assert(ok.details.ok === true && ok.details.decoded === true, JSON.stringify(ok.details))
      assert(ok.details.width === 1600 && ok.details.height === 1200, `原尺寸报错：${ok.details.width}x${ok.details.height}`)
      const blocks = imageBlocks(ok)
      assert(blocks.length === 1, `图块数=${blocks.length}`)
      assert(blocks[0].mimeType === 'image/jpeg', `mimeType=${blocks[0].mimeType}`)
      assert(typeof blocks[0].data === 'string' && blocks[0].data.length > 1000, 'base64 空或过短')
      assert(!nativeImage.createFromBuffer(Buffer.from(blocks[0].data, 'base64')).isEmpty(), '回出去的 base64 解不回图片')
      return `图块 base64 ${blocks[0].data.length} 字符`
    })

    await check('缩放真的发生 ⇒ 1600px 原图回传后最长边 = 1024（不是原图塞上下文）', async () => {
      const { width, height } = nativeImage.createFromBuffer(Buffer.from(imageBlocks(ok)[0].data, 'base64')).getSize()
      assert(Math.max(width, height) === MAX_EDGE, `最长边=${Math.max(width, height)}，应为 ${MAX_EDGE}`)
      assert(Math.abs(width / height - 1600 / 1200) < 0.02, `宽高比走样：${width}x${height}`)
      return `回传 ${width}x${height}（等比自 1600x1200）`
    })

    await check('文本块留足可引用凭据：路径 / 大小 / 已缩放 / 别看文件名猜', async () => {
      const text = textOf(ok)
      assert(text.includes(fwd(bigArtifact)), '没复述真实路径')
      assert(/\d+(KB|MB|B)/.test(text), '没报大小')
      assert(text.includes(String(MAX_EDGE)) || /缩/.test(text), '没说缩放到多少')
      assert(/不要凭文件名猜测/.test(text), '缺"别看文件名猜内容"的约束')
      return `${text.split('\n').length} 行元信息`
    })

    await check('裸文件名同名双份 ⇒ 取到产物根那张（真机 bug 的反向锁）', async () => {
      const out = await call('dup.png')
      assert(out.details.ok === true, JSON.stringify(out.details))
      assert(out.details.absPath === fwd(mediaAbs('dup.png')), `定位到：${out.details.absPath}`)
      assert(out.details.width === 1600, `读到了工作区根那张 60px 的同名图：${out.details.width}px`)
      return 'dup.png ⇒ 产物根 1600×1200'
    })

    await check('相对路径与绝对路径指向同一文件 ⇒ 都命中', async () => {
      const rel = await call('assets/images/small.png')
      assert(rel.details.ok === true && rel.details.decoded === true, JSON.stringify(rel.details))
      assert(rel.details.absPath === fwd(smallPng), `相对定位到：${rel.details.absPath}`)
      const abs = await call(smallPng)
      assert(abs.details.absPath === rel.details.absPath && abs.details.width === 80, `绝对定位到：${JSON.stringify(abs.details)}`)
      return '两种写法同一文件'
    })

    await check('inbox（有意放在工作区之外）⇒ 放行并标明是临时上传', async () => {
      const out = await call(uploadPng)
      assert(out.details.ok === true && out.details.decoded === true, JSON.stringify(out.details))
      assert(/临时上传/.test(textOf(out)), '没标出"临时上传"（Agent 会以为在工作区里）')
      return 'inbox 图可读'
    })

    await check('源级回归锁：工具已接进 chat:create，提示词已指到 read_media', async () => {
      // 装配在 src/main/ipc/chat.ts（M 拆分后从 ipc.ts 迁出），锁它而不是编排器
      const chatIpc = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'ipc', 'chat.ts'), 'utf8')
      assert(/customTools:\s*\[[^\]]*readMediaTool/.test(chatIpc), 'chat:create 没挂 read_media（引用契约只剩"发路径"那一半）')
      const prompt = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'shared', 'prompt.ts'), 'utf8')
      assert(prompt.includes('read_media'), '系统提示词没告诉 Agent 有 read_media')
      const host = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'agent', 'host.ts'), 'utf8')
      assert(/'read'/.test(host), "pi 的 read 白名单变了 —— 文本转交那条分支的前提不再成立")
      return 'ipc + prompt + read 白名单'
    })

    const pass = results.filter((r) => r.pass).length
    const allPass = pass === results.length
    console.log(`\n================ probe:read-media ${pass}/${results.length} ${allPass ? 'PASS' : 'FAIL'} ================`)
    flush(startedAt)
    fs.rmSync(TMP, { recursive: true, force: true })
    fs.rmSync(parent, { recursive: true, force: true })
    app.exit(allPass ? 0 : 2)
  })
  .catch((error) => {
    console.log(`ERROR ${error && error.stack ? error.stack : error}`)
    results.push({ name: '夹具/运行', pass: false, detail: String(error && error.stack ? error.stack : error) })
    flush(startedAt)
    app.exit(3)
  })
