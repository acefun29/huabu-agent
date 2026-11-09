/**
 * 开发期 Web 桥 token 的单一来源。
 *
 * 谁需要它：
 * - `electron.vite.config.ts`（**最先执行**：起 renderer dev server 前就把 token 注入 bundle）
 * - 主进程 `src/main/index.ts`（起桥时用同一个 token）
 *
 * 为什么放文件而不是每次随机：随机 token 意味着浏览器地址每次重启都变，
 * 旧地址一打开就是 401（且客户端无法自愈）。放一个稳定文件后：
 * - renderer 编译期就知道 token，`pnpm web` 直接打开 http://localhost:5173/ 即可，URL 里不用带 token；
 * - 重启后 token 不变，书签/标签页不会失效。
 *
 * 只落在项目根的 `.huabu-dev/`（已 gitignore），不含任何用户数据；
 * 打包态不启用 Web 桥，因此不会读到这个文件。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 项目根下的隐藏目录（本地开发状态，不入库） */
export const DEV_STATE_DIR = '.huabu-dev'

/** token 文件绝对路径 */
export function devTokenPath(rootDir: string = process.cwd()): string {
  return resolve(rootDir, DEV_STATE_DIR, 'bridge-token')
}

/**
 * 读取 token；不存在或损坏时生成并落盘。
 * 返回空串表示无法读写（调用方应退回随机 token / 不启用桥）。
 */
export function readOrCreateDevToken(rootDir: string = process.cwd()): string {
  const file = devTokenPath(rootDir)
  try {
    const cached = readFileSync(file, 'utf8').trim()
    // 拒掉明显无效的内容（手工改坏、半截写入）
    if (cached.length >= 16) return cached
  } catch {
    // 首次启动没有文件
  }
  const token = randomUUID()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, token, 'utf8')
  } catch {
    return ''
  }
  return token
}

/** 桥端口：dev server 与主进程必须一致（可用环境变量覆盖） */
export function devBridgePort(): number {
  const raw = Number(process.env['HUABU_WEB_BRIDGE_PORT'])
  return Number.isFinite(raw) && raw > 0 ? raw : 4788
}
