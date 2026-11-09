/**
 * 浏览器侧的远程 bridge 客户端（Web + 真后端）。
 *
 * 与 preload **共用同一个 `createHuabuApi` 工厂**：方法名、参数形状、channel 绑定
 * 完全一致，差别只在传输层——
 *   preload：ipcRenderer.invoke / 原生事件通道
 *   这里    ：POST /invoke  / WebSocket /events
 *
 * 因此 renderer 业务代码一行都不用改（store / 组件只认 window.huabu）。
 *
 * 接入：`pnpm web` 会以 headless 模式起主进程（不建 Electron 窗口），并自动打开浏览器。
 * 地址里**不需要 token**：dev 期 token 由 electron.vite.config 在编译期注入
 * （见 src/shared/devBridgeToken，与主进程读同一个文件），所以
 *   http://localhost:5173/
 * 即可，重启也不会失效。URL 上仍可显式带 ?bridge=&token=（临时换桥/排查用）。
 */

import type { HuabuApi } from '../../shared/api'
import { createHuabuApi } from '../../shared/apiFactory'

declare const __HUABU_DEV_BRIDGE__: WebBridgeConfig | null

export interface WebBridgeConfig {
  /** 桥端口（main 侧打印） */
  port: number
  /** 桥 token（开发期持久化，重启后仍有效） */
  token: string
}

/** 旧地址缓存键：仅作兼容回退（编译期注入优先） */
const TOKEN_KEY = 'huabu.webBridge'

/** 编译期注入的桥配置（仅 electron-vite 的 renderer 构建有；web:mock 下为 undefined） */
function injectedBridgeConfig(): WebBridgeConfig | null {
  try {
    if (typeof __HUABU_DEV_BRIDGE__ === 'undefined') return null
    return __HUABU_DEV_BRIDGE__ ?? null
  } catch {
    // 未注入（如纯 vite mock 预览）时该标识符不存在
    return null
  }
}

/**
 * 从 URL / 编译期注入 / localStorage 解析桥配置；都没有返回 null。
 * 优先级：URL（临时覆盖）> 编译期注入（dev 默认）> localStorage（兼容旧地址）。
 */
export function resolveBridgeConfig(): WebBridgeConfig | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const portParam = params.get('bridge')
  const tokenParam = params.get('token')
  if (portParam && tokenParam) {
    const cfg = { port: Number(portParam), token: tokenParam }
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify(cfg))
    } catch {
      // localStorage 不可用时本次会话仍有效
    }
    return cfg
  }
  const injected = injectedBridgeConfig()
  if (injected) {
    // 覆盖旧地址残留的过期 token，避免 401 死循环
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify(injected))
    } catch {
      // 忽略
    }
    return injected
  }
  try {
    const cached = localStorage.getItem(TOKEN_KEY)
    if (!cached) return null
    const parsed = JSON.parse(cached) as { port?: unknown; token?: unknown }
    if (typeof parsed.port === 'number' && typeof parsed.token === 'string') {
      return { port: parsed.port, token: parsed.token }
    }
  } catch {
    // 解析失败视为未配置
  }
  return null
}

/** 构造 window.huabu：底层走 HTTP + WS，形状与 preload 完全一致 */
export function createWebBridgeApi(config: WebBridgeConfig): HuabuApi {
  // 供 assetSrc 把 huabu-media:// 改写成 HTTP（图片/视频元素无法带 Authorization 头）
  ;(globalThis as unknown as { __HUABU_MEDIA_BRIDGE__?: WebBridgeConfig }).__HUABU_MEDIA_BRIDGE__ = config
  /** 运行时可变：401 时换成编译期注入的 token 重试一次（旧标签页里残留的过期 token 自愈） */
  let token = config.token
  const base = `http://127.0.0.1:${config.port}`
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let socket: WebSocket | null = null
  let connecting = false
  /** 已经因为 401 换过 token：避免反复重试 */
  let tokenRefreshed = false

  /** 懒连接 WS；有订阅者时断线自动重连 */
  const ensureSocket = (): void => {
    if (socket || connecting) return
    connecting = true
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${config.port}/events?token=${encodeURIComponent(token)}`)
    } catch {
      connecting = false
      return
    }
    socket = ws
    ws.onopen = () => {
      connecting = false
    }
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { channel?: string; payload?: unknown }
        if (!frame.channel) return
        for (const fn of listeners.get(frame.channel) ?? []) {
          try {
            fn(frame.payload)
          } catch (error) {
            // 单个订阅者抛错不能影响其他订阅者
            console.error('[web-bridge] 事件处理失败', error)
          }
        }
      } catch {
        // 坏帧忽略
      }
    }
    ws.onclose = () => {
      socket = null
      connecting = false
      if (listeners.size > 0) setTimeout(ensureSocket, 1500)
    }
    ws.onerror = () => {
      // onclose 接管重连
    }
  }

  /**
   * 401 自愈：URL 里带着上次会话的旧 token 时（用户手动打开旧标签页/书签），
   * 换成编译期注入的当前 token 再试一次。只做一次，失败就照常抛错。
   */
  const refreshToken = (): boolean => {
    if (tokenRefreshed) return false
    const injected = injectedBridgeConfig()
    if (!injected || injected.token === token) return false
    tokenRefreshed = true
    token = injected.token
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify(injected))
    } catch {
      // 忽略
    }
    // WS 用的是旧 token，重连一次
    socket?.close()
    socket = null
    return true
  }

  const invoke = async <T = unknown>(channel: string, payload?: unknown): Promise<T> => {
    const post = (authToken: string): Promise<Response> =>
      fetch(`${base}/invoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ channel, payload }),
      })
    let res = await post(token)
    if (res.status === 401 && refreshToken()) {
      res = await post(token)
    }
    if (!res.ok) {
      throw new Error(`bridge ${res.status}：${await res.text().catch(() => '')}`)
    }
    const body = (await res.json()) as { ok?: boolean; value?: unknown; error?: string }
    if (body.ok === false) {
      // handler 内部抛错：reject 给调用方（与 ipcRenderer.invoke 语义一致）
      throw new Error(body.error ?? 'bridge handler 失败')
    }
    return body.value as T
  }

  const subscribe = (channel: string, listener: (payload: unknown) => void): (() => void) => {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(listener)
    ensureSocket()
    return () => {
      set!.delete(listener)
      if (set!.size === 0) listeners.delete(channel)
    }
  }

  return createHuabuApi({ invoke, subscribe })
}
