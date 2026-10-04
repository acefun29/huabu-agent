/**
 * 应用级状态目录（userData/huabu-state）的定位与按工作区派生的凭据文件路径。
 *
 * 从 workspace/store.ts 拆出：MCP 全局配置（mcp/store.ts）等轻量模块只需要状态目录，
 * 不该为这一个函数背上 store 的模型目录闭包（probe/检查脚本转译时尤其敏感）。
 * store.ts 从这里 re-export 保持既有引用不动。
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

/** 应用级状态目录（不是用户项目目录）：最近列表、加密凭据与 MCP 全局配置都放这里 */
export function getAppStateDir(): string {
  const dir = resolve(app.getPath('userData'), 'huabu-state')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 工作区 id：路径的短哈希。凭据文件按它隔离，目录改名/移动后凭据需重新录入 */
export function workspaceId(dir: string): string {
  return createHash('sha256').update(resolve(dir).toLowerCase()).digest('hex').slice(0, 16)
}

/** 某工作区的凭据文件路径（safeStorage 加密），供 AgentHost 与诊断页共用 */
export function getCredentialsFile(workspaceDir: string): string {
  return join(getAppStateDir(), 'credentials', `${workspaceId(workspaceDir)}.credentials.json`)
}
