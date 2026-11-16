import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * MCP 工具注入（本地无凭据 fixture）。
 *
 * 用真的 stdio 子进程 + 手写 JSON-RPC 服务器，验证两件事：
 * 1. 已启用的服务器，工具会以 `mcp_<server>_<tool>` 出现在装配结果里，并且能真的执行；
 * 2. 未启用的服务器，工具一个都不出现。
 *
 * 不碰网络、不读凭据：fixture 就是本文件写进临时目录的一段 node 脚本。
 */
const { stateRoot } = vi.hoisted(() => ({
  stateRoot: `${process.env.TEMP ?? process.env.TMPDIR ?? '.'}/huabu-mcp-test-${process.pid}-${Date.now()}`
}))

vi.mock('../workspace/stateDir', () => ({ getAppStateDir: () => stateRoot }))
vi.mock('electron', () => ({ app: { getPath: () => stateRoot } }))

import { McpManager } from './manager'

const FIXTURE_SERVER = `
import { createInterface } from 'node:readline'

const TOOLS = [{
  name: 'review_echo',
  description: 'Echo the given text (offline fixture).',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
}]

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '0.0.1' }
    } })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
    return
  }
  if (message.method === 'tools/call') {
    const text = message.params?.arguments?.text ?? ''
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + text }] } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
})
`

const managers: McpManager[] = []

beforeAll(() => {
  mkdirSync(stateRoot, { recursive: true })
  const script = join(stateRoot, 'fixture-server.mjs')
  writeFileSync(script, FIXTURE_SERVER, 'utf8')
  writeFileSync(
    join(stateRoot, 'mcp.json'),
    JSON.stringify(
      {
        version: 1,
        servers: [
          {
            id: 'mcp-fixture-1',
            name: 'fixture',
            command: process.execPath,
            args: [script],
            enabled: true
          },
          {
            id: 'mcp-off-1',
            name: 'off',
            command: process.execPath,
            args: [script],
            enabled: false
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  )
})

afterAll(() => {
  for (const manager of managers) manager.disposeAll()
  try {
    rmSync(stateRoot, { recursive: true, force: true })
  } catch {
    /* Windows 下子进程句柄未释放时留给系统清理 */
  }
})

function manager(): McpManager {
  const instance = new McpManager()
  managers.push(instance)
  return instance
}

describe('McpManager.assembleTools', () => {
  it('启用的服务器工具进入装配结果，未启用的不进入', async () => {
    const tools = await manager().assembleTools()
    const names = tools.map((tool) => tool.name)
    expect(names).toContain('mcp_fixture_review_echo')
    expect(names.some((name) => name.startsWith('mcp_off_'))).toBe(false)
  }, 20_000)

  it('装配出的工具可以真正执行（content 透传）', async () => {
    const tool = (await manager().assembleTools()).find(
      (entry) => entry.name === 'mcp_fixture_review_echo'
    )
    expect(tool).toBeTruthy()
    const result = await tool!.execute('call-1', { text: 'ping' }, undefined, undefined, {})
    expect((result.content[0] as { text: string }).text).toBe('echo:ping')
    expect(result.details).toMatchObject({ server: 'fixture', tool: 'review_echo' })
  }, 20_000)
})
