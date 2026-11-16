import { app, dialog, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import type {
  CanvasSnapshot,
  WorkspaceDeleteFailure,
  WorkspaceDeleteResult,
  WorkspaceInfo,
  WorkspaceOpenResult,
  WorkspaceStateInfo,
  WorkspaceSummary
} from '../../shared/ipc'
import { MEDIA_ROOT_REL } from '../../shared/assets'
import type { FacetSchema } from '../../shared/facets'
import { readChatConfig, readWorkspaceMeta, writeChatSegment, writeWorkspaceMeta } from './metadata'
import type { WorkspaceLibrary, WorkspaceMediaConfig, WorkspaceMetaFile } from './types'
export type { MediaModelOverride, WorkspaceMediaProviderConfig, WorkspaceMediaConfig, WorkspaceFacetsConfig, WorkspaceSkillsConfig, WorkspaceAgentConfig, WorkspaceLibrary } from './types'
export { readChatConfig, readChatMigrationPlan, readRawMetaFile, writeChatSegment } from './metadata'
import { atomicWriteSync, recoverAtomicBackup } from '../fsutil/atomic'
import { CanvasPersistence } from './canvasPersistence'

/**
 * 管理当前工作区、最近列表和画布快照；工作区元数据由 metadata.ts 持久化。
 * 工作区切换时会话的释放由 IPC 装配层负责。
 */

const CANVAS_VERSIONS = [1, 2, 3] as const

interface RecentsFile {
  version: 1
  lastWorkspace?: string
  recents: WorkspaceSummary[]
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/* 状态目录/凭据路径已拆到 stateDir.ts（轻量模块，避免无关闭包）；此处 re-export 保住既有引用 */
export { getCredentialsFile } from './stateDir'
import { getAppStateDir, getCredentialsFile } from './stateDir'

export class WorkspaceStore {
  private current: WorkspaceInfo | null = null
  private recents: WorkspaceSummary[] = []
  private readonly canvasPersistence = new CanvasPersistence()

  /** 应用启动时调用：恢复上次工作区。返回是否恢复了工作区（渲染端据此决定显示画布还是选择页） */
  bootstrap(): boolean {
    this.recents = this.readRecents()
    const last = this.recentsFile()?.lastWorkspace
    if (isNonEmptyString(last) && existsSync(last)) {
      try {
        this.openByPath(last)
        return true
      } catch (error) {
        console.warn(`[workspace] 恢复上次工作区失败：${String(error)}`)
      }
    }
    return false
  }

  state(): WorkspaceStateInfo {
    return { workspace: this.current, recents: [...this.recents] }
  }

  get currentWorkspace(): WorkspaceInfo | null {
    return this.current
  }

  get currentDir(): string | null {
    return this.current?.path ?? null
  }

  private recentsFile(): RecentsFile | undefined {
    try {
      const raw = readFileSync(join(getAppStateDir(), 'recents.json'), 'utf8')
      return JSON.parse(raw) as RecentsFile
    } catch {
      return undefined
    }
  }

  private readRecents(): WorkspaceSummary[] {
    const file = this.recentsFile()
    return Array.isArray(file?.recents) ? file.recents.filter((item) => existsSync(item.path)) : []
  }

  private persistRecents(): void {
    const last = this.current?.path
    const data: RecentsFile = {
      version: 1,
      ...(last ? { lastWorkspace: last } : {}),
      recents: this.recents.slice(0, 10)
    }
    const file = join(getAppStateDir(), 'recents.json')
    atomicWriteSync(file, JSON.stringify(data, null, 2))
  }

  private remember(dir: string): void {
    this.recents = [
      { path: dir, name: basename(dir), lastOpenedAt: new Date().toISOString() },
      ...this.recents.filter((item) => item.path !== dir)
    ].slice(0, 10)
    this.persistRecents()
  }

  /**
   * 打开（或初始化）一个工作区目录并切换为当前。
   *
   * 返回值里的 disposedSessions 告诉调用方有几个旧会话被释放 —— 这是 M5 DoD
   * 「切换工作区必须 dispose 旧会话」的可观察证据，由调用方（ipc.ts）在切换前
   * 先向 AgentHost 要数字，本类只负责目录与元数据。
   */
  openByPath(requested: string, disposedSessions = 0): WorkspaceInfo {
    if (!isAbsolute(requested)) {
      throw new Error(`工作区路径必须是绝对路径：${requested}`)
    }
    const dir = resolve(requested)
    const root = this.workspacesRoot()
    // 开发期允许在 .workspaces/ 下任意建目录；越出根的用户目录也允许（用户自己选的），
    // 但不允许选盘符根与用户主目录这类「一锅端」的位置，防止 Agent 的 cwd 失控。
    if (dir === dirname(dir)) {
      throw new Error(`不能把盘符根用作工作区：${dir}`)
    }
    // 只需要 .huabu 本体：会话历史已改用 LibSQL（.huabu/mastra.db），不再预建
    // sessions/ 目录（那是 Pi 的 JSONL 落点，运行时已移除）。
    mkdirSync(join(dir, '.huabu'), { recursive: true })

    // workspace.json 的首次读取点：先把崩溃可能遗留的 .bak 还原回来。原子写在
    // 「旧文件已挪成 .bak、新文件未落位」之间被强杀的话，不还原直接读会把旧工作区
    // 误判成从未初始化过，配置整段回默认
    recoverAtomicBackup(join(dir, '.huabu', 'workspace.json'))

    const meta = this.readMeta(dir)
    const info: WorkspaceInfo = {
      path: dir,
      name: basename(dir),
      canvasFile: join(dir, '.huabu', 'canvas.json'),
      workspaceFile: join(dir, '.huabu', 'workspace.json'),
      credentialsHint: getCredentialsFile(dir)
    }
    if (meta.chat?.defaultModel) info.defaultModel = meta.chat.defaultModel
    if (!existsSync(info.workspaceFile)) {
      this.writeMeta(dir, meta)
    }

    // 待写画布只保留一份；切换前先落盘，避免新工作区的保存覆盖旧工作区的待写快照。
    if (this.current?.path !== dir) this.canvasPersistence.flush()
    this.current = info
    this.remember(dir)
    console.log(
      `[workspace] 打开工作区 ${dir}（disposedSessions=${disposedSessions}，root=${root}）`
    )
    return info
  }

  /** 系统目录选择框。取消返回 null；选中即切换 */
  async openDialog(): Promise<WorkspaceOpenResult> {
    const result = await dialog.showOpenDialog({
      title: '选择工作区目录（一个目录 = 一张画布）',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: this.workspacesRoot()
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true, disposedSessions: 0 }
    }
    return { workspace: this.openByPath(result.filePaths[0]), disposedSessions: 0 }
  }

  /** 所有工作区的父目录。打包后放 userData；开发期放工程内 .workspaces/ */
  private workspacesRoot(): string {
    return app.isPackaged
      ? resolve(app.getPath('userData'), 'workspaces')
      : resolve(process.cwd(), '.workspaces')
  }

  private readMeta(dir: string): WorkspaceMetaFile {
    return readWorkspaceMeta(dir)
  }

  /* ---------------------------------------------------------------------- */
  /* 素材库映射（libraries 段）：名字 → 工作区内相对路径                        */
  /* ---------------------------------------------------------------------- */

  /** 当前工作区的素材库映射（不含内置 assets/ 合成库 —— 那个由 asset:libraries 现算） */
  getLibraries(): WorkspaceLibrary[] {
    const dir = this.current?.path
    if (!dir) return []
    return [...(this.readMeta(dir).libraries ?? [])]
  }

  /**
   * 新建素材库映射：目录映射到 素材库/<名>/（已在该路径下建真实目录）。
   * 第一个被创建的库自动成为公共库（默认落库兜底）；公共库不可删。
   */
  addLibrary(name: string): WorkspaceLibrary {
    if (!this.current) throw new Error('尚未打开工作区')
    const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 24)
    if (!cleaned) throw new Error('素材库名称不能为空')
    const dir = this.current.path
    const meta = this.readMeta(dir)
    const libraries = meta.libraries ?? []
    if (libraries.some((l) => l.name === cleaned)) throw new Error(`素材库「${cleaned}」已存在`)
    const target = resolve(dir, '素材库', cleaned)
    if (!target.startsWith(resolve(dir) + sep)) throw new Error(`素材库名称越界：${name}`)
    mkdirSync(target, { recursive: true })
    const lib: WorkspaceLibrary = {
      id: randomUUID(),
      name: cleaned,
      path: `素材库/${cleaned}`,
      ...(libraries.length === 0 ? { isPublic: true } : {})
    }
    meta.libraries = [...libraries, lib]
    this.writeMeta(dir, meta)
    return lib
  }

  /** 移除素材库映射（只删映射，库内文件不动）；公共库不可删 */
  removeLibrary(id: string): void {
    if (!this.current) throw new Error('尚未打开工作区')
    const dir = this.current.path
    const meta = this.readMeta(dir)
    const lib = (meta.libraries ?? []).find((l) => l.id === id)
    if (!lib) throw new Error(`素材库不存在：${id}`)
    if (lib.isPublic) throw new Error('公共素材库不可移除')
    meta.libraries = (meta.libraries ?? []).filter((l) => l.id !== id)
    this.writeMeta(dir, meta)
  }

  /** 当前工作区的媒体配置（未打开工作区时返回默认：只含确认闸门默认值） */
  mediaConfig(): WorkspaceMediaConfig {
    const dir = this.current?.path
    const meta = dir ? this.readMeta(dir) : undefined
    return meta?.media ?? { confirmVideo: true, accessMode: 'full' }
  }

  /** 更新媒体确认闸门等配置 */
  setMediaConfig(patch: Partial<WorkspaceMediaConfig>): WorkspaceMediaConfig {
    if (!this.current) throw new Error('尚未打开工作区')
    const dir = this.current.path
    const meta = this.readMeta(dir)
    const merged: WorkspaceMediaConfig = { ...(meta.media ?? {}), ...patch }
    meta.media = merged
    this.writeMeta(dir, meta)
    return merged
  }

  /** 当前工作区被禁用的技能名（未打开工作区 = 空名单） */
  skillsDisabled(): string[] {
    const dir = this.current?.path
    return dir ? [...(this.readMeta(dir).skills?.disabled ?? [])] : []
  }

  /** 整表设置禁用技能名单（写 workspace.json skills 段；影响之后新建的会话） */
  setSkillsDisabled(disabled: string[]): string[] {
    if (!this.current) throw new Error('尚未打开工作区')
    const cleaned = [...new Set(disabled.filter((name): name is string => typeof name === 'string' && name.length > 0))]
    const dir = this.current.path
    const meta = this.readMeta(dir)
    meta.skills = cleaned.length > 0 ? { disabled: cleaned } : {}
    this.writeMeta(dir, meta)
    return cleaned
  }

  /**
   * 当前工作区定义的全部分级结构（未打开工作区 = 空数组）。
   * 结构是工作区数据，不是内置模板：空数组 = 这个项目还没定义过分级维度。
   */
  facetSchemas(): FacetSchema[] {
    const dir = this.current?.path
    return dir ? (this.readMeta(dir).facets?.schemas ?? []) : []
  }

  /**
   * 当前生效的分级 schema id（未打开工作区 / 未设置 = null，调用方回落第一套）。
   * schema 决定层级叫什么，只影响显示与校验深度；已写入的分级各自带 schemaId，
   * 切换不会改变老数据的语义。
   */
  facetSchemaId(): string | null {
    const dir = this.current?.path
    return dir ? (this.readMeta(dir).facets?.schemaId ?? null) : null
  }

  /** 设置生效 schema（只影响之后的显示与写入）；id 必须在已有结构里 */
  setFacetSchemaId(schemaId: string): void {
    if (!this.current) throw new Error('尚未打开工作区')
    const dir = this.current.path
    const meta = this.readMeta(dir)
    const schemas = meta.facets?.schemas ?? []
    if (!schemas.some((s) => s.id === schemaId)) throw new Error(`没有这个分级结构：${schemaId}`)
    meta.facets = { ...meta.facets, schemaId, schemas }
    this.writeMeta(dir, meta)
  }

  /**
   * 新建或更新一套分级结构（按 id upsert）。
   * `activate` 为 true 时同时设为生效结构；工作区第一套结构自动生效。
   * 调用方（IPC/Agent）负责先做 sanitizeFacetSchema，这里只做存在性与上限校验。
   */
  saveFacetSchema(schema: FacetSchema, activate = true): void {
    if (!this.current) throw new Error('尚未打开工作区')
    const dir = this.current.path
    const meta = this.readMeta(dir)
    const schemas = [...(meta.facets?.schemas ?? [])]
    const index = schemas.findIndex((s) => s.id === schema.id)
    if (index >= 0) schemas[index] = schema
    else schemas.push(schema)
    const isFirst = schemas.length === 1
    const activeId = activate || isFirst ? schema.id : (meta.facets?.schemaId ?? schema.id)
    meta.facets = { schemaId: activeId, schemas }
    this.writeMeta(dir, meta)
  }

  /**
   * 删除一套分级结构；删掉的正好是生效结构时回落到第一套（没有结构则清空段）。
   * 返回是否真的删掉了（id 不存在时 false）。
   * 注意：facets.json 里指向该 id 的分级数据不动——值仍有意义，只是层名不可解析。
   */
  deleteFacetSchema(id: string): boolean {
    if (!this.current) throw new Error('尚未打开工作区')
    const dir = this.current.path
    const meta = this.readMeta(dir)
    const schemas = meta.facets?.schemas ?? []
    const next = schemas.filter((s) => s.id !== id)
    if (next.length === schemas.length) return false
    if (next.length === 0) {
      delete meta.facets
    } else {
      const activeId = meta.facets?.schemaId && meta.facets.schemaId !== id ? meta.facets.schemaId : next[0].id
      meta.facets = { schemaId: activeId, schemas: next }
    }
    this.writeMeta(dir, meta)
    return true
  }

  /**
   * 当前工作区的媒体产物目录（绝对路径）；未打开工作区时为 null。
   * 目录由 media.outputDir 配置（相对工作区根），越界/绝对路径一律回退默认产物根
   * （MEDIA_ROOT_REL，渲染端解析卡片引用时用同一常量）。
   */
  mediaDir(): string | null {
    if (!this.current) return null
    const fallback = join(this.current.path, MEDIA_ROOT_REL)
    const configured = (this.readMeta(this.current.path).media?.outputDir ?? '').trim()
    if (!configured) return fallback
    const resolved = resolve(this.current.path, configured)
    if (resolved !== this.current.path && resolved.startsWith(this.current.path + sep)) {
      return resolved
    }
    console.warn(`[workspace] media.outputDir 越界，回退默认目录：${configured}`)
    return fallback
  }

  writeMeta(dir: string, meta: WorkspaceMetaFile): void {
    writeWorkspaceMeta(dir, meta)
  }

  /** 修改工作区默认聊天模型（写 chat 段）；只影响新建会话（DoD：已存在会话不变） */
  setDefaultModel(modelId: string | null): WorkspaceInfo {
    if (!this.current) throw new Error('尚未打开工作区')
    const dir = this.current.path
    const chat = { ...readChatConfig(dir) }
    if (modelId) chat.defaultModel = modelId
    else delete chat.defaultModel
    writeChatSegment(dir, chat)
    if (modelId) this.current.defaultModel = modelId
    else delete this.current.defaultModel
    return this.current
  }

  /* ---------------------------------------------------------------------- */
  /* canvas.json                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * 校验并安排画布快照写入。默认合并短时间内的写入；需要确认落盘的调用方
   * 随后调用 flushPendingWrites，写入失败会抛错且快照仍保留在内存中。
   */
  saveCanvas(snapshot: CanvasSnapshot): void {
    if (!this.current) throw new Error('尚未打开工作区，画布无处可存')
    if (!snapshot || !(CANVAS_VERSIONS as readonly number[]).includes(snapshot?.version) || !Array.isArray(snapshot.nodes)) {
      throw new Error(`画布快照形状不合法（需要 version ${CANVAS_VERSIONS.join('/')} 且 nodes 为数组）`)
    }
    // 上限防御：主进程按不透明 JSON 存储，但不能让渲染端把画布当成数据库灌爆磁盘
    if (snapshot.nodes.length > 2000) {
      throw new Error(`画布节点数超过上限（${snapshot.nodes.length} > 2000）`)
    }
    this.canvasPersistence.schedule(this.current.canvasFile, snapshot)
  }

  /**
   * 立刻把合并窗口里的画布快照写盘（正常退出前调用）。
   * 渲染端 800ms 防抖 + 这里 200ms 合并是两层缓冲，退出时必须两层都冲刷。
   */
  flushPendingWrites(): void {
    this.canvasPersistence.flush()
  }

  loadCanvas(): CanvasSnapshot | null {
    if (!this.current) throw new Error('尚未打开工作区')
    // 读前先冲刷未落盘的 pending 保存：saveCanvas 有 200ms 防抖窗口，
    // 「保存后立刻读取」必须读到刚存的内容（e2e 的 canvas 往返用例与未来任何
    // 直接 invoke 方都依赖读后写语义），不能让窗口内的 load 拿到旧文件
    this.canvasPersistence.flush()
    if (!existsSync(this.current.canvasFile)) return null
    try {
      const raw = JSON.parse(readFileSync(this.current.canvasFile, 'utf8')) as CanvasSnapshot
      if (!raw || !(CANVAS_VERSIONS as readonly number[]).includes(raw?.version) || !Array.isArray(raw.nodes)) {
        throw new Error('画布版本或数据形状不受支持')
      }
      return raw
    } catch (error) {
      // 损坏的画布文件宁可报出来也不能静默清空用户的布局
      throw new Error(`canvas.json 解析失败：${String(error)}`)
    }
  }

  /**
   * 在工作区根目录下新建子目录并切换为当前（「新建工作区」）。
   * 名字走 sanitizeName 同款约束，防路径穿越；已存在同名目录时直接打开（幂等）。
   */
  createWorkspace(name: string): WorkspaceInfo {
    const cleaned = name
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 80)
    if (!cleaned) throw new Error('工作区名称不能为空')
    const root = this.workspacesRoot()
    const dir = join(root, cleaned)
    if (dir !== resolve(root) && !resolve(dir).startsWith(resolve(root) + sep)) {
      throw new Error(`工作区名称越界：${name}`)
    }
    return this.openByPath(dir)
  }

  /**
   * 批量删除工作区：目录移入系统回收站（shell.trashItem，可恢复）并移出最近列表；
   * 目录已消失的条目只清登记。守卫拒绝而不是静默跳过：
   * - 只删最近列表里登记过的工作区（渲染端伪造的任意路径不收）
   * - 当前打开的工作区不可删（会话/凭据都锚在上面，先切走再删）
   * - 盘符根 / 用户主目录 / 工作区根目录这类「一锅端」位置一律拒绝
   * 单条失败（被占用、无回收站等）不影响其余条目，逐条回传给调用方汇总提示。
   */
  async deleteWorkspaces(paths: string[]): Promise<WorkspaceDeleteResult> {
    const removed: WorkspaceSummary[] = []
    const failures: WorkspaceDeleteFailure[] = []
    for (const raw of paths) {
      const dir = isNonEmptyString(raw) ? resolve(raw) : ''
      const entry = dir ? this.recents.find((item) => item.path === dir) : undefined
      if (!entry) {
        failures.push({ path: String(raw), error: '不在工作区最近列表中' })
        continue
      }
      const guard = this.deleteGuard(dir)
      if (guard) {
        failures.push({ path: dir, error: guard })
        continue
      }
      try {
        if (existsSync(dir)) await shell.trashItem(dir)
        removed.push(entry)
        this.recents = this.recents.filter((item) => item.path !== dir)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ path: dir, error: `移入回收站失败：${message}` })
      }
    }
    if (removed.length > 0) this.persistRecents()
    return { removed, failures, recents: [...this.recents] }
  }

  /** 删除守卫：返回拒绝原因文案；null = 放行 */
  private deleteGuard(dir: string): string | null {
    if (this.current && dir === this.current.path) return '正在使用中，请先切换到其他工作区'
    if (dir === dirname(dir)) return '不能删除盘符根目录'
    if (dir === resolve(homedir())) return '不能删除用户主目录'
    if (dir === resolve(this.workspacesRoot())) return '不能删除工作区根目录'
    return null
  }
}
