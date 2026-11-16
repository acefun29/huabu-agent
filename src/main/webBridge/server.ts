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
 * - **默认关闭**：只有显式 `HUABU_WEB_BRIDGE=1` / `HUABU_HEADLESS=1`（`pnpm web`，
 *   主进程不建窗口）才监听，不改变 Electron 默认行为、不额外开端口。
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
import { handleMediaRequest } from '../media/protocol'
import { EVENT_CHANNEL_ALLOWLIST } from '../../shared/eventChannels'
import { ReplayBuffer, isHighVolumeEvent } from './replayBuffer'

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
  /** 固定 token（开发期从 userData 读，重启后浏览器地址仍有效）；缺省每次随机 */
  token?: string
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

/**
 * 事件通道白名单：与 preload 共用 `@shared/eventChannels` 的唯一清单。
 *
 * 此前这里是手抄的第二份，并且把 `window:state-changed` 抄成了
 * `workspace:state-changed`——死字符串，转发永不出错也永远不生效（A18）。
 */
const EVENT_CHANNELS = new Set(EVENT_CHANNEL_ALLOWLIST)

/**
 * 启动桥服务。
 * @param getWsServer 延迟获取 ws 服务实例（避免循环依赖：main 先建 http，再挂 ws）
 */
export async function startWebBridge(options: WebBridgeOptions = {}): Promise<WebBridgeHandle> {
  const port = options.port ?? 4788
  const token = options.token ?? randomUUID()
  const clients = new Set<WebSocket>()
  /** 没有在线客户端期间攒下的终态帧（D6）：只留生命周期事件，见 replayBuffer.ts */
  const replay = new ReplayBuffer()

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

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    /**
     * 媒体路由：GET /media/<host>/<relPath>
     * `<img src>` / `<video src>` 无法带 Authorization 头，所以这里用 query token 鉴权；
     * 路径解析、越界拒绝、缩略图缓存全部复用 Electron 侧的 handleMediaRequest
     * （同一套根目录与安全边界，不另写一份）。
     */
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      if (url.searchParams.get('token') !== token) {
        res.writeHead(401).end('unauthorized')
        return
      }
      // 还原成 huabu-media:// 形态交给既有 handler（它按 url.host + pathname 解析）
      const rest = url.pathname.slice('/media/'.length)
      const slash = rest.indexOf('/')
      const host = slash === -1 ? rest : rest.slice(0, slash)
      const mediaUrl = new URL(`huabu-media://${host}/${slash === -1 ? '' : rest.slice(slash + 1)}`)
      try {
        const mediaResponse = await handleMediaRequest(new Request(mediaUrl.toString()))
        const headers: Record<string, string> = {}
        mediaResponse.headers.forEach((value, key) => {
          headers[key] = value
        })
        // 浏览器里同源是 5174，图片请求来自 4788 —— 需要放行
        if (allowed) headers['access-control-allow-origin'] = origin!
        const buffer = Buffer.from(await mediaResponse.arrayBuffer())
        res.writeHead(mediaResponse.status, headers)
        res.end(buffer)
      } catch (error) {
        res.writeHead(500).end(String(error))
      }
      return
    }

    // 鉴权：token 走 Authorization 头（query 仅用于 WS 握手 / 媒体直取）
    if (!checkAuth(req, token)) {
      json(res, 401, { ok: false, code: 'unauthorized', error: 'token 无效' })
      return
    }
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
      // 补发断线期间的终态事件（D6）：先 __ready 再重放，客户端此刻订阅者已就位
      for (const frame of replay.drain()) {
        if (ws.readyState === ws.OPEN) ws.send(frame)
      }
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
      let delivered = 0
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(frame)
          delivered += 1
        }
      }
      // 没有任何在线客户端：这一帧会永久丢失（客户端不做状态重取）。
      // 只留生命周期帧，重放时把界面拉回正确终态；逐字增量不留（见 replayBuffer.ts）。
      if (delivered === 0 && !isHighVolumeEvent(payload)) replay.push(frame)
    },
    async close(): Promise<void> {
      replay.clear()
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

/**
 * 转发事件到浏览器（未启用桥时直接返回）。
 *
 * 必须自己吞异常（A15）：调用方是六条 `broadcastXxx`，其中 `broadcastChatEvent`
 * 同时是 AgentHost 的 emitter 与 Mastra 的 `deps.broadcast`。这里一旦抛出
 * （WS 正在关闭、payload 有环引用、JSON.stringify 失败），异常会顺着 broadcast
 * 打断整条事件链；Mastra 侧更严重——收尾广播抛错会让 `session.run` 永远停着，
 * 该会话之后每次 prompt 都回 busy（见 A2）。
 */
export function forwardEvent(channel: string, payload: unknown): void {
  if (!activeBridge) return
  try {
    activeBridge.broadcast(channel, payload)
  } catch (error) {
    console.error(`[web-bridge] 事件转发失败（${channel}）：`, error)
  }
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
