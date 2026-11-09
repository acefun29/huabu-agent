/**
 * 项目结构模型（原型 index-projects.html 的后端真相源）。
 *
 * 关键定位（与用户澄清一致）：**层级不是目录嵌套**。
 * - 素材库仍与工作区最上层对齐，文件平铺在原路径，不因层级新建目录；
 * - 画布上新增的只是「共享父级的容器卡」这层聚合表达；
 * - 父级只存在于本文件的数据里，叶子节点用 `assetId` **引用**已有素材（不复制）。
 *
 * 因此本模块是纯增量：删掉 project.json 即回到纯画布，素材/媒体/血脉零影响。
 *
 * 层级完全由数据定义（原型 README:29）：levels 里的名称/字段/是否容器，渲染逻辑
 * 里没有写死"剧集/场景/镜头"——短剧 3 层与套图 2 层共用同一套代码。
 */

/** 单层定义（原型 DRAMA_LEVELS / PROMO_LEVELS 的形状） */
export interface ProjectLevel {
  key: string
  label: string
  plural: string
  icon: string
  /** true = 容器卡，可下钻；false = 叶子（对应一张素材） */
  container: boolean
  /** 本层字段定义（结构化元数据，进详情与列表） */
  fields: { key: string; label: string }[]
  /** 卡片上显示哪些字段 */
  cardFields: string[]
  /** 详情里显示哪些字段 */
  detailFields: string[]
}

/**
 * 节点状态（原型 §"生成即校验，没有待审"：只保留四个）。
 * 由「是否有产物 / 是否有在跑的任务 / 有无验收失败」派生，不额外落盘第五态。
 */
export type ProjectNodeStatus = 'todo' | 'generating' | 'done' | 'attention'

/** 结构节点（容器与叶子共用；叶子多一个 assetId 引用） */
export interface ProjectNode {
  id: string
  /** 层级序号，从 1 开始（1 = 最上层） */
  level: number
  /** 父节点 id；顶层为 null */
  parentId: string | null
  title: string
  subtitle?: string
  /** 同级排序 */
  order: number
  /** 本层结构化字段（键来自 levels[level-1].fields） */
  fields: Record<string, string>
  /** 本层提示词（参与逐级继承） */
  prompt?: string
  /**
   * 叶子专用：引用的素材（素材库条目的稳定标识）。
   * 为空 = 待生成；生成完成后回填。容器节点恒为空。
   */
  assetId?: string
  /** 显式覆盖的展示封面（可选；缺省取素材缩略图） */
  cover?: string
}

/** 项目（原型 PROJECTS 的一项） */
export interface Project {
  id: string
  name: string
  /** 类型标签：短剧 / 产品套图 / 任意 */
  kind: string
  /** 主题色（原型 pill 上的圆点） */
  dot?: string
  tagline?: string
  /** 层级定义，长度即 depth */
  levels: ProjectLevel[]
  rootLabel: string
  /** 项目级提示词（继承链的最顶层） */
  promptBase?: string
  nodes: ProjectNode[]
}

/** project.json 顶层（一个工作区一份） */
export interface ProjectFile {
  version: 1
  /** 当前选中的项目 */
  activeProjectId: string | null
  projects: Project[]
}

export const EMPTY_PROJECT_FILE: ProjectFile = { version: 1, activeProjectId: null, projects: [] }

/* ------------------------------------------------------------ 只读查询 */

/** 节点深度（levels.length；短剧 3、套图 2） */
export function projectDepth(project: Project): number {
  return project.levels.length
}

export function findNode(project: Project, nodeId: string | null | undefined): ProjectNode | null {
  if (!nodeId) return null
  return project.nodes.find((node) => node.id === nodeId) ?? null
}

/** 子节点（按 order 排序） */
export function childrenOf(project: Project, parentId: string | null): ProjectNode[] {
  return project.nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order)
}

/** 从根到该节点的路径（含自身）；原型 pathOf */
export function pathOf(project: Project, nodeId: string): ProjectNode[] {
  const out: ProjectNode[] = []
  let node = findNode(project, nodeId)
  while (node) {
    out.unshift(node)
    node = node.parentId ? findNode(project, node.parentId) : null
  }
  return out
}

/** 某节点是否在另一节点的子树内（含自身判断由调用方决定） */
export function isDescendantOf(project: Project, node: ProjectNode, ancestorId: string): boolean {
  let parent = node.parentId
  while (parent) {
    if (parent === ancestorId) return true
    parent = findNode(project, parent)?.parentId ?? null
  }
  return false
}

/** 容器进度：子树内叶子 已完成/总数（原型 leafStats） */
export function leafStats(project: Project, nodeId: string): { total: number; done: number; pct: number } {
  const depth = projectDepth(project)
  const leaves = project.nodes.filter(
    (node) =>
      node.level === depth &&
      (node.id === nodeId || isDescendantOf(project, node, nodeId))
  )
  const done = leaves.filter((node) => deriveStatus(project, node) === 'done').length
  return { total: leaves.length, done, pct: leaves.length ? Math.round((done / leaves.length) * 100) : 0 }
}

/* ------------------------------------------------------------ 状态派生 */

/**
 * 状态派生（无 review 态）。优先级：验收失败 > 生成中 > 已生成 > 待生成。
 * `runtime` 由调用方注入实时信息（任务是否在跑、是否验收失败），
 * 这样结构文件本身不必随任务状态频繁重写（避免双写漂移）。
 */
export interface NodeRuntimeHint {
  /** 该节点当前有任务在跑 */
  generating?: boolean
  /** 最近一次验收失败（带原因），等待主 Agent 重派或专家重试 */
  attention?: boolean
}

export function deriveStatus(
  project: Project,
  node: ProjectNode,
  runtime: NodeRuntimeHint = {}
): ProjectNodeStatus {
  if (runtime.attention) return 'attention'
  if (runtime.generating) return 'generating'
  // 叶子：有素材引用即视为已生成；容器：子树叶子全部完成才算完成
  if (node.level < projectDepth(project)) {
    const stats = leafStats(project, node.id)
    return stats.total > 0 && stats.done === stats.total ? 'done' : stats.done > 0 ? 'generating' : 'todo'
  }
  return node.assetId ? 'done' : 'todo'
}

/* ------------------------------------------------------ 提示词逐级继承 */

export interface PromptLayer {
  level: string
  label: string
  prompt: string
}

export interface EffectivePrompt {
  /** 从项目到本节点逐级展开（本层在最后，UI 高亮） */
  layers: PromptLayer[]
  /** 拼成的有效提示词（可复制） */
  effective: string
  /** 本层是否已有自己的 prompt（否则靠继承） */
  ownPrompt: boolean
}

/**
 * 有效提示词（原型 §"提示词分级：项目 → 剧集 → 场景 → 镜头逐级继承"）。
 * 空 prompt 的层级跳过，但层级标签保留在 layers 里（UI 显示"继承自"）。
 */
export function effectivePrompt(project: Project, nodeId: string): EffectivePrompt {
  const chain = pathOf(project, nodeId)
  const layers: PromptLayer[] = []
  if (project.promptBase?.trim()) {
    layers.push({ level: 'project', label: project.name, prompt: project.promptBase.trim() })
  }
  for (const node of chain) {
    const levelDef = project.levels[node.level - 1]
    const prompt = node.prompt?.trim()
    if (!prompt) continue
    layers.push({
      level: levelDef?.key ?? `level-${node.level}`,
      label: node.title || levelDef?.label || `L${node.level}`,
      prompt,
    })
  }
  const own = findNode(project, nodeId)
  return {
    layers,
    effective: layers.map((layer) => layer.prompt).join('。'),
    ownPrompt: Boolean(own?.prompt?.trim()),
  }
}

/* ------------------------------------------------------- 上下文健康 */

/**
 * 上下文健康（原型 §"上下文健康"）：只表达「缺参考/有冲突」，
 * 不是人工审批。`missing` 由调用方按资产解析结果注入（如引用的 assetId 已失效）。
 */
export interface ContextHealth {
  ok: boolean
  /** 缺失/冲突项（进对话让用户补，Agent 停在这里） */
  issues: { kind: 'missing_asset' | 'stale_ref' | 'conflict'; detail: string }[]
}

export function contextHealth(project: Project, nodeId: string, resolvedAssetIds: ReadonlySet<string>): ContextHealth {
  const node = findNode(project, nodeId)
  if (!node) return { ok: false, issues: [{ kind: 'conflict', detail: `节点不存在：${nodeId}` }] }
  const issues: ContextHealth['issues'] = []
  if (node.assetId && !resolvedAssetIds.has(node.assetId)) {
    issues.push({ kind: 'missing_asset', detail: `引用的素材不存在：${node.assetId}` })
  }
  // 容器：子树里任一叶子缺资产也算缺参考
  if (node.level < projectDepth(project)) {
    const depth = projectDepth(project)
    for (const leaf of project.nodes) {
      if (leaf.level !== depth) continue
      if (!isDescendantOf(project, leaf, nodeId)) continue
      if (leaf.assetId && !resolvedAssetIds.has(leaf.assetId)) {
        issues.push({ kind: 'missing_asset', detail: `${leaf.title}：引用的素材不存在（${leaf.assetId}）` })
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

/* ------------------------------------------------------------ 结构变更 */

/** 新增节点（校验 parent 与 level 一致性，防止层级错位） */
export function addNode(project: Project, node: Omit<ProjectNode, 'order'> & { order?: number }): Project {
  const parent = node.parentId ? findNode(project, node.parentId) : null
  const expectedLevel = parent ? parent.level + 1 : 1
  if (node.level !== expectedLevel) {
    throw new Error(`层级不匹配：父级为 ${parent?.level ?? 0}，新节点应为 level ${expectedLevel}，实际 ${node.level}`)
  }
  if (node.level > projectDepth(project)) {
    throw new Error(`层级越界：项目只有 ${projectDepth(project)} 层`)
  }
  if (parent && node.level <= projectDepth(project) && project.levels[parent.level - 1]?.container === false) {
    throw new Error(`父节点 ${parent.id} 是叶子层，不能再挂子节点`)
  }
  const siblings = childrenOf(project, node.parentId)
  const order = node.order ?? (siblings.at(-1)?.order ?? 0) + 1
  return { ...project, nodes: [...project.nodes, { ...node, order }] }
}

/** 更新节点字段（只合并提供的键，避免整体覆盖） */
export function patchNode(
  project: Project,
  nodeId: string,
  patch: Partial<Pick<ProjectNode, 'title' | 'subtitle' | 'prompt' | 'assetId' | 'cover' | 'order'> & { fields?: Record<string, string> }>
): Project {
  return {
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            ...patch,
            fields: patch.fields ? { ...node.fields, ...patch.fields } : node.fields,
          }
        : node
    ),
  }
}

/** 删除节点及其子树（返回被删 id 列表，供调用方清理任务引用） */
export function removeNode(project: Project, nodeId: string): { project: Project; removedIds: string[] } {
  const removed = new Set<string>([nodeId])
  let changed = true
  while (changed) {
    changed = false
    for (const node of project.nodes) {
      if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
        removed.add(node.id)
        changed = true
      }
    }
  }
  return {
    project: { ...project, nodes: project.nodes.filter((node) => !removed.has(node.id)) },
    removedIds: [...removed],
  }
}

/** 重排同级顺序（拖拽/手动排序） */
export function reorderChildren(project: Project, parentId: string | null, orderedIds: string[]): Project {
  const rank = new Map(orderedIds.map((id, index) => [id, index + 1]))
  return {
    ...project,
    nodes: project.nodes.map((node) =>
      node.parentId === parentId && rank.has(node.id) ? { ...node, order: rank.get(node.id)! } : node
    ),
  }
}
