/**
 * 本地测试 MCP 服务器（probe 夹具 + 手动 E2E 用）。
 *
 * 运行：node scripts/mcp/test-server.cjs
 * 形态：stdio transport，三个工具——
 *   echo       {text}            → 文本回显
 *   make_image {label?}          → 文本 + 1x1 PNG 图片（验证图片 content 映射）
 *   fail       {message?}        → isError:true（验证错误路径）
 * stderr 输出一行启动日志（验证 stderr 尾部捕获）。
 * SDK 1.32 的 registerTool 只收 Zod schema（raw JSON Schema 是 v2 特性），故用 zod。
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const server = new McpServer({ name: 'huabu-test-server', version: '1.0.0' })

server.registerTool(
  'echo',
  {
    description: '回显输入文本（huabu 测试服务器）',
    inputSchema: { text: z.string() }
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] })
)

server.registerTool(
  'make_image',
  {
    description: '返回一张 1x1 PNG 与说明文本（huabu 测试服务器）',
    inputSchema: { label: z.string().optional() }
  },
  async ({ label }) => ({
    content: [
      { type: 'text', text: `image for: ${label ?? 'unlabeled'}` },
      { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }
    ]
  })
)

server.registerTool(
  'fail',
  {
    description: '总是失败的工具（isError 路径测试）',
    inputSchema: { message: z.string().optional() }
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: message ?? 'intentional failure' }],
    isError: true
  })
)

process.stderr.write('[huabu-test-server] ready\n')

server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`[huabu-test-server] connect failed: ${error}\n`)
  process.exit(1)
})
