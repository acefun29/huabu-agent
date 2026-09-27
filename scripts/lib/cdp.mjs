/**
 * CDP（Chrome DevTools Protocol）客户端：连到「正在运行的 Electron 窗口」上驱动真实 UI。
 *
 * 为什么要这一层：会话能力依赖 window.huabu（preload 注入），纯浏览器打开 dev server 时
 * 它并不存在，UI 会整体降级，因此在浏览器里跑不出任何有意义的验收结论。
 * 只有连进 Electron 的渲染进程，才能验到「用户实际看到的东西」。
 *
 * 前置：dev 需开启远程调试端口
 *   PowerShell:  $env:REMOTE_DEBUGGING_PORT='9222'; pnpm dev
 *
 * 与单次探针脚本（如 ipc-selfcheck 的内联求值）不同：这里提供 id 递增 + pending 表
 * + awaitPromise + 轮询采样，可以编排多步骤验收。
 *
 * 依赖 Node >= 22 内置的 fetch 与 WebSocket。
 */

/**
 * 注入页面的 DOM helper。
 *
 * 本函数通过 `fn.toString()` 序列化后在页面里执行，因此**不能引用任何模块作用域的变量**，
 * 也不能用 import 进来的东西。好处是它有真实语法检查，不必在字符串里转义 `${`。
 */
export function installDomHelpers() {
  const q = (sel, root) => (root || document).querySelector(sel)
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel))

  const nodeWrap = (id) => q('[data-node-id="' + id + '"]')

  /** React 受控组件不能直接赋 value：必须走原生 setter 再派发 input 事件 */
  const setNativeValue = (el, value) => {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  /** 画布上所有节点：[{id, type}]，type 由子组件的 testid 判定（画布只剩文件卡片） */
  const nodeIds = () =>
    qa('[data-node-id]').map((el) => {
      const id = el.getAttribute('data-node-id')
      const type = q('[data-testid="gen-node"]', el)
        ? 'gen'
        : q('[data-testid="asset-node"]', el)
          ? 'asset'
          : 'unknown'
      return { id, type }
    })

  const genIds = () => nodeIds().filter((n) => n.type === 'gen').map((n) => n.id)
  const assetIds = () => nodeIds().filter((n) => n.type === 'asset').map((n) => n.id)

  /**
   * 底部对话坞可观测状态（对话历史不再有会话卡片，全部渲染在 ChatDock 里；
   * 折叠态 DOM 仍然完整存在，只是视觉上被裁剪，因此这里读的是用户真实看到的渲染产物）。
   */
  const dock = () => {
    const el = q('[data-testid="chat-dock"]')
    if (!el) return { visible: false, messages: [], tools: [], thinkingBlocks: 0 }
    const messages = qa('[data-testid="chat-message-user"], [data-testid="chat-message-model"]', el).map((item) => ({
      role: item.getAttribute('data-testid') === 'chat-message-user' ? 'user' : 'model',
      streaming: item.getAttribute('data-streaming') === 'true',
      text: (item.textContent || '').slice(0, 600)
    }))
    return {
      visible: true,
      messages,
      running: messages.some((m) => m.streaming),
      tools: qa('[data-testid="tool-call"]', el).map((card) => ({
        name: card.getAttribute('data-tool-name'),
        status: card.getAttribute('data-status')
      })),
      thinkingBlocks: qa('[data-testid="thinking-block"]', el).length,
      fullText: (el.textContent || '').slice(0, 4000)
    }
  }

  const snapshot = dock

  /** 底部输入框状态：内容/按钮可用性/引用 chips（会话坞模型：输入框只有对话一个身份） */
  const composer = () => {
    const el = q('[data-testid="composer"]')
    if (!el) return null
    const ta = q('textarea', el)
    const submit = q('[data-testid="composer-submit"]', el)
    const statusEl = q('[data-testid="composer-status"]', el)
    const chatChip = q('[data-testid="active-chat-chip"]', el)
    return {
      value: ta ? ta.value : '',
      submitDisabled: submit ? submit.disabled : null,
      status: statusEl ? (statusEl.textContent || '').trim() : '',
      chips: qa('[data-testid="context-chip"]', el).map((c) => (c.textContent || '').trim()),
      tempChips: qa('[data-testid="temp-chip"]', el).map((c) => (c.textContent || '').trim()),
      activeChatChip: chatChip ? (chatChip.textContent || '').trim() : null
    }
  }

  /** 通过底部输入框发送（真实 UI 路径：受控 setter + 按钮点击） */
  const send = (text) => {
    const el = q('[data-testid="composer"]')
    if (!el) return { ok: false, error: '未找到底部输入框' }
    const ta = q('textarea', el)
    if (!ta) return { ok: false, error: '未找到输入区' }
    if (text != null) setNativeValue(ta, text)
    const submit = q('[data-testid="composer-submit"]', el)
    if (!submit) return { ok: false, error: '未找到发送按钮' }
    if (submit.disabled) return { ok: false, error: '发送按钮为 disabled（可能在生成中或内容为空）' }
    submit.click()
    return { ok: true }
  }

  /** 生成卡片可观测状态：状态/进度/版本/产物路径/内联提示词 */
  const genSnapshot = (id) => {
    const el = nodeWrap(id)
    if (!el) return null
    const gen = q('[data-testid="gen-node"]', el)
    if (!gen) return null
    const status = gen.getAttribute('data-status')
    const statusPill = qa('span', gen).map((s2) => (s2.textContent || '').trim())
    const progressMatch = statusPill.find((t) => /生成中 \d+%/.test(t))
    const pathEl = qa('span.font-mono', gen)
      .map((s2) => (s2.textContent || '').trim())
      .find((t) => t.includes('/'))
    const promptTa = q('textarea', gen)
    return {
      id,
      status,
      prompt: promptTa ? promptTa.value : null,
      progress: progressMatch
        ? Number(progressMatch.match(/\d+%/)[0].replace('%', '')) / 100
        : status === 'succeeded'
          ? 1
          : 0,
      versionButton: q('[data-testid="switch-version"]', gen)
        ? (q('[data-testid="switch-version"]', gen).textContent || '').trim()
        : null,
      pathText: pathEl ?? null,
      retryVisible: Boolean(q('[data-testid="retry-generate"]', gen)),
      regenerateVisible: Boolean(q('[data-testid="regenerate"]', gen)),
      errorText: status === 'failed' ? (gen.textContent || '').slice(0, 300) : null
    }
  }

  const workspaceBadge = () => {
    const el = q('[data-testid="workspace-badge"]')
    return el ? { path: el.getAttribute('data-path') || '', name: (el.textContent || '').trim() } : null
  }

  /** 确认框 / Toast / 查看器 / 设置面板 */
  const confirmDialog = (accept) => {
    const el = q('[data-testid="confirm-dialog"]')
    if (!el) return { visible: false }
    if (accept) {
      const button = q('[data-testid="confirm-accept"]', el)
      if (!button) return { visible: true, accepted: false }
      button.click()
      return { visible: true, accepted: true }
    }
    return { visible: true, text: (el.textContent || '').slice(0, 300) }
  }

  const toastText = () => {
    const els = qa('.fixed.bottom-28')
    return els.length > 0 ? (els[els.length - 1].textContent || '').trim() : null
  }

  const viewer = () => {
    const el = q('[data-testid="media-viewer"]')
    if (!el) return { visible: false }
    return {
      visible: true,
      image: Boolean(q('[data-testid="viewer-image"]', el)),
      video: Boolean(q('[data-testid="viewer-video"]', el)),
      audio: Boolean(q('[data-testid="viewer-audio"]', el)),
      caption: (el.textContent || '').slice(0, 200)
    }
  }

  const settingsPanel = () => {
    const el = q('[data-testid="settings-panel"]')
    return el ? { open: true, text: (el.textContent || '').slice(0, 400) } : { open: false }
  }

  const openSettings = () => {
    const button = qa('button').find((item) => item.getAttribute('title') === '设置')
    if (!button) return { ok: false, error: '未找到设置按钮' }
    button.click()
    return { ok: true }
  }

  /** 左侧图标栏：点开某个浮层面板（sessions/libraries）；返回是否找到按钮 */
  const openRail = (tab) => {
    const button = q('[data-tour="rail-' + tab + '"]')
    if (!button) return { ok: false, error: '未找到图标栏按钮：' + tab }
    button.click()
    return { ok: true }
  }

  /** 会话浮层面板：面板可见性与会话条目（对话坞模型的会话列表入口） */
  const sessionPanel = () => {
    const items = qa('[data-testid="session-item"]')
    return {
      open: items.length > 0,
      count: items.length,
      titles: items.map((item) => (item.textContent || '').trim().slice(0, 60))
    }
  }

  /** 侧栏清空画布按钮：两步确认状态 */
  const clearCanvasButton = () => {
    const el = q('[data-testid="clear-canvas"]')
    return el ? { visible: true, confirming: el.getAttribute('data-confirming') === 'true' } : { visible: false }
  }

  /** dev 测试桥（store 级动作，与 UI 按钮同路径） */
  const store = () => window.__huabuCanvas ?? null

  /*
   * 轨迹观测器：MutationObserver 记录对话坞流式文本长度与工具状态每一次变化。
   * CDP 轮询（150ms+）会漏采几十毫秒的中间态，页面内观察者不会。
   */
  const WATCH_LIMIT = 20000
  const watchLog = []
  let lastEntry = null
  let observer = null

  const noteDock = () => {
    const d = dock()
    if (!d.visible) return
    const draftLength = d.messages.reduce((sum, item) => sum + (item.text || '').length, 0)
    const tools = d.tools.map((card) => card.name + ':' + card.status).join(',')
    const streaming = d.running
    if (lastEntry && lastEntry.draftLength === draftLength && lastEntry.tools === tools && lastEntry.streaming === streaming) {
      return
    }
    lastEntry = { draftLength, tools, streaming, at: Date.now() }
    if (watchLog.length < WATCH_LIMIT) watchLog.push(lastEntry)
  }

  const startWatch = () => {
    watchLog.length = 0
    lastEntry = null
    if (observer) observer.disconnect()
    observer = new MutationObserver(() => noteDock())
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-status', 'data-streaming']
    })
    noteDock()
    return { ok: true }
  }

  const stopWatch = () => {
    if (observer) observer.disconnect()
    observer = null
    const log = watchLog.slice()
    watchLog.length = 0
    lastEntry = null
    return log
  }

  window.__dod = {
    nodeIds,
    assetIds,
    genIds,
    dock,
    snapshot,
    composer,
    send,
    genSnapshot,
    workspaceBadge,
    confirmDialog,
    toastText,
    viewer,
    settingsPanel,
    openSettings,
    openRail,
    sessionPanel,
    clearCanvasButton,
    store,
    startWatch,
    stopWatch
  }
  return true
}

const HELPER_SOURCE = `(${installDomHelpers.toString()})()`

export class CdpError extends Error {}

/**
 * 一条 CDP WebSocket 连接。消息 id 递增，用 pending 表把响应对回请求，
 * 因此可以并发发多个命令。
 */
export class CdpSession {
  #ws
  #nextId = 1
  #pending = new Map()
  #closed = false

  constructor(ws) {
    this.#ws = ws
    ws.addEventListener('message', (event) => this.#onMessage(String(event.data)))
    ws.addEventListener('close', () => {
      this.#closed = true
      for (const [, entry] of this.#pending) {
        entry.reject(new CdpError('CDP 连接已关闭'))
      }
      this.#pending.clear()
    })
  }

  static async connect(wsUrl, { timeout = 10_000 } = {}) {
    if (typeof WebSocket === 'undefined') {
      throw new CdpError('当前 Node 未启用全局 WebSocket，请用 Node >= 22 运行')
    }
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('CDP 握手超时')), timeout)
      ws.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true })
      ws.addEventListener(
        'error',
        () => (clearTimeout(timer), reject(new CdpError(`WebSocket 连接失败：${wsUrl}`))),
        { once: true }
      )
    })
    return new CdpSession(ws)
  }

  #onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return
    const entry = this.#pending.get(msg.id)
    if (!entry) return
    this.#pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) entry.reject(new CdpError(`CDP 错误：${JSON.stringify(msg.error)}`))
    else entry.resolve(msg.result)
  }

  send(method, params = {}, { timeout = 30_000 } = {}) {
    if (this.#closed) return Promise.reject(new CdpError('CDP 连接已关闭'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError(`${method} 超时（${timeout}ms）`))
      }, timeout)
      this.#pending.set(id, { resolve, reject, timer })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * @param {boolean} awaitPromise 表达式返回 Promise 时必须开，否则拿到的是空对象
   */
  async evaluate(expression, { awaitPromise = false, timeout = 30_000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      { timeout }
    )
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知异常'
      throw new CdpError(`页面求值异常：${text}`)
    }
    return result.result?.value
  }

  close() {
    this.#closed = true
    try {
      this.#ws.close()
    } catch {
      /* 关闭失败无所谓，进程马上就退出了 */
    }
  }
}

/**
 * 连到渲染页面（跳过 service worker / iframe 之类的其它 target）。
 * dev 下渲染进程的 url 是 http://localhost:5173/，用它来认页面最可靠。
 */
export async function connectRendererPage({ port = '9222', urlHint = 'localhost:5173' } = {}) {
  const base = `http://127.0.0.1:${port}`
  let targets
  try {
    targets = await (await fetch(`${base}/json/list`)).json()
  } catch (error) {
    throw new CdpError(
      `连不上 ${base}：${error.message}。请确认 dev 已用 REMOTE_DEBUGGING_PORT=${port} 启动`
    )
  }

  const pages = targets.filter((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  if (pages.length === 0) {
    throw new CdpError(`未发现可调试页面，targets=${JSON.stringify(targets.map((t) => t.type))}`)
  }
  const page = pages.find((item) => String(item.url).includes(urlHint)) ?? pages[0]
  const session = await CdpSession.connect(page.webSocketDebuggerUrl)
  return { session, page }
}

/** 注入 DOM helper，之后页面里就有 window.__dod */
export async function installHelpers(session) {
  const ok = await session.evaluate(HELPER_SOURCE)
  if (ok !== true) throw new CdpError('DOM helper 注入失败')
}

/** 调用 window.__dod 上的方法 */
export async function callHelper(session, method, ...args) {
  const argSource = args.map((item) => JSON.stringify(item)).join(', ')
  return session.evaluate(`window.__dod.${method}(${argSource})`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询采样直到满足条件。
 *
 * 返回**采样轨迹**而不只是最后一个值：DoD 里「流式逐字出现」「三路同时在跑」
 * 这类断言只能靠轨迹判定，末态看不出过程。
 */
export async function pollUntil(session, sample, predicate, options = {}) {
  const { timeout = 60_000, interval = 300, label = 'poll', onSample = null } = options
  const deadline = Date.now() + timeout
  const samples = []
  let last
  while (Date.now() < deadline) {
    last = await sample()
    samples.push({ at: Date.now(), value: last })
    if (onSample) onSample(last, samples.length)
    if (predicate(last, samples)) return { value: last, samples, timedOut: false }
    await sleep(interval)
  }
  return { value: last, samples, timedOut: true }
}

export { sleep }
