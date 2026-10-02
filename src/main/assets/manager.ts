import { randomUUID } from 'crypto'
import { basename, dirname, join, relative, resolve, sep } from 'path'
// 约束与出处（性能优化 P0：素材/导入链路去同步 IO）：导入/清单/归档的文件操作一律走
// fs/promises，主进程同步 IO（512MB 级 copyFile、逐文件 stat）会冻结全部 IPC/UI 数秒。
// 留存的同步调用都有出处：renameAsset/deleteAsset 是单文件元数据操作（不在本次范围）、
// inboxRoot 的 mkdirSync 只跑一次、uniqueNameInDir 仅 existsSync 元数据查询
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { app } from 'electron'
import {
  ASSET_CATEGORIES,
  categorizeFileName,
  dedupeName,
  normalizePath,
  OTHER_CATEGORY
} from '../../shared/assets'
import type {
  AssetDeleteRequest,
  AssetImportItem,
  AssetImportResult,
  AssetLibrariesInfo,
  AssetLibrary,
  AssetLibraryFile,
  AssetRenameRequest,
  AssetRenameResult,
  AssetTransferResult,
  ImportedAsset
} from '../../shared/ipc'
import { copyIntoDir, WorkspaceStore } from '../workspace/store'
import { loadTagsIndex, setFileTags } from './tagsIndex'

/**
 * 素材域（asset）主进程模块。
 *
 * 对应原型 huabuai-proto-v2 的 src/harness/mockFs.ts（@backend 标注的模拟实现），
 * 这里是真实落盘版本：
 *
 * - `importToWorkspace`：@backend(import-canvas)。OS 拖入画布的源文件按
 *   ASSET_CATEGORIES 归档到 <工作区>/assets/<分类>/，重名追加时间戳，永不覆盖。
 * - `importToInbox`：@backend(import-temp)。拖到输入框的源文件复制到
 *   userData/huabu-inbox/<yyyymmdd>/<uuid>-<名> —— 故意放在工作区之外：
 *   临时素材不属于项目，且 Agent 只会拿到绝对路径（路径引用契约）。
 * - `listLibraries`：素材库清单 = 内置 assets/ 合成库 + workspace.json
 *   libraries 段映射的命名库。文件清单现算（目录扫描），不落库。
 *
 * 素材库面板维护（新建/移除映射）走 WorkspaceStore.addLibrary/removeLibrary，
 * 本模块只管读。
 */

/** 单个素材文件的上限（拖入即复制，防误拖超大文件占爆磁盘） */
const MAX_IMPORT_BYTES = 512 * 1024 * 1024
/** 素材库面板每个库列出的文件数上限（目录扫描现算，截断防爆） */
const MAX_LIBRARY_FILES = 200
/** 临时收件箱保留天数：更早的日期目录在下次 importToInbox 时清理 */
const INBOX_KEEP_DAYS = 7

let cachedInboxRoot: string | null = null

/** @backend(temp-inbox)：临时收件箱根目录（userData 下，工作区之外）。媒体协议每个请求都会取，结果缓存 */
export function inboxRoot(): string {
  if (!cachedInboxRoot) {
    cachedInboxRoot = resolve(app.getPath('userData'), 'huabu-inbox')
    mkdirSync(cachedInboxRoot, { recursive: true })
  }
  return cachedInboxRoot
}

function dateTag(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

function isImportItem(raw: unknown): raw is AssetImportItem {
  if (!raw || typeof raw !== 'object') return false
  const rec = raw as Record<string, unknown>
  return typeof rec.sourcePath === 'string' && rec.sourcePath.trim().length > 0
}

/**
 * @backend(import-canvas)：源文件按分类归档进工作区 assets/。
 * 逐文件独立容错：一个失败不影响其余（拖一堆文件时常见的部分成功场景）。
 */
export async function importToWorkspace(workspaceDir: string, files: unknown[]): Promise<AssetImportResult> {
  const imported: ImportedAsset[] = []
  const failed: { name: string; error: string }[] = []
  for (const raw of files) {
    if (!isImportItem(raw)) {
      failed.push({ name: String((raw as { name?: unknown })?.name ?? '?'), error: '条目缺少 sourcePath' })
      continue
    }
    const name = (typeof raw.name === 'string' && raw.name.trim()) || basename(raw.sourcePath)
    try {
      const source = resolve(raw.sourcePath)
      if (!existsSync(source)) throw new Error(`源文件不存在：${raw.sourcePath}`)
      const st = await stat(source)
      if (!st.isFile()) throw new Error('不是常规文件')
      if (st.size > MAX_IMPORT_BYTES) throw new Error(`文件过大（>${MAX_IMPORT_BYTES / 1024 / 1024}MB）`)

      const { category, kind } = categorizeFileName(name)
      const destDir = resolve(workspaceDir, category.dir)
      let destName = name
      if (existsSync(join(destDir, destName))) destName = dedupeName(name)
      const dest = await copyIntoDir(source, destDir, destName)
      imported.push({
        name: destName,
        kind,
        relPath: normalizePath(relative(workspaceDir, dest)),
        absPath: normalizePath(dest),
        bytes: st.size,
        ...(typeof raw.mime === 'string' && raw.mime ? { mime: raw.mime } : {})
      })
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { imported, failed }
}

/**
 * @backend(import-temp)：源文件复制进临时收件箱（工作区之外），回传绝对路径。
 * 顺手清理超过保留天数的日期目录（拖文件时顺带做一次，不引入定时器）。
 */
export async function importToInbox(files: unknown[]): Promise<AssetImportResult> {
  const dayDir = resolve(inboxRoot(), dateTag())
  await mkdir(dayDir, { recursive: true })
  await pruneInbox()

  const imported: ImportedAsset[] = []
  const failed: { name: string; error: string }[] = []
  for (const raw of files) {
    if (!isImportItem(raw)) {
      failed.push({ name: String((raw as { name?: unknown })?.name ?? '?'), error: '条目缺少 sourcePath' })
      continue
    }
    const name = (typeof raw.name === 'string' && raw.name.trim()) || basename(raw.sourcePath)
    try {
      const source = resolve(raw.sourcePath)
      if (!existsSync(source)) throw new Error(`源文件不存在：${raw.sourcePath}`)
      const st = await stat(source)
      if (!st.isFile()) throw new Error('不是常规文件')
      if (st.size > MAX_IMPORT_BYTES) throw new Error(`文件过大（>${MAX_IMPORT_BYTES / 1024 / 1024}MB）`)

      const dest = await copyIntoDir(source, dayDir, `${randomUUID()}-${name}`)
      const { kind } = categorizeFileName(name)
      imported.push({
        name,
        kind,
        absPath: normalizePath(dest),
        bytes: st.size,
        ...(typeof raw.mime === 'string' && raw.mime ? { mime: raw.mime } : {})
      })
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { imported, failed }
}

/** 清理超过 INBOX_KEEP_DAYS 天的收件箱日期目录（readdir/rm 失败沿用同步版的整体上抛，由 handler 收敛） */
async function pruneInbox(now: Date = new Date()): Promise<void> {
  const root = inboxRoot()
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - INBOX_KEEP_DAYS)
  const cutoffTag = dateTag(cutoff)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    // 只动符合 yyyymmdd 形态的目录，其余（用户的任何东西）不碰
    if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name)) continue
    if (entry.name < cutoffTag) {
      await rm(join(root, entry.name), { recursive: true, force: true })
    }
  }
}

/**
 * 单目录扫描成 AssetLibraryFile 列表（不递归；素材库是扁平目录约定）。tags 从 .huabu/tags.json 合并。
 * 全异步（fs/promises）：每库逐文件 stat，每库上限 200 文件 × 多目录，同步跑会冻结面板刷新。
 */
async function scanLibraryDir(
  absDir: string,
  workspaceDir: string,
  tagsIndex: Record<string, string[]>
): Promise<AssetLibraryFile[]> {
  if (!existsSync(absDir)) return []
  const out: AssetLibraryFile[] = []
  for (const entry of await readdir(absDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    const abs = join(absDir, entry.name)
    const { kind } = categorizeFileName(entry.name)
    const relPath = normalizePath(relative(workspaceDir, abs))
    out.push({
      name: entry.name,
      kind,
      relPath,
      absPath: normalizePath(abs),
      bytes: (await stat(abs)).size,
      ...(tagsIndex[relPath]?.length ? { tags: tagsIndex[relPath] } : {})
    })
    if (out.length >= MAX_LIBRARY_FILES) break
  }
  // 目录创建顺序不稳定，统一按名字排序让面板展示确定
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * 素材库清单 = 内置 assets/ 合成库 + 命名库（workspace.json libraries 段）。
 * 内置库恒在首位且标记 builtin，渲染端据此隐藏删除按钮。
 * 各目录逐个 await（顺序 = 返回顺序，内置库恒首位），不做并行以保持清单次序确定。
 */
export async function listLibraries(store: WorkspaceStore): Promise<AssetLibrariesInfo> {
  const dir = store.currentDir
  const libraries: AssetLibrary[] = []
  if (dir) {
    const root = resolve(dir)
    // 标签索引每次现读（.huabu/tags.json 小文件，避免标签写入后清单不同步）
    const tagsIndex = loadTagsIndex(root)
    // 内置合成库：assets/ 根（分类归档的落盘点）。files 列各分类子目录的并集
    const assetFiles: AssetLibraryFile[] = []
    for (const category of [...ASSET_CATEGORIES, OTHER_CATEGORY]) {
      assetFiles.push(...(await scanLibraryDir(resolve(root, category.dir), root, tagsIndex)))
    }
    libraries.push({
      id: 'builtin-assets',
      name: '画布素材',
      path: 'assets',
      builtin: true,
      files: assetFiles
    })
    for (const lib of store.getLibraries()) {
      libraries.push({
        id: lib.id,
        name: lib.name,
        path: lib.path,
        ...(lib.isPublic ? { isPublic: true } : {}),
        files: await scanLibraryDir(resolve(root, lib.path), root, tagsIndex)
      })
    }
  }
  return {
    workspaceDir: dir ? normalizePath(dir) : null,
    inboxDir: normalizePath(inboxRoot()),
    libraries
  }
}

/** 文件是否落在收件箱内（WorkspaceReveal / 媒体协议越界校验用） */
export function isInboxPath(absPath: string): boolean {
  const resolved = resolve(absPath)
  const root = inboxRoot()
  return resolved === root || resolved.startsWith(root + sep)
}

/** 供外部拿到「某分类目录的绝对路径」（媒体落库等场景） */
export function categoryAbsDir(workspaceDir: string, categoryId: string): string {
  const category = [...ASSET_CATEGORIES, OTHER_CATEGORY].find((c) => c.id === categoryId)
  return resolve(workspaceDir, category?.dir ?? OTHER_CATEGORY.dir)
}

/* -------------------------------------------------------------------------- */
/* 拖拽归档（asset:transfer）                                                   */
/* -------------------------------------------------------------------------- */

/** 内置合成库 id（listLibraries 的约定，两处必须一致） */
const BUILTIN_LIBRARY_ID = 'builtin-assets'

/**
 * 目标目录不覆盖既有文件：name → name-2 / name-3 …，序号耗尽退回时间戳后缀。
 * 保持同步：只有 existsSync 元数据查询（无重 IO），且 renameAsset（单文件元数据操作，
 * 不在本次异步化范围）同步依赖它 —— 异步化会连带破坏 renameAsset 与探针的直调约定。
 */
function uniqueNameInDir(destDir: string, name: string): string {
  if (!existsSync(join(destDir, name))) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}${ext}`
    if (!existsSync(join(destDir, candidate))) return candidate
  }
  return dedupeName(name)
}

/**
 * 单个文件的落位目录：命名库 = 库目录；内置画布素材库 = 按文件类型归入分类子目录
 * （面板只扫 assets/<分类>/，落 assets 根会不可见）。
 */
function transferDestDir(root: string, namedDir: string | null, fileName: string): string {
  if (namedDir) return namedDir
  return resolve(root, categorizeFileName(fileName).category.dir)
}

/**
 * @backend(asset:transfer)：把文件归入指定素材库 —— 拖拽归档的唯一后端口。
 *
 * - 移动（movePaths）：工作区内文件 rename 到库目录，改路径不复制。画布卡片 /
 *   素材库条目拖到另一个库走这里；源目录 === 目标目录、越界、不存在都按单条失败，
 *   不影响其余条目（成批拖拽时部分成功是常态）。
 * - 复制（copyFiles）：OS 外部文件 copy 进库目录（与 importToWorkspace 同一校验链，
 *   只是落点从「分类目录」换成「指定库目录」）。
 */
export async function transferToLibrary(
  store: WorkspaceStore,
  request: { libraryId: string; movePaths?: string[]; copyFiles?: unknown[] }
): Promise<AssetTransferResult> {
  const wsRoot = store.currentDir
  if (!wsRoot) throw new Error('尚未打开工作区')
  const root = resolve(wsRoot)
  const namedLib =
    request.libraryId === BUILTIN_LIBRARY_ID
      ? null
      : store.getLibraries().find((l) => l.id === request.libraryId)
  if (!namedLib && request.libraryId !== BUILTIN_LIBRARY_ID) {
    throw new Error(`素材库不存在：${request.libraryId}`)
  }
  const namedDir = namedLib ? resolve(root, namedLib.path) : null

  const moved: AssetTransferResult['moved'] = []
  const copied: ImportedAsset[] = []
  const failed: AssetTransferResult['failed'] = []

  for (const rel of request.movePaths ?? []) {
    // rel 是 POSIX 相对路径，Windows 的 path.basename 不认 '/'，自己取末段
    const name = rel.replace(/\/+$/, '').split('/').pop() ?? rel
    try {
      const abs = resolve(root, rel)
      if (abs === root || !abs.startsWith(root + sep)) throw new Error('路径越出工作区')
      if (!existsSync(abs)) throw new Error('源文件不存在（可能已被移动或删除）')
      const destDir = transferDestDir(root, namedDir, name)
      if (resolve(destDir) === resolve(dirname(abs))) throw new Error('文件已在该素材库中')
      await mkdir(destDir, { recursive: true })
      // uniqueNameInDir 保持同步（仅 existsSync 元数据探测，非大文件 copy/目录扫描一类重 IO）
      const finalName = uniqueNameInDir(destDir, name)
      const dest = join(destDir, finalName)
      await rename(abs, dest)
      moved.push({
        from: normalizePath(rel),
        to: normalizePath(relative(root, dest)),
        name: finalName,
        kind: categorizeFileName(finalName).kind
      })
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error.message : String(error) })
    }
  }

  for (const raw of request.copyFiles ?? []) {
    if (!isImportItem(raw)) {
      failed.push({ name: String((raw as { name?: unknown })?.name ?? '?'), error: '条目缺少 sourcePath' })
      continue
    }
    const name = (typeof raw.name === 'string' && raw.name.trim()) || basename(raw.sourcePath)
    try {
      const source = resolve(raw.sourcePath)
      if (!existsSync(source)) throw new Error(`源文件不存在：${raw.sourcePath}`)
      const st = await stat(source)
      if (!st.isFile()) throw new Error('不是常规文件')
      if (st.size > MAX_IMPORT_BYTES) throw new Error(`文件过大（>${MAX_IMPORT_BYTES / 1024 / 1024}MB）`)
      const destDir = transferDestDir(root, namedDir, name)
      // uniqueNameInDir 保持同步（仅 existsSync 元数据探测，非大文件 copy/目录扫描一类重 IO）
      const finalName = uniqueNameInDir(destDir, name)
      const dest = await copyIntoDir(source, destDir, finalName)
      copied.push({
        name: finalName,
        kind: categorizeFileName(name).kind,
        relPath: normalizePath(relative(root, dest)),
        absPath: normalizePath(dest),
        bytes: st.size,
        ...(typeof raw.mime === 'string' && raw.mime ? { mime: raw.mime } : {})
      })
    } catch (error) {
      failed.push({ name, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { moved, copied, failed }
}

/** 把工作区相对路径解析成「根内绝对路径」，越界/非文件抛错（delete/rename 共用的第一道闸） */
function resolveInsideWorkspace(root: string, relPath: string): string {
  const abs = resolve(root, relPath)
  if (abs === root || !abs.startsWith(root + sep)) throw new Error(`路径越出工作区：${relPath}`)
  if (!existsSync(abs)) throw new Error(`文件不存在（可能已被移动或删除）：${relPath}`)
  if (!statSync(abs).isFile()) throw new Error('目标不是文件')
  return abs
}

/**
 * @backend(asset:delete)：真删素材文件。破坏性操作，渲染端负责二次确认；
 * 这里只做越界校验 + 删文件 + 清标签索引键（画布引用卡片由渲染端按返回结果一并移除）。
 */
export function deleteAsset(store: WorkspaceStore, request: AssetDeleteRequest): void {
  const wsRoot = store.currentDir
  if (!wsRoot) throw new Error('尚未打开工作区')
  const root = resolve(wsRoot)
  const abs = resolveInsideWorkspace(root, request.relPath)
  const relPath = normalizePath(relative(root, abs))
  rmSync(abs, { force: true })
  // 标签索引键清理（不存在该键时为无害空操作）
  setFileTags(root, relPath, [])
}

/**
 * @backend(asset:rename)：同目录改名。newName 只取末段（剥掉误带的路径分隔符），
 * 非法字符按导入同款白名单净化；目标重名自动加 `-2` 序号（与 transferToLibrary 同一规则）。
 * 标签索引键随迁（旧键删除、新键写入原标签），返回实际落盘的新名。
 */
export function renameAsset(store: WorkspaceStore, request: AssetRenameRequest): AssetRenameResult {
  const wsRoot = store.currentDir
  if (!wsRoot) throw new Error('尚未打开工作区')
  const root = resolve(wsRoot)
  const abs = resolveInsideWorkspace(root, request.relPath)
  const fromRel = normalizePath(relative(root, abs))
  const rawName = request.newName.trim()
  if (!rawName) throw new Error('新文件名不能为空')
  // 只取末段并净化：白名单外字符换 _（与 media:import 的 sanitizeName 同字符集），保留扩展名形态
  const cleaned = basename(rawName.replace(/\\/g, '/'))
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5 ]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 120)
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error(`文件名不合法：${request.newName}`)
  if (cleaned === basename(abs)) {
    // 名字没变：直接回显当前状态（不落 rename，避免无谓的索引迁移）
    return { relPath: fromRel, name: cleaned }
  }
  const destDir = dirname(abs)
  const finalName = uniqueNameInDir(destDir, cleaned)
  const dest = join(destDir, finalName)
  renameSync(abs, dest)
  const toRel = normalizePath(relative(root, dest))
  // 标签是文件级元数据：旧键删除、新键承接（无标签时两步都是无害空操作）
  const tags = loadTagsIndex(root)[fromRel]
  if (tags && tags.length > 0) {
    setFileTags(root, fromRel, [])
    setFileTags(root, toRel, tags)
  }
  return { relPath: toRel, name: finalName }
}
