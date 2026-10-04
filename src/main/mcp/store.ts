/**
 * MCP 服务器全局配置（userData/huabu-state/mcp.json）。
 *
 * 作用域为全局（跨工作区共享，对齐 Claude Desktop 的使用习惯）；
 * 工作区级技能走 .huabu/skills/，与这里无关。读失败（损坏/缺文件）
 * 静默回落空清单——配置文件坏不该阻断应用启动。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppStateDir } from '../workspace/stateDir'
import { atomicWriteSync } from '../fsutil/atomic'
import type { McpServerConfig } from '../../shared/ipc'

/** 校验+归一化后的条目才允许进内存与落盘（渲染端载荷按不可信输入处理） */
export function normalizeServerConfig(raw: unknown): McpServerConfig | string {
  const input = raw as Partial<McpServerConfig> | null
  if (!input || typeof input !== 'object') return '条目必须是对象'
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!name) return '缺少名称'
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return `名称 ${name} 只允许字母/数字/横线/下划线（用于工具名 mcp_<name>_）`
  if (!command) return `服务器 ${name} 缺少启动命令`
  const args = Array.isArray(input.args)
    ? input.args.filter((a): a is string => typeof a === 'string' && a.length > 0)
    : []
  const env: Record<string, string> = {}
  if (input.env && typeof input.env === 'object') {
    for (const [key, value] of Object.entries(input.env as Record<string, unknown>)) {
      if (typeof value === 'string' && key.length > 0) env[key] = value
    }
  }
  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `mcp-${name}-${Date.now()}`,
    name,
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    enabled: input.enabled !== false
  }
}

export function getMcpConfigFile(): string {
  return join(getAppStateDir(), 'mcp.json')
}

export function readMcpServers(): McpServerConfig[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(getMcpConfigFile(), 'utf-8'))
  } catch {
    return []
  }
  const list = (raw as { servers?: unknown } | null)?.servers
  if (!Array.isArray(list)) return []
  const out: McpServerConfig[] = []
  for (const entry of list) {
    const normalized = normalizeServerConfig(entry)
    if (typeof normalized !== 'string') out.push(normalized)
  }
  return out
}

/** 整表替换（渲染端先在清单上增删改再整体提交）；名称重复直接抛错 */
export function writeMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
  const seen = new Set<string>()
  for (const server of servers) {
    if (seen.has(server.name)) throw new Error(`服务器名称重复：${server.name}`)
    seen.add(server.name)
  }
  atomicWriteSync(getMcpConfigFile(), `${JSON.stringify({ version: 1, servers }, null, 2)}\n`)
  return servers
}
