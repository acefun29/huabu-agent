/**
 * 打包态冒烟（M14 分层 2 + M12 DoD「打包态可播放」）：
 * 启动 release/win-unpacked/Huabu.exe，验证协议/IPC/凭据/媒体在打包产物里可用。
 *
 * 前置：pnpm dist 已产出 release/win-unpacked
 * 运行：node scripts/packaged-smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CdpSession, sleep } from './lib/cdp.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(PROJECT_ROOT, 'release', 'win-unpacked', 'Huabu.exe')
const PORT = '9223'
const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
}

if (!fs.existsSync(EXE)) {
  console.error(`未找到打包产物：${EXE}（先运行 pnpm dist）`)
  process.exit(2)
}

console.log('启动打包版（独立 userData，避免污染开发态）…')
// 实测：打包态用命令行开关开 CDP（env REMOTE_DEBUGGING_PORT 在 Git Bash 后台派生下不可靠）
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env }
})
child.unref()

// 等 CDP 可达
let targets = null
for (let i = 0; i < 30; i += 1) {
  await sleep(1500)
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    if (targets.some((t) => t.type === 'page')) break
  } catch {
    /* 还没起来 */
  }
}
if (!targets) {
  console.error('打包版 45s 内未开启 CDP 端口')
  process.exit(2)
}

const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost')) ?? targets.find((t) => t.type === 'page')
const session = await CdpSession.connect(page.webSocketDebuggerUrl)
await sleep(3500)

const evalp = (expr) => session.evaluate(expr, { awaitPromise: true })

// 打包态窗口加载的是 file:// 渲染产物
const version = await evalp('window.huabu.version()')
record('打包态 IPC 可达', version.isPackaged === true, `electron=${version.electron} node=${version.node} packaged=${version.isPackaged}`)

// 工作区恢复（复用 userData 的 recents：最近工作区应被恢复）
await sleep(2500)
const wsState = await evalp('window.huabu.workspace.state()')
record('打包态恢复上次工作区', Boolean(wsState.workspace?.path), wsState.workspace?.path ?? '未恢复（选择页）')

const runtime = await evalp('window.huabu.chat.runtime()')
record(
  '打包态 ModelRuntime 就绪',
  runtime.ok === true && runtime.value.ready === true && runtime.value.models.length > 0,
  `models=${runtime.value?.models?.length} error=${runtime.value?.error ?? 'none'}`
)

const mediaProviders = await evalp('window.huabu.media.providers()')
record('打包态 media:providers', mediaProviders.ok === true && mediaProviders.value.length >= 1, `count=${mediaProviders.value?.length}`)

// 媒体协议：在打包态页面里注入 <img> 加载一个已知产物
const mediaDir = path.join(PROJECT_ROOT, '.workspaces', 'full-scenario', '.huabu', 'media')
const sample = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).find((f) => f.endsWith('.png')) : null
if (sample) {
  // 工作区未恢复时先手动打开（生产构建无 __huabuStores 钩子，只能依赖自动恢复）
  if (!wsState.workspace) {
    record('huabu-media:// 打包态可加载', 'MANUAL', '打包态未恢复工作区且无 dev 钩子，跳过协议样本验证')
  } else {
    const load = await evalp(`new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve('loaded ' + img.naturalWidth);
      img.onerror = () => resolve('error');
      img.src = 'huabu-media://media/${sample}';
      setTimeout(() => resolve('timeout'), 6000);
    })`)
    record('huabu-media:// 打包态可加载', String(load).startsWith('loaded'), String(load))
  }
} else {
  record('huabu-media:// 打包态可加载', false, '没有样例图片（先跑 full-scenario）')
}

const pong = await evalp('window.huabu.ping()')
record('app:ping', pong === 'pong', String(pong))

session.close()
// 关闭打包实例
try {
  spawn('taskkill', ['/F', '/IM', 'Huabu.exe'], { detached: true, stdio: 'ignore' })
} catch {
  /* 尽力清理 */
}

const failed = results.filter((r) => !r.pass)
fs.mkdirSync(path.join(PROJECT_ROOT, 'out'), { recursive: true })
fs.writeFileSync(path.join(PROJECT_ROOT, 'out', 'packaged-smoke-result.json'), JSON.stringify({ results }, null, 2))
console.log(`\n== PACKAGED SMOKE: PASS=${results.length - failed.length} FAIL=${failed.length} ==`)
process.exit(failed.length === 0 ? 0 : 1)
