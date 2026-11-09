/**
 * Web 后端桥（HTTP + WebSocket）——让浏览器里的 renderer 操作真实主进程能力。
 *
 * 设计（为什么这样最省）：
 * - **复用现有 IPC handler**：不重写任何业务逻辑。注册 IPC 时同步记一份
 *   channel → handler 表（见 ipcRegistry），HTTP 请求按 channel 直接派发，
 *   与 Electron 内 ipcRenderer.invoke 走同一条代码路径、同一份状态。
 * - **事件走 WS**：主进程已有 broadcastXxx 系列广播函数（chat:event /
 *   media:job / asset:changed / task:event / project:changed / mcp:status）。
 *   桥把它们统一转发到 WS，浏览器按 channel 订阅——与 preload 的 onEvent 语义一致。
 * - **默认关闭**：只有显式 `HUABU_WEB_BRIDGE=1`（或 --web-bridge）才监听，
 *   不改变 Electron 默认行为、不额外开端口。
 *
 * 安全（本地开发通道，不是公网服务）：
 * - 仅监听 127.0.0.1；
 * - 启动时生成一次性 token，renderer 必须带上（?token= / Authorization）；
 * - 不暴露任意文件系统路径（走既有 path guard 的同一批 handler）；
 * - 明确标注为开发用途：生产 Electron 不启用。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'

/** channel → handler（由 IPC 注册层登记） */
export type ChannelHandler = (payload: unknown) => unknown

const registry = new Map<string, ChannelHandler>()

/** IPC 注册时登记：同一个 channel 只登记一次（后注册覆盖，与 ipcMain.handle 语义一致） */
export function registerBridgeChannel(channel: string, handler: ChannelHandler): void {
  registry.set(channel, handler)
}

export function registeredChannels(): string[] {
  return [...registry.keys()]
}

export interface WebBridgeOptions {
  port?: number
  /** 允许的来源（浏览器 dev server）；缺省只允许同源 + localhost */
  allowedOrigins?: string[]
}

export interface WebBridgeHandle {
  port: number
  token: string
  close(): Promise<void>
  /** 向所有 WS 客户端广播（channel + payload） */
  broadcast(channel: string, payload: unknown): void
}

/** 事件通道白名单：与 preload EVENT_CHANNEL_ALLOWLIST 保持一致（只转发这些） */
const EVENT_CHANNELS = new Set([
  'chat:event',
  'media:job',
  'media:confirm-request',
  'media:confirm-resolved',
  'asset:changed',
  'workspace:state-changed',
  'task:event',
  'project:changed',
  'mcp:status',
])

/**
 * 启动桥服务。
 * @param getWsServer 延迟获取 ws 服务实例（避免循环依赖：main 先建 http，再挂 ws）
 */
export async function startWebBridge(options: WebBridgeOptions = {}): Promise<WebBridgeHandle> {
  const port = options.port ?? 4788
  const token = randomUUID()
  const clients = new Set<WebSocket>()

  const server: Server = createServer(async (req, res) => {
    // CORS：本地 dev server（5174/5173）跨端口调用需要
    const origin = req.headers.origin
    const allowed = origin && isAllowedOrigin(origin, options.allowedOrigins)
    if (allowed) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-headers', 'content-type, authorization')
      res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(allowed ? 204 : 403).end()
      return
    }

    // 鉴权：token 走 Authorization 头（query 仅用于 WS 握手）
    if (!checkAuth(req, token)) {
      json(res, 401, { ok: false, code: 'unauthorized', error: 'token 无效' })
      return
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    // GET /channels：调试/自检用，列出可调用的 channel
    if (req.method === 'GET' && url.pathname === '/channels') {
      json(res, 200, { channels: registeredChannels() })
      return
    }
    // POST /invoke：{ channel, payload } → 调 handler
    if (req.method === 'POST' && url.pathname === '/invoke') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 32 * 1024 * 1024) {
          json(res, 413, { ok: false, code: 'unknown', error: 'payload 过大' })
          return
        }
      }
      let parsed: { channel?: unknown; payload?: unknown }
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        json(res, 400, { ok: false, code: 'unknown', error: '请求体不是合法 JSON' })
        return
      }
      const channel = typeof parsed.channel === 'string' ? parsed.channel : ''
      const handler = registry.get(channel)
      if (!handler) {
        json(res, 404, { ok: false, code: 'unknown', error: `未注册的 channel：${channel}` })
        return
      }
      try {
        const value = await handler(parsed.payload)
        json(res, 200, { ok: true, value })
      } catch (error) {
        json(res, 200, {
          ok: false,
          code: 'unknown',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    json(res, 404, { ok: false, code: 'unknown', error: 'not found' })
  })

  // WS 升级：同一端口（/events?token=...）
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname !== '/events' || url.searchParams.get('token') !== token) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws)
      ws.on('close', () => clients.delete(ws))
      ws.on('error', () => clients.delete(ws))
      ws.send(JSON.stringify({ channel: '__ready', payload: { channels: registeredChannels() } }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })

  console.log(`[web-bridge] 已启动 http://127.0.0.1:${port}（token 见 renderer 引导）`)

  return {
    port,
    token,
    broadcast(channel: string, payload: unknown): void {
      if (!EVENT_CHANNELS.has(channel)) return
      const frame = JSON.stringify({ channel, payload })
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(frame)
      }
    },
    async close(): Promise<void> {
      for (const ws of clients) ws.terminate()
      clients.clear()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 桥实例（供各个 broadcastXxx 调用；未启用时为 null，零开销） */
let activeBridge: WebBridgeHandle | null = null

export function setActiveBridge(bridge: WebBridgeHandle | null): void {
  activeBridge = bridge
}

/** 转发事件到浏览器（未启用桥时直接返回） */
export function forwardEvent(channel: string, payload: unknown): void {
  activeBridge?.broadcast(channel, payload)
}

/* ---------------------------------------------------------------- 小工具 */

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function checkAuth(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7) === token
  }
  return false
}

function isAllowedOrigin(origin: string, extra?: string[]): boolean {
  if (extra?.includes(origin)) return true
  try {
    const url = new URL(origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  } catch {
    return false
  }
}
