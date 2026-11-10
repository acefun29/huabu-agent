/**
 * 素材分级的通用 schema（单一事实来源）。
 *
 * 「分级」回答的是**位置**问题：这张图在项目的哪个位置。短剧里是「第3集 / 第2场 /
 * 第12镜」，漫画里是「第5话 / 第3页 / 第2格」，套图里是「春季系列 / 主视觉」——
 * 它们的**形状完全一样**：一条从粗到细的路径，只是每层叫什么不同。
 *
 * 所以这里**不定义任何具体业务层级**，只定义「怎么描述一套层级」：
 *
 * ```ts
 * const schema: FacetSchema = {
 *   id: 'facet-m3k1',
 *   label: '短剧',
 *   levels: [
 *     { key: 'episode', label: '集', hint: '第01集' },
 *     { key: 'scene',   label: '场', hint: '第2场' },
 *     { key: 'shot',    label: '镜', hint: '第12镜' }
 *   ]
 * }
 * ```
 *
 * 层级定义本身也是**工作区数据**（workspace.json 的 facets.schemas），由使用者
 * 在界面里创建、或由 Agent 按对话创建。本文件只提供数据结构、清洗与解析工具，
 * 不内置任何方案——一份方案值不值得内置，取决于具体项目，不该由产品决定。
 *
 * 数据侧只存值数组，**不存层名**（层名随 schema 变，值不变）：
 * ```json
 * { "facets": { "assets/images/a.png": { "schemaId": "facet-m3k1",
 *     "chain": ["第03集", "第2场", "第12镜"] } } }
 * ```
 *
 * 这样换 schema 不需要迁移已有值；同一工作区可以并存多套 schema（同时做短剧和
 * 产品套图），靠 `schemaId` 区分；换掉 schema 后老数据仍按写入时的语义显示。
 *
 * 与标签的区别（刻意分开）：
 * - 标签 tags：扁平、可多值、用于交叉检索（「主视觉」「风格参考」）
 * - 分级 facets：单值、有序、用于**定位**（「这东西在项目的哪个位置」）
 * 把层级塞进标签会让「按类型筛选」和「按位置定位」两种查询互相污染。
 *
 * 关于编码：`chain` 存的是**给人看的字符串**（"第03集"），不是 id。因为分级
 * 主要是人机共同阅读的上下文（Agent 需要知道"这张图是第3集第2场"），用可读值
 * 比用 id 更省一层翻译。排序/比较请用 `nodeIndex` 派生，不要对中文排序。
 */

/* ------------------------------------------------------------ 核心类型 */

/** 单层定义 */
export interface FacetLevel {
  /** 稳定键名（schema 内部用，落盘不进 chain）：episode / scene / shot */
  key: string
  /** 单字/短名，用于紧凑展示（「集」「场」「镜」） */
  label: string
  /** 完整名，用于表单与详情（「剧集」「场景」「镜头」） */
  title?: string
  /** 输入提示（占位符），帮助人/AI 用统一写法 */
  hint?: string
  /**
   * 该层是否允许存在「无子级」的空容器（如只到「场」没有「镜」）。
   * 只影响 UI 提示，不参与校验。
   */
  optional?: boolean
}

/**
 * 一套层级定义。
 * `levels.length` 即深度；`levels[0]` 最粗。
 */
export interface FacetSchema {
  /** 稳定 id（落盘进 facet.schemaId）；由 newFacetSchemaId 生成 */
  id: string
  /** 展示名（用户自己起，如「短剧」「分镜表」） */
  label: string
  /** 从粗到细的层定义 */
  levels: FacetLevel[]
  /** 该 schema 的用途说明（给 Agent 看的一句话） */
  description?: string
}

/** 一个文件的分级坐标 */
export interface Facet {
  /** 使用哪套 schema；缺省 = 工作区当前生效 schema */
  schemaId?: string
  /**
   * 从粗到细的值，长度 <= schema.levels.length。
   * 允许短于深度（只定位到「场」没到「镜」），但不允许有空洞（不能 ["第1集", "", "第3镜"]）。
   */
  chain: string[]
  /**
   * 在父级内的显式排序号（可选）。
   * 缺省按 chain 在 schema 中的出现顺序；显式给值可表达「第12镜在第3镜之前」这种剪辑顺序。
   */
  order?: number
}

/* ------------------------------------------------------------ 约束常量 */

/** 一条分级链最多几层（schema 深度上限，也是无 schema 时的收敛深度） */
export const MAX_FACET_DEPTH = 6
/** 一个工作区最多存几套 schema */
export const MAX_FACET_SCHEMAS = 20
/** schema id 的合法形态（落盘键，保持窄字符集） */
const SCHEMA_ID_RE = /^[a-z0-9_-]{1,32}$/i
/** 层名最长多少字（紧凑展示用，过长会撑坏筛选条） */
const LEVEL_LABEL_MAX = 12

/* ------------------------------------------------------------ 清洗 */

/** 路径键规范化：反斜杠转正斜杠、去前导斜杠（与 tags.json 的键约定一致） */
export function normalizeFacetKey(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** 单个层级值清洗：去首尾空白、去内部换行、限长（防止 agent 写入超长文本） */
export function cleanFacetValue(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60)
}

/** 短文本清洗（label / title / hint 共用） */
function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
}

/**
 * 把任意输入收敛成合法 FacetLevel；层级名缺失时返回 null（丢弃该层）。
 * key 不合法时按 `level-N` 派生，重复由 sanitizeFacetSchema 统一去重。
 */
function sanitizeFacetLevel(raw: unknown, index: number): FacetLevel | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const label = cleanText(rec.label, LEVEL_LABEL_MAX)
  if (!label) return null
  const key = typeof rec.key === 'string' && /^[a-z0-9_-]{1,32}$/i.test(rec.key) ? rec.key : `level-${index + 1}`
  const title = cleanText(rec.title, 40)
  const hint = cleanText(rec.hint, 40)
  return {
    key,
    label,
    ...(title ? { title } : {}),
    ...(hint ? { hint } : {}),
    ...(rec.optional === true ? { optional: true } : {})
  }
}

/**
 * 把任意输入收敛成合法 FacetSchema；结构不成立时返回 null。
 *
 * 渲染端与主进程的载荷都按不可信处理（Agent 也会写），所以这里不抛错：
 * 坏层丢弃、坏 id 丢弃、超深截断，只要求「至少一层且每层有名字」。
 */
export function sanitizeFacetSchema(raw: unknown): FacetSchema | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const id = typeof rec.id === 'string' && SCHEMA_ID_RE.test(rec.id) ? rec.id : ''
  const label = cleanText(rec.label, 40)
  if (!id || !label) return null
  if (!Array.isArray(rec.levels)) return null

  const levels: FacetLevel[] = []
  const usedKeys = new Set<string>()
  for (const item of rec.levels.slice(0, MAX_FACET_DEPTH)) {
    const level = sanitizeFacetLevel(item, levels.length)
    if (!level) continue
    // key 去重：第二层同名时退化成 level-N，避免 React key / datalist id 撞车
    let key = level.key
    for (let n = 2; usedKeys.has(key); n += 1) key = `${level.key}-${n}`
    usedKeys.add(key)
    levels.push({ ...level, key })
  }
  if (levels.length === 0) return null

  const description = cleanText(rec.description, 200)
  return { id, label, levels, ...(description ? { description } : {}) }
}

/** 一批 schema 的清洗：按 id 去重（后者覆盖前者）、上限 MAX_FACET_SCHEMAS */
export function sanitizeFacetSchemas(raw: unknown): FacetSchema[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, FacetSchema>()
  for (const item of raw) {
    const schema = sanitizeFacetSchema(item)
    if (!schema) continue
    byId.delete(schema.id) // 后出现的覆盖先出现的，同时移到末尾
    byId.set(schema.id, schema)
    if (byId.size > MAX_FACET_SCHEMAS) {
      const oldest = byId.keys().next().value
      if (oldest !== undefined) byId.delete(oldest)
    }
  }
  return [...byId.values()]
}

/** 生成一个新的 schema id，避开已有 id（短、稳定、不与人工输入冲突） */
export function newFacetSchemaId(existing: readonly string[] = []): string {
  const taken = new Set(existing)
  for (;;) {
    const id = `facet-${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
}

/* ------------------------------------------------------------ 解析 */

/** 按 id 找 schema；找不到返回 null（不再有内置默认回落） */
export function findFacetSchema(schemas: readonly FacetSchema[], id?: string | null): FacetSchema | null {
  if (!id) return null
  return schemas.find((s) => s.id === id) ?? null
}

/**
 * 工作区当前生效的 schema：命中 activeId → 第一套 → null。
 * null 表示「这个工作区还没有建过任何分级结构」，各 UI 据此隐藏分级入口。
 */
export function activeFacetSchema(
  schemas: readonly FacetSchema[],
  activeId?: string | null
): FacetSchema | null {
  return findFacetSchema(schemas, activeId) ?? schemas[0] ?? null
}

/**
 * 某个 facet 该用哪套 schema 解释。
 *
 * 为什么优先用 facet 自己的 schemaId：工作区切到另一套结构后，老数据的 `chain`
 * 值本身没变，但层名含义完全不同。存了 schemaId 就能「按写入时的语义显示」，
 * 不会把「第01集」错标成「第01话」。
 *
 * 回退顺序：facet.schemaId → 当前生效结构 → null（层名未知，按「第N层」显示）。
 */
export function schemaForFacet(
  facet: Facet | null | undefined,
  schemas: readonly FacetSchema[],
  fallback: FacetSchema | null
): FacetSchema | null {
  if (facet?.schemaId) {
    const own = findFacetSchema(schemas, facet.schemaId)
    if (own) return own
  }
  return fallback
}

/**
 * 写入前盖章：把 facet 的 schemaId 记成写入时用的那套结构。
 *
 * 总是覆盖（而不是「已知 id 就保留」）：写入时的语义就是当前的语义，让数据能
 * 自解释。跨结构搬迁请显式调用两次写入，不要靠保留旧 id 表达。
 */
export function stampFacetSchema(facet: Facet | null, schema: FacetSchema | null | undefined): Facet | null {
  if (!facet || !schema) return facet
  if (facet.schemaId === schema.id) return facet
  return { ...facet, schemaId: schema.id }
}

/**
 * 把任意输入收敛成合法 Facet（渲染端/Agent 的载荷都按不可信处理）。
 *
 * 规则：
 * - `chain` 必须是字符串数组，逐项清洗；遇到空串视为链的结束（后面的丢弃）
 * - 给了 schema 时按深度截断；没给时按 MAX_FACET_DEPTH 兜底
 * - 清洗后为空返回 null（= 删除该文件的分级）
 * - schemaId 只保留合法 id 形态（字母数字、-、_），否则丢弃
 */
export function coerceFacet(input: unknown, schema?: FacetSchema | null): Facet | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as { schemaId?: unknown; chain?: unknown; order?: unknown }
  if (!Array.isArray(raw.chain)) return null

  const depth = schema?.levels.length ?? MAX_FACET_DEPTH
  const chain: string[] = []
  for (const item of raw.chain) {
    const value = cleanFacetValue(item)
    // 空值 = 链在这里结束（不允许中间空洞）
    if (!value) break
    chain.push(value)
    if (chain.length >= depth) break
  }
  if (chain.length === 0) return null

  const out: Facet = { chain }
  if (typeof raw.schemaId === 'string' && SCHEMA_ID_RE.test(raw.schemaId)) {
    out.schemaId = raw.schemaId
  }
  if (typeof raw.order === 'number' && Number.isFinite(raw.order)) {
    out.order = Math.trunc(raw.order)
  }
  return out
}

/**
 * facet 的展示路径（「第03集 / 第2场 / 第12镜」）。
 * 值多于层数时原样显示（schema 换过时不至于丢信息）。
 */
export function facetPath(facet: Facet | null | undefined, schema: FacetSchema | null): string {
  if (!facet || facet.chain.length === 0) return ''
  return facet.chain
    .map((value, index) => {
      const level = schema?.levels[index]
      if (!level) return `+${value}`
      return `${value}`
    })
    .join(' / ')
}

/**
 * 分组键：用于「按分级归类」时把同一父级的卡片聚在一起。
 * 取到 `depth` 层（含），不足则返回现有全长。
 */
export function facetGroupKey(facet: Facet | null | undefined, depth: number): string {
  if (!facet || facet.chain.length === 0) return ''
  return facet.chain.slice(0, Math.max(1, depth)).join('\u0000')
}

/**
 * 该 facet 是否匹配某个前缀（用于「看第3集的所有素材」）。
 * `prefix` 逐项精确比较；空 prefix 恒匹配。
 */
export function facetMatchesPrefix(facet: Facet | null | undefined, prefix: string[]): boolean {
  if (prefix.length === 0) return true
  if (!facet) return false
  if (facet.chain.length < prefix.length) return false
  return prefix.every((value, index) => facet.chain[index] === value)
}

/** 从 facet 数组里收集某一层的所有取值（去重、按首次出现顺序） */
export function collectFacetValues(facets: Array<Facet | null | undefined>, levelIndex: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const facet of facets) {
    const value = facet?.chain[levelIndex]
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
