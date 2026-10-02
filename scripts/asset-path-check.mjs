/**
 * 素材引用路径解析自检（阶段 0 真机冒烟发现的 bug 的回归锁）。
 *
 * 运行：pnpm asset-path:check
 *
 * 起因：真机上引用一张"未落库"的生成产物，发给 Agent 的绝对路径是
 * `<工作区>/<裸文件名>.png`，而文件真身在 `<工作区>/.huabu/media/<裸文件名>.png`。
 * 根因是卡片 `AssetData.path` 的语义是"相对 storage 根"，`media` 这一路被当成
 * "相对工作区根"拼了 —— 不报错、不炸，只是 Agent 说"找不到我引用的图片"。
 *
 * 这里断言的是解析函数本身（shared/assets.ts 不依赖 electron，纯 Node 可跑）：
 *   1. media 形态带 pathRoot ⇒ 拼出的路径 existsSync 命中真实文件（不是"看着像对的字符串"）。
 *   2. 老卡片没有 pathRoot ⇒ 回退默认产物根，并且**绝不**退化成 `<工作区>/<裸文件名>`。
 *   3. 产物目录被 media.outputDir 改过 ⇒ 每张卡片按自己落盘时的根解析，互不串台。
 *   4. ws 形态（拖入归档 / 素材库条目 / 落库产物）⇒ 按工作区根，含中文目录与多级子目录。
 *   5. 已是绝对路径 ⇒ 原样归一分隔符，不二次拼接。
 *   6. 尚无文件的卡片（未生成完）⇒ null，引用契约据此丢弃而不是发一条指不到东西的路径。
 *   7. 单一事实来源：默认产物根字面量只许出现在 shared/assets.ts；引用契约那一段只许走
 *      assetAbsPath —— 防的是"下次有人在渲染端再拼一次"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'out', 'asset-path-check-tmp')
const SOURCE = path.join(PROJECT_ROOT, 'src', 'shared', 'assets.ts')

const results = []
function check(name, fn) {
  try {
    const detail = fn()
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

/** 把 src/shared/assets.ts 转译成 CJS 后加载（与另外两份自检同一手法） */
function loadAssetsModule() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(SOURCE, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: SOURCE,
    reportDiagnostics: true
  })
  const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  assert(errors.length === 0, `转译失败：${errors.map((d) => d.messageText).join('; ')}`)
  const target = path.join(OUT_DIR, 'assets.js')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(target, outputText)
  return import(pathToFileURL(target).href)
}

/** 造一棵真的落盘目录树：断言"拼出来的路径能打开文件"，而不是只比字符串 */
function fakeWorkspace() {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huabu-asset-'))
  const root = path.join(parent, 'ws')
  fs.mkdirSync(root, { recursive: true })
  // inbox 有意放在工作区**之外**（临时上传的真实形态）：read_media 要允许它，
  // 但它不能因此成为越界读取的旁路，所以它必须是独立的根
  const inbox = path.join(parent, 'inbox')
  const write = (base) => (rel) => {
    const file = path.join(base, ...rel.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'x')
    return rel
  }
  const inWs = write(root)
  const inInbox = write(inbox)
  return {
    root: root.split(path.sep).join('/'),
    inbox: inbox.split(path.sep).join('/'),
    files: [
      inWs('.huabu/media/a1.png'),
      inWs('生成区/b2.png'),
      inWs('assets/images/c3.png'),
      inWs('素材库/海报产出/d4.png'),
      inWs('notes/hello.txt'),
      inWs('clip.mp4'),
      // 同名双份，产物根与工作区根各一张。旧写法拼出的路径在这里"能打开文件"，
      // 但打开的是另一张图 —— 比报"不存在"更坏，所以单列一条断言盯住它。
      inWs('.huabu/media/dup.png'),
      inWs('dup.png'),
      inInbox('2026-09-24/upload-9.png')
    ]
  }
}

const ws = fakeWorkspace()
const { assetAbsPath, workspaceAbs, MEDIA_ROOT_REL, resolveMediaTarget, mediaKindForFileName } = await loadAssetsModule()
const exists = (abs) => fs.existsSync(path.join(...abs.split('/')))
const roots = { workspaceDir: ws.root, mediaDir: `${ws.root}/${MEDIA_ROOT_REL}`, inboxDir: ws.inbox }

check('media 形态带 pathRoot ⇒ 解析结果命中真实文件', () => {
  const abs = assetAbsPath({ storage: 'media', path: 'a1.png', pathRoot: '.huabu/media' }, ws.root)
  assert(abs === `${ws.root}/.huabu/media/a1.png`, `拼接不对：${abs}`)
  assert(exists(abs), `解析出的路径落不到真实文件：${abs}`)
  return `${abs}`
})

check('老卡片没有 pathRoot ⇒ 回退默认产物根（且绝不退化成 <工作区>/<裸文件名>）', () => {
  const abs = assetAbsPath({ storage: 'media', path: 'a1.png' }, ws.root)
  assert(exists(abs), `回退根解析后文件不存在：${abs}`)
  assert(abs !== `${ws.root}/a1.png`, '又拼回工作区根了 —— 这正是真机冒烟踩到的那条错')
  // 同名双份时旧写法会"成功打开另一张图"，比报错更坏：必须落在产物根那一张
  const dup = assetAbsPath({ storage: 'media', path: 'dup.png' }, ws.root)
  assert(dup === `${ws.root}/.huabu/media/dup.png`, `同名文件解析到了错误的根：${dup}`)
  assert(exists(dup) && exists(`${ws.root}/dup.png`), '同名双份夹具没建好')
  return `回退 ${MEDIA_ROOT_REL} ⇒ ${abs}；同名双份不串台`
})

check('产物目录被改过 ⇒ 每张卡片按落盘当时的根解析，互不串台', () => {
  // 配置改成 生成区/ 之后生成的产物
  const newer = assetAbsPath({ storage: 'media', path: 'b2.png', pathRoot: '生成区' }, ws.root)
  assert(exists(newer), `改配置后的产物解析失败：${newer}`)
  // 改配置之前就存在的老卡片（无 pathRoot）仍指向默认产物根，不会被"当前配置"带偏
  const older = assetAbsPath({ storage: 'media', path: 'a1.png' }, ws.root)
  assert(older === `${ws.root}/.huabu/media/a1.png`, `老卡片被当前配置带偏：${older}`)
  assert(exists(older), `老卡片解析后文件不存在：${older}`)
  return `新 ${newer} / 老 ${older}`
})

check('ws 形态 ⇒ 按工作区根，中文目录与多级子目录都命中真实文件', () => {
  for (const rel of ['assets/images/c3.png', '素材库/海报产出/d4.png']) {
    const abs = assetAbsPath({ storage: 'ws', path: rel, pathRoot: '不该被用到' }, ws.root)
    assert(abs === `${ws.root}/${rel}`, `拼接不对：${abs}`)
    assert(exists(abs), `解析出的路径落不到真实文件：${abs}`)
  }
  return 'assets/images + 素材库/海报产出 均可定位'
})

check('已是绝对路径 ⇒ 原样归一分隔符，不二次拼接', () => {
  const posix = assetAbsPath({ storage: 'ws', path: '/tmp/outside/x.png' }, ws.root)
  assert(posix === '/tmp/outside/x.png', `POSIX 绝对路径被改写：${posix}`)
  const win = assetAbsPath({ storage: 'ws', path: 'D:\\inbox\\y.png' }, ws.root)
  assert(win === 'D:/inbox/y.png', `Windows 绝对路径未归一：${win}`)
  return '两条路都直接透传'
})

check('卡片尚无文件（未生成完）⇒ null，引用契约据此丢弃', () => {
  assert(assetAbsPath({ storage: 'media', path: '   ' }, ws.root) === null, '空白 path 没返回 null')
  assert(assetAbsPath({ storage: 'media' }, ws.root) === null, '无 path 没返回 null')
  return 'null'
})

check('workspaceAbs 旧语义未变（临时上传与提示词里的工作区根还走它）', () => {
  assert(workspaceAbs('assets/x.png', ws.root) === `${ws.root}/assets/x.png`, '相对拼接变了')
  assert(workspaceAbs('D:\\inbox\\y.png', ws.root) === 'D:/inbox/y.png', '绝对路径透传变了')
  return '相对拼接 / 绝对透传 两项不变'
})

check('单一事实来源：默认产物根字面量只在 shared/assets.ts', () => {
  const offenders = []
  const walk = (entry) => {
    const stat = fs.statSync(entry)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) {
        if (name === 'node_modules' || name === 'out') continue
        walk(path.join(entry, name))
      }
      return
    }
    if (!/\.tsx?$/.test(entry) || entry === SOURCE) return
    const text = fs.readFileSync(entry, 'utf8')
    if (text.includes("'.huabu', 'media'") || text.includes("'.huabu/media'")) {
      offenders.push(path.relative(PROJECT_ROOT, entry))
    }
  }
  walk(path.join(PROJECT_ROOT, 'src'))
  assert(offenders.length === 0, `又出现写死的产物根：${offenders.join(', ')}`)
  return '主进程与渲染端都取 MEDIA_ROOT_REL'
})

check('引用契约只走 assetAbsPath（禁止再在渲染端手拼卡片路径）', () => {
  // T8 拆分后：解析入口在 contextCollector.ts（sendMessage 经 chatRuntime 调 collectRoundContext）
  const collector = path.join(PROJECT_ROOT, 'src', 'renderer', 'src', 'store', 'canvas', 'contextCollector.ts')
  const collectorText = fs.readFileSync(collector, 'utf8')
  // 调用形态匹配（参数名无关）：意图是"解析必须走 assetAbsPath + 工作区根入参"，
  // 锁死参数名会在重构改名时误报（genSummary 去重重命名 flatMap 参数时踩过）
  assert(
    /assetAbsPath\(\s*\w+\s*,\s*input\.workspaceDir\s*\)/.test(collectorText),
    '引用契约没走 assetAbsPath（这次 bug 的修复点被回退了）'
  )
  assert(!/workspaceAbs\(\s*\w+\.path/.test(collectorText), '又出现 workspaceAbs(<卡片>.path …) 的手拼写法')
  const chatRuntime = path.join(PROJECT_ROOT, 'src', 'renderer', 'src', 'store', 'canvas', 'chatRuntime.ts')
  const runtimeText = fs.readFileSync(chatRuntime, 'utf8')
  assert(runtimeText.includes('collectRoundContext('), 'sendMessage 不再经采集器组装引用（契约被旁路了）')
  const storeFile = path.join(PROJECT_ROOT, 'src', 'renderer', 'src', 'store', 'canvasStore.tsx')
  assert(!/assetAbsPath\(/.test(fs.readFileSync(storeFile, 'utf8')), '装配层不应再直接解析卡片路径（入口收拢被破坏）')
  return 'contextCollector 单一解析入口 + chatRuntime 经采集器'
})

check('read_media 解析：绝对路径命中真实文件并报出所属根', () => {
  const artifact = resolveMediaTarget(`${ws.root}/.huabu/media/a1.png`, roots, exists)
  assert(artifact?.absPath === `${ws.root}/.huabu/media/a1.png`, `产物路径解析错：${artifact?.absPath}`)
  assert(artifact.root === 'media', `产物该报 media 根，报了 ${artifact.root}（文案会误导 Agent）`)
  assert(artifact.kind === 'image', `分类错：${artifact.kind}`)
  const asset = resolveMediaTarget(`${ws.root}/assets/images/c3.png`, roots, exists)
  assert(asset?.root === 'workspace' && asset.kind === 'image', `素材文件解析错：${JSON.stringify(asset)}`)
  const uploaded = resolveMediaTarget(`${ws.inbox}/2026-09-24/upload-9.png`, roots, exists)
  assert(uploaded?.root === 'inbox', `临时上传没认出来：${JSON.stringify(uploaded)}`)
  return 'media / workspace / inbox 三根各自命中'
})

check('read_media 解析：相对路径与裸文件名按根优先级拼并校验存在', () => {
  const rel = resolveMediaTarget('assets/images/c3.png', roots, exists)
  assert(rel?.absPath === `${ws.root}/assets/images/c3.png`, `相对路径错：${rel?.absPath}`)
  // 裸文件名：产物根优先（引用契约里生成产物就是这种形态）
  const bare = resolveMediaTarget('a1.png', roots, exists)
  assert(bare?.absPath === `${ws.root}/.huabu/media/a1.png`, `裸文件名没落到产物根：${bare?.absPath}`)
  // exists 参与判定：产物根里没有就得换下一个根，不能停在第一个候选上报"不存在"
  const onlyWs = resolveMediaTarget('clip.mp4', roots, exists)
  assert(onlyWs?.absPath === `${ws.root}/clip.mp4` && onlyWs.kind === 'video', `跨根回退失败：${JSON.stringify(onlyWs)}`)
  const ghost = resolveMediaTarget('assets/images/没这个文件.png', roots, exists)
  assert(ghost === null, `不存在的文件被编出了路径：${JSON.stringify(ghost)}`)
  return '相对 / 裸名 / 跨根回退 / 不存在拒'
})

check('read_media 解析：越界一律拒（折叠 .. 之后再比前缀）', () => {
  const escapes = [
    `${ws.root}/assets/../../etc/passwd`,
    `${ws.root}/.huabu/media/../../../../Windows/win.ini`,
    '/etc/passwd',
    'D:\\Windows\\system32\\config.sam'
  ]
  const leaked = escapes.filter((raw) => resolveMediaTarget(raw, roots) !== null)
  assert(leaked.length === 0, `这些路径被放行了：${leaked.join(' | ')}`)
  // 前缀相似但不是子目录（<parent>/ws 与 <parent>/ws-evil）也不能算在工作区内
  const sibling = resolveMediaTarget(`${ws.root}-evil/secret.png`, roots)
  assert(sibling === null, `同前缀的兄弟目录被放行：${JSON.stringify(sibling)}`)
  // 带 .. 但折叠后仍落在允许根内 → 允许，且报的是折叠后的干净路径（不是旁路：
  // 那两个根本来就允许，旁路的定义是"折叠后跑到根外"）
  const foldedInbox = resolveMediaTarget(`${ws.inbox}/../ws/assets/images/c3.png`, roots, exists)
  assert(foldedInbox?.absPath === `${ws.root}/assets/images/c3.png`, `折叠没生效：${JSON.stringify(foldedInbox)}`)
  const foldedWs = resolveMediaTarget(`${ws.root}/../ws/notes/hello.txt`, roots, exists)
  assert(foldedWs?.absPath === `${ws.root}/notes/hello.txt` && foldedWs.kind === 'text', `工作区内折叠错：${JSON.stringify(foldedWs)}`)
  return `${escapes.length + 1} 种越界写法全拒 + 2 种合法折叠报干净路径`
})

check('read_media 分类：认识的后缀归位，不认识的落 other 而不是猜', () => {
  const cases = { 'x.PNG': 'image', 'a.mp4': 'video', 'b.WAV': 'audio', 'c.md': 'text', 'd.sh': 'other', '无后缀': 'other' }
  for (const [name, kind] of Object.entries(cases)) {
    const got = mediaKindForFileName(name)
    assert(got === kind, `${name} 分类成 ${got}，应为 ${kind}`)
  }
  return Object.keys(cases).length + ' 种后缀'
})

fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.rmSync(path.dirname(ws.root), { recursive: true, force: true })
const pass = results.filter((r) => r.pass).length
console.log(`\n================ asset-path:check ${pass}/${results.length} PASS ================`)
process.exit(pass === results.length ? 0 : 2)
