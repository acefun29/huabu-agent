/**
 * workspace 域 IPC（M5）。
 *
 * 覆盖通道：workspace:state / workspace:open-dialog / workspace:open-path /
 * workspace:canvas-save / workspace:canvas-load / workspace:set-default-model /
 * workspace:create / workspace:files / workspace:read-file / workspace:write-file /
 * workspace:reveal / workspace:source-path-registered（拖拽源路径登记）。
 *
 * 域内局部（不进 IpcContext）：disposePreviousWorkspace（切换工作区释放旧会话）、
 * SKIP_DIRS / collectWorkspaceFiles（可导入文件清单收集）、
 * TEXT_EXTS / READ_FILE_MAX_BYTES（文本读写白名单与大小上限）、
 * sourcePathRegistry / consumeSourcePath（拖拽登记表，media/asset 域导入闸消费）。
 */
import { ipcMain, shell } from 'electron'
import { existsSync, readFileSync, statSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { extname, join, relative, resolve, sep } from 'path'
import {
  IpcChannel,
  type CanvasSnapshot,
  type ChatResult,
  type WorkspaceFileInfo,
  type WorkspaceReadFileResult
} from '../../shared/ipc'
import { categorizeFileName, normalizePath } from '../../shared/assets'
import { atomicWriteSync } from '../fsutil/atomic'
import { isInboxPath } from '../assets/manager'
import type { IpcContext } from './shared'
import { describe, guardSync, invalidPayload, isNonEmptyString } from './shared'

// ---------------------------------------------------------------- 拖拽源路径登记（防伪造导入）

/**
 * 拖拽源路径登记表：path → 登记时间戳。
 *
 * 拖拽 File → 真路径的唯一出口是 preload 的 pathForFile（webUtils.getPathForFile），
 * 它解析成功即 send 到 workspace:source-path-registered 登记到这里；media:import 与
 * asset:import-canvas/temp 在消费 sourcePath 前先经 consumeSourcePath 校验「确经拖拽」，
 * 渲染端被攻破也无法拿任意用户路径让主进程复制进工作区再借 Agent 外泄。
 */
const SOURCE_PATH_TTL_MS = 5 * 60 * 1000
/** 登记集上限：一次拖拽可达数十文件，超限时清过期而不是无限增长 */
const SOURCE_PATH_MAX = 1000
const sourcePathRegistry = new Map<string, number>()

/** 清掉登记表里超过 TTL 的过期项（登记超上限 / 消费未命中时顺手执行） */
function pruneSourcePaths(now: number): void {
  for (const [path, at] of sourcePathRegistry) {
    if (now - at > SOURCE_PATH_TTL_MS) sourcePathRegistry.delete(path)
  }
}

/**
 * 消费一条登记路径：TTL 内 = 删除并返回 true（消费制，防同一登记被重复导入）；
 * 未登记或已过期 = 顺手清过期后返回 false。
 */
export function consumeSourcePath(path: string): boolean {
  if (typeof path !== 'string' || !path) return false
  const now = Date.now()
  const registeredAt = sourcePathRegistry.get(path)
  if (registeredAt !== undefined) {
    sourcePathRegistry.delete(path)
    return now - registeredAt <= SOURCE_PATH_TTL_MS
  }
  pruneSourcePaths(now)
  return false
}

export function registerWorkspaceIpc(ctx: IpcContext): void {
  const store = ctx.store
  const host = ctx.host
  const currentDir = ctx.currentDir

  // 拖拽源路径登记（fire-and-forget send）：只登记非空字符串，超上限先清过期再落表
  ipcMain.on(IpcChannel.WorkspaceSourcePathRegistered, (_event, path: unknown) => {
    if (!isNonEmptyString(path)) return
    const now = Date.now()
    if (sourcePathRegistry.size >= SOURCE_PATH_MAX) pruneSourcePaths(now)
    sourcePathRegistry.set(path, now)
  })

  ipcMain.handle(IpcChannel.WorkspaceState, () => store.state())

  ipcMain.handle(IpcChannel.WorkspaceOpenDialog, async () => {
    // 切换前先记住旧工作区：打开对话框期间 current 可能被并发操作改变，以此刻快照为准
    const previous = store.currentDir
    const result = await store.openDialog()
    if (!result.cancelled && result.workspace) {
      // 切换前释放旧工作区的全部会话（M5 DoD：切换不残留上一工作区的会话）
      result.disposedSessions = await disposePreviousWorkspace(previous)
    }
    return result
  })

  ipcMain.handle(IpcChannel.WorkspaceOpenPath, async (_event, payload: unknown) => {
    const path = (payload as { path?: unknown } | null)?.path
    if (!isNonEmptyString(path)) return invalidPayload('workspace:open-path 需要 path')
    try {
      const previous = store.currentDir
      const workspace = store.openByPath(path)
      const disposedSessions = await disposePreviousWorkspace(previous)
      return {
        ok: true,
        value: { workspace, disposedSessions }
      } satisfies ChatResult<{ workspace: typeof workspace; disposedSessions: number }>
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'unknown' as const, error: message }
    }
  })

  /** 释放切换前工作区的会话；返回释放数（dispose 的可观察证据） */
  async function disposePreviousWorkspace(previous: string | null): Promise<number> {
    if (!previous) return 0
    const count = await host.disposeWorkspace(previous)
    if (count > 0) console.log(`[ipc] 工作区切换：已释放旧工作区 ${previous} 的 ${count} 个会话`)
    return count
  }

  ipcMain.handle(IpcChannel.WorkspaceCanvasSave, (_event, payload: unknown) => {
    // 快照外壳形状由 WorkspaceStore 校验；这里只挡掉明显的非对象载荷
    if (!payload || typeof payload !== 'object') return invalidPayload('workspace:canvas-save 需要快照对象')
    return guardSync(() => {
      store.saveCanvas(payload as CanvasSnapshot)
      return undefined
    })
  })

  ipcMain.handle(IpcChannel.WorkspaceCanvasLoad, () => guardSync(() => store.loadCanvas()))

  ipcMain.handle(IpcChannel.WorkspaceSetDefaultModel, (_event, payload: unknown) => {
    const modelId = (payload as { modelId?: unknown } | null)?.modelId
    if (modelId !== null && !isNonEmptyString(modelId)) {
      return invalidPayload('workspace:set-default-model 需要 modelId（string 或 null）')
    }
    return guardSync(() => store.setDefaultModel(isNonEmptyString(modelId) ? modelId : null))
  })

  ipcMain.handle(IpcChannel.WorkspaceCreate, (_event, payload: unknown) => {
    const name = (payload as { name?: unknown } | null)?.name
    if (!isNonEmptyString(name)) return invalidPayload('workspace:create 需要 name')
    try {
      const previous = store.currentDir
      const workspace = store.createWorkspace(name)
      void disposePreviousWorkspace(previous).then((count) => {
        if (count > 0) console.log(`[ipc] 新建工作区切换：释放旧会话 ${count} 个`)
      })
      return { ok: true, value: { workspace } } satisfies ChatResult<{ workspace: typeof workspace }>
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  /** 工作区目录内不参与导入/编排的位置 */
  const SKIP_DIRS = new Set(['.huabu', '.git', 'node_modules', '.venv', 'dist', 'out', '.next'])

  /** 递归收集工作区内可导入文件；深度与总量有上限，防止巨大目录拖垮 IPC。
   * 异步遍历（fs.promises）：网络盘/慢磁盘上同步 readdir/stat 可能阻塞主进程数百 ms */
  async function collectWorkspaceFiles(): Promise<WorkspaceFileInfo[]> {
    const dir = currentDir()
    if (!dir) throw new Error('尚未打开工作区')
    const out: WorkspaceFileInfo[] = []
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 4 || out.length >= 800) return
      let entries: string[]
      try {
        entries = await readdir(current)
      } catch {
        return
      }
      for (const name of entries.sort()) {
        if (name.startsWith('.') && depth === 0) continue
        const full = join(current, name)
        let info
        try {
          info = await stat(full)
        } catch {
          continue
        }
        if (info.isDirectory()) {
          if (!SKIP_DIRS.has(name)) await walk(full, depth + 1)
          continue
        }
        if (!info.isFile()) continue
        // 分类单一事实来源在 shared/assets.ts；清单只列认识的大类，'other' 不进导入菜单
        const { kind } = categorizeFileName(name)
        if (kind === 'other') continue
        out.push({
          name,
          relPath: relative(dir, full).split(sep).join('/'),
          kind,
          bytes: info.size,
          mtime: info.mtime.toISOString()
        })
        if (out.length >= 800) return
      }
    }
    await walk(dir, 0)
    // 最近修改的排前面，导入菜单里优先看到刚产出的文件
    out.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return out.slice(0, 800)
  }

  // 异步 handler：错误返回形态与 guardSync 一致（describe 收敛 + ok:false 包装）
  ipcMain.handle(IpcChannel.WorkspaceFiles, async () => {
    try {
      return { ok: true as const, value: await collectWorkspaceFiles() }
    } catch (error) {
      return { ok: false as const, code: 'unknown' as const, error: describe(error) }
    }
  })

  /** 文本上下文注入的扩展名白名单与大小上限 */
  const TEXT_EXTS = new Set([
    '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
    '.c', '.h', '.cpp', '.cs', '.rb', '.php', '.sh', '.yml', '.yaml', '.toml', '.html', '.css'
  ])
  const READ_FILE_MAX_BYTES = 512 * 1024

  ipcMain.handle(IpcChannel.WorkspaceReadFile, (_event, payload: unknown) => {
    const relPath = (payload as { relPath?: unknown } | null)?.relPath
    if (!isNonEmptyString(relPath)) return invalidPayload('workspace:read-file 需要 relPath')
    return guardSync<WorkspaceReadFileResult>(() => {
      const dir = currentDir()
      if (!dir) throw new Error('尚未打开工作区')
      const target = resolve(dir, relPath)
      if (target !== dir && !target.startsWith(dir + sep)) {
        throw new Error(`路径越出工作区：${relPath}`)
      }
      if (!TEXT_EXTS.has(extname(target).toLowerCase())) {
        throw new Error(`不支持作为文本读取的类型：${extname(target) || '(无扩展名)'}`)
      }
      const stat = statSync(target)
      if (!stat.isFile()) throw new Error('目标不是文件')
      const truncated = stat.size > READ_FILE_MAX_BYTES
      const fd = readFileSync(target)
      const text = fd.subarray(0, READ_FILE_MAX_BYTES).toString('utf8')
      return { text, bytes: stat.size, truncated }
    })
  })

  /** md 笔记编辑保存/新建：白名单收紧到 md/txt，父目录自动建，tmp+rename 原子写 */
  ipcMain.handle(IpcChannel.WorkspaceWriteFile, (_event, payload: unknown) => {
    const request = payload as { relPath?: unknown; content?: unknown } | null
    if (!isNonEmptyString(request?.relPath)) return invalidPayload('workspace:write-file 需要 relPath')
    if (typeof request?.content !== 'string') return invalidPayload('workspace:write-file 需要 content 字符串')
    const relPath: string = request.relPath
    const content: string = request.content
    if (Buffer.byteLength(content, 'utf8') > READ_FILE_MAX_BYTES) {
      return invalidPayload(`内容超过上限（${READ_FILE_MAX_BYTES / 1024}KB）`)
    }
    return guardSync(() => {
      const dir = currentDir()
      if (!dir) throw new Error('尚未打开工作区')
      const target = resolve(dir, relPath)
      if (target !== dir && !target.startsWith(dir + sep)) {
        throw new Error(`路径越出工作区：${relPath}`)
      }
      const ext = extname(target).toLowerCase()
      if (ext !== '.md' && ext !== '.txt') {
        throw new Error(`只支持写入 .md / .txt：${ext || '(无扩展名)'}`)
      }
      // 原子写收口到 fsutil/atomic（父目录它内部自建）：此前手写的「先 rm 旧文件再改名」
      // 在 rm 与 rename 之间崩溃会把原文件彻底丢掉，atomic 的 .bak 腾位法不会
      atomicWriteSync(target, content)
      return { relPath: normalizePath(relative(dir, target)), bytes: Buffer.byteLength(content, 'utf8') }
    })
  })

  ipcMain.handle(IpcChannel.WorkspaceDelete, async (_event, payload: unknown) => {
    const paths = (payload as { paths?: unknown } | null)?.paths
    if (!Array.isArray(paths)) return invalidPayload('workspace:delete 需要 paths 字符串数组')
    try {
      const value = await store.deleteWorkspaces(paths.filter(isNonEmptyString))
      return { ok: true as const, value }
    } catch (error) {
      return { ok: false as const, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.WorkspaceReveal, (_event, payload: unknown) => {
    const relPath = (payload as { relPath?: unknown } | null)?.relPath
    if (!isNonEmptyString(relPath)) return invalidPayload('workspace:reveal 需要 relPath')
    return guardSync(() => {
      // 临时附件（import-temp 落点）在工作区之外：绝对路径 + 收件箱前缀校验后放行
      if (isInboxPath(relPath)) {
        if (!existsSync(relPath)) throw new Error(`文件不存在：${relPath}`)
        shell.showItemInFolder(resolve(relPath))
        return undefined
      }
      const dir = currentDir()
      if (!dir) throw new Error('尚未打开工作区')
      const target = resolve(dir, relPath)
      if (target !== dir && !target.startsWith(dir + sep)) {
        throw new Error(`路径越出工作区：${relPath}`)
      }
      if (!existsSync(target)) throw new Error(`文件不存在：${relPath}`)
      shell.showItemInFolder(target)
      return undefined
    })
  })
}
