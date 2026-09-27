import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { AgentHost } from './agent/host'
import { resolveSessionFile } from './agent/workspace'
import { WorkspaceStore } from './workspace/store'
import { MediaJobManager } from './media/manager'
import type { MediaProviderAdapter } from './media/provider'
import {
  createAdapters,
  isRegisteredAdapterType,
  type AdapterDeps,
  type AdapterProviderConfig
} from './media/adapters'
import {
  BUILTIN_PROVIDERS,
  browseCatalog,
  mergeCatalog,
  MODEL_ID_PATTERN,
  PROVIDER_ID_PATTERN,
  sanitizeCapabilities,
  sanitizeUserProvider
} from './media/catalog'
import { assembleMediaTools } from './agent/mediaToolAssembly'
import type { MediaApprovalInfo } from './agent/mediaTools'
import {
  addCustomModel,
  addCustomProvider,
  deleteModel,
  editCustomModel,
  removeCustomProvider,
  restoreBuiltinModel
} from './models/overlay'
import { copyIntoDir } from './workspace/store'
import { buildMediaUrl } from './media/protocol'
import { importToInbox, importToWorkspace, isInboxPath, listLibraries, inboxRoot, transferToLibrary, deleteAsset, renameAsset } from './assets/manager'
import { setFileTags } from './assets/tagsIndex'
import { categorizeFileName, MEDIA_ROOT_REL, normalizePath } from '../shared/assets'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import {
  IpcChannel,
  type AppVersionInfo,
  type CanvasSnapshot,
  type WindowControlAction,
  type WindowStateInfo,
  type ChatCreateRequest,
  type ChatEvent,
  type ChatNodeRequest,
  type ChatPromptRequest,
  type ChatResult,
  type ChatSteerRequest,
  type MediaGenerateRequest,
  type MediaImportRequest,
  type MediaJobStatus,
  type MediaProviderInfo,
  type MediaConfirmPayload,
  type SettingsSetApiKeyRequest,
  type CustomModelInput,
  type CustomProviderInput,
  type MediaProviderStatus,
  type MediaSettingsStatus,
  type ManagedModelInfo,
  type ModelEditInput,
  type MediaUserModelInput,
  type MediaUserProviderInput,
  type WorkspaceFileInfo,
  type WorkspaceReadFileResult,
  type MediaConfigPatch
} from '../shared/ipc'
import type { MediaKind, MediaRatio } from '../shared/media'
import {
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_MEDIA_DURATION_S,
  DEFAULT_MEDIA_PROVIDER,
  DEFAULT_MEDIA_RATIO,
  MEDIA_RATIOS
} from '../shared/media'

/**
 * 注册全部 IPC handler。
 *
 * 通道清单见 docs/ipc-contract.md。M1 落地 app 域，M3 落地 chat 域，
 * M5 扩展落地 workspace 域，M9 扩展落地 settings 域。
 *
 * 安全约定：渲染进程发来的载荷一律按「不可信输入」处理，先做形状校验再交给服务层。
 * 事件广播前检查 webContents 是否已销毁，否则关窗瞬间会抛错。
 */

let agentHost: AgentHost | null = null
let workspaceStore: WorkspaceStore | null = null

/** 供主进程其它模块（如退出流程、媒体协议）访问；未注册时为 null */
export function getAgentHost(): AgentHost | null {
  return agentHost
}

export function getWorkspaceStore(): WorkspaceStore | null {
  return workspaceStore
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 把 invoke 传来的未知载荷收敛成 ChatNodeRequest，形状不对就返回 null */
function asNodeRequest(payload: unknown): ChatNodeRequest | null {
  const nodeId = (payload as { nodeId?: unknown } | null)?.nodeId
  return isNonEmptyString(nodeId) ? { nodeId } : null
}

function invalidPayload<T>(what: string): ChatResult<T> {
  return { ok: false, code: 'unknown', error: `IPC 载荷不合法：${what}` }
}

function ok(): ChatResult {
  return { ok: true, value: undefined }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 400 ? `${message.slice(0, 400)}…` : message
}

/** 把服务层抛出的同步异常（目录不可写、画布超限等）收敛成 ChatResult，不外泄堆栈 */
function guardSync<T>(fn: () => T): ChatResult<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'unknown', error: message.length > 500 ? `${message.slice(0, 500)}…` : message }
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.AppPing, () => 'pong')

  ipcMain.handle(IpcChannel.AppVersion, (): AppVersionInfo => {
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      chrome: process.versions.chrome ?? 'unknown',
      isPackaged: app.isPackaged
    }
  })

  // ---------------------------------------------------------------- window 域（自绘标题栏）

  ipcMain.handle(IpcChannel.WindowControl, (event, action: WindowControlAction) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (action === 'minimize') window.minimize()
    else if (action === 'toggle-maximize') {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    } else if (action === 'close') window.close()
  })

  ipcMain.handle(IpcChannel.WindowState, (event): WindowStateInfo => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return { maximized: window?.isMaximized() ?? false }
  })

  // ---------------------------------------------------------------- workspace 域（M5）

  const store = new WorkspaceStore()
  workspaceStore = store
  // 冷启动恢复上次工作区（打包态冒烟抓出的缺失：此前恢复只发生在 dev 长驻进程里）
  if (store.bootstrap()) {
    console.log(`[workspace] 冷启动已恢复上次工作区：${store.currentDir}`)
  }

  const host = new AgentHost((event: ChatEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents
      if (contents.isDestroyed()) continue
      try {
        contents.send(IpcChannel.ChatEvent, event)
      } catch (error) {
        // 广播失败不能打断事件链，否则一个坏窗口会让所有会话都收不到后续增量
        console.error(`[ipc] chat:event 广播失败：${String(error)}`)
      }
    }
  })
  agentHost = host

  // 预热：pi 是动态导入，放到窗口创建前 await 会拖慢启动。
  // chat:runtime / chat:create 内部各自 await init()，天然幂等。
  void host.init()

  /** 当前工作区目录（可能为 null：选择页状态下不该有会话） */
  const currentDir = (): string | null => store.currentDir

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

  /** 递归收集工作区内可导入文件；深度与总量有上限，防止巨大目录拖垮 IPC */
  function collectWorkspaceFiles(): WorkspaceFileInfo[] {
    const dir = currentDir()
    if (!dir) throw new Error('尚未打开工作区')
    const out: WorkspaceFileInfo[] = []
    const walk = (current: string, depth: number): void => {
      if (depth > 4 || out.length >= 800) return
      let entries: string[] = []
      try {
        entries = readdirSync(current)
      } catch {
        return
      }
      for (const name of entries.sort()) {
        if (name.startsWith('.') && depth === 0) continue
        const full = join(current, name)
        let stat
        try {
          stat = statSync(full)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(full, depth + 1)
          continue
        }
        if (!stat.isFile()) continue
        // 分类单一事实来源在 shared/assets.ts；清单只列认识的大类，'other' 不进导入菜单
        const { kind } = categorizeFileName(name)
        if (kind === 'other') continue
        out.push({
          name,
          relPath: relative(dir, full).split(sep).join('/'),
          kind,
          bytes: stat.size,
          mtime: stat.mtime.toISOString()
        })
        if (out.length >= 800) return
      }
    }
    walk(dir, 0)
    // 最近修改的排前面，导入菜单里优先看到刚产出的文件
    out.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return out.slice(0, 800)
  }

  ipcMain.handle(IpcChannel.WorkspaceFiles, () => guardSync(() => collectWorkspaceFiles()))

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
      mkdirSync(dirname(target), { recursive: true })
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, content, 'utf8')
      rmSync(target, { force: true })
      renameSync(tmp, target)
      return { relPath: normalizePath(relative(dir, target)), bytes: Buffer.byteLength(content, 'utf8') }
    })
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

  // ---------------------------------------------------------------- asset 域（新原型同步）

  /** 素材目录变更广播（import/建库/删库后渲染端刷新素材库面板与目录约定） */
  const broadcastAssetChanged = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents
      if (contents.isDestroyed()) continue
      try {
        contents.send(IpcChannel.AssetChanged, { at: new Date().toISOString() })
      } catch (error) {
        console.error(`[ipc] asset:changed 广播失败：${String(error)}`)
      }
    }
  }

  const asImportFiles = (payload: unknown): unknown[] | null => {
    const files = (payload as { files?: unknown } | null)?.files
    return Array.isArray(files) && files.length > 0 ? files : null
  }

  /** @backend(import-canvas)：OS 文件归档进 <工作区>/assets/<分类>/ */
  ipcMain.handle(IpcChannel.AssetImportCanvas, (_event, payload: unknown) => {
    const files = asImportFiles(payload)
    if (!files) return invalidPayload('asset:import-canvas 需要 files 数组')
    return guardSync(() => {
      const dir = currentDir()
      if (!dir) throw new Error('尚未打开工作区')
      const result = importToWorkspace(dir, files)
      if (result.imported.length > 0) broadcastAssetChanged()
      return result
    })
  })

  /** @backend(import-temp)：OS 文件复制进 userData 收件箱（工作区之外），回传绝对路径 */
  ipcMain.handle(IpcChannel.AssetImportTemp, (_event, payload: unknown) => {
    const files = asImportFiles(payload)
    if (!files) return invalidPayload('asset:import-temp 需要 files 数组')
    return guardSync(() => importToInbox(files))
  })

  /** 素材库清单：内置 assets/ 合成库 + workspace.json libraries 段的命名库 */
  ipcMain.handle(IpcChannel.AssetLibraries, () => guardSync(() => listLibraries(store)))

  ipcMain.handle(IpcChannel.AssetLibraryCreate, (_event, payload: unknown) => {
    const name = (payload as { name?: unknown } | null)?.name
    if (!isNonEmptyString(name)) return invalidPayload('asset:library-create 需要 name')
    return guardSync(() => {
      const lib = store.addLibrary(name)
      broadcastAssetChanged()
      return lib
    })
  })

  ipcMain.handle(IpcChannel.AssetLibraryRemove, (_event, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (!isNonEmptyString(id)) return invalidPayload('asset:library-remove 需要 id')
    return guardSync(() => {
      store.removeLibrary(id)
      broadcastAssetChanged()
      return undefined
    })
  })

  /** @backend(asset:transfer)：拖拽归档 —— 工作区内文件移动 / OS 外部文件复制到指定素材库 */
  ipcMain.handle(IpcChannel.AssetTransfer, (_event, payload: unknown) => {
    const request = payload as { libraryId?: unknown; movePaths?: unknown; copyFiles?: unknown } | null
    if (!isNonEmptyString(request?.libraryId)) return invalidPayload('asset:transfer 需要 libraryId')
    const movePaths = Array.isArray(request?.movePaths)
      ? request.movePaths.filter((p): p is string => isNonEmptyString(p)).slice(0, 50)
      : []
    const copyFiles = Array.isArray(request?.copyFiles) ? request.copyFiles : []
    if (movePaths.length === 0 && copyFiles.length === 0) {
      return invalidPayload('asset:transfer 需要 movePaths 或 copyFiles')
    }
    return guardSync(() => {
      const result = transferToLibrary(store, { libraryId: request!.libraryId as string, movePaths, copyFiles })
      if (result.moved.length > 0 || result.copied.length > 0) broadcastAssetChanged()
      return result
    })
  })

  /** @backend(asset:set-tags)：文件标签写 .huabu/tags.json 并广播（卡片/库面板同源刷新） */
  ipcMain.handle(IpcChannel.AssetSetTags, (_event, payload: unknown) => {
    const request = payload as { relPath?: unknown; tags?: unknown } | null
    if (!isNonEmptyString(request?.relPath)) return invalidPayload('asset:set-tags 需要 relPath')
    const tags = Array.isArray(request?.tags) ? request!.tags.filter((t): t is string => isNonEmptyString(t)) : []
    return guardSync(() => {
      const dir = currentDir()
      if (!dir) throw new Error('尚未打开工作区')
      const target = resolve(dir, request!.relPath as string)
      if (target !== dir && !target.startsWith(dir + sep)) {
        throw new Error(`路径越出工作区：${request!.relPath}`)
      }
      const cleaned = setFileTags(dir, normalizePath(relative(dir, target)), tags)
      broadcastAssetChanged()
      return { relPath: normalizePath(relative(dir, target)), tags: cleaned }
    })
  })

  /** @backend(asset:delete)：真删素材文件（破坏性；渲染端二次确认，画布卡片由渲染端一并移除） */
  ipcMain.handle(IpcChannel.AssetDelete, (_event, payload: unknown) => {
    const request = payload as { relPath?: unknown } | null
    if (!isNonEmptyString(request?.relPath)) return invalidPayload('asset:delete 需要 relPath')
    return guardSync(() => {
      deleteAsset(store, { relPath: request!.relPath as string })
      broadcastAssetChanged()
      return undefined
    })
  })

  /** @backend(asset:rename)：同目录改名（重名加序号；标签索引键随迁） */
  ipcMain.handle(IpcChannel.AssetRename, (_event, payload: unknown) => {
    const request = payload as { relPath?: unknown; newName?: unknown } | null
    if (!isNonEmptyString(request?.relPath)) return invalidPayload('asset:rename 需要 relPath')
    if (!isNonEmptyString(request?.newName)) return invalidPayload('asset:rename 需要 newName')
    return guardSync(() => {
      const result = renameAsset(store, { relPath: request!.relPath as string, newName: request!.newName as string })
      broadcastAssetChanged()
      return result
    })
  })

  // ---------------------------------------------------------------- media 域：Agent 变更前确认（accessMode=confirm）

  /** 变更前确认的挂起表：requestId → { nodeId, resolve }；回执/中止任一路径都会 settle */
  const pendingApprovals = new Map<string, { nodeId: string; resolve: (accepted: boolean) => void }>()

  /** 发确认卡事件并等待渲染端回执；signal 中止 = 拒绝。settle 后广播 media:confirm-resolved 供渲染端撤卡（幂等） */
  const requestMediaApproval = (
    kind: 'image' | 'video' | 'audio',
    info: MediaApprovalInfo,
    nodeId: string,
    signal: AbortSignal | undefined
  ): Promise<boolean> => {
    const requestId = randomUUID()
    return new Promise<boolean>((resolvePromise) => {
      let settled = false
      const settle = (accepted: boolean) => {
        if (settled) return
        settled = true
        pendingApprovals.delete(requestId)
        resolvePromise(accepted)
        // 撤卡广播：用户点击（本窗口已 resolve）、中止清理都要让所有窗口收卡
        for (const window of BrowserWindow.getAllWindows()) {
          try {
            window.webContents.send(IpcChannel.MediaConfirmResolvedEvent, { requestId })
          } catch {
            /* 窗口可能正在销毁 */
          }
        }
      }
      pendingApprovals.set(requestId, { nodeId, resolve: settle })
      for (const window of BrowserWindow.getAllWindows()) {
        try {
          window.webContents.send(IpcChannel.MediaConfirmRequest, {
            requestId,
            nodeId,
            kind,
            prompt: info.prompt,
            ...(info.provider ? { provider: info.provider } : {}),
            ...(info.model ? { model: info.model } : {}),
            ...(info.ratio ? { ratio: info.ratio } : {}),
            ...(info.durationSeconds ? { durationSeconds: info.durationSeconds } : {}),
            refCount: info.refCount
          } satisfies MediaConfirmPayload)
        } catch {
          /* 窗口可能正在销毁 */
        }
      }
      if (signal) {
        if (signal.aborted) settle(false)
        else signal.addEventListener('abort', () => settle(false), { once: true })
      }
    })
  }

  // ---------------------------------------------------------------- chat 域（M3 + M9 扩展）

  ipcMain.handle(IpcChannel.ChatRuntime, () => {
    const dir = currentDir()
    if (!dir) {
      return {
        ok: true,
        value: { ready: false, error: '尚未打开工作区', models: [], configuredProviders: [] }
      } satisfies ChatResult<unknown>
    }
    return host.runtime(dir)
  })

  ipcMain.handle(IpcChannel.ChatCreate, (_event, payload: unknown) => {
    const request = payload as Partial<ChatCreateRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:create 需要 nodeId')
    const createRequest: ChatCreateRequest = { nodeId: request.nodeId }
    if (isNonEmptyString(request.cwd)) createRequest.cwd = request.cwd
    if (isNonEmptyString(request.modelId)) createRequest.modelId = request.modelId
    if (isNonEmptyString(request.sessionFile)) createRequest.sessionFile = request.sessionFile
    const current = store.currentWorkspace

    // M13 + T7：会话注入媒体生成工具与 read_media（装配见 agent/mediaToolAssembly.ts）。
    // submit = 提交 + 等待终态：工具 execute 阻塞到成功/失败/取消，期间经 onUpdate 推进度，
    // 失败信息原样进工具结果（Agent 据此引导用户配置），不再有"提交即成功"的假反馈
    const { mediaTools, readMediaTool } = assembleMediaTools(createRequest.nodeId, {
      store,
      mediaManager,
      requestApproval: requestMediaApproval,
      sessionModelSupportsImages: (nid) => host.sessionModelSupportsImages(nid),
      currentDir,
      mediaContext,
      inboxRoot
    })

    return host.create(createRequest, {
      currentDir: current?.path ?? null,
      defaultModel: current?.defaultModel,
      customTools: [...mediaTools, readMediaTool]
    })
  })

  ipcMain.handle(IpcChannel.ChatPrompt, (_event, payload: unknown) => {
    const request = payload as Partial<ChatPromptRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:prompt 需要 nodeId')
    if (!isNonEmptyString(request.text)) return invalidPayload('chat:prompt 需要 text')

    const promptRequest: ChatPromptRequest = { nodeId: request.nodeId, text: request.text }
    return host.prompt(promptRequest)
  })

  ipcMain.handle(IpcChannel.ChatSteer, (_event, payload: unknown) => {
    const request = payload as Partial<ChatSteerRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:steer 需要 nodeId')
    if (!isNonEmptyString(request.text)) return invalidPayload('chat:steer 需要 text')
    return host.steer({ nodeId: request.nodeId, text: request.text })
  })

  ipcMain.handle(IpcChannel.ChatAbort, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:abort 需要 nodeId')
    return host.abort(request)
  })

  ipcMain.handle(IpcChannel.ChatDispose, async (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:dispose 需要 nodeId')
    const result = await host.dispose(request)
    // dispose 成功后该会话不会再有回执：挂起的确认请求按拒绝 settle，防孤儿挂起
    if (result.ok) {
      for (const entry of pendingApprovals.values()) {
        if (entry.nodeId === request.nodeId) entry.resolve(false)
      }
    }
    return result
  })

  ipcMain.handle(IpcChannel.ChatHistory, (_event, payload: unknown) => {
    // 画布恢复时按文件回放历史；节点可能尚未 create，所以直接按路径读
    const request = payload as { nodeId?: unknown; sessionFile?: unknown } | null
    if (!isNonEmptyString(request?.sessionFile)) return invalidPayload('chat:history 需要 sessionFile')
    const nodeId = isNonEmptyString(request.nodeId) ? request.nodeId : ''
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    // 路径合法性校验：必须位于当前工作区 .huabu/sessions/ 内
    const resolved = resolveSessionFile(request.sessionFile, dir)
    if (!resolved.ok) return { ok: false, code: 'cwd_rejected' as const, error: resolved.error }
    return host.readSessionHistory(resolved.sessionFile, nodeId)
  })

  ipcMain.handle(IpcChannel.ChatContextUsage, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:context-usage 需要 nodeId')
    return host.contextUsage(request.nodeId)
  })

  ipcMain.handle(IpcChannel.ChatContextBreakdown, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:context-breakdown 需要 nodeId')
    return host.contextBreakdown(request.nodeId)
  })

  ipcMain.handle(IpcChannel.ChatCompact, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:compact 需要 nodeId')
    return host.compact(request)
  })

  ipcMain.handle(IpcChannel.ChatFork, (_event, payload: unknown) => {
    const request = payload as { nodeId?: unknown; sessionFile?: unknown } | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:fork 需要 nodeId')
    if (!isNonEmptyString(request.sessionFile)) return invalidPayload('chat:fork 需要 sessionFile')
    return host.forkSession({ nodeId: request.nodeId, sessionFile: request.sessionFile }, currentDir())
  })

  ipcMain.handle(IpcChannel.ChatSetModel, async (_event, payload: unknown) => {
    const request = payload as { nodeId?: unknown; modelId?: unknown } | null
    if (!isNonEmptyString(request?.nodeId) || !isNonEmptyString(request?.modelId)) {
      return invalidPayload('chat:set-model 需要 nodeId 与 modelId')
    }
    return host.setModel({ nodeId: request.nodeId, modelId: request.modelId })
  })

  ipcMain.handle(IpcChannel.ChatSetThinking, (_event, payload: unknown) => {
    const request = payload as { nodeId?: unknown; thinkingLevel?: unknown } | null
    if (!isNonEmptyString(request?.nodeId) || !isNonEmptyString(request?.thinkingLevel)) {
      return invalidPayload('chat:set-thinking 需要 nodeId 与 thinkingLevel')
    }
    return host.setThinking({ nodeId: request.nodeId, thinkingLevel: request.thinkingLevel })
  })

  // ---------------------------------------------------------------- settings 域（M9）

  ipcMain.handle(IpcChannel.SettingsChatProviders, () => {
    const dir = currentDir()
    if (!dir) {
      return {
        ok: true,
        value: { providers: [], credentialsHint: '' }
      } satisfies ChatResult<unknown>
    }
    return host.chatProviders(dir)
  })

  ipcMain.handle(IpcChannel.SettingsSetApiKey, (_event, payload: unknown) => {
    const request = payload as Partial<SettingsSetApiKeyRequest> | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('settings:set-api-key 需要 providerId')
    if (!isNonEmptyString(request.apiKey)) return invalidPayload('settings:set-api-key 需要 apiKey')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    return host.setApiKey(dir, request.providerId, request.apiKey)
  })

  ipcMain.handle(IpcChannel.SettingsRemoveApiKey, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('settings:remove-api-key 需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    return host.removeApiKey(dir, providerId)
  })

  ipcMain.handle(IpcChannel.SettingsTestProvider, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('settings:test-provider 需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    return host.testProvider(dir, providerId)
  })

  // ------------------------------------------------ settings 域：自定义模型/供应商（T5 起写 chat 段）

  /**
   * 覆盖层写完后的统一收尾：重注册 + 归一错误。
   * 忘记调用就等于"设置改了但不生效"，所以收成一个函数而不是各处手抄。
   */
  async function afterChatConfigChange(dir: string): Promise<ChatResult<undefined>> {
    const refreshed = await host.refreshModels(dir)
    return refreshed.ok ? ok() : refreshed
  }

  ipcMain.handle(IpcChannel.SettingsCustomAddProvider, async (_event, payload: unknown) => {
    const request = payload as Partial<CustomProviderInput> | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.baseUrl)) return invalidPayload('需要 baseUrl')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      addCustomProvider(dir, {
        providerId: request.providerId,
        ...(isNonEmptyString(request.name) ? { name: request.name } : {}),
        baseUrl: request.baseUrl,
        ...(isNonEmptyString(request.api) ? { api: request.api } : {})
      })
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsCustomRemoveProvider, async (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      removeCustomProvider(dir, providerId)
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsCustomAddModel, async (_event, payload: unknown) => {
    const request = payload as Partial<CustomModelInput> | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.id)) return invalidPayload('需要模型 id')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      // 供应商存在性由 addCustomModel 判定（覆盖层里有条目 或 在内置目录里），
      // 不再问 pi 的 getProvider——T5 之后内置目录才是"内置"的定义。
      addCustomModel(dir, {
        providerId: request.providerId,
        id: request.id,
        ...(isNonEmptyString(request.name) ? { name: request.name } : {}),
        ...(typeof request.contextWindow === 'number' ? { contextWindow: request.contextWindow } : {}),
        ...(typeof request.maxTokens === 'number' ? { maxTokens: request.maxTokens } : {}),
        ...(request.reasoning === true ? { reasoning: true } : {}),
        ...(Array.isArray(request.input_modalities) ? { input_modalities: request.input_modalities } : {})
      })
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  // ------------------------------------------------ settings 域：模型管理（内置+自定义）

  ipcMain.handle(
    IpcChannel.SettingsModelsList,
    async (_event, payload: unknown): Promise<ChatResult<ManagedModelInfo[]>> => {
      const providerId = (payload as { providerId?: unknown } | null)?.providerId
      if (!isNonEmptyString(providerId)) return invalidPayload('settings:models-list 需要 providerId')
      const dir = currentDir()
      if (!dir) return invalidPayload('尚未打开工作区')
      return host.managedModels(dir, providerId)
    }
  )

  ipcMain.handle(IpcChannel.SettingsModelEdit, async (_event, payload: unknown) => {
    const request = payload as Partial<ModelEditInput> | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.modelId)) return invalidPayload('需要 modelId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    const patch = {
      name: isNonEmptyString(request.name) ? request.name : undefined,
      ...(typeof request.contextWindow === 'number' ? { contextWindow: request.contextWindow } : {}),
      ...(typeof request.maxTokens === 'number' ? { maxTokens: request.maxTokens } : {}),
      ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {})
    }
    try {
      // 落点由覆盖层判定（自建条目直接改；内置条目 = 改名进 modelOverrides、
      // 能力字段进同 id 补丁），这里不再区分两套文件
      editCustomModel(dir, {
        providerId: request.providerId,
        modelId: request.modelId,
        ...patch
      })
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsModelRemove, async (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; modelId?: unknown } | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.modelId)) return invalidPayload('需要 modelId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      deleteModel(dir, request.providerId, request.modelId)
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsModelRestore, async (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; modelId?: unknown } | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.modelId)) return invalidPayload('需要 modelId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      restoreBuiltinModel(dir, request.providerId, request.modelId)
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsMediaStatus, async (): Promise<ChatResult<MediaSettingsStatus>> => {
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      const config = store.mediaConfig()
      const effective = mergeCatalog(BUILTIN_PROVIDERS, config)
      const providers: MediaProviderStatus[] = []
      for (const entry of effective) {
        const hasStored = await host.hasMediaKey(dir, entry.authKey)
        const keySource: MediaProviderStatus['keySource'] = hasStored
          ? 'workspace-store'
          : entry.authEnv && process.env[entry.authEnv]
            ? 'environment'
            : 'none'
        providers.push({
          id: entry.id,
          label: entry.label,
          type: entry.type,
          source: entry.source,
          modelCount: entry.models.length,
          keySource
        })
      }
      return {
        ok: true,
        value: {
          confirmVideo: config.confirmVideo ?? true,
          accessMode: config.accessMode ?? 'full',
          providers,
          config: {
            agentProvider: config.agentProvider ?? DEFAULT_MEDIA_PROVIDER,
            agentModels: config.agentModels ?? {},
            outputDir: config.outputDir ?? MEDIA_ROOT_REL,
            concurrency: normalizeConcurrency(config.concurrency),
            defaultRatio: config.defaultRatio ?? DEFAULT_MEDIA_RATIO,
            defaultDuration: config.defaultDuration ?? DEFAULT_MEDIA_DURATION_S,
            ...(config.defaultLibraryId ? { defaultLibraryId: config.defaultLibraryId } : {}),
            ...(config.kindLibraryDefaults ? { kindLibraryDefaults: config.kindLibraryDefaults } : {}),
            ...(config.hiddenBuiltin?.length ? { hiddenBuiltin: config.hiddenBuiltin } : {})
          }
        }
      }
    } catch (error) {
      return { ok: false, code: 'unknown', error: describe(error) }
    }
  })

  function normalizeConcurrency(value: unknown): number {
    return typeof value === 'number' && value >= 1 && value <= 8 ? Math.round(value) : DEFAULT_MEDIA_CONCURRENCY
  }

  ipcMain.handle(IpcChannel.MediaSetConfig, (_event, payload: unknown) => {
    const patch = (payload ?? {}) as MediaConfigPatch
    if (typeof patch !== 'object' || patch === null) return invalidPayload('media:set-config 需要配置对象')
    const clean: Record<string, unknown> = {}
    if (isNonEmptyString(patch.agentProvider)) clean.agentProvider = patch.agentProvider
    if (patch.agentModels && typeof patch.agentModels === 'object') {
      const models: Record<string, string> = {}
      for (const kind of ['image', 'video', 'audio'] as const) {
        const value = patch.agentModels[kind]
        if (isNonEmptyString(value)) models[kind] = value
      }
      clean.agentModels = models
    }
    if (patch.outputDir !== undefined) {
      if (!isNonEmptyString(patch.outputDir)) {
        clean.outputDir = MEDIA_ROOT_REL
      } else {
        const normalized = patch.outputDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const resolved = resolve(currentDir() ?? '', normalized)
        const base = resolve(currentDir() ?? '')
        if (!normalized || resolved === base || !resolved.startsWith(base + sep)) {
          return invalidPayload('media:set-config 的 outputDir 必须是工作区内的相对路径')
        }
        clean.outputDir = normalized
      }
    }
    if (patch.concurrency !== undefined) {
      if (typeof patch.concurrency !== 'number' || patch.concurrency < 1 || patch.concurrency > 8) {
        return invalidPayload('media:set-config 的 concurrency 需在 1..8')
      }
      clean.concurrency = Math.round(patch.concurrency)
    }
    if (patch.defaultRatio !== undefined) {
      if (!(MEDIA_RATIOS as readonly string[]).includes(patch.defaultRatio)) {
        return invalidPayload('media:set-config 的 defaultRatio 不合法')
      }
      clean.defaultRatio = patch.defaultRatio
    }
    if (patch.defaultDuration !== undefined) {
      if (typeof patch.defaultDuration !== 'number' || patch.defaultDuration < 1 || patch.defaultDuration > 60) {
        return invalidPayload('media:set-config 的 defaultDuration 需在 1..60 秒')
      }
      clean.defaultDuration = Math.round(patch.defaultDuration)
    }
    if (typeof patch.confirmVideo === 'boolean') clean.confirmVideo = patch.confirmVideo
    if (patch.defaultLibraryId !== undefined) {
      // 空串清除；特殊值 builtin-assets（画布素材）/ none（仅产物目录）；
      // 其余必须是现存素材库 id（防拼出指向不存在库的僵尸默认）
      if (!isNonEmptyString(patch.defaultLibraryId)) {
        clean.defaultLibraryId = ''
      } else if (
        patch.defaultLibraryId !== 'builtin-assets' &&
        patch.defaultLibraryId !== 'none' &&
        !store.getLibraries().some((l) => l.id === patch.defaultLibraryId)
      ) {
        return invalidPayload('media:set-config 的 defaultLibraryId 不是现存素材库')
      } else {
        clean.defaultLibraryId = patch.defaultLibraryId
      }
    }
    if (patch.kindLibraryDefaults !== undefined) {
      const known = new Set(store.getLibraries().map((l) => l.id))
      known.add('builtin-assets')
      known.add('none')
      const defaults: Record<string, string> = {}
      for (const kind of ['image', 'video', 'audio'] as const) {
        const value = patch.kindLibraryDefaults[kind]
        if (!isNonEmptyString(value)) continue
        if (!known.has(value)) return invalidPayload(`media:set-config 的 kindLibraryDefaults.${kind} 不是现存素材库`)
        defaults[kind] = value
      }
      clean.kindLibraryDefaults = defaults
    }
    return guardSync(() => {
      // 空串 defaultLibraryId = 清除语义：setMediaConfig 是 merge，undefined 覆盖后
      // JSON.stringify 会丢掉该键，达到删除效果
      if (clean.defaultLibraryId === '') {
        store.setMediaConfig({ defaultLibraryId: undefined })
        delete clean.defaultLibraryId
      }
      return store.setMediaConfig(clean)
    })
  })

  // ------------------------------------------------ media 域：用户供应商/模型管理（写 workspace.json 覆盖层）

  /**
   * 校验+清洗用的小工具：kind 只认三类媒体。这里的校验刻意与 merge.ts 的清洗
   * 同源（PROVIDER/MODEL_ID_PATTERN），用户输入错误给可读的错误文本。
   */
  const asMediaKind = (value: unknown): 'image' | 'video' | 'audio' | null =>
    value === 'image' || value === 'video' || value === 'audio' ? value : null

  ipcMain.handle(IpcChannel.MediaUserAddProvider, (_event, payload: unknown) => {
    const request = payload as Partial<MediaUserProviderInput> | null
    const rawId = request?.id
    if (!isNonEmptyString(rawId) || !PROVIDER_ID_PATTERN.test(rawId.trim())) {
      return invalidPayload('供应商 id 不合法（只允许字母/数字/点/横线/下划线）')
    }
    const providerId = rawId.trim()
    const type = request?.type
    if (typeof type !== 'string' || !isRegisteredAdapterType(type)) {
      return invalidPayload('type 必须是已实现的适配器类型（如 gateway-openai-compat）')
    }
    const first = request?.firstModel
    const firstModelId = first?.id
    if (!isNonEmptyString(firstModelId) || !MODEL_ID_PATTERN.test(firstModelId.trim())) {
      return invalidPayload('首个模型 id 不合法（只允许字母/数字/点/横线/下划线/斜杠）')
    }
    const firstKind = asMediaKind(first?.kind)
    if (!firstKind) return invalidPayload('firstModel.kind 需要 image|video|audio')
    const label = isNonEmptyString(request?.label) ? request.label : undefined
    const baseUrl = isNonEmptyString(request?.baseUrl) ? request.baseUrl : undefined
    const authEnv = isNonEmptyString(request?.authEnv) ? request.authEnv : undefined
    const firstLabel = isNonEmptyString(first?.label) ? first.label : undefined
    return guardSync(() => {
      const config = store.mediaConfig()
      if ((config.userProviders ?? []).some((p) => p.id === providerId)) {
        throw new Error(`用户供应商 ${providerId} 已存在；如需替换请先删除`)
      }
      // 结构化后仍过一遍 sanitize（baseUrl 等形态兜底；关键字段已手校，不会触发 warn）
      const sanitized = sanitizeUserProvider({
        id: providerId,
        type,
        ...(label ? { label } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(authEnv ? { authEnv } : {}),
        models: {
          [firstModelId.trim()]: {
            kind: firstKind,
            ...(firstLabel ? { label: firstLabel } : {})
          }
        }
      })
      if (!sanitized) throw new Error('供应商配置不合法，已拦截')
      return store.setMediaConfig({ userProviders: [...(config.userProviders ?? []), sanitized] })
    })
  })

  ipcMain.handle(IpcChannel.MediaUserRemoveProvider, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    return guardSync(() => {
      const config = store.mediaConfig()
      const existing = config.userProviders ?? []
      const next = existing.filter((p) => p.id !== providerId)
      if (next.length === existing.length) {
        throw new Error(`没有用户供应商 ${providerId}（内置供应商不能删除，只能移除它的模型）`)
      }
      return store.setMediaConfig({ userProviders: next })
    })
  })

  ipcMain.handle(IpcChannel.MediaUserAddModel, (_event, payload: unknown) => {
    const request = payload as Partial<MediaUserModelInput> | null
    const providerId = request?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    const rawModelId = request?.id
    if (!isNonEmptyString(rawModelId) || !MODEL_ID_PATTERN.test(rawModelId.trim())) {
      return invalidPayload('模型 id 不合法（只允许字母/数字/点/横线/下划线/斜杠）')
    }
    const modelId = rawModelId.trim()
    const kind = asMediaKind(request?.kind)
    if (!kind) return invalidPayload('kind 需要 image|video|audio')
    const label = isNonEmptyString(request?.label) ? request.label : undefined
    const costHint = isNonEmptyString(request?.costHint) ? request.costHint.trim() : undefined
    const capabilities = sanitizeCapabilities(request?.capabilities)
    return guardSync(() => {
      const config = store.mediaConfig()
      const effective = mergeCatalog(BUILTIN_PROVIDERS, config)
      const provider = effective.find((p) => p.id === providerId)
      if (!provider) throw new Error(`供应商不存在：${providerId}`)
      if (provider.models.some((m) => m.id === modelId)) {
        throw new Error(`模型已存在：${modelId}`)
      }
      const modelDef = {
        kind,
        ...(label ? { label } : {}),
        ...(costHint ? { costHint } : {}),
        ...(capabilities ? { capabilities } : {})
      }
      const userProviders = [...(config.userProviders ?? [])]
      const entryIndex = userProviders.findIndex((p) => p.id === providerId)
      if (entryIndex >= 0) {
        userProviders[entryIndex] = {
          ...userProviders[entryIndex],
          models: { ...userProviders[entryIndex].models, [modelId]: modelDef }
        }
      } else {
        // 内置供应商：经同名用户条目追加模型（type 跟随内置目录，合并层语义即覆盖子集）
        userProviders.push({
          id: providerId,
          type: provider.type,
          models: { [modelId]: modelDef }
        })
      }
      return store.setMediaConfig({ userProviders })
    })
  })

  ipcMain.handle(IpcChannel.MediaUserRemoveModel, (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; modelId?: unknown } | null
    const providerId = request?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    const modelId = request?.modelId
    if (!isNonEmptyString(modelId)) return invalidPayload('需要 modelId')
    return guardSync(() => {
      const config = store.mediaConfig()
      const effective = mergeCatalog(BUILTIN_PROVIDERS, config)
      const provider = effective.find((p) => p.id === providerId)
      if (!provider?.models.some((m) => m.id === modelId)) {
        throw new Error(`${providerId} 下没有模型 ${modelId}`)
      }
      // 用户配置里的同 id 模型删除；模型被删光的用户供应商整个清掉
      const userProviders = (config.userProviders ?? [])
        .map((p) => {
          if (p.id !== providerId || !(modelId in p.models)) return p
          const models = { ...p.models }
          delete models[modelId]
          return { ...p, models }
        })
        .filter((p) => Object.keys(p.models).length > 0)
      const patch: Record<string, unknown> = { userProviders }
      // 同时是内置模型 → 进隐藏清单（不删除目录条目，恢复随时可做）
      const isBuiltin = BUILTIN_PROVIDERS.some(
        (p) => p.id === providerId && p.models.some((m) => m.id === modelId)
      )
      if (isBuiltin) {
        patch.hiddenBuiltin = [...new Set([...(config.hiddenBuiltin ?? []), modelId])]
      }
      return store.setMediaConfig(patch)
    })
  })

  ipcMain.handle(IpcChannel.MediaUserRestoreModel, (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; modelId?: unknown } | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    const modelId = request?.modelId
    if (!isNonEmptyString(modelId)) return invalidPayload('需要 modelId')
    return guardSync(() => {
      const config = store.mediaConfig()
      const hiddenBuiltin = (config.hiddenBuiltin ?? []).filter((id) => id !== modelId)
      return store.setMediaConfig({ hiddenBuiltin })
    })
  })

  /**
   * 浏览供应商的全量模型目录（随应用打包的只读数据，见 catalog/browse.ts）。
   * enabled 标注按生效清单计算：条目 id（即发给网关的 endpoint）命中任一
   * 生效模型的 id 或 requestModel 即视为已添加；没有目录的供应商返回空数组。
   */
  ipcMain.handle(IpcChannel.MediaBrowseCatalog, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    return guardSync(() => {
      const source = browseCatalog(providerId.trim())
      if (source.length === 0) return []
      const config = store.mediaConfig()
      const effective = mergeCatalog(BUILTIN_PROVIDERS, config)
      const provider = effective.find((p) => p.id === providerId.trim())
      const enabledKeys = new Set<string>()
      for (const m of provider?.models ?? []) {
        enabledKeys.add(m.id)
        if (m.requestModel) enabledKeys.add(m.requestModel)
      }
      return source.map((item) => ({ ...item, enabled: enabledKeys.has(item.id) }))
    })
  })

  ipcMain.handle(IpcChannel.SettingsMediaSetKey, async (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; apiKey?: unknown } | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.apiKey)) return invalidPayload('需要 apiKey')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      await host.setMediaKey(dir, request.providerId, request.apiKey)
      return ok()
    } catch (error) {
      return { ok: false, code: 'unknown', error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsMediaRemoveKey, async (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      await host.removeMediaKey(dir, providerId)
      return ok()
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  // ---------------------------------------------------------------- media 域（M11/M12）

  /**
   * 媒体凭据读取：加密存储优先，退回供应商声明的环境变量（合并层已按
   * 目录 auth.env / 适配器默认值缺省化，这里不再写死任何厂商约定）。
   */
  const resolveMediaKey =
    async (auth: { authKey?: string; authEnv?: string }): Promise<string | undefined> => {
      const dir = currentDir()
      if (!dir) return undefined
      if (auth.authKey) {
        const stored = await host.getMediaKey(dir, auth.authKey)
        if (stored) return stored
      }
      return auth.authEnv ? process.env[auth.authEnv] : undefined
    }

  const adapterDeps: AdapterDeps = {
    mediaDir: () => store.mediaDir(),
    resolveKey: resolveMediaKey
  }

  /**
   * 适配器按「工作区 + 合并清单指纹」缓存：config 指纹不变则复用实例，
   * 避免每次 context() 都重建全部适配器。
   */
  let adapterCache: { workspace: string | null; fingerprint: string; adapters: MediaProviderAdapter[] } | null = null

  const mediaContext = (): {
    mediaDir: string | null
    workspaceDir: string | null
    config: ReturnType<WorkspaceStore['mediaConfig']>
    providers: AdapterProviderConfig[]
    adapters: MediaProviderAdapter[]
    ready: boolean
    notifyAssetsChanged: () => void
  } => {
    const mediaDir = store.mediaDir()
    const config = store.mediaConfig()
    const workspace = currentDir()
    // mergeCatalog 是清单的唯一入口：内置目录 + workspace.json 覆盖层 → 生效供应商
    const providers = mergeCatalog(BUILTIN_PROVIDERS, config)
    const fingerprint = JSON.stringify(providers)
    if (!adapterCache || adapterCache.workspace !== workspace || adapterCache.fingerprint !== fingerprint) {
      adapterCache = {
        workspace,
        fingerprint,
        adapters: createAdapters(providers, adapterDeps)
      }
    }
    return {
      mediaDir,
      workspaceDir: workspace,
      config,
      providers,
      adapters: adapterCache.adapters,
      ready: Boolean(workspace),
      // 产物落进素材库目录后由 MediaJobManager 调用，面板才会即时出现新文件（否则要重开工作区）
      notifyAssetsChanged: broadcastAssetChanged
    }
  }

  const broadcastMediaJob = (job: MediaJobStatus): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents
      if (contents.isDestroyed()) continue
      try {
        contents.send(IpcChannel.MediaJobEvent, job)
      } catch (error) {
        console.error(`[ipc] media:job 广播失败：${String(error)}`)
      }
    }
  }

  const mediaManager = new MediaJobManager(broadcastMediaJob, mediaContext)
  mediaManager.reconcilePersistedJobs()

  ipcMain.handle(IpcChannel.MediaProviders, async (): Promise<ChatResult<MediaProviderInfo[]>> => {
    try {
      // 异步凭据探测（isReady：查加密存储/环境变量），设置页绿点才真实
      return { ok: true, value: await mediaManager.providers() }
    } catch (error) {
      return { ok: false, code: 'unknown', error: describe(error) }
    }
  })

  ipcMain.handle(
    IpcChannel.MediaGenerate,
    async (_event, payload: unknown): Promise<ChatResult<{ jobId: string }>> => {
      const request = payload as Partial<MediaGenerateRequest> | null
      if (!isNonEmptyString(request?.provider)) return invalidPayload('media:generate 需要 provider')
      if (!isNonEmptyString(request.model)) return invalidPayload('media:generate 需要 model')
      if (!isNonEmptyString(request.prompt)) return invalidPayload('media:generate 需要 prompt')
      if (request.kind !== 'image' && request.kind !== 'video' && request.kind !== 'audio') {
        return invalidPayload('media:generate 需要 kind=image|video|audio')
      }
      const generateRequest: MediaGenerateRequest = {
        provider: request.provider,
        model: request.model,
        kind: request.kind,
        prompt: request.prompt
      }
      if (isNonEmptyString(request.nodeId)) generateRequest.nodeId = request.nodeId
      if (isNonEmptyString(request.sourceChatId)) generateRequest.sourceChatId = request.sourceChatId
      // 比例是语义参数（像素换算在编排层收口）；width/height 仅作高级覆盖保留
      if (isNonEmptyString(request.ratio)) {
        if (!(MEDIA_RATIOS as readonly string[]).includes(request.ratio)) {
          return invalidPayload(`media:generate 的 ratio 不合法（可选：${MEDIA_RATIOS.join('/')}）`)
        }
        generateRequest.ratio = request.ratio as MediaRatio
      }
      if (typeof request.width === 'number' && request.width > 0) {
        generateRequest.width = Math.min(4096, Math.round(request.width))
      }
      if (typeof request.height === 'number' && request.height > 0) {
        generateRequest.height = Math.min(4096, Math.round(request.height))
      }
      if (typeof request.durationSeconds === 'number' && request.durationSeconds > 0) {
        generateRequest.durationSeconds = Math.min(120, Math.round(request.durationSeconds))
      }
      if (Array.isArray(request.refPaths)) {
        const refPaths = request.refPaths.filter((p): p is string => isNonEmptyString(p)).slice(0, 4)
        if (refPaths.length > 0) generateRequest.refPaths = refPaths
      }
      // 落库目录（相对工作区根）：越界校验在 MediaJobManager.submit 内做
      if (isNonEmptyString(request.outputDir)) generateRequest.outputDir = request.outputDir
      // 产物命名：净化与重名序号在 MediaJobManager.submit/materialize 内收口
      if (isNonEmptyString(request.name)) generateRequest.name = request.name
      try {
        return { ok: true, value: await mediaManager.submit(generateRequest) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, code: 'unknown', error: message }
      }
    }
  )

  ipcMain.handle(IpcChannel.MediaCancel, async (_event, payload: unknown) => {
    const jobId = (payload as { jobId?: unknown } | null)?.jobId
    if (!isNonEmptyString(jobId)) return invalidPayload('media:cancel 需要 jobId')
    const cancelled = await mediaManager.cancel(jobId)
    return {
      ok: cancelled,
      ...(cancelled ? {} : { code: 'unknown' as const, error: '任务不存在或已结束' })
    }
  })

  ipcMain.handle(IpcChannel.MediaJobs, () => {
    return { ok: true, value: mediaManager.list() } satisfies ChatResult<MediaJobStatus[]>
  })

  ipcMain.handle(IpcChannel.MediaSetConfirmVideo, (_event, payload: unknown) => {
    const confirm = (payload as { confirm?: unknown } | null)?.confirm
    if (typeof confirm !== 'boolean') return invalidPayload('media:set-confirm-video 需要 confirm:boolean')
    return guardSync(() => store.setMediaConfig({ confirmVideo: confirm }))
  })

  ipcMain.handle(IpcChannel.MediaSetAccessMode, (_event, payload: unknown) => {
    const mode = (payload as { mode?: unknown } | null)?.mode
    if (mode !== 'full' && mode !== 'confirm') {
      return invalidPayload('media:set-access-mode 需要 mode=full|confirm')
    }
    return guardSync(() => {
      store.setMediaConfig({ accessMode: mode as 'full' | 'confirm' })
      return undefined
    })
  })

  ipcMain.handle(IpcChannel.MediaConfirmResolve, (_event, payload: unknown) => {
    const request = payload as { requestId?: unknown; accepted?: unknown } | null
    if (!isNonEmptyString(request?.requestId) || typeof request.accepted !== 'boolean') {
      return invalidPayload('media:confirm-resolve 需要 requestId 与 accepted:boolean')
    }
    // 未知 requestId 静默 ok：回执可能晚于中止/清理的先行 settle，幂等
    pendingApprovals.get(request.requestId)?.resolve(request.accepted === true)
    return ok()
  })

  /**
   * 导入 OS 媒体文件：拷入当前工作区 .huabu/media/，返回产物描述。
   * sourcePath 来自 preload 的 webUtils.getPathForFile（不把文件字节搬过 IPC）；
   * 剪贴板图片没有磁盘路径，走 base64 兜底通道。
   */
  ipcMain.handle(IpcChannel.MediaImport, (_event, payload: unknown): ChatResult<unknown> => {
    const request = payload as Partial<MediaImportRequest> | null
    const dir = store.mediaDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    if (!request || (typeof request.sourcePath !== 'string' && typeof request.base64 !== 'string')) {
      return invalidPayload('media:import 需要 sourcePath 或 base64')
    }
    const kind: MediaKind =
      request.kind === 'video' || request.kind === 'audio' || request.kind === 'image'
        ? request.kind
        : guessKind(request.sourcePath ?? '', request.mime)
    try {
      mkdirSync(dir, { recursive: true })
      let target: string
      let displayName: string
      if (typeof request.base64 === 'string') {
        const ext = request.mime?.includes('jpeg') ? '.jpg' : '.png'
        displayName = `clipboard-${randomUUID().slice(0, 8)}${ext}`
        target = join(dir, displayName)
        writeFileSync(target, Buffer.from(request.base64, 'base64'))
      } else if (typeof request.sourcePath === 'string') {
        const source = resolve(request.sourcePath)
        displayName = `${randomUUID().slice(0, 8)}-${sanitizeName(request.name ?? basename(source))}`
        target = copyIntoDir(source, dir, displayName)
      } else {
        return invalidPayload('media:import 需要 sourcePath 或 base64')
      }
      const bytes = statSync(target).size
      const mime = request.mime ?? mimeFromExt(extname(target)) ?? defaultMime(kind)
      const relPath = basename(target)
      return {
        ok: true,
        value: {
          artifact: {
            relPath,
            name: sanitizeName(request.name ?? relPath),
            mime,
            bytes
          },
          url: buildMediaUrl(relPath)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'unknown', error: `导入失败：${message}` }
    }
  })
}

/**
 * Agent 媒体工具的 provider/model 解析。
 *
 * 回退链的唯一实现在 shared/mediaResolve.ts（与渲染端卡片共用同一纯函数，语义一致）。
 * 默认供应商不存在、没有同类模型、没配 Key 时，都给可操作错误，绝不静默生成假图。
 */
/**
 * 生成产物的默认落库目录与 Agent 媒体解析已收拢进 agent/mediaToolAssembly.ts
 * （T12）：它们只服务 Agent 工具路径，此处原先的两份实现随之删除。
 */

/** 从扩展名猜媒体大类（导入时渲染端可不传 kind） */
function guessKind(pathOrName: string, mime?: string): MediaKind {
  if (mime?.startsWith('video/')) return 'video'
  if (mime?.startsWith('audio/')) return 'audio'
  const ext = extname(pathOrName).toLowerCase()
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext)) return 'audio'
  return 'image'
}

function mimeFromExt(ext: string): string | undefined {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac'
  }
  return map[ext.toLowerCase()]
}

function defaultMime(kind: MediaKind): string {
  return kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/wav' : 'image/png'
}

/** 文件名只保留安全字符，防止路径穿越与奇怪字符进 canvas.json */
function sanitizeName(name: string): string {
  const cleaned = basename(name)
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5 ]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120)
  return cleaned || 'media'
}
