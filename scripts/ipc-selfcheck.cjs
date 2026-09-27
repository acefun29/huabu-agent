/**
 * IPC 联通自检（诊断工具，不参与打包）。
 *
 * 用途：脱离 dev 热重载时序，单独验证「preload 注入 → window.huabu → ipcMain.handle」这条链路。
 * 它复用 out/preload/index.js（即 pnpm build / pnpm dev 的真实产物），
 * 并注册与 src/main/ipc.ts 完全相同的 handler，因此结论对真窗口有效。
 *
 * 运行：pnpm selfcheck                       仅验证 preload + IPC 链路（加载 about:blank）
 *       pnpm selfcheck --url=http://localhost:5173   加载真实 dev 页面，读真实渲染环境的 IPC 状态
 *
 * 结果同时写到 stdout 与 out/selfcheck-result.json。
 * 写文件是必要的：Windows 上 electron.exe 是 GUI 子系统程序，stdout 不保证被父终端捕获。
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path')
const { writeFileSync, mkdirSync } = require('fs')

const PRELOAD_PATH = join(__dirname, '../out/preload/index.js')
const RESULT_PATH = join(__dirname, '../out/selfcheck-result.json')

// 可选：加载真实页面（dev server），用于复现角标在真窗口里的显示结果
const urlArg = process.argv.find((arg) => arg.startsWith('--url='))
const TARGET_URL = urlArg ? urlArg.slice('--url='.length) : null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @type {Record<string, unknown>} */
const result = {
  startedAt: new Date().toISOString(),
  preloadPath: PRELOAD_PATH,
  preloadError: null,
  consoleErrors: [],
  probe: null,
  targetUrl: TARGET_URL,
  badge: null,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  verdict: 'unknown'
}

function flush() {
  mkdirSync(join(__dirname, '../out'), { recursive: true })
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8')
}

// 与 src/main/ipc.ts 保持一致
ipcMain.handle('app:ping', () => 'pong')
ipcMain.handle('app:version', () => ({
  appVersion: app.getVersion(),
  electron: process.versions.electron ?? 'unknown',
  node: process.versions.node,
  chrome: process.versions.chrome ?? 'unknown',
  isPackaged: app.isPackaged
}))

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // preload 脚本自身抛错时，Electron 通过这个事件通知主进程（终端里未必看得到）
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    result.preloadError = {
      preloadPath,
      message: error?.message ?? String(error),
      stack: error?.stack ?? null
    }
  })

  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) result.consoleErrors.push(message)
  })

  await win.loadURL(TARGET_URL ?? 'about:blank')

  result.probe = await win.webContents.executeJavaScript(
    `(async () => {
      const out = { huabuType: typeof window.huabu, keys: null, ping: null, version: null, error: null }
      try {
        if (window.huabu) {
          out.keys = Object.keys(window.huabu)
          out.ping = await window.huabu.ping()
          out.version = await window.huabu.version()
        }
      } catch (err) {
        out.error = (err && err.message) ? err.message : String(err)
      }
      return out
    })()`,
    true
  )

  // 加载真实页面时，等 React 挂载完成，确认页面本身没有报错
  if (TARGET_URL) {
    await sleep(3000)
  }

  const probe = result.probe ?? {}
  const ipcOk = probe.huabuType === 'object' && probe.ping === 'pong' && !probe.error && !result.preloadError
  result.verdict = ipcOk ? 'PASS' : 'FAIL'
  result.finishedAt = new Date().toISOString()

  flush()
  process.stdout.write(`[selfcheck] ${result.verdict}\n${JSON.stringify(result, null, 2)}\n`)

  win.destroy()
  app.exit(result.verdict === 'PASS' ? 0 : 1)
})
