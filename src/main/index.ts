import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { join } from 'path'
import { disposeChatSessions, getMcpManager, getWorkspaceStore, registerIpcHandlers } from './ipc'
import { startWebBridge, setActiveBridge } from './webBridge/server'
import { IpcChannel } from '../shared/ipc'
import { initMediaProtocol, registerMediaSchemePrivileged } from './media/protocol'
import { inboxRoot } from './assets/manager'
import { readOrCreateDevToken, devBridgePort } from './devBridgeToken'
import { requestCloseFlushConfirmation } from './ipc/closeFlush'

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

  /*
   * 正常关窗先收口再退。
   *
   * 渲染端画布自动保存有 800ms 防抖、主进程写盘还有 200ms 合并窗口，直接 close
   * 会把「刚新建的会话 / 刚改的卡片」丢在内存里（实测窗口内关闭只留下上一版）。
   * 这里拦一次 close：请渲染端立刻冲刷，确认落盘后再关闭；失败时提示用户。
   */
  let closing = false
  mainWindow.on('close', (event) => {
    // 收口期间的所有 close 都走同一条路径：destroy 由 finishWindowClose 自己调，
    // 避免「连点关闭」绕过冲刷（repeat 事件也只挂起、不再排一次收口）
    event.preventDefault()
    if (closing) return
    closing = true
    void finishWindowClose(mainWindow).catch(async (error) => {
      console.error('[main] 关闭前保存画布失败：', error)
      if (mainWindow.isDestroyed()) return
      try {
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: '画布未保存',
          message: '无法确认画布已保存。',
          detail: '返回应用后可检查存储空间或权限并重试；仍然关闭可能丢失未保存的更改。',
          buttons: ['返回应用', '仍然关闭'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        if (result.response === 1 && !mainWindow.isDestroyed()) mainWindow.destroy()
      } catch (dialogError) {
        console.error('[main] 无法显示保存失败提示：', dialogError)
      } finally {
        closing = false
      }
    })
  })

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

/** 关闭前等渲染端冲刷画布快照的上限：超过就按「渲染端已卡住」直接退，不能把退出挂死 */
const CLOSE_FLUSH_TIMEOUT_MS = 1500

/**
 * 关窗收口：渲染端 800ms 防抖 → 主进程 200ms 合并，两层缓冲都要在退出前冲刷。
 * 放行信号只认渲染端对**本次**关闭请求的回执（app:flush-done）或超时：
 * 合并窗口里可能躺着更早的快照，它的落盘事件不能当作「最新编辑已保存」的证据。
 */
async function finishWindowClose(window: BrowserWindow): Promise<void> {
  const store = getWorkspaceStore()
  if (store?.currentDir && !window.isDestroyed()) {
    // 先挂等待者再发事件：渲染端的回执可能比等待者就位更早到
    const confirmed = requestCloseFlushConfirmation(CLOSE_FLUSH_TIMEOUT_MS)
    window.webContents.send(IpcChannel.AppFlushBeforeClose)
    if (!(await confirmed)) throw new Error('渲染端未确认画布保存成功')
  }
  // 主进程侧最后一道：把渲染端刚交上来（或更早）的最后一版快照写盘
  store?.flushPendingWrites()
  if (!window.isDestroyed()) window.destroy()
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
  // 画布快照最后一道冲刷：窗口 close 流程之外的退出路径（系统关机、Cmd+Q）也覆盖
  try {
    getWorkspaceStore()?.flushPendingWrites()
  } catch (error) {
    console.error('[main] 退出前保存画布失败：', error)
  }
  disposeChatSessions()
  // MCP 子进程关停（关 stdin → 等 SDK 兜底 kill）；close 异步但触发即算完成职责
  getMcpManager()?.disposeAll()
})
