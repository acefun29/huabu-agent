/**
 * asset 域 IPC（新原型同步：素材归档 / 临时收件箱 / 素材库映射 / 标签）。
 *
 * 覆盖通道：asset:import-canvas / asset:import-temp / asset:libraries /
 * asset:library-create / asset:library-remove / asset:transfer / asset:set-tags /
 * asset:delete / asset:rename。目录变更统一经 broadcastAssetChanged 广播 asset:changed。
 */
import { ipcMain } from 'electron'
import { relative, resolve, sep } from 'path'
import { IpcChannel } from '../../shared/ipc'
import { normalizePath } from '../../shared/assets'
import {
  deleteAsset,
  importToInbox,
  importToWorkspace,
  listLibraries,
  renameAsset,
  transferToLibrary
} from '../assets/manager'
import { setFileTags } from '../assets/tagsIndex'
import type { IpcContext } from './shared'
import { guardAsync, guardSync, invalidPayload, isNonEmptyString } from './shared'
import { consumeSourcePath } from './workspace'

export function registerAssetIpc(ctx: IpcContext): void {
  const store = ctx.store
  const currentDir = ctx.currentDir
  const broadcastAssetChanged = ctx.broadcastAssetChanged

  const asImportFiles = (payload: unknown): unknown[] | null => {
    const files = (payload as { files?: unknown } | null)?.files
    return Array.isArray(files) && files.length > 0 ? files : null
  }

  /**
   * 拖拽登记闸：files 里每条 sourcePath 都必须经 preload pathForFile 登记过
   * （消费制，逐条删除防重复导入）；任一条未登记/已过期即整单拒绝。
   */
  const consumeRegisteredSourcePaths = (files: unknown[]): boolean => {
    for (const file of files) {
      const sourcePath = (file as { sourcePath?: unknown } | null)?.sourcePath
      if (typeof sourcePath !== 'string' || !consumeSourcePath(sourcePath)) return false
    }
    return true
  }

  /** @backend(import-canvas)：OS 文件归档进 <工作区>/assets/<分类>/（落盘走 fs/promises，handler 异步化） */
  ipcMain.handle(IpcChannel.AssetImportCanvas, async (_event, payload: unknown) => {
    const files = asImportFiles(payload)
    if (!files) return invalidPayload('asset:import-canvas 需要 files 数组')
    // 安全闸：sourcePath 只可能来自 preload pathForFile 的拖拽登记，
    // 未登记的路径一律拒绝，堵住「伪造路径把任意用户文件复制进工作区」的口子
    if (!consumeRegisteredSourcePaths(files)) {
      return invalidPayload('导入路径未经过拖拽登记，已拒绝：请重新把文件拖入画布')
    }
    return guardAsync(async () => {
      const dir = currentDir()
      if (!dir) throw new Error('尚未打开工作区')
      const result = await importToWorkspace(dir, files)
      if (result.imported.length > 0) broadcastAssetChanged()
      return result
    })
  })

  /** @backend(import-temp)：OS 文件复制进 userData 收件箱（工作区之外），回传绝对路径 */
  ipcMain.handle(IpcChannel.AssetImportTemp, async (_event, payload: unknown) => {
    const files = asImportFiles(payload)
    if (!files) return invalidPayload('asset:import-temp 需要 files 数组')
    // 安全闸：同 import-canvas，sourcePath 必须经过拖拽登记
    if (!consumeRegisteredSourcePaths(files)) {
      return invalidPayload('导入路径未经过拖拽登记，已拒绝：请重新把文件拖入画布')
    }
    return guardAsync(() => importToInbox(files))
  })

  /** 素材库清单：内置 assets/ 合成库 + workspace.json libraries 段的命名库（目录扫描异步化） */
  ipcMain.handle(IpcChannel.AssetLibraries, () => guardAsync(() => listLibraries(store)))

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
  ipcMain.handle(IpcChannel.AssetTransfer, async (_event, payload: unknown) => {
    const request = payload as { libraryId?: unknown; movePaths?: unknown; copyFiles?: unknown } | null
    if (!isNonEmptyString(request?.libraryId)) return invalidPayload('asset:transfer 需要 libraryId')
    const movePaths = Array.isArray(request?.movePaths)
      ? request.movePaths.filter((p): p is string => isNonEmptyString(p)).slice(0, 50)
      : []
    const copyFiles = Array.isArray(request?.copyFiles) ? request.copyFiles : []
    if (movePaths.length === 0 && copyFiles.length === 0) {
      return invalidPayload('asset:transfer 需要 movePaths 或 copyFiles')
    }
    return guardAsync(async () => {
      const result = await transferToLibrary(store, { libraryId: request!.libraryId as string, movePaths, copyFiles })
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
}
