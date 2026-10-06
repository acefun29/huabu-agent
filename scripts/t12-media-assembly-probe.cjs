/**
 * 媒体工具装配探针（架构计划 T12 的机器证据）。
 *
 * 运行：pnpm probe:media-assembly
 *
 * mediaToolAssembly.ts 是 chat:create 注入 Agent 会话的工具装配层，依赖（store/
 * mediaManager/mediaContext/host）全部经窄接口注入 —— 本探针用 mock 依赖真调
 * assembleMediaTools，断言的是装配语义本身：
 *
 *   工具面：3 个生成工具 + read_media + 视频两工具（skim_video / read_video_frames）
 *   submit 拼装：落库链 → outputDir 条件透传 / refPaths 空不传字段 / sourceChatId=nodeId /
 *               ratio·时长条件透传 / waitForCompletion 与进度转发
 *   失败分类：无可用模型 → 工具结果含可操作指引（不静默、不裸抛）
 *   现读语义（T2）：capabilities 与 confirmVideo 每次调用现读，改 mock 即时生效
 *   落库链直测：默认库 / 已删库回退公共库 / 再兜底画布素材 / 'none' / 'builtin-assets'
 *   read_media 接线：无工作区报 no-workspace；三根齐备时 inbox 放行
 *   视频两工具（视频理解 M2/M3）：skim 粗扫/无视觉降级、read_video_frames 的
 *   MM:SS 入参解析与区间/时间守卫（夹具 ffmpeg lavfi 现场生成，用完即清）
 *   generate_video 成功回传首帧（P2 多模态自检）：artifactDirRel/缺省两路拼径、
 *   无视觉不抽帧、抽帧失败/宿主抛错降级纯文本、真实抽帧管线端到端（夹具用完即清）
 *
 * 为什么要在 electron 里跑：装配链含 artifactImage（nativeImage），纯 Node 加载不了。
 * 不需要任何 API Key：mediaManager 是 mock，全程不碰网络。
 */
const { app, nativeImage } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 't12-probe-tmp')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 't12-media-assembly-result.json')

const results = []
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

// @shared/* 重定向到 OUT_DIR 里的转译产物（与 context-digest:check 同一手法）
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@shared/')) {
    const target = path.join(TMP, 'src', 'shared', request.slice('@shared/'.length))
    return origResolve.call(this, target, parent, ...rest)
  }
  return origResolve.call(this, request, parent, ...rest)
}

/** 真 PNG 夹具（read_media 成功路径用） */
function writePng(absPath, width, height) {
  const bitmap = Buffer.alloc(width * height * 4)
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = 200
    bitmap[i + 1] = 60
    bitmap[i + 2] = 30
    bitmap[i + 3] = 255
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height })
  assert(!image.isEmpty(), `夹具位图解码为空：${absPath}`)
  mkdir(path.dirname(absPath))
  fs.writeFileSync(absPath, image.toPNG())
  return absPath
}

/** 真 mp4 夹具（视频两工具用）：ffmpeg lavfi mandelbrot 现场生成 —— 亮度真变化不会被
 *  感知去重误伤；640x480 让 skim 的 384px 降缩放真的在测"缩"。夹具零入库，用完即删。 */
function writeVideoFixture(absPath) {
  mkdir(path.dirname(absPath))
  execFileSync(require('ffmpeg-static'), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'mandelbrot=size=640x480:rate=10',
    '-t', '6', '-pix_fmt', 'yuv420p', absPath
  ])
  assert(fs.existsSync(absPath) && fs.statSync(absPath).size > 10000, `视频夹具生成失败：${absPath}`)
  return absPath
}

const startedAt = new Date().toISOString()

void app
  .whenReady()
  .then(async () => {
    transpileToTmp([
      path.join('src', 'main', 'agent', 'mediaToolAssembly.ts'),
      path.join('src', 'main', 'agent', 'mediaTools.ts'),
      // mediaTools.ts 引用其 MEDIA_SRC_MARKER（产物路径标记行）
      path.join('src', 'main', 'agent', 'contextEviction.ts'),
      path.join('src', 'main', 'agent', 'readMediaTool.ts'),
      path.join('src', 'main', 'agent', 'videoTools.ts'),
      path.join('src', 'main', 'media', 'artifactImage.ts'),
      path.join('src', 'main', 'media', 'videoFrames.ts'),
      path.join('src', 'main', 'media', 'manager.ts'),
      path.join('src', 'main', 'media', 'provider.ts'),
      path.join('src', 'main', 'media', 'imageSize.ts'),
      // manager.ts 依赖的原子写（1d60212 收口到 fsutil；漏登会让产物主名净化直测挂掉）
      path.join('src', 'main', 'fsutil', 'atomic.ts'),
      path.join('src', 'shared', 'assets.ts'),
      path.join('src', 'shared', 'media.ts'),
      path.join('src', 'shared', 'mediaResolve.ts')
    ])
    const assembly = require(path.join(TMP, 'src', 'main', 'agent', 'mediaToolAssembly.js'))

    /* ---------------- mock 依赖 ---------------- */

    const NODE = 'probe-node'
    let mediaConfigValue = { confirmVideo: true, defaultLibraryId: 'lib-default' }
    /** 变更前确认：approval 结果可控（undefined = 不拦截/未调用） */
    let approvalDecision = undefined
    let approvalCalls = []
    let librariesValue = [
      { id: 'lib-default', path: 'assets/images', isPublic: false },
      { id: 'lib-public', path: 'libraries/public', isPublic: true }
    ]
    const submitted = []
    let submitResult = null
    let waitForResult = null
    let progressSink = null
    const fakeArtifact = { relPath: '.huabu/media/out-1.png', name: 'out-1.png', mime: 'image/png', bytes: 1234 }
    const mediaManager = {
      async submit(input) {
        submitted.push(input)
        if (submitResult) return submitResult
        return { jobId: 'job-1' }
      },
      async waitForCompletion(jobId, opts) {
        progressSink = opts?.onProgress ?? null
        if (waitForResult) return waitForResult
        return {
          jobId, kind: 'image', state: 'succeeded', progress: 1,
          prompt: 'p', provider: 'prov', model: 'prov/img', updatedAt: 't',
          artifact: fakeArtifact
        }
      }
    }
    // 一家有三种模型（image/video/audio）的供应商（resolveAgentMedia 的解析原料）
    let providersValue = [
      {
        id: 'prov', label: 'Prov', adapter: 'gateway-openai-compat', baseUrl: 'https://x/v1',
        apiKey: 'k',
        models: [
          { id: 'prov/img', kind: 'image', capabilities: { ratios: ['1:1', '16:9'], durations: [4] } },
          { id: 'prov/vid', kind: 'video', capabilities: { ratios: ['16:9'], durations: [4, 8] } },
          { id: 'prov/aud', kind: 'audio', capabilities: { durations: [4, 8] } }
        ]
      }
    ]
    let mediaDirValue = null
    const deps = {
      store: {
        mediaConfig: () => mediaConfigValue,
        getLibraries: () => librariesValue
      },
      mediaManager,
      sessionModelSupportsImages: () => true,
      currentDir: () => '/ws-root',
      mediaContext: () => ({ providers: providersValue, config: mediaConfigValue, mediaDir: mediaDirValue }),
      inboxRoot: () => '/inbox-root',
      requestApproval: async (kind, info, nodeId, signal) => {
        approvalCalls.push({ kind, model: info.model, prompt: info.prompt, nodeId })
        return approvalDecision !== false
      }
    }
    const { mediaTools, readMediaTool, videoTools } = assembly.assembleMediaTools(NODE, deps)
    const byName = new Map([...mediaTools, readMediaTool, ...videoTools].map((t) => [t.name, t]))
    const imageTool = byName.get('generate_image')

    await check('工具面齐备：3 个生成工具 + read_media + 视频两工具', async () => {
      for (const n of ['generate_image', 'generate_video', 'generate_audio', 'read_media', 'skim_video', 'read_video_frames']) {
        assert(byName.has(n), `缺 ${n}`)
      }
      return '6 个 customTool'
    })

    await check('submit 拼装：落库链命中 ⇒ outputDir=库路径，sourceChatId=nodeId', async () => {
      await imageTool.execute('c1', { prompt: 'p', ratio: '1:1' })
      const arg = submitted.at(-1)
      assert(arg.outputDir === 'assets/images', `outputDir=${JSON.stringify(arg.outputDir)}`)
      assert(arg.sourceChatId === NODE, `sourceChatId=${JSON.stringify(arg.sourceChatId)}`)
      assert(arg.provider === 'prov' && arg.model === 'prov/img', `解析=${arg.provider}:${arg.model}`)
      assert(arg.refPaths === undefined, 'refPaths 空时不应传字段')
      return 'outputDir + 身份 + 模型解析'
    })

    await check('submit 拼装：ratio/时长/refPaths 条件透传，空 refPaths 不传字段', async () => {
      await imageTool.execute('c2', { prompt: 'p', ratio: '16:9', reference_images: ['/x.png'] })
      const arg = submitted.at(-1)
      assert(arg.ratio === '16:9', `ratio=${JSON.stringify(arg.ratio)}`)
      assert(Array.isArray(arg.refPaths) && arg.refPaths[0] === '/x.png', `refPaths=${JSON.stringify(arg.refPaths)}`)
      const audioTool = byName.get('generate_audio')
      await audioTool.execute('c3', { prompt: 'p', duration_seconds: 4 })
      const a = submitted.at(-1)
      assert(a.durationSeconds === 4, `durationSeconds=${JSON.stringify(a.durationSeconds)}`)
      return '三种条件字段'
    })

    await check('产物命名透传：工具 name → submit.name；省略不传字段', async () => {
      const schema = imageTool.parameters
      const nameProp = schema && schema.properties ? schema.properties.name : null
      assert(nameProp, 'generate_image 参数表缺 name')
      await imageTool.execute('c2b', { prompt: 'p', name: '海报-v1-重绘', ratio: '1:1' })
      const named = submitted.at(-1)
      assert(named.name === '海报-v1-重绘', `name=${JSON.stringify(named.name)}`)
      assert(
        typeof nameProp.description === 'string' && /前缀|参考图/.test(nameProp.description),
        'name 参数描述应引导沿用参考图前缀'
      )
      await imageTool.execute('c2c', { prompt: 'p' })
      const unnamed = submitted.at(-1)
      assert(unnamed.name === undefined, `省略 name 时不应传字段，实际：${JSON.stringify(unnamed.name)}`)
      return '传/省略两分支'
    })

    await check('产物主名净化直测：剥扩展名/非法字符/保留名/越界/空回退', () => {
      const { sanitizeArtifactName } = require(path.join(TMP, 'src', 'main', 'media', 'manager.js'))
      assert(sanitizeArtifactName('海报-v1.png') === '海报-v1', '应剥掉误带的扩展名')
      assert(sanitizeArtifactName('a/b\\c:*?"<>|') === 'a_b_c_______', '非法字符应替换为 _')
      assert(sanitizeArtifactName('CON') === 'CON_', 'Windows 保留名应追加 _')
      assert(sanitizeArtifactName('名字结尾点空格. ') === '名字结尾点空格', '结尾点/空格应剥掉')
      assert(sanitizeArtifactName(undefined) === undefined && sanitizeArtifactName('   ') === undefined, '空输入回退 undefined')
      assert(sanitizeArtifactName('...') === '_', '纯点应防隐藏文件（换成 _）而非落盘')
      assert(sanitizeArtifactName('x'.repeat(300)).length === 80, '应截断到 80 字符')
      return '六种形态'
    })

    await check('waitForCompletion 转发：execute 阻塞到终态 + 进度经 onUpdate 推出', async () => {
      const updates = []
      mediaConfigValue = { ...mediaConfigValue, confirmVideo: false }
      waitForResult = {
        jobId: 'job-9', kind: 'video', state: 'succeeded', progress: 1,
        prompt: 'p', provider: 'prov', model: 'prov/vid', updatedAt: 't',
        artifact: { relPath: '.huabu/media/out-9.mp4', name: 'out-9.mp4', mime: 'video/mp4', bytes: 9, durationSeconds: 4 }
      }
      const out = await byName.get('generate_video').execute('c4', { prompt: 'p', confirmed: true }, undefined, (u) => updates.push(u))
      const text = out.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      assert(/已生成成功/.test(text) && text.includes('out-9.mp4'), `终态文本不对：${text.slice(0, 100)}`)
      assert(progressSink, '装配层没有把 onProgress 传给 waitForCompletion')
      progressSink({ jobId: 'job-9', kind: 'video', state: 'running', progress: 0.5, prompt: 'p', provider: 'prov', model: 'prov/vid', updatedAt: 't' })
      assert(updates.length === 1 && /50%/.test(updates[0].content[0].text), `进度没转成 onUpdate：${JSON.stringify(updates)}`)
      return '终态文本 + 进度 50% 推送'
    })

    await check('失败分类：解析不到模型 ⇒ 抛可操作指引（execute 以 error 进 pi 工具结果）', async () => {
      providersValue = []
      let threw = null
      try {
        await imageTool.execute('c5', { prompt: 'p', ratio: '1:1' })
      } catch (e) {
        threw = e
      }
      assert(threw && /没有可用的图片生成模型/.test(threw.message), `应抛指引，实际：${threw}`)
      providersValue = [
        {
          id: 'prov', label: 'Prov', adapter: 'gateway-openai-compat', baseUrl: 'https://x/v1',
          apiKey: 'k',
          models: [
            { id: 'prov/img', kind: 'image', capabilities: { ratios: ['1:1', '16:9'], durations: [4] } },
            { id: 'prov/vid', kind: 'video', capabilities: { ratios: ['16:9'], durations: [4, 8] } },
            { id: 'prov/aud', kind: 'audio', capabilities: { durations: [4, 8] } }
          ]
        }
      ]
      return '指引文本在抛出的错误里'
    })

    await check('capabilities 现读（T2）：改 mock 立即生效，非法比例给支持清单', async () => {
      await imageTool.execute('c6', { prompt: 'p', ratio: '9:16' }).catch(() => {})
      let threw = null
      try {
        await imageTool.execute('c7', { prompt: 'p', ratio: '3:4' })
      } catch (e) {
        threw = e
      }
      assert(threw && /不支持比例/.test(threw.message) && threw.message.includes('1:1'), `缺支持清单：${threw}`)
      return '9:16 过 → 3:4 拒（同一次装配）'
    })

    await check('confirmVideo 现读：true+未确认 ⇒ 求确认文本；false ⇒ 直通 submit', async () => {
      mediaConfigValue = { ...mediaConfigValue, confirmVideo: true }
      const gate = await byName.get('generate_video').execute('c8', { prompt: 'p' })
      const gateText = gate.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      assert(/确认/.test(gateText), `闸门没拦：${gateText.slice(0, 80)}`)
      const before = submitted.length
      mediaConfigValue = { ...mediaConfigValue, confirmVideo: false }
      await byName.get('generate_video').execute('c9', { prompt: 'p' })
      assert(submitted.length === before + 1, 'confirmVideo=false 应直通提交')
      return '闸门 + 直通各一次'
    })

    await check('变更前确认：confirm 模式拒绝 ⇒ 不提交且返回可转告文本', async () => {
      mediaConfigValue = { ...mediaConfigValue, confirmVideo: false, accessMode: 'confirm' }
      approvalDecision = false
      approvalCalls = []
      const before = submitted.length
      const out = await imageTool.execute('c12', { prompt: '海报重绘', ratio: '1:1', reference_images: ['/x.png'] })
      const text = out.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      assert(submitted.length === before, '拒绝后不应提交任务')
      assert(/用户拒绝/.test(text) && /未提交/.test(text), `拒绝文案不对：${text.slice(0, 80)}`)
      assert(out.details.reason === 'declined', `details=${JSON.stringify(out.details)}`)
      // 确认卡要素：装配层要把解析出的 provider/model 与参考图数补进 info
      assert(approvalCalls.length === 1, `approval 应调一次，实际 ${approvalCalls.length}`)
      assert(approvalCalls[0].model === 'prov/img' && approvalCalls[0].kind === 'image', JSON.stringify(approvalCalls[0]))
      assert(approvalCalls[0].prompt === '海报重绘', 'prompt 应原样进确认卡')
      return '拒绝 + 确认卡要素'
    })

    await check('变更前确认：接受 ⇒ 放行提交；full 模式 ⇒ 不经确认直接提交', async () => {
      approvalDecision = true
      approvalCalls = []
      const before = submitted.length
      const out = await imageTool.execute('c13', { prompt: 'p' })
      const text = out.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      assert(/已生成成功/.test(text), `接受后应正常生成：${text.slice(0, 60)}`)
      assert(submitted.length === before + 1 && approvalCalls.length === 1, '接受后应提交一次')
      // full 模式：确认口不再被调用（视频对话闸门语义保留）
      mediaConfigValue = { ...mediaConfigValue, accessMode: 'full' }
      approvalCalls = []
      await imageTool.execute('c14', { prompt: 'p' })
      assert(approvalCalls.length === 0, 'full 模式不应调用确认口')
      return '接受 + full 直通'
    })

    await check('落库链直测：默认库 / 已删库回退公共库 / 空库兜底画布素材 / none / builtin / 类型默认优先', () => {
      const store = { mediaConfig: () => mediaConfigValue, getLibraries: () => librariesValue }
      const emptyStore = { mediaConfig: () => mediaConfigValue, getLibraries: () => [] }
      assert(assembly.resolveOutputLibrary(store, { defaultLibraryId: 'lib-default' }, 'image') === 'assets/images', '默认库未命中')
      assert(assembly.resolveOutputLibrary(store, { defaultLibraryId: 'ghost' }, 'image') === 'libraries/public', '已删库未回退公共库')
      assert(assembly.resolveOutputLibrary(emptyStore, { defaultLibraryId: 'ghost' }, 'video') === 'assets/video', '无公共库未兜底分类目录')
      assert(assembly.resolveOutputLibrary(store, { defaultLibraryId: 'builtin-assets' }, 'audio') === 'assets/audio', 'builtin 未映射')
      assert(assembly.resolveOutputLibrary(store, { defaultLibraryId: 'none' }, 'image') === undefined, 'none 应返回 undefined')
      assert(
        assembly.resolveOutputLibrary(store, { kindLibraryDefaults: { video: 'lib-public' }, defaultLibraryId: 'lib-default' }, 'video') === 'libraries/public',
        '类型默认应压过全局默认'
      )
      return '六种形态'
    })

    await check('read_media 接线：无工作区 ⇒ no-workspace；roots 三根齐备 ⇒ inbox 放行', async () => {
      deps.currentDir = () => null
      const orphan = await readMediaTool.execute('c10', { path: '/ws-root/x.png' })
      assert(orphan.details.reason === 'no-workspace', `reason=${orphan.details.reason}`)
      deps.currentDir = () => '/ws-root'
      mediaDirValue = '/ws-root/.huabu/media'
      const upload = writePng('/inbox-root/2026-09/upload.png', 60, 40)
      const out = await readMediaTool.execute('c11', { path: upload })
      assert(out.details.ok === true && out.details.decoded === true, JSON.stringify(out.details))
      assert(/临时上传/.test(out.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')), '没标注 inbox 来源')
      return '两分支'
    })

    await check('resolveAgentMedia 直测：解析命中 / 无模型抛可操作错误', () => {
      const hit = assembly.resolveAgentMedia(
        [{ id: 'prov', models: [{ id: 'prov/img', kind: 'image' }] }],
        { agentProvider: 'prov' },
        'image'
      )
      assert(hit.provider === 'prov' && hit.model === 'prov/img', JSON.stringify(hit))
      let threw = null
      try {
        assembly.resolveAgentMedia([], {}, 'video')
      } catch (e) {
        threw = e
      }
      assert(threw && /没有可用的视频生成模型/.test(threw.message), `抛错形态不对：${threw}`)
      return '正反两路'
    })

    /* ---------------- 视频两工具（视频理解 M2/M3）---------------- */
    // 夹具：ffmpeg lavfi 现场 mandelbrot 6s（亮度真变化，不会被感知去重误伤），
    // 放 inbox 根（与上面 upload.png 同款真实落盘路径），缓存会写到 /ws-root/.huabu/vframes
    const skim = byName.get('skim_video')
    const readFrames = byName.get('read_video_frames')
    const clipAbs = writeVideoFixture('/inbox-root/2026-09/clip.mp4')
    const blocksOf = (out) => (out?.content ?? []).filter((b) => b?.type === 'image')
    const textOfOut = (out) => (out?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')

    await check('skim_video：粗扫回低清帧 + 时间轴，且引导区间精读', async () => {
      const out = await skim.execute('c20', { path: clipAbs })
      assert(out.details.ok === true && out.details.decoded === true, JSON.stringify(out.details))
      assert(out.details.frames >= 3 && out.details.frames <= 6, `帧数=${out.details.frames}`)
      const blocks = blocksOf(out)
      assert(blocks.length === out.details.frames, `图块数 ${blocks.length} ≠ details.frames`)
      for (const b of blocks) {
        const img = nativeImage.createFromBuffer(Buffer.from(b.data, 'base64'))
        assert(!img.isEmpty(), '粗扫帧解不回')
        assert(Math.max(...Object.values(img.getSize())) <= 384, `粗扫帧该 ≤384px`)
      }
      const text = textOfOut(out)
      assert(/时长/.test(text) && /read_video_frames/.test(text), '没回时长或没引导区间精读')
      assert(/帧1=00:0\d/.test(text), '缺帧时间戳清单')
      return `${blocks.length} 帧 @384px + 时间轴`
    })

    await check('skim_video 无视觉模型 ⇒ 只回文本时间轴（帧回传也会被协议层丢）', async () => {
      deps.sessionModelSupportsImages = () => false
      const out = await skim.execute('c21', { path: clipAbs })
      deps.sessionModelSupportsImages = () => true
      assert(out.details.decoded === false, JSON.stringify(out.details))
      assert(blocksOf(out).length === 0, '无视觉还塞帧图块')
      assert(/时间点/.test(textOfOut(out)) && /视觉/.test(textOfOut(out)), '没保留时间轴价值或没提示换视觉模型')
      return '元数据降级'
    })

    await check('read_video_frames：MM:SS 入参可解析，帧落在区间内', async () => {
      const out = await readFrames.execute('c22', { path: clipAbs, t1: '00:01', t2: '00:03' })
      assert(out.details.ok === true && out.details.decoded === true, JSON.stringify(out.details))
      assert(out.details.t1 === 1 && out.details.t2 === 3, `t1/t2=${out.details.t1}/${out.details.t2}`)
      const blocks = blocksOf(out)
      assert(blocks.length === out.details.frames && out.details.frames >= 2, `帧数=${out.details.frames}`)
      assert(/精读区间/.test(textOfOut(out)) && /区间外内容未读取/.test(textOfOut(out)), '缺区间边界声明')
      return `${blocks.length} 帧落 [1,3]s`
    })

    await check('read_video_frames 守卫：乱时间 / 超宽区间 / 非视频路径', async () => {
      const badTime = await readFrames.execute('c23', { path: clipAbs, t1: 'abc', t2: '00:03' })
      assert(badTime.details.reason === 'bad-time', `reason=${badTime.details.reason}`)
      const wide = await readFrames.execute('c24', { path: clipAbs, t1: '0', t2: '600' })
      assert(wide.details.reason === 'range-too-wide', `reason=${wide.details.reason}`)
      assert(/skim_video/.test(textOfOut(wide)), '超宽文案没引导回 skim')
      const pngPath = writePng('/inbox-root/2026-09/not-video.png', 60, 40)
      const notVideo = await readFrames.execute('c25', { path: pngPath })
      assert(notVideo.details.reason === 'not-found-or-out-of-scope', `reason=${notVideo.details.reason}`)
      return 'bad-time / range-too-wide / 非视频全拒'
    })

    /* ---------------- generate_video 成功回传首帧（P2 多模态自检）---------------- */
    // readVideoPosterAsBase64 在 assembleMediaTools 内联实现、不可注入，探针经转译产物的
    // CJS 导出面替换其唯一依赖 extractVideoFrames（TS CommonJS 输出是调用点属性访问，
    // 打补丁/还原都生效）；用完还原，不影响既有断言。posterCalls 记录入参，顺带锁死
    // 装配层的拼径（artifactDirRel / 缺省回退 MEDIA_ROOT_REL）与抽帧参数契约。
    const vfModule = require(path.join(TMP, 'src', 'main', 'media', 'videoFrames.js'))
    const realExtract = vfModule.extractVideoFrames
    const posterCalls = []
    /** null = 透传真实现（端到端用）；{ok:true,value}|{ok:false,…} = 固定返回；Error = 抛错 */
    let posterStub = null
    vfModule.extractVideoFrames = async (absPath, opts) => {
      posterCalls.push({ absPath, opts })
      if (!posterStub) return realExtract(absPath, opts)
      if (posterStub instanceof Error) throw posterStub
      return posterStub
    }
    /** generate_video 的 mock 终态：succeeded 视频，artifactDirRel 是任务自带的落盘目录（可选） */
    const setPosterVideoResult = (artifact, artifactDirRel) => {
      waitForResult = {
        jobId: 'job-poster', kind: 'video', state: 'succeeded', progress: 1,
        prompt: 'p', provider: 'prov', model: 'prov/vid', updatedAt: 't',
        ...(artifactDirRel ? { artifactDirRel } : {}),
        artifact
      }
    }
    const videoTool = byName.get('generate_video')
    const posterVideoArtifact = { relPath: 'poster-1.mp4', name: 'poster-1.mp4', mime: 'video/mp4', bytes: 8 }

    await check('generate_video 成功回传首帧：artifactDirRel 拼径 + image 块 + 文本说明', async () => {
      const mockPng = writePng(path.join(TMP, 'poster-mock.png'), 8, 8)
      const posterData = fs.readFileSync(mockPng).toString('base64')
      posterStub = {
        ok: true,
        value: {
          frames: [{ data: posterData, mimeType: 'image/png', ptsSec: 0.25 }],
          durationSec: 4, cached: false, sceneEnhanced: false, deduped: false
        }
      }
      setPosterVideoResult(posterVideoArtifact, 'assets/video')
      const out = await videoTool.execute('c30', { prompt: 'p', confirmed: true })
      const blocks = blocksOf(out)
      assert(blocks.length === 1, `应附 1 个 image 块，实际 ${blocks.length}`)
      assert(blocks[0].data === posterData && blocks[0].mimeType === 'image/png', 'image 块应是 poster 数据源返回的首帧')
      const text = textOfOut(out)
      assert(/首帧/.test(text), `成功文本没说明首帧：${text.slice(0, 120)}`)
      assert(posterCalls.length === 1, `抽帧应恰好被调一次，实际 ${posterCalls.length}`)
      assert(
        posterCalls[0].absPath === path.join('/ws-root', 'assets/video', 'poster-1.mp4'),
        `artifactDirRel 拼径不对：${posterCalls[0].absPath}`
      )
      assert(
        posterCalls[0].opts.maxFrames === 2 && posterCalls[0].opts.maxEdge === 768,
        `抽帧参数不对：${JSON.stringify(posterCalls[0].opts)}`
      )
      assert(
        posterCalls[0].opts.cacheDir === path.join('/ws-root', '.huabu', 'vframes'),
        `缓存目录不对：${posterCalls[0].opts.cacheDir}`
      )
      // 无 artifactDirRel 的历史任务 → 回退媒体产物目录根（MEDIA_ROOT_REL）
      setPosterVideoResult(posterVideoArtifact, undefined)
      const out2 = await videoTool.execute('c31', { prompt: 'p', confirmed: true })
      assert(posterCalls.length === 2, '第二次成功也应触发抽帧')
      assert(
        posterCalls[1].absPath === path.join('/ws-root', '.huabu', 'media', 'poster-1.mp4'),
        `缺省应回退 MEDIA_ROOT_REL：${posterCalls[1].absPath}`
      )
      assert(blocksOf(out2).length === 1, '回退路径也应附首帧')
      return 'image 块 + 文本说明 + artifactDirRel/缺省两路拼径'
    })

    await check('generate_video 无视觉 ⇒ 不抽帧、纯文本成功', async () => {
      deps.sessionModelSupportsImages = () => false
      const before = posterCalls.length
      setPosterVideoResult(posterVideoArtifact, 'assets/video')
      const out = await videoTool.execute('c32', { prompt: 'p', confirmed: true })
      deps.sessionModelSupportsImages = () => true
      assert(posterCalls.length === before, '无视觉模型不应触发抽帧')
      assert(blocksOf(out).length === 0, '无视觉不应有 image 块')
      const text = textOfOut(out)
      assert(/已生成成功/.test(text) && !/首帧/.test(text), `降级文本不对：${text.slice(0, 120)}`)
      return '抽帧未触达 + 无 image 块'
    })

    await check('generate_video 抽帧失败/宿主抛错 ⇒ 降级纯文本，成功结果不受影响', async () => {
      setPosterVideoResult(posterVideoArtifact, 'assets/video')
      posterStub = { ok: false, code: 'probe-failed', error: 'mock：抽帧失败' }
      const failOut = await videoTool.execute('c33', { prompt: 'p', confirmed: true })
      const failText = textOfOut(failOut)
      assert(/已生成成功/.test(failText) && !/首帧/.test(failText), `ok:false 降级文本不对：${failText.slice(0, 120)}`)
      assert(blocksOf(failOut).length === 0, 'ok:false 不应附 image 块')
      posterStub = new Error('mock：宿主抽帧实现抛错')
      const throwOut = await videoTool.execute('c34', { prompt: 'p', confirmed: true })
      const throwText = textOfOut(throwOut)
      assert(/已生成成功/.test(throwText) && !/首帧/.test(throwText), `抛错降级文本不对：${throwText.slice(0, 120)}`)
      assert(blocksOf(throwOut).length === 0, '宿主抛错不应附 image 块')
      posterStub = null
      return 'ok:false 与抛错两路都降级为成功文本'
    })

    // 端到端：不打补丁，真实 extractVideoFrames 跑通装配层——这条锁住"首帧回传真实生效"
    // 而不是 mock 假绿（maxFrames=2 取第 1 帧的参数契约也在此被真实管线验证）。
    // 夹具是亮度连续变化的 mandelbrot，不依赖场景帧数量，用完即清
    await check('generate_video 首帧端到端：真实抽帧管线回传 1 帧 ≤768px JPEG', async () => {
      const e2eAbs = writeVideoFixture('/ws-root/assets/video/poster-e2e.mp4')
      try {
        setPosterVideoResult(
          { relPath: 'poster-e2e.mp4', name: 'poster-e2e.mp4', mime: 'video/mp4', bytes: fs.statSync(e2eAbs).size },
          'assets/video'
        )
        posterStub = null
        const out = await videoTool.execute('c35', { prompt: 'p', confirmed: true })
        const blocks = blocksOf(out)
        assert(blocks.length === 1, `真实管线应附 1 帧首帧，实际 ${blocks.length}`)
        assert(blocks[0].mimeType === 'image/jpeg', `首帧 mime=${blocks[0].mimeType}`)
        const img = nativeImage.createFromBuffer(Buffer.from(blocks[0].data, 'base64'))
        assert(!img.isEmpty(), '真实首帧解不回')
        const size = img.getSize()
        assert(Math.max(size.width, size.height) <= 768, `首帧应 ≤768px：${size.width}×${size.height}`)
        assert(/首帧/.test(textOfOut(out)), '端到端文本缺首帧说明')
        return `真实抽帧回传 ${size.width}×${size.height}px JPEG`
      } finally {
        fs.rmSync('/ws-root/assets/video', { recursive: true, force: true })
      }
    })

    // 还原补丁：后续不再有 generate_* 调用，纯粹防脏（缓存目录清理在下方统一做）
    vfModule.extractVideoFrames = realExtract

    // 清理：视频工具的缓存落在 /ws-root/.huabu（真实盘符根），不留垃圾
    fs.rmSync('/ws-root/.huabu/vframes', { recursive: true, force: true })
    fs.rmSync(clipAbs, { force: true })

    const pass = results.filter((r) => r.pass).length
    const allPass = pass === results.length
    console.log(`\n============ probe:media-assembly ${pass}/${results.length} ${allPass ? 'PASS' : 'FAIL'} ============`)
    mkdir(path.join(PROJECT_ROOT, 'out'))
    fs.writeFileSync(
      RESULT_PATH,
      JSON.stringify({ startedAt, pass, total: results.length, verdict: allPass ? 'PASS' : 'FAIL', results }, null, 2),
      'utf8'
    )
    fs.rmSync(TMP, { recursive: true, force: true })
    app.exit(allPass ? 0 : 2)
  })
  .catch((error) => {
    console.log(`ERROR ${error && error.stack ? error.stack : error}`)
    results.push({ name: '夹具/运行', pass: false, detail: String(error && error.stack ? error.stack : error) })
    fs.mkdirSync(path.join(PROJECT_ROOT, 'out'), { recursive: true })
    fs.writeFileSync(
      RESULT_PATH,
      JSON.stringify({ startedAt, pass: 0, total: results.length, verdict: 'ERROR', results }, null, 2),
      'utf8'
    )
    app.exit(3)
  })
