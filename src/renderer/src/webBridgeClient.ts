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
 * 接入：main 以 HUABU_WEB_BRIDGE=1 启动后会打印
 *   http://localhost:5174/?bridge=4788&token=xxxx
 * 打开该地址即可（token 记在 localStorage，后续免带）。
 */

import type { HuabuApi } from '../../shared/api'
import { createHuabuApi } from '../../shared/apiFactory'

export interface WebBridgeConfig {
  /** 桥端口（main 侧打印） */
  port: number
  /** 一次性 token */
  token: string
}

const TOKEN_KEY = 'huabu.webBridge'

/** 从 URL / localStorage 解析桥配置；缺失返回 null（此时不应启用远程桥） */
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
  const base = `http://127.0.0.1:${config.port}`
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let socket: WebSocket | null = null
  let connecting = false

  /** 懒连接 WS；有订阅者时断线自动重连 */
  const ensureSocket = (): void => {
    if (socket || connecting) return
    connecting = true
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${config.port}/events?token=${encodeURIComponent(config.token)}`)
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

  const invoke = async <T = unknown>(channel: string, payload?: unknown): Promise<T> => {
    const res = await fetch(`${base}/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ channel, payload }),
    })
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
