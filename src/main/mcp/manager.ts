/**
 * MCP 桥接管理器（stdio client 连接池 + pi customTools 转换）。
 *
 * pi 不内置 MCP（官方明示由宿主桥接），这里用官方 SDK 起 stdio 子进程，
 * 把每个 server 的 tools/list 结果包装成 pi 的 ToolDefinition：
 * - 工具名 mcp_<server>_<tool>（清洗为 [A-Za-z0-9_-]，冲突加序号）
 * - parameters 直接透传 MCP 的 JSON Schema（TypeBox 本质即 JSON Schema）
 * - execute 桥接 AbortSignal + 60s 超时调 tools/call；text/image 原样映射，
 *   其余 content 序列化为 JSON 文本；isError=true 抛 Error 让模型自纠
 *
 * 生命周期：全局单例（配置跨工作区共享）；sync() 按配置 diff 启停；
 * 未就绪/失败的 server 不阻塞会话创建（assembleTools 跳过并在状态徽章报错）。
 * 关停走 client.close()（SDK 按规范顺序：关 stdin → 等退出 → 超时 kill）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  McpServerConfig,
  McpServerRuntimeInfo,
  McpServerStatus
} from '../../shared/ipc'
import { readMcpServers } from './store'

/** 连接超时（npx 冷启动可能要下载包，给足余量） */
const CONNECT_TIMEOUT_MS = 20_000
/** 单次工具调用超时 */
const CALL_TIMEOUT_MS = 60_000
/** 单 server 工具数上限 / 全局上限（保护上下文窗口） */
const MAX_TOOLS_PER_SERVER = 64
const MAX_TOOLS_TOTAL = 128
/** 状态徽章可显示的 stderr 尾部行数 */
const STDERR_TAIL_LINES = 8

/** 翻页拉全的 server 工具快照 */
interface McpToolSnapshot {
  name: string
  description?: string
  inputSchema: Record<string, unknown> & { type: 'object' }
}

interface ServerEntry {
  config: McpServerConfig
  status: McpServerStatus
  client: Client | null
  tools: McpToolSnapshot[]
  error?: string
  stderrTail: string[]
  /** 捕获 in-flight start，避免 sync 重入重复起进程 */
  starting: Promise<void> | null
}

/** 工具名清洗：非 [A-Za-z0-9_-] 一律转 _ */
function sanitizeNamePart(part: string): string {
  const cleaned = part.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'x'
}

export class McpManager {
  private readonly entries = new Map<string, ServerEntry>()
  /** 状态变化时推给设置页徽章（mcp:status 事件，由编排器注入） */
  private readonly onStatusChange: () => void
  private disposed = false

  constructor(onStatusChange?: () => void) {
    this.onStatusChange = onStatusChange ?? (() => {})
  }

  /** 配置 → 运行池 diff：停掉移除/禁用的，起新增/变更的（异步，不等待） */
  sync(): void {
    if (this.disposed) return
    const wanted = readMcpServers()
    const wantedByName = new Map(wanted.map((s) => [s.name, s]))

    for (const [name, entry] of this.entries) {
      const next = wantedByName.get(name)
      if (!next || !next.enabled) {
        void this.stopEntry(name, entry)
      } else if (
        next.command !== entry.config.command ||
        JSON.stringify(next.args) !== JSON.stringify(entry.config.args) ||
        JSON.stringify(next.env ?? {}) !== JSON.stringify(entry.config.env ?? {})
      ) {
        // 启动参数变了：先停旧再起新（名字复用）
        void this.stopEntry(name, entry).then(() => this.startEntry(next))
      } else {
        entry.config = next
      }
    }
    for (const server of wanted) {
      if (server.enabled && !this.entries.has(server.name)) this.startEntry(server)
    }
  }

  private async stopEntry(name: string, entry: ServerEntry): Promise<void> {
    this.entries.delete(name)
    const { client } = entry
    entry.client = null
    if (client) {
      try {
        await client.close()
      } catch {
        // 关停失败不阻断（进程可能已死）；SDK 内部有 kill 兜底
      }
    }
  }

  private startEntry(config: McpServerConfig): void {
    const entry: ServerEntry = {
      config,
      status: 'starting',
      client: null,
      tools: [],
      stderrTail: [],
      starting: null
    }
    this.entries.set(config.name, entry)
    entry.starting = this.connect(entry).finally(() => {
      entry.starting = null
    })
    // connect 内部自捕获，这里的 catch 只防极端（finally 后不该有 rejection）
    entry.starting.catch(() => {})
  }

  private async connect(entry: ServerEntry): Promise<void> {
    const { config } = entry
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      stderr: 'pipe'
    })
    // 捕获 server stderr 尾部：错误徽章的诊断上下文（stdout 是协议通道不能动）
    try {
      const stream = transport.stderr as import('node:stream').Readable | null
      if (stream) {
        stream.setEncoding('utf-8')
        stream.on('data', (chunk: string) => {
          for (const line of String(chunk).split(/\r?\n/)) {
            if (!line.trim()) continue
            entry.stderrTail.push(line)
            if (entry.stderrTail.length > STDERR_TAIL_LINES) entry.stderrTail.shift()
          }
        })
      }
    } catch {
      /* stderr 捕获是增强项，失败不影响连接 */
    }

    const client = new Client({ name: 'huabu', version: '0.2.0' })
    try {
      // connect = initialize 握手；SDK RequestOptions 原生超时（超时抛 McpError RequestTimeout）
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      if (this.entries.get(config.name) !== entry) {
        // sync 期间被替换/移除：立即关停新连接
        await client.close()
        return
      }
      entry.client = client
      client.onclose = () => {
        const current = this.entries.get(config.name)
        if (current === entry && current.status === 'connected') {
          current.status = 'error'
          current.error = '连接已被服务器关闭'
          this.onStatusChange()
        }
      }
      client.onerror = (error: Error) => {
        const current = this.entries.get(config.name)
        if (current === entry) {
          current.stderrTail.push(`[transport] ${error.message}`)
          if (current.status !== 'connected') {
            current.status = 'error'
            current.error = error.message
            this.onStatusChange()
          }
        }
      }
      entry.tools = await this.listAllTools(client)
      entry.status = 'connected'
      entry.error = undefined
      console.log(`[mcp] ${config.name} 已连接（${entry.tools.length} 个工具）`)
      this.onStatusChange()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await client.close()
      } catch {
        /* 同上 */
      }
      if (this.entries.get(config.name) === entry) {
        entry.status = 'error'
        entry.error = entry.stderrTail.length > 0 ? `${message}\n${entry.stderrTail.join('\n')}` : message
        entry.client = null
        console.warn(`[mcp] ${config.name} 连接失败：${message}`)
        this.onStatusChange()
      }
    }
  }

  /** tools/list 翻页拉全（cursor 分页，规范允许 server 分页） */
  private async listAllTools(client: Client): Promise<McpToolSnapshot[]> {
    const out: McpToolSnapshot[] = []
    let cursor: string | undefined
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined)
      for (const tool of result.tools) {
        out.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as McpToolSnapshot['inputSchema']
        })
        if (out.length >= MAX_TOOLS_PER_SERVER) break
      }
      cursor = result.nextCursor
    } while (cursor && out.length < MAX_TOOLS_PER_SERVER)
    return out
  }

  /** 设置页徽章数据：配置 + 运行态合并（未运行的按 disabled 呈现） */
  runtimeInfo(): McpServerRuntimeInfo[] {
    const config = readMcpServers()
    const byName = new Map<string, ServerEntry>()
    for (const entry of this.entries.values()) byName.set(entry.config.name, entry)
    return config.map((server) => {
      const entry = byName.get(server.name)
      if (!server.enabled) {
        return { ...server, status: 'disabled' as const }
      }
      if (!entry) {
        // 配置在、运行池没有（sync 尚未跑）：给 starting 占位，徽章不至于空白
        return { ...server, status: 'starting' as const }
      }
      const runtime: McpServerRuntimeInfo = {
        ...entry.config,
        status: entry.status
      }
      if (entry.status === 'connected') runtime.toolCount = entry.tools.length
      if (entry.error) runtime.error = entry.error
      return runtime
    })
  }

  /**
   * 全部已连接 server 的工具 → pi customTools。
   * starting 的 server 等一小会儿（首个会话常在 sync 后立刻来），
   * 失败/未就绪直接跳过——错误在设置页徽章可见，模型侧感知为"没有这些工具"。
   */
  async assembleTools(): Promise<ToolDefinition[]> {
    if (this.disposed) return []
    this.sync()
    // 最多等 3 秒让在途连接收敛（首个会话常在 sync 后立刻来）；已连接的不耗时
    await Promise.race([
      Promise.all([...this.entries.values()].map((entry) => entry.starting?.catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ])

    const usedNames = new Set<string>()
    const out: ToolDefinition[] = []
    for (const entry of this.entries.values()) {
      if (entry.status !== 'connected' || !entry.client || entry.tools.length === 0) continue
      for (const tool of entry.tools) {
        if (out.length >= MAX_TOOLS_TOTAL) break
        out.push(this.wrapTool(entry, tool, usedNames))
      }
    }
    return out
  }

  /** 单个 MCP 工具 → pi ToolDefinition（名字冲突加序号） */
  private wrapTool(entry: ServerEntry, tool: McpToolSnapshot, usedNames: Set<string>): ToolDefinition {
    const base = `mcp_${sanitizeNamePart(entry.config.name)}_${sanitizeNamePart(tool.name)}`
    let name = base
    for (let i = 2; usedNames.has(name); i++) name = `${base}_${i}`
    usedNames.add(name)

    const serverName = entry.config.name
    const toolName = tool.name
    const clientRef = entry
    return {
      name,
      label: `${serverName}/${toolName}`,
      description:
        (tool.description ? `${tool.description}\n\n` : '') +
        `来自 MCP 服务器「${serverName}」的工具 ${toolName}。`,
      // MCP 的 inputSchema 就是标准 JSON Schema，pi 的 TypeBox schema 本质相同，直接透传
      parameters: tool.inputSchema as never,
      execute: async (_toolCallId, params, signal) => {
        const client = clientRef.client
        if (!client || clientRef.status !== 'connected') {
          throw new Error(`MCP 服务器「${serverName}」当前未连接，工具 ${toolName} 不可用`)
        }
        try {
          // SDK RequestOptions 原生 timeout + signal（中止/超时都抛错，经外层转成带指引的 Error）
          const result = await client.callTool(
            { name: toolName, arguments: params as Record<string, unknown> },
            undefined,
            { timeout: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) }
          )
          // SDK 的 content 联合类型过宽，按结构窄化成 mapContent/summarizeContent 认的形状
          const content = result.content as Array<Record<string, unknown>> | undefined
          if (result.isError) {
            throw new Error(`MCP 工具 ${name} 执行失败：${summarizeContent(content)}`)
          }
          return {
            content: mapContent(content),
            details: { server: serverName, tool: toolName }
          }
        } catch (error) {
          if (signal?.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`MCP 工具 ${name} 调用失败：${message}`)
        }
      }
    } as ToolDefinition
  }

  /** 应用退出时全量关停（同步语义：触发关闭不等子进程退出，SDK kill 兜底） */
  disposeAll(): void {
    this.disposed = true
    for (const [name, entry] of this.entries) {
      entry.status = 'disabled'
      const client = entry.client
      entry.client = null
      if (client) {
        client.close().catch(() => {})
      }
      this.entries.delete(name)
    }
  }
}

/** MCP content → pi content：text/image 原样，其余 JSON 序列化 */
function mapContent(
  content: Array<Record<string, unknown>> | undefined
): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (!content || content.length === 0) return [{ type: 'text', text: '(空结果)' }]
  const out: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && typeof block.data === 'string') {
      out.push({ type: 'image', data: block.data, mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png' })
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      out.push({ type: 'text', text: `resource: ${block.uri}` })
    } else {
      out.push({ type: 'text', text: JSON.stringify(block) })
    }
  }
  return out
}

function summarizeContent(content: Array<Record<string, unknown>> | undefined): string {
  const text = (content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  return text || '(无错误详情)'
}
