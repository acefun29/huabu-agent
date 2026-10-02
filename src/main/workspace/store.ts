import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { copyFile, mkdir } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import type {
  CanvasSnapshot,
  WorkspaceInfo,
  WorkspaceOpenResult,
  WorkspaceStateInfo,
  WorkspaceSummary
} from '../../shared/ipc'
import type { MediaProviderType, MediaRatio, ModelCapabilities } from '../../shared/media'
import { MEDIA_RATIOS } from '../../shared/media'
import { MEDIA_ROOT_REL } from '../../shared/assets'
import type {
  ChatMigrationInput,
  ChatMigrationPlan,
  LegacyModelsFile
} from '../models/migrate'
import { migrateChatConfig } from '../models/migrate'
import type { WorkspaceChatConfig } from '../models/types'
import {
  sanitizeHiddenBuiltin as sanitizeChatHiddenBuiltin,
  sanitizeModelOverrides as sanitizeChatModelOverrides,
  sanitizeUserProviders as sanitizeChatUserProviders
} from '../models/catalog'
import {
  sanitizeHiddenBuiltin,
  sanitizeModelOverrides,
  sanitizeUserProviders
} from '../media/catalog/merge'
import { atomicWriteSync, recoverAtomicBackup } from '../fsutil/atomic'

/**
 * 工作区存储：一个工作区 = 一张画布 + 一个磁盘目录（开发计划 2.1）。
 *
 * M5 扩展的核心状态都在这里：
 * - 当前工作区（单例）：所有会话 cwd、画布持久化、凭据都锚定在它上面
 * - 最近列表 + 上次工作区（应用重启后恢复）
 * - `.huabu/canvas.json` 的原子读写（临时文件 + rename，强杀不产生半写文件）
 * - `.huabu/workspace.json`（版本、聊天模型覆盖层 `chat`、媒体 provider 覆盖层 `media`、素材库映射）
 *
 * 本类不持有 electron BrowserWindow 之外的运行时状态；AgentHost 的会话释放
 * 由 ipc.ts 编排（先问本类拿 dispose 数，再切 current），避免两个模块互相持有引用。
 */

const CANVAS_VERSIONS = [1, 2, 3] as const

/** canvas.json 写盘防抖窗口：合并窗口内的多次 invoke 为一次序列化 + 原子写 */
const CANVAS_WRITE_DEBOUNCE_MS = 200

/**
 * canvas.json 的写盘防抖状态（与 metaCache 同理放模块级，last-write-wins）：
 * 200ms 窗口内的多次 saveCanvas 合并为一次 stringify + 原子写——新调用只覆盖
 * pending 快照、不重置定时器（合并而非顺延）。崩溃最多丢 200ms 的画布快照；
 * 渲染端 autosave 已有 800ms 防抖，这里只防直接高频 invoke 的重复序列化。
 *
 * pending 连目标 file 一起捕获：到点写盘时 this.current 可能已切到别的工作区，
 * 写盘目标必须锚定排期那一刻的画布文件，而不是当下正在打开的工作区。
 */
let canvasSaveTimer: ReturnType<typeof setTimeout> | null = null
let canvasSavePending: { file: string; snapshot: CanvasSnapshot } | null = null

/**
 * 立即冲刷未落盘的 pending 画布保存（防抖定时器与 loadCanvas 读前都会调用）：
 * 取走 pending 并同步写盘。pending 为空时是空操作。
 */
function flushCanvasSave(): void {
  if (canvasSaveTimer) {
    clearTimeout(canvasSaveTimer)
    canvasSaveTimer = null
  }
  const pending = canvasSavePending
  canvasSavePending = null
  if (!pending) return
  try {
    const serialized = JSON.stringify(pending.snapshot)
    if (serialized.length > 32 * 1024 * 1024) {
      console.error('[workspace] 画布快照体积超过 32MB 上限，已跳过本次写盘')
      return
    }
    atomicWriteSync(pending.file, serialized)
  } catch (error) {
    // 防抖后写盘失败已无法抛回 invoke 调用方，只能记日志：宁可丢一拍，
    // 也不能让定时器里的异常变成主进程未捕获错误
    console.error('[workspace] canvas.json 写盘失败：', error)
  }
}

/**
 * workspace.json 的读取缓存（key = 工作区目录）：readMeta 是热路径——每个
 * huabu-media:// 协议请求都会经 mediaDir() 读一次 meta，不缓存的话反复读盘 + 解析。
 *
 * 放在模块级而不是 WorkspaceStore 实例字段：写路径除了实例方法 writeMeta，还有
 * 模块级函数 writeChatSegment（host 与 models/overlay 都在调），后者拿不到实例
 * 私有字段，而它的写盘同样要失效缓存。
 *
 * 正确性依据：读路径全在主进程单线程内；对 workspace.json 的写入全在本文件
 * （writeMeta / writeChatSegment），写前显式失效；mtimeMs 双保险兜住进程外的
 * 意外改动（用户手改、其他实例）。
 */
const metaCache = new Map<string, { mtimeMs: number; value: WorkspaceMetaFile }>()

/** workspace.json 的 media.userProviders 条目（M11；用户自建供应商，文件持久化形态） */
export interface WorkspaceMediaProviderConfig {
  id: string
  /** 必须是已注册的适配器类型；单一声明处在 shared/media.ts */
  type: MediaProviderType
  label?: string
  /** 凭据存储键后缀（safeStorage 存储 media:<authKey>），缺省 = id */
  authKey?: string
  /** 环境变量名（缺省按适配器约定，gateway-fal 为 FAL_KEY），已录入存储 Key 时优先 */
  authEnv?: string
  /** 网关基址（协议家族适配器用，如 gateway-openai-compat）；缺省 = 适配器官方默认 */
  baseUrl?: string
  /** 认证头风格（通用协议用）：bearer | x-api-key；缺省 = 适配器默认 */
  authStyle?: 'bearer' | 'x-api-key'
  models: Record<
    string,
    {
      kind: 'image' | 'video' | 'audio'
      label?: string
      /** 覆盖产物 URL 抽取路径（默认按 images/videos/audio[0].url） */
      resultKey?: string
      /** 能力元数据（比例/时长档位等，浏览目录「添加」时透传；驱动渲染端参数面板） */
      capabilities?: ModelCapabilities
      /** 一句人话的成本提示，展示在参数面板 */
      costHint?: string
    }
  >
}

/** 对内置模型（按用户可见 id，如 'fal/veo3.1'）的展示覆盖 */
export interface MediaModelOverride {
  label?: string
}

/**
 * workspace.json 的 media 段。
 *
 * 模型清单的单一事实来源是内置目录（src/main/media/catalog），本段只存**覆盖层**：
 * userProviders（用户自建供应商）、hiddenBuiltin（隐藏的内置模型）、modelOverrides
 * （展示覆盖）。生效清单由 catalog/merge.ts 的 mergeCatalog 运行时合并。
 *
 * 旧字段 `providers` 已改名 `userProviders`：readMeta 读旧写新（读入时迁移），
 * 老工作区无感升级，写入一律用新字段名。
 */
export interface WorkspaceMediaConfig {
  /** 高成本确认闸门：Agent 视频生成工具是否需要确认（M13） */
  confirmVideo?: boolean
  /**
   * Agent 媒体访问模式：full = 直接执行（现状，视频仍受 confirmVideo 约束）；
   * confirm = 变更前确认（所有生成提交前弹确认卡，取代视频对话闸门）。缺省 full。
   */
  accessMode?: 'full' | 'confirm'
  /** Agent 媒体工具使用的 provider（缺省 fal：内置目录真实网关） */
  agentProvider?: string
  /**
   * 各 kind 的默认模型，记法统一为 `provider:模型id` 复合串（可跨供应商指定）。
   * 旧版存的裸模型 id 由 shared/mediaResolve 的 matchBareModelId 兼容解析，下次写入自动升级。
   */
  agentModels?: Partial<Record<'image' | 'video' | 'audio', string>>
  userProviders?: WorkspaceMediaProviderConfig[]
  /** 被用户隐藏的内置模型 id（如 'fal/veo3.1'） */
  hiddenBuiltin?: string[]
  /** 对内置模型的展示覆盖（按用户可见模型 id） */
  modelOverrides?: Record<string, MediaModelOverride>
  /** 产物输出目录（相对工作区根；空/缺省 = .huabu/media） */
  outputDir?: string
  /** 同时进行的生成任务数上限（1..8；缺省 3） */
  concurrency?: number
  /** 新建生成卡片的默认图片比例 */
  defaultRatio?: MediaRatio
  /** 新建生成卡片的默认时长（秒） */
  defaultDuration?: number
  /** 全局默认落库素材库 id（libraries 段的条目 id；空 = 公共库/工作目录兜底） */
  defaultLibraryId?: string
  /** 按媒体大类的默认落库素材库 id（优先级高于全局默认） */
  kindLibraryDefaults?: Partial<Record<'image' | 'video' | 'audio', string>>
}

interface WorkspaceMetaFile {
  version: 1
  /**
   * @deprecated 旧顶层字段：只出现在 `readMeta` 解析出的 `raw` 里，作为一次性迁移输入。
   * readMeta 的返回值**不含**这两个字段（回填就是双轨），所以任何写入路径都不会再产生它们。
   */
  defaultModel?: string
  /** @deprecated 同 defaultModel：迁移进 chat.hiddenBuiltin，读取后即弃 */
  hiddenModels?: string[]
  /**
   * 聊天模型清单的**覆盖层**（架构计划 §3）：自定义供应商、隐藏项、展示覆盖、默认模型。
   * 内置清单不在这里——那是 src/main/models/catalog 的代码数据，运行时由 mergeChatCatalog 合并。
   * 缺省时 readMeta 会从旧三处（顶层两字段 + .huabu/models.json）一次性迁移得到，见 chatMigration()。
   */
  chat?: WorkspaceChatConfig
  media?: WorkspaceMediaConfig
  /** 素材库映射（新原型同步）：名字 → 工作区内相对路径。公共库首个建库时播种 */
  libraries?: WorkspaceLibrary[]
}

/** workspace.json 的 libraries 段条目（素材库 = 名字 → 相对路径的映射，不复制文件） */
export interface WorkspaceLibrary {
  id: string
  name: string
  /** 工作区内相对路径（POSIX 风格，如 素材库/海报产出） */
  path: string
  /** 公共素材库：默认落库的兜底，不可删除 */
  isPublic?: boolean
}

interface RecentsFile {
  version: 1
  lastWorkspace?: string
  recents: WorkspaceSummary[]
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 工作区 id：路径的短哈希。凭据文件按它隔离，目录改名/移动后凭据需重新录入 */
export function workspaceId(dir: string): string {
  return createHash('sha256').update(resolve(dir).toLowerCase()).digest('hex').slice(0, 16)
}

/** 应用级状态目录（不是用户项目目录）：最近列表与加密凭据都放这里 */
export function getAppStateDir(): string {
  const dir = resolve(app.getPath('userData'), 'huabu-state')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 某工作区的凭据文件路径（safeStorage 加密），供 AgentHost 与诊断页共用 */
export function getCredentialsFile(workspaceDir: string): string {
  return join(getAppStateDir(), 'credentials', `${workspaceId(workspaceDir)}.credentials.json`)
}

export class WorkspaceStore {
  private current: WorkspaceInfo | null = null
  private recents: WorkspaceSummary[] = []

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
    mkdirSync(join(dir, '.huabu', 'sessions'), { recursive: true })

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
    const file = join(dir, '.huabu', 'workspace.json')
    // 先 stat 拿 mtime：文件不存在（还没初始化的工作区）走缺省返回，且不缓存负结果
    let mtimeMs: number
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      return { version: 1 }
    }
    const cached = metaCache.get(dir)
    if (cached && cached.mtimeMs === mtimeMs) return cached.value
    let raw: Partial<WorkspaceMetaFile>
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WorkspaceMetaFile>
    } catch {
      // 文件在但读不出/解析失败（半写残留等瞬态）：按缺省处理，同样不缓存，下次重读
      return { version: 1 }
    }
    const chat = resolveChatSegment(dir, raw)
    const meta: WorkspaceMetaFile = {
      version: 1,
      // 顶层 defaultModel/hiddenModels **不回填**：它们是旧位置，只作为迁移输入被读取一次。
      // 读出来再写回去就是双轨（T1 刚清掉一次双轨），所以本方法唯一的输出形态是 chat 段。
      ...(Object.keys(chat).length > 0 ? { chat } : {}),
      ...(raw.media !== undefined ? { media: normalizeMediaSegment(raw.media) } : {}),
      ...(Array.isArray(raw.libraries) ? { libraries: sanitizeLibraries(raw.libraries) } : {})
    }
    metaCache.set(dir, { mtimeMs, value: meta })
    return meta
  }

  /**
   * 聊天模型覆盖层的读取/落盘都在模块级函数（readChatConfig / writeChatSegment /
   * readChatMigrationPlan）：host 与 models/overlay 手里只有 workspaceDir，
   * 走实例方法会把「当前工作区」这个隐式状态引进来。本类只保留画布与 media/libraries 的读写。
   */

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
    const file = join(dir, '.huabu', 'workspace.json')
    // 写前先失效缓存：调用方（addLibrary 等）会原地改写 readMeta 返回的对象再传进来，
    // 写盘若失败（磁盘满等），不能让缓存残留这个已被改写的脏对象；单线程内同步写，
    // 失效与写盘之间没有别的读路径能插进来
    metaCache.delete(dir)
    atomicWriteSync(file, JSON.stringify(meta, null, 2))
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
   * 画布快照落盘（200ms 防抖合并写）：形状/节点数校验保持同步——invoke 当场把
   * 非法输入抛回渲染端；序列化 + 原子写延迟到定时器合并执行。崩溃最多丢 200ms
   * 的画布快照；渲染端 autosave 已有 800ms 防抖，这里只防直接高频 invoke 的
   * 重复序列化与写盘。
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
    // last-write-wins：pending 只留最新快照引用（渲染端每次传新对象），
    // 已有定时器不重置——合并而非顺延
    canvasSavePending = { file: this.current.canvasFile, snapshot }
    if (canvasSaveTimer) return
    canvasSaveTimer = setTimeout(flushCanvasSave, CANVAS_WRITE_DEBOUNCE_MS)
  }

  loadCanvas(): CanvasSnapshot | null {
    if (!this.current) throw new Error('尚未打开工作区')
    // 读前先冲刷未落盘的 pending 保存：saveCanvas 有 200ms 防抖窗口，
    // 「保存后立刻读取」必须读到刚存的内容（e2e 的 canvas 往返用例与未来任何
    // 直接 invoke 方都依赖读后写语义），不能让窗口内的 load 拿到旧文件
    flushCanvasSave()
    if (!existsSync(this.current.canvasFile)) return null
    try {
      const raw = JSON.parse(readFileSync(this.current.canvasFile, 'utf8')) as CanvasSnapshot
      if (!raw || !(CANVAS_VERSIONS as readonly number[]).includes(raw?.version) || !Array.isArray(raw.nodes)) {
        console.warn('[workspace] canvas.json 版本或形状不识别，按空画布处理')
        return null
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
}

/** libraries 段读入清洗：逐条校验字段形状，坏条目丢弃（素材库映射与媒体覆盖层同款容错） */
function sanitizeLibraries(raw: unknown[]): WorkspaceLibrary[] {
  const out: WorkspaceLibrary[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (!isNonEmptyString(rec.id) || !isNonEmptyString(rec.name) || !isNonEmptyString(rec.path)) continue
    // path 必须是工作区内相对路径（POSIX 风格），拒绝绝对路径与越界
    if (isAbsolute(rec.path) || rec.path.includes('..')) continue
    out.push({
      id: rec.id,
      name: rec.name,
      path: rec.path,
      ...(rec.isPublic === true ? { isPublic: true } : {})
    })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* chat 段（模型清单覆盖层）：清洗 + 旧三处一次性迁移                            */
/* -------------------------------------------------------------------------- */

/** 迁移提示只在本进程打印一次：readMeta 会被高频调用，逐次刷同一句 note 是噪音 */
const migrationNotesPrinted = new Set<string>()

/** chat 段：磁盘上有就用（逐字段清洗）；没有则从旧三处一次性迁移得到 */
function resolveChatSegment(dir: string, raw: Partial<WorkspaceMetaFile>): WorkspaceChatConfig {
  if (raw.chat !== undefined) return normalizeChatSegment(raw.chat)
  const plan = migrateChatConfig(legacyChatInput(dir, raw))
  if (!migrationNotesPrinted.has(dir)) {
    migrationNotesPrinted.add(dir)
    for (const note of plan.notes) console.warn(`[workspace] 模型配置迁移：${note}`)
  }
  return plan.config
}

function legacyChatInput(dir: string, raw: Partial<WorkspaceMetaFile>): ChatMigrationInput {
  const modelsFile = readLegacyModelsFile(dir)
  return {
    ...(isNonEmptyString(raw.defaultModel) ? { defaultModel: raw.defaultModel } : {}),
    ...(Array.isArray(raw.hiddenModels) ? { hiddenModels: raw.hiddenModels.filter(isNonEmptyString) } : {}),
    ...(modelsFile ? { modelsFile } : {})
  }
}

/**
 * 旧 `.huabu/models.json`（Pi 原生格式）。
 *
 * 读不到或解析失败一律按"无遗留"处理：这个文件已经不再被任何运行时路径消费（旧读取方
 * `agent/customModels.ts` 已随 T5 拆除），它剩下的唯一身份是**迁移输入**——一次坏 JSON
 * 不该让工作区连配置都读不出来。
 */
function readLegacyModelsFile(dir: string): LegacyModelsFile | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, '.huabu', 'models.json'), 'utf8')) as LegacyModelsFile | null
    return parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 按目录读聊天覆盖层（不需要 WorkspaceStore 实例）。
 *
 * host 与模型覆盖层的写入方都按这个口子取用：它们手里只有 workspaceDir，
 * 拿单例 store 会把「当前工作区」这个隐式状态引进来——切工作区时最容易错的就是这种隐式状态。
 */
export function readChatConfig(dir: string): WorkspaceChatConfig {
  return resolveChatSegment(dir, readRawMetaFile(dir))
}

/** 只读磁盘原文（不清洗、不迁移）：迁移判定与 readMeta 的容错都要它 */
export function readRawMetaFile(dir: string): Partial<WorkspaceMetaFile> {
  try {
    return JSON.parse(readFileSync(join(dir, '.huabu', 'workspace.json'), 'utf8')) as Partial<WorkspaceMetaFile>
  } catch {
    return {}
  }
}

/** 待执行的一次性迁移计划（`chat` 段已落盘或无可迁内容时为 null） */
export function readChatMigrationPlan(dir: string): ChatMigrationPlan | null {
  const raw = readRawMetaFile(dir)
  if (raw.chat !== undefined) return null
  if (!isNonEmptyString(raw.defaultModel) && !Array.isArray(raw.hiddenModels) && !readLegacyModelsFile(dir)) return null
  return migrateChatConfig(legacyChatInput(dir, raw))
}

/**
 * 落盘聊天覆盖层（其余段原样保留）。
 *
 * 空对象也照写：`chat` 段存在与否就是"迁移已落地"的标记，靠"空就不写"会让下次启动
 * 再迁移一遍，notes 反复刷屏。media/libraries 走与 readMeta 相同的归一化，避免这条
 * 写入路径把旧字段（media.providers 之类）原样搬回去。
 */
export function writeChatSegment(dir: string, chat: WorkspaceChatConfig): void {
  const raw = readRawMetaFile(dir)
  const meta: WorkspaceMetaFile = {
    version: 1,
    chat: normalizeChatSegment(chat),
    ...(raw.media !== undefined ? { media: normalizeMediaSegment(raw.media) } : {}),
    ...(Array.isArray(raw.libraries) ? { libraries: sanitizeLibraries(raw.libraries) } : {})
  }
  // 本文件对 workspace.json 的另一条写路径：同样写前失效 metaCache。mtime 兜底在
  // 粗粒度文件系统上可能吞掉同刻的两次变更，本文件内的写入就该显式失效
  metaCache.delete(dir)
  atomicWriteSync(join(dir, '.huabu', 'workspace.json'), JSON.stringify(meta, null, 2))
}

/** 磁盘上的 chat 段清洗：规则全在 models/catalog/merge 的 sanitize 里，这里只决定"空就不写" */
function normalizeChatSegment(raw: unknown): WorkspaceChatConfig {  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn('[workspace] chat 段不是对象，已按空覆盖层处理')
    return {}
  }
  const source = raw as Record<string, unknown>
  const chat: WorkspaceChatConfig = {}
  if (isNonEmptyString(source.defaultModel)) chat.defaultModel = source.defaultModel.trim()
  const userProviders = sanitizeChatUserProviders(source.userProviders)
  if (userProviders.length > 0) chat.userProviders = userProviders
  const hiddenBuiltin = sanitizeChatHiddenBuiltin(source.hiddenBuiltin)
  if (hiddenBuiltin.length > 0) chat.hiddenBuiltin = hiddenBuiltin
  const modelOverrides = sanitizeChatModelOverrides(source.modelOverrides)
  if (Object.keys(modelOverrides).length > 0) chat.modelOverrides = modelOverrides
  return chat
}

/**
 * media 段读入归一化（读旧写新）：
 * - 旧字段 `providers` 迁移为 `userProviders`（老工作区无感升级，写入一律新字段名）
 * - 覆盖层字段逐条清洗，坏配置丢弃并给出「哪条哪个字段错了」的警告（catalog 架构 §5）
 * - 其余标量字段轻量类型收敛，未知字段不透传
 */
function normalizeMediaSegment(raw: unknown): WorkspaceMediaConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn('[workspace] media 段不是对象，已按默认配置处理')
    return { confirmVideo: true }
  }
  const rawMedia = raw as Record<string, unknown>
  // 字段名迁移：providers（旧）→ userProviders（新）；两者同时存在时新字段优先
  const userProvidersRaw = rawMedia.userProviders ?? rawMedia.providers
  if (rawMedia.providers !== undefined && rawMedia.userProviders !== undefined) {
    console.warn('[workspace] media.providers（旧字段）与 media.userProviders 并存，已采用 userProviders')
  }
  const userProviders = sanitizeUserProviders(userProvidersRaw)
  const hiddenBuiltin = sanitizeHiddenBuiltin(rawMedia.hiddenBuiltin)
  const modelOverrides = sanitizeModelOverrides(rawMedia.modelOverrides)
  const media: WorkspaceMediaConfig = {
    ...(typeof rawMedia.confirmVideo === 'boolean' ? { confirmVideo: rawMedia.confirmVideo } : { confirmVideo: true }),
    // 访问模式：只认 'confirm' 这个显式值，其余（含缺省）一律回落 'full'（现状行为）
    ...(rawMedia.accessMode === 'confirm' ? { accessMode: 'confirm' as const } : { accessMode: 'full' as const }),
    // 已下架的内置供应商（第三方聚合中转平台，生产环境移除）：存量配置视为未设置，回落默认
    ...(isNonEmptyString(rawMedia.agentProvider) && rawMedia.agentProvider !== 'mock' && rawMedia.agentProvider !== 'muapi'
      ? { agentProvider: rawMedia.agentProvider }
      : {}),
    ...normalizeAgentModels(rawMedia.agentModels),
    ...(userProviders.length > 0 ? { userProviders } : {}),
    ...(hiddenBuiltin.length > 0 ? { hiddenBuiltin } : {}),
    ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
    ...(isNonEmptyString(rawMedia.outputDir) ? { outputDir: rawMedia.outputDir } : {}),
    ...(typeof rawMedia.concurrency === 'number' ? { concurrency: rawMedia.concurrency } : {}),
    ...normalizeDefaultRatio(rawMedia.defaultRatio),
    ...(typeof rawMedia.defaultDuration === 'number' ? { defaultDuration: rawMedia.defaultDuration } : {}),
    ...(isNonEmptyString(rawMedia.defaultLibraryId) ? { defaultLibraryId: rawMedia.defaultLibraryId } : {}),
    ...normalizeKindLibraryDefaults(rawMedia.kindLibraryDefaults)
  }
  return media
}

function normalizeKindLibraryDefaults(raw: unknown): Pick<WorkspaceMediaConfig, 'kindLibraryDefaults'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const defaults: NonNullable<WorkspaceMediaConfig['kindLibraryDefaults']> = {}
  for (const kind of ['image', 'video', 'audio'] as const) {
    const value = (raw as Record<string, unknown>)[kind]
    if (isNonEmptyString(value)) defaults[kind] = value
  }
  return Object.keys(defaults).length > 0 ? { kindLibraryDefaults: defaults } : {}
}

function normalizeAgentModels(raw: unknown): Pick<WorkspaceMediaConfig, 'agentModels'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const models: NonNullable<WorkspaceMediaConfig['agentModels']> = {}
  for (const kind of ['image', 'video', 'audio'] as const) {
    const value = (raw as Record<string, unknown>)[kind]
    if (isNonEmptyString(value)) models[kind] = value
  }
  return Object.keys(models).length > 0 ? { agentModels: models } : {}
}

function normalizeDefaultRatio(raw: unknown): Pick<WorkspaceMediaConfig, 'defaultRatio'> {
  return typeof raw === 'string' && (MEDIA_RATIOS as readonly string[]).includes(raw)
    ? { defaultRatio: raw as MediaRatio }
    : {}
}

/** 原子写已收口到 src/main/fsutil/atomic（tmp+rename；Windows 占用时挪 .bak 腾位，
 * 绝不先删旧文件）。本文件此前的本地实现在 rename 失败时退化为 rm-then-rename，
 * rm 与 rename 之间崩溃会把原文件彻底丢掉，已删除，改为从 fsutil/atomic 导入。 */

/** copyFile 的目录自备版（fs/promises）：导入媒体/资产时先把目标目录建好。
 * 收口为 async 的出处：同步 copy 允许到 512MB（MAX_IMPORT_BYTES），跑在主进程会
 * 冻结全部 IPC/UI 数秒（性能优化 P0：素材/导入链路去同步 IO） */
export async function copyIntoDir(src: string, destDir: string, destName: string): Promise<string> {
  await mkdir(destDir, { recursive: true })
  const dest = join(destDir, destName)
  await copyFile(src, dest)
  return dest
}
