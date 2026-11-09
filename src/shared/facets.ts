/**
 * 素材分级的通用 schema（单一事实来源）。
 *
 * 要解决的问题：短剧制作里一张图属于「第3集 / 第2场 / 第12镜」，漫画里一格属于
 * 「第5话 / 第3页 / 第2格」，套图里一张属于「春季系列 / 主视觉」。它们的**形状完全一样**
 * ——一条从粗到细的路径——只是每层叫什么不同。
 *
 * 所以这里不定义任何具体业务层级，只定义「怎么描述一套层级」：
 *
 * ```ts
 * const DRAMA: FacetSchema = {
 *   id: 'drama',
 *   label: '短剧',
 *   levels: [
 *     { key: 'episode', label: '集', hint: '第01集' },
 *     { key: 'scene',   label: '场', hint: 'EP01-S02' },
 *     { key: 'shot',    label: '镜', hint: 'EP01-S02-C03' }
 *   ]
 * }
 * ```
 *
 * 数据侧只存值数组，**不存层名**（层名随 schema 变，值不变）：
 * ```json
 * { "facets": { "assets/images/a.png": { "schemaId": "drama",
 *     "chain": ["第03集", "第2场", "第12镜"] } } }
 * ```
 *
 * 这样换 schema（短剧 ↔ 漫画）不需要迁移已有值；同一工作区也可以并存多套
 * schema（比如同时做短剧和产品套图），靠 `schemaId` 区分。
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
  /** 稳定 id（落盘进 facet.schemaId）：drama / manga / promo / custom-* */
  id: string
  /** 展示名（「短剧」「漫画」「产品套图」） */
  label: string
  /** 从粗到细的层定义 */
  levels: FacetLevel[]
  /** 该 schema 的用途说明（给 Agent 看的一句话） */
  description?: string
}

/** 一个文件的分级坐标 */
export interface Facet {
  /** 使用哪套 schema；缺省 = 工作区当前默认 schema */
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

/* ------------------------------------------------------------ 内置 schema */

export const FACET_SCHEMA_DRAMA: FacetSchema = {
  id: 'drama',
  label: '短剧',
  description: '按 集 → 场 → 镜 三级定位，适合真人短剧/AI 短剧的分镜管理。',
  levels: [
    { key: 'episode', label: '集', title: '剧集', hint: '第01集' },
    { key: 'scene', label: '场', title: '场景', hint: '第2场' },
    { key: 'shot', label: '镜', title: '镜头', hint: '第12镜' }
  ]
}

export const FACET_SCHEMA_MANGA: FacetSchema = {
  id: 'manga',
  label: '漫画',
  description: '按 话 → 页 → 格 三级定位，适合条漫/页漫。',
  levels: [
    { key: 'chapter', label: '话', title: '话', hint: '第05话' },
    { key: 'page', label: '页', title: '页', hint: '第3页' },
    { key: 'panel', label: '格', title: '格', hint: '第2格' }
  ]
}

export const FACET_SCHEMA_PROMO: FacetSchema = {
  id: 'promo',
  label: '产品套图',
  description: '按 组 → 图 两级定位，适合电商/V 视觉的成套产出。',
  levels: [
    { key: 'set', label: '组', title: '套图组', hint: '春季系列' },
    { key: 'image', label: '图', title: '单图', hint: '主视觉' }
  ]
}

export const FACET_SCHEMA_FLAT: FacetSchema = {
  id: 'flat',
  label: '单层分类',
  description: '只有一层（如「章节」「批次」），适合想分个组但不需要多级的场景。',
  levels: [{ key: 'group', label: '组', title: '分组', hint: '第1组' }]
}

export const BUILTIN_FACET_SCHEMAS: FacetSchema[] = [
  FACET_SCHEMA_DRAMA,
  FACET_SCHEMA_MANGA,
  FACET_SCHEMA_PROMO,
  FACET_SCHEMA_FLAT
]

/** 工作区未指定 schema 时的缺省（与「短剧」一致，最常见场景） */
export const DEFAULT_FACET_SCHEMA_ID = FACET_SCHEMA_DRAMA.id

/* ------------------------------------------------------------ 工具函数 */

/** 路径键规范化：反斜杠转正斜杠、去前导斜杠（与 tags.json 的键约定一致） */
export function normalizeFacetKey(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** 单个层级值清洗：去首尾空白、去内部换行、限长（防止 agent 写入超长文本） */
export function cleanFacetValue(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60)
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
export const MAX_FACET_DEPTH = 6

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
  if (typeof raw.schemaId === 'string' && /^[a-z0-9_-]{1,32}$/i.test(raw.schemaId)) {
    out.schemaId = raw.schemaId
  }
  if (typeof raw.order === 'number' && Number.isFinite(raw.order)) {
    out.order = Math.trunc(raw.order)
  }
  return out
}

/** 按 id 找 schema；id 缺省时返回默认 schema；找不到返回 null（调用方决定回退） */
export function findFacetSchema(
  schemas: FacetSchema[],
  id?: string | null
): FacetSchema | null {
  if (!id) return schemas.find((s) => s.id === DEFAULT_FACET_SCHEMA_ID) ?? schemas[0] ?? null
  return schemas.find((s) => s.id === id) ?? null
}

/**
 * facet 的展示路径（「第03集 / 第2场 / 第12镜」）。
 * 值多于层数时多出来的部分用 `+` 前缀原样显示（schema 换过时不至于丢信息）。
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
