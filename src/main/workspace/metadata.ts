/** 工作区配置的读取、迁移、缓存和原子写入，不依赖 Electron。 */
import { readFileSync, statSync } from 'fs'
import { isAbsolute, join } from 'path'
import { MEDIA_RATIOS, type MediaRatio } from '../../shared/media'
import { sanitizeFacetSchemas } from '../../shared/facets'
import { atomicWriteSync } from '../fsutil/atomic'
import { migrateChatConfig, type ChatMigrationInput, type ChatMigrationPlan, type LegacyModelsFile } from '../models/migrate'
import type { WorkspaceChatConfig } from '../models/types'
import {
  sanitizeHiddenBuiltin as sanitizeChatHiddenBuiltin,
  sanitizeModelOverrides as sanitizeChatModelOverrides,
  sanitizeUserProviders as sanitizeChatUserProviders
} from '../models/catalog'
import { sanitizeHiddenBuiltin, sanitizeModelOverrides, sanitizeUserProviders } from '../media/catalog/merge'
import type { WorkspaceAgentConfig, WorkspaceFacetsConfig, WorkspaceLibrary, WorkspaceMediaConfig, WorkspaceMetaFile, WorkspaceSkillsConfig } from './types'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 按工作区缓存解析后的元数据，避免媒体协议等热路径反复读盘。
 * 本模块的写入会显式失效缓存；mtime 用于发现进程外修改。
 */
const metaCache = new Map<string, { mtimeMs: number; value: WorkspaceMetaFile }>()

export function readWorkspaceMeta(dir: string): WorkspaceMetaFile {
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
    // 旧顶层模型字段只用于迁移，归一化后仅保留 chat 段。
    ...(Object.keys(chat).length > 0 ? { chat } : {}),
    ...(raw.media !== undefined ? { media: normalizeMediaSegment(raw.media) } : {}),
    ...(raw.skills !== undefined ? { skills: normalizeSkillsSegment(raw.skills) } : {}),
    ...(raw.agent !== undefined ? { agent: normalizeAgentSegment(raw.agent) } : {}),
    ...(raw.facets !== undefined ? { facets: normalizeFacetsSegment(raw.facets) } : {}),
    ...(Array.isArray(raw.libraries) ? { libraries: sanitizeLibraries(raw.libraries) } : {})
  }
  metaCache.set(dir, { mtimeMs, value: meta })
  return meta
}
/** 写前失效缓存，避免写入失败后继续读到已修改的缓存对象。 */
export function writeWorkspaceMeta(dir: string, meta: WorkspaceMetaFile): void {
  const file = join(dir, '.huabu', 'workspace.json')
  metaCache.delete(dir)
  atomicWriteSync(file, JSON.stringify(meta, null, 2))
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

/** 只保留可识别的历史运行时值；实际运行时由应用入口选择。 */
function normalizeAgentSegment(raw: unknown): WorkspaceAgentConfig {
  const runtime = (raw as { runtime?: unknown } | null)?.runtime
  return runtime === 'pi' || runtime === 'mastra' ? { runtime } : {}
}

/**
 * facets 段读入清洗：结构定义逐套收敛（sanitizeFacetSchemas），生效 id 必须
 * 在列表里真实存在，否则丢弃（读取侧回落第一套）。
 * 用「存在性校验」而不是形状校验：id 拼错时宁可回落到第一套，也不要让整个
 * UI 因为找不到 schema 而停止渲染分级。
 */
function normalizeFacetsSegment(raw: unknown): WorkspaceFacetsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const rec = raw as { schemaId?: unknown; schemas?: unknown }
  const schemas = sanitizeFacetSchemas(rec.schemas)
  if (schemas.length === 0) return {}
  const schemaId = typeof rec.schemaId === 'string' && schemas.some((s) => s.id === rec.schemaId) ? rec.schemaId : undefined
  return { ...(schemaId ? { schemaId } : {}), schemas }
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
    ...(raw.skills !== undefined ? { skills: normalizeSkillsSegment(raw.skills) } : {}),
    ...(raw.agent !== undefined ? { agent: normalizeAgentSegment(raw.agent) } : {}),
    ...(raw.facets !== undefined ? { facets: normalizeFacetsSegment(raw.facets) } : {}),
    ...(Array.isArray(raw.libraries) ? { libraries: sanitizeLibraries(raw.libraries) } : {})
  }
  writeWorkspaceMeta(dir, meta)
}

/** 磁盘上的 chat 段清洗：规则全在 models/catalog/merge 的 sanitize 里，这里只决定"空就不写" */
function normalizeChatSegment(raw: unknown): WorkspaceChatConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
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

/** skills 段读入归一化：只收 disabled 字符串数组，其余丢弃 */
function normalizeSkillsSegment(raw: unknown): WorkspaceSkillsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const disabled = (raw as { disabled?: unknown }).disabled
  if (!Array.isArray(disabled)) return {}
  const cleaned = [...new Set(disabled.filter((name): name is string => typeof name === 'string' && name.length > 0))]
  return cleaned.length > 0 ? { disabled: cleaned } : {}
}

