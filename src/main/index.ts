import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { disposeChatSessions, getMcpManager, getWorkspaceStore, registerIpcHandlers } from './ipc'
import { startWebBridge, setActiveBridge } from './webBridge/server'
import { IpcChannel } from '../shared/ipc'
import { initMediaProtocol, registerMediaSchemePrivileged } from './media/protocol'
import { inboxRoot } from './assets/manager'
import { readOrCreateDevToken, devBridgePort } from './devBridgeToken'

/**
 * 主进程入口。
 *
 * 职责：创建窗口、注册 IPC、注册媒体协议、加载渲染进程。
 * 会话运行时（Mastra）在 registerIpcHandlers 里创建，见 src/main/ipc/chat.ts。
 * huabu-media:// 特权协议必须在 app ready 前注册 scheme，ready 后绑定处理器。
 */

/**
 * 无窗口（headless）模式：主进程只当后端跑，不创建 BrowserWindow。
 *
 * 为什么需要：真数据/真模型都在主进程里，而调试前端时用浏览器更顺手。
 * `pnpm web` 即 `electron-vite dev -- --huabu-headless`：dev server 提供 renderer，
 * 主进程起 Web 桥并自动打开浏览器——不需要再弹 Electron 窗口。
 *
 * 开关名带 huabu 前缀：避开 Chromium 自己的 `--headless`。
 */
const HEADLESS =
  process.argv.includes('--huabu-headless') || process.env['HUABU_HEADLESS'] === '1'

// README 约定的调试端口环境变量：显式接线（appendSwitch 必须在 app ready 之前）
if (!app.isPackaged && process.env['REMOTE_DEBUGGING_PORT'] && !HEADLESS) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['REMOTE_DEBUGGING_PORT'])
}

/**
 * 开发期桥 token：与 renderer 编译期读到的**同一个文件**（src/main/devBridgeToken）。
 * 这样浏览器地址固定为 http://localhost:5173/，不需要 ?token=，重启也不失效。
 */
const DEV_BRIDGE_TOKEN = readOrCreateDevToken()

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Huabu',
    frame: false,
    backgroundColor: '#f7f7f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 最大化状态推给渲染进程，自绘标题栏用来切换最大化/还原图标
  const sendWindowState = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.WindowStateChanged, {
        maximized: mainWindow.isMaximized()
      })
    }
  }
  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 外部链接交给系统浏览器，禁止在应用内开新窗口。
  // 协议白名单：file://、smb:// 等任意协议都能经聊天内容里的链接触发 openExternal，
  // 只放行 http(s)；new URL 解析失败同样视为不安全。
  mainWindow.webContents.setWindowOpenHandler((details) => {
    let protocol = ''
    try {
      protocol = new URL(details.url).protocol
    } catch {
      // 解析失败保持空串，落入下方拒绝分支
    }
    if (protocol === 'https:' || protocol === 'http:') {
      void shell.openExternal(details.url)
    } else {
      console.warn('[main] 拒绝非 http(s) 外链：' + details.url)
    }
    return { action: 'deny' }
  })

  /** 启动瞬时竞态（网络服务偶发重启）会让首次加载静默失败停在 about:blank，重试到成功为止 */
  const loadWithRetry = async (load: () => Promise<void>, attempt = 0): Promise<void> => {
    try {
      await load()
    } catch (error) {
      if (attempt >= 5 || mainWindow.isDestroyed()) throw error
      console.warn(`[main] 渲染页加载失败，1s 后重试（第 ${attempt + 1} 次）：${String(error)}`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return loadWithRetry(load, attempt + 1)
    }
  }

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void loadWithRetry(() => mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] as string))
    // 性能基准（pnpm bench）时关掉：detached DevTools 本身会显著拖累帧率，污染测量
    if (!process.env['HUABU_NO_DEVTOOLS']) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    // file:// 分支同样可能撞上网络服务重启竞态（preview/打包态实测出现过空白窗口），一并进行重试
    void loadWithRetry(() => mainWindow.loadFile(join(__dirname, '../renderer/index.html')))
  }

  return mainWindow
}

// scheme 特权必须在 ready 前注册；处理器在 ready 后绑定当前工作区的媒体目录
registerMediaSchemePrivileged()

void app.whenReady().then(() => {
  // 自绘标题栏替代原生菜单栏（File/Edit/View/Window 是 Electron 默认菜单）
  Menu.setApplicationMenu(null)
  registerIpcHandlers()
  // Web 后端桥（默认关闭）：HUABU_WEB_BRIDGE=1 / --headless 时监听 127.0.0.1，供浏览器里的
  // renderer 调同一批 IPC handler（复用业务逻辑，不重写）。仅本地开发用途，生产不启用。
  const bridgeEnabled = HEADLESS || process.env.HUABU_WEB_BRIDGE === '1'
  if (bridgeEnabled) {
    // 前端地址：dev 下是 electron-vite 的 renderer dev server；缺省退回 5173
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173'
    void startWebBridge({ port: devBridgePort(), token: DEV_BRIDGE_TOKEN })
      .then((bridge) => {
        setActiveBridge(bridge)
        const entry = `${rendererUrl}/?bridge=${bridge.port}&token=${bridge.token}`
        console.log(`[web-bridge] 浏览器接入：${entry}`)
        // headless 下没有窗口可看，直接把浏览器打开到真实后端
        if (HEADLESS) void shell.openExternal(entry)
      })
      .catch((error) => console.error('[web-bridge] 启动失败：', error))
  }
  // 媒体协议服务四个根：media=产物目录，ws=工作区根，inbox=临时收件箱（工作区之外），thumbs=缩略图缓存
  initMediaProtocol(() => {
    const store = getWorkspaceStore()
    return {
      mediaDir: store?.mediaDir() ?? null,
      workspaceDir: store?.currentDir ?? null,
      inboxDir: inboxRoot(),
      thumbsDir: store?.currentDir ? join(store.currentDir, '.huabu', 'thumbs') : null
    }
  })
  // headless：不建窗口，进程常驻只服务 Web 桥
  if (!HEADLESS) {
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  }
})

app.on('window-all-closed', () => {
  // headless 没有窗口，不能因为「窗口都关了」退出（否则桥刚起来就停）
  if (HEADLESS) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出前释放会话：Mastra 的两张表（sessions + OM bindings）。will-quit 里无法阻塞
// 等待，所以这里只做同步收口 + 触发异步关停（Pi 侧已随运行时移除）。
app.on('will-quit', () => {
  disposeChatSessions()
  // MCP 子进程关停（关 stdin → 等 SDK 兜底 kill）；close 异步但触发即算完成职责
  getMcpManager()?.disposeAll()
})
