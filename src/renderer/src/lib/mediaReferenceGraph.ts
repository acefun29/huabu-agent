/**
 * 生成参考引用链（media reference chain）纯函数模块。
 *
 * 职责：统一「参考记录」的读/写/校验/规划。AssetGen.references 是唯一事实源，
 * legacy refs/refRoles 是兼容视图，本模块是两者之间唯一的换算口：
 * - 读：getGenerateReferences —— references 缺席的旧数据按 refs/refRoles + 当前
 *   模型 caps 懒派生（刻意不在载入期固化，避免 settings 未就绪时把
 *   reference_image 专用视频模型的默认角色错存成 first_frame）；
 * - 写：withGenerateReferences —— references 去重重排后反写 legacy 双视图；
 * - 判：wouldCreateReferenceCycle / validateGenerateReferences /
 *   getReferenceUpdateState / planGenerationChain。
 *
 * 硬约束：electron-free / store-free / window-free；不 import 任何 store、React、
 * window/electron API；类型 import 一律 type-only。渲染端与脚本两侧可复用。
 */
import {
  MEDIA_MODE_LABEL,
  MEDIA_REF_ROLES,
  MEDIA_ROLE_KIND,
  REF_ROLE_LABEL,
  deriveRefRole,
  inferMediaMode
} from '@shared/media'
import type { MediaGenMode, MediaKind, MediaRefRole, ResolvedRefCaps } from '@shared/media'
import { KIND_LABEL } from '../types'
import type { AssetGen, AssetKind, CanvasNode, GenerateReference } from '../types'

/** legacy 引用的稳定 id（同一输入恒得同一 id）：`目标:来源:角色` */
export function legacyReferenceId(targetNodeId: string, sourceNodeId: string, role: MediaRefRole): string {
  return `${targetNodeId}:${sourceNodeId}:${role}`
}

/**
 * 无能力声明时的角色兜底（历史语义：视频通道的第一张图当首帧，其余按素材大类）。
 * 仅在 caps 缺席或 deriveRefRole 派生不出（该模型不吃这种素材）时使用 ——
 * 后者得到的是「供校验报错」的占位角色，不代表模型真的支持。
 */
export function defaultRefRole(sourceKind: AssetKind, targetKind: MediaKind, index: number): MediaRefRole {
  if (targetKind === 'video' && sourceKind === 'image' && index === 0) return 'first_frame'
  if (sourceKind === 'video') return 'reference_video'
  if (sourceKind === 'audio') return 'reference_audio'
  return 'reference_image'
}

/** 素材卡是否已有可投递文件（storage 明确且 path 非空）。生成卡未产出 = false */
export function isReferenceSourceProduced(source: CanvasNode): boolean {
  const data = source.data
  return (data.storage === 'media' || data.storage === 'ws') && Boolean(data.path)
}

/** 单卡的参考来源序列（不含角色信息；图/链遍历共用）。无 gen 的素材卡 = 空 */
function referenceSourcesOf(node: CanvasNode, nodes: readonly CanvasNode[]): string[] {
  if (!node.data.gen) return []
  return getGenerateReferences(node, nodes).map((r) => r.sourceNodeId)
}

/**
 * 卡片的权威参考列表。references 数组存在（含显式空数组 = 用户已清空）即权威，
 * 原样返回（防外部改动的浅拷贝）；缺席的旧数据按 refs/refRoles 懒派生：显式
 * refRoles 优先，否则按 caps 派生（同 jobRuntime 历史语义），派生不出也保留
 * （占位角色，供 validate 报 role_unsupported）。
 */
export function getGenerateReferences(
  node: CanvasNode,
  nodes: readonly CanvasNode[],
  caps?: ResolvedRefCaps
): GenerateReference[] {
  const gen = node.data.gen
  if (!gen) return []
  if (Array.isArray(gen.references)) {
    return gen.references
      .filter((r) => r && typeof r.id === 'string' && typeof r.sourceNodeId === 'string' && MEDIA_REF_ROLES.includes(r.role))
      .map((r) => ({ ...r }))
      .sort((a, b) => a.order - b.order)
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const targetKind = (node.data.kind as MediaKind) ?? 'image'
  return (gen.refs ?? []).map((sourceId, index): GenerateReference => {
    const source = byId.get(sourceId)
    const sourceKind = (source?.data.kind as MediaKind | undefined) ?? 'image'
    const explicit = gen.refRoles?.[sourceId]
    const role =
      explicit ??
      (caps ? deriveRefRole(sourceKind, targetKind, index, caps.quota) ?? defaultRefRole(sourceKind, targetKind, index) : defaultRefRole(sourceKind, targetKind, index))
    return { id: legacyReferenceId(node.id, sourceId, role), sourceNodeId: sourceId, role, order: index }
  })
}

/**
 * 以 references 为唯一权威写回 AssetGen：入参去重（按 id 保序）并重排序号，
 * 同步反推 legacy 视图 —— refs = 去重后的 sourceNodeId 序列；refRoles = 按首现身
 * 角色 × sourceNodeId 的映射（legacy 表达不了同源多角色，真相在 references）。
 */
export function withGenerateReferences(gen: AssetGen, references: GenerateReference[]): AssetGen {
  const seen = new Set<string>()
  const normalized: GenerateReference[] = []
  for (const ref of references) {
    if (!ref || seen.has(ref.id)) continue
    seen.add(ref.id)
    normalized.push({ ...ref, order: normalized.length })
  }
  const refs: string[] = []
  const refRoles: Record<string, MediaRefRole> = {}
  for (const ref of normalized) {
    if (!refs.includes(ref.sourceNodeId)) refs.push(ref.sourceNodeId)
    if (!(ref.sourceNodeId in refRoles)) refRoles[ref.sourceNodeId] = ref.role
  }
  return { ...gen, references: normalized, refs, refRoles }
}

/**
 * 加边 target → source（target 引用 source 作参考）是否成环：
 * 自引直接成环；否则从 source 沿既有引用边向上走，能回到 target 即成环。
 */
export function wouldCreateReferenceCycle(nodes: readonly CanvasNode[], sourceNodeId: string, targetNodeId: string): boolean {
  if (sourceNodeId === targetNodeId) return true
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visited = new Set<string>([sourceNodeId])
  const stack = [sourceNodeId]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const node = byId.get(current)
    if (!node) continue
    for (const next of referenceSourcesOf(node, nodes)) {
      if (next === targetNodeId) return true
      if (!visited.has(next)) {
        visited.add(next)
        stack.push(next)
      }
    }
  }
  return false
}

/**
 * 生成前的引用校验（纯连接/结构层面，不做模型解析）。
 *
 * 返回契约：
 * - errors：严格校验的全部中文硬错误（保持既有语义：有错就报，不做静默裁剪），
 *   其中也含「未产出」类错误（源卡存在、类型匹配但没有可投递文件）；
 * - unproduced：errors 中「未产出」条目的原串子集（unproduced ⊆ errors）。
 *   runtime 用 `errors.filter((e) => !unproduced.includes(e))` 得纯连接错误，
 *   或直接读它区分"链式生成应先跑上游"与"直接提交应拦截"。
 *
 * 校验项：来源缺失 / 素材大类与角色不符 / 逐角色配额（0 = 模型不接受该角色）/
 * 总量闸 / 模式可达 / 尾帧依赖。角色/数量/模式按「存在且类型匹配」的全部引用判——
 * 未产出的生成卡同样占配额、同样参与组合判定（搭链时上游本轮会产出，但结构错误
 * 不该被"还没产出"掩盖，等产出了才报就是纯负向体验）；未产出另以 unproduced
 * 单独留痕。引用列表不裁剪，超量以错误报告。
 */
export function validateGenerateReferences(
  node: CanvasNode,
  nodes: readonly CanvasNode[],
  caps: ResolvedRefCaps
): { references: GenerateReference[]; errors: string[]; unproduced: string[] } {
  const references = getGenerateReferences(node, nodes, caps)
  const errors: string[] = []
  const unproduced: string[] = []
  if (!node.data.gen) return { references, errors, unproduced }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const targetKind = (node.data.kind as MediaKind) ?? 'image'
  // 存在且类型匹配的引用全部参与配额/总量/模式判定（未产出只额外加一条留痕错误）
  const usable: GenerateReference[] = []

  for (const ref of references) {
    const roleLabel = REF_ROLE_LABEL[ref.role]
    const source = byId.get(ref.sourceNodeId)
    if (!source) {
      errors.push(`参考的素材卡片不存在或已被删除（${roleLabel}），请移除该参考或撤销删除`)
      continue
    }
    const expectedKind = MEDIA_ROLE_KIND[ref.role]
    if (source.data.kind !== expectedKind) {
      errors.push(
        `按${roleLabel}引用的「${source.data.name}」是${KIND_LABEL[source.data.kind]}，${roleLabel}只能使用${KIND_LABEL[expectedKind]}`
      )
      continue
    }
    if (!isReferenceSourceProduced(source)) {
      const message = `参考的「${source.data.name}」还没有产出文件（${roleLabel}）`
      errors.push(message)
      unproduced.push(message)
    }
    usable.push(ref)
  }

  const perRole = new Map<MediaRefRole, number>()
  for (const ref of usable) perRole.set(ref.role, (perRole.get(ref.role) ?? 0) + 1)
  for (const [role, count] of perRole) {
    const max = caps.quota[role]
    if (!max || max <= 0) {
      errors.push(`该模型不接受${REF_ROLE_LABEL[role]}参考，请更换模型或改用其他参考类型`)
    } else if (count > max) {
      errors.push(`${REF_ROLE_LABEL[role]}参考超出该模型上限（${count}/${max}），请移除多余的参考`)
    }
  }
  if (caps.total > 0 && usable.length > caps.total) {
    errors.push(`参考素材合计超出该模型上限 ${caps.total} 条（当前 ${usable.length} 条），请移除多余的参考`)
  }

  if (usable.length > 0) {
    const roles = [...new Set(usable.map((r) => r.role))]
    const missingFirstFrame = roles.includes('last_frame') && !roles.includes('first_frame')
    if (missingFirstFrame) {
      errors.push('尾帧必须与首帧一起提交，请补充首帧参考或移除尾帧')
    } else if (inferMediaMode(roles, targetKind, caps.modes) === null) {
      const modes = caps.modes.map((m: MediaGenMode) => MEDIA_MODE_LABEL[m]).join(' / ')
      errors.push(`这些参考素材的组合不属于该模型支持的任何用法（支持：${modes || '无'}）`)
    }
  }
  return { references, errors, unproduced }
}

/**
 * 引用新鲜度（相对激活版本.inputs 快照）：unknown 无从比对 / current 未过期 /
 * changed 已过期 / missing 来源已消失。
 */
export type GenerateRefUpdateState = 'unknown' | 'current' | 'changed' | 'missing'

/**
 * 卡片当前参考相对激活版本 inputs 快照的新鲜度。
 *
 * - missing 以**当前引用**为基准：现在挂着的任何一条参考，其来源卡已不在画布即
 *   missing（用户主动移除的引用不算——快照里多出来的条目走 changed；老版本没有
 *   inputs 快照也照样能报 missing，这个判定不依赖快照）。
 * - 其余比对以快照为基准，位置对位置：条数、referenceId、sourceNodeId、role、
 *   顺序任一变化即 changed；来源是生成卡再比激活版本 id（上游再生成即过期，
 *   只改提示词不换版本不触发）+ 文件落点（path/pathRoot，防"版本没变但产物
 *   引用被清/挪"漏报）；来源是普通文件比 storage/path/pathRoot（改名/移动即过期）。
 * - 老版本无 inputs / 卡无激活版本 → unknown（无从比对，不冤枉）。
 */
export function getReferenceUpdateState(node: CanvasNode, nodes: readonly CanvasNode[]): GenerateRefUpdateState {
  const gen = node.data.gen
  if (!gen) return 'unknown'
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const current = getGenerateReferences(node, nodes)
  // 来源缺失优先（以当前引用为基准）：占位引用还没恢复，其它状态没有意义
  for (const ref of current) {
    if (!byId.has(ref.sourceNodeId)) return 'missing'
  }
  const active = gen.activeVersionId ? gen.versions.find((v) => v.id === gen.activeVersionId) : undefined
  if (!active?.inputs) return 'unknown'
  const snapshotRefs = active.inputs.refs
  if (snapshotRefs.length !== current.length) return 'changed'
  for (let i = 0; i < snapshotRefs.length; i += 1) {
    const snap = snapshotRefs[i]
    const now = current[i]
    if (snap.referenceId !== now.id || snap.sourceNodeId !== now.sourceNodeId || snap.role !== now.role) return 'changed'
    const source = byId.get(now.sourceNodeId) as CanvasNode
    if (source.data.gen) {
      // 有版本的来源：激活版本 id 不同 = 上游再生成过（只改提示词不换版本不触发）；
      // 版本相同也要核对文件落点——path/pathRoot 可被清掉或移动而 activeVersion 不动
      if ((snap.sourceVersionId ?? null) !== (source.data.gen.activeVersionId ?? null)) return 'changed'
      if ((snap.path ?? null) !== (source.data.path ?? null)) return 'changed'
      if ((snap.pathRoot ?? null) !== (source.data.pathRoot ?? null)) return 'changed'
    } else {
      // 无版本素材（普通文件卡）：比较落点，改名/移动即过期
      if ((snap.storage ?? null) !== (source.data.storage ?? null)) return 'changed'
      if ((snap.pathRoot ?? null) !== (source.data.pathRoot ?? null)) return 'changed'
      if ((snap.path ?? null) !== (source.data.path ?? null)) return 'changed'
    }
  }
  return 'current'
}

/**
 * 以 target 为终点的生成链规划：把全部上游生成卡依赖按拓扑序（上游在前、
 * target 最后）输出。不做模型解析、不决定运行复用（runtime 负责）；普通素材卡
 * 是叶子，不进 nodeIds。循环 / 目标缺失 / 引用悬空以错误报告，不产出半截链。
 */
export function planGenerationChain(targetNodeId: string, nodes: readonly CanvasNode[]): { nodeIds: string[]; errors: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const errors = new Set<string>()
  const nodeIds: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, trail: readonly string[]) => {
    const node = byId.get(id)
    if (!node) {
      errors.add(`引用的素材卡片不存在（${id}），请先恢复或移除该参考`)
      return
    }
    const mark = state.get(id)
    if (mark === 'done') return
    if (mark === 'visiting') {
      const start = trail.indexOf(id)
      const cycle = [...trail.slice(start), id]
      const names = cycle.map((cid) => byId.get(cid)?.data.name ?? cid)
      errors.add(`参考链存在循环依赖：${names.join(' → ')}`)
      return
    }
    state.set(id, 'visiting')
    for (const sourceId of referenceSourcesOf(node, nodes)) visit(sourceId, [...trail, id])
    state.set(id, 'done')
    // 只有生成卡需要执行；普通素材卡只是链上的现成叶子
    if (node.data.gen) nodeIds.push(id)
  }
  if (!byId.get(targetNodeId)) {
    return { nodeIds: [], errors: [`目标卡片不存在（${targetNodeId}）`] }
  }
  visit(targetNodeId, [])
  return { nodeIds, errors: [...errors] }
}
