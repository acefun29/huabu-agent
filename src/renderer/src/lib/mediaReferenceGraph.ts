/**
 * 引用链（media reference chain）纯函数模块。
 *
 * 链条是生成事实的只读投影：权威来源 = 激活版本 inputs.refs（生成时由系统自动
 * 写入，用户与 Agent 都不能手动建链/删链）。本模块职责：
 * - 读：getCardReferences —— 三级解析（激活版本 inputs.refs → data.references
 *   迁移手动链 → legacy refs/refRoles 懒派生），连线绘制/新鲜度/血脉共用；
 * - 血脉：deriveLineage / formatLineageText —— 递归祖先链（防环、可截断）；
 * - 判：validateRefSet（提交前结构校验）/ getReferenceUpdateState（上游漂移）。
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
import type { AssetKind, CanvasNode, GenerateReference, GenerateVersion } from '../types'

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

/** 素材卡是否已有可投递文件（storage 明确且 path 非空）。生成中的占位卡 = false */
export function isReferenceSourceProduced(source: CanvasNode): boolean {
  const data = source.data
  return (data.storage === 'media' || data.storage === 'ws') && Boolean(data.path)
}

/** 卡片的激活版本（activeVersionId 缺失/失效时回退最新版本）；无版本 = undefined */
export function activeVersionOf(node: CanvasNode): GenerateVersion | undefined {
  const versions = node.data.versions
  if (!versions || versions.length === 0) return undefined
  return versions.find((v) => v.id === node.data.activeVersionId) ?? versions[0]
}

/**
 * 卡片的当前引用链（三级解析，权威在前）：
 * 1. 激活版本 inputs.refs —— 新权威：生成时系统自动写入的定格快照；
 * 2. data.references —— 迁移自旧结构 AssetGen.references 的手动链（legacy 只读展示）；
 * 3. refs/refRoles —— 更旧的 legacy 视图，按当前 caps 懒派生（刻意不在载入期固化，
 *    避免 settings 未就绪时把 reference_image 专用视频模型的默认角色错存成 first_frame）。
 *
 * 画布外文件（Agent 引用了临时上传等，快照里 sourceNodeId 缺省）不画链。
 */
export function getCardReferences(
  node: CanvasNode,
  nodes: readonly CanvasNode[],
  caps?: ResolvedRefCaps
): GenerateReference[] {
  const data = node.data
  const active = activeVersionOf(node)
  if (active?.inputs) {
    return active.inputs.refs
      .filter((r) => r && typeof r.sourceNodeId === 'string' && MEDIA_REF_ROLES.includes(r.role))
      .map((r, index) => ({ id: r.referenceId, sourceNodeId: r.sourceNodeId as string, role: r.role, order: index }))
  }
  if (Array.isArray(data.references)) {
    return data.references
      .filter((r) => r && typeof r.id === 'string' && typeof r.sourceNodeId === 'string' && MEDIA_REF_ROLES.includes(r.role))
      .map((r) => ({ ...r }))
      .sort((a, b) => a.order - b.order)
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const targetKind = (data.kind as MediaKind) ?? 'image'
  return (data.refs ?? []).map((sourceId, index): GenerateReference => {
    const source = byId.get(sourceId)
    const sourceKind = (source?.data.kind as MediaKind | undefined) ?? 'image'
    const explicit = data.refRoles?.[sourceId]
    const role =
      explicit ??
      (caps ? deriveRefRole(sourceKind, targetKind, index, caps.quota) ?? defaultRefRole(sourceKind, targetKind, index) : defaultRefRole(sourceKind, targetKind, index))
    return { id: legacyReferenceId(node.id, sourceId, role), sourceNodeId: sourceId, role, order: index }
  })
}

/**
 * 为一组来源卡派生参考角色（生成 Popover 选卡后由系统分配，用户不手动指定）。
 * 同源去重（按 id 保序），序号即 order；派生不出时用 defaultRefRole 占位，
 * 占位角色会在 validateRefSet 里报 role_unsupported，由提交前校验拦截。
 */
export function assignRefRoles(
  targetNodeId: string,
  sources: readonly CanvasNode[],
  targetKind: MediaKind,
  caps?: ResolvedRefCaps
): GenerateReference[] {
  const seen = new Set<string>()
  const refs: GenerateReference[] = []
  for (const source of sources) {
    if (seen.has(source.id)) continue
    seen.add(source.id)
    const sourceKind = (source.data.kind as MediaKind) ?? 'image'
    const role =
      caps
        ? deriveRefRole(sourceKind, targetKind, refs.length, caps.quota) ??
          defaultRefRole(sourceKind, targetKind, refs.length)
        : defaultRefRole(sourceKind, targetKind, refs.length)
    refs.push({ id: legacyReferenceId(targetNodeId, source.id, role), sourceNodeId: source.id, role, order: refs.length })
  }
  return refs
}

/**
 * 提交生成前的参考校验（纯连接/结构层面，不做模型解析）。
 *
 * 返回契约：
 * - errors：严格校验的全部中文硬错误（有错就报，不做静默裁剪），其中也含
 *   「未产出」类错误（源卡存在、类型匹配但没有可投递文件）；
 * - unproduced：errors 中「未产出」条目的原串子集（unproduced ⊆ errors）。
 *
 * 校验项：来源缺失 / 素材大类与角色不符 / 逐角色配额（0 = 模型不接受该角色）/
 * 总量闸 / 模式可达 / 尾帧依赖。角色/数量/模式按「存在且类型匹配」的全部引用判。
 * 引用列表不裁剪，超量以错误报告。
 */
export function validateRefSet(
  targetKind: MediaKind,
  refs: readonly GenerateReference[],
  nodes: readonly CanvasNode[],
  caps: ResolvedRefCaps
): { errors: string[]; unproduced: string[] } {
  const errors: string[] = []
  const unproduced: string[] = []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // 存在且类型匹配的引用全部参与配额/总量/模式判定（未产出只额外加一条留痕错误）
  const usable: GenerateReference[] = []

  for (const ref of refs) {
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
  return { errors, unproduced }
}

/**
 * 引用新鲜度（相对激活版本.inputs 快照）：unknown 无从比对 / current 未过期 /
 * changed 已过期 / missing 来源已消失。
 *
 * 链条本身就是从激活版本 inputs 派生的，所以「引用列表是否被改过」不再可比；
 * 这里比对的是**上游卡片的当前状态**：来源是生成卡再比激活版本 id（上游再生成
 * 即过期，只改提示词不换版本不触发）+ 文件落点（path/pathRoot，防"版本没变但
 * 产物引用被清/挪"漏报）；来源是普通文件比 storage/path/pathRoot（改名/移动即过期）。
 */
export type GenerateRefUpdateState = 'unknown' | 'current' | 'changed' | 'missing'

export function getReferenceUpdateState(node: CanvasNode, nodes: readonly CanvasNode[]): GenerateRefUpdateState {
  const active = activeVersionOf(node)
  if (!active?.inputs) return 'unknown'
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const snapshotRefs = active.inputs.refs.filter((r) => r.sourceNodeId)
  for (const snap of snapshotRefs) {
    if (!byId.has(snap.sourceNodeId as string)) return 'missing'
  }
  for (const snap of snapshotRefs) {
    const source = byId.get(snap.sourceNodeId as string) as CanvasNode
    const sourceActive = activeVersionOf(source)
    if (sourceActive) {
      // 有版本的来源：激活版本 id 不同 = 上游再生成过（只改提示词不换版本不触发）；
      // 版本相同也要核对文件落点——path/pathRoot 可被清掉或移动而 activeVersion 不动
      if ((snap.sourceVersionId ?? null) !== (source.data.activeVersionId ?? sourceActive.id)) return 'changed'
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

/** 血脉链上的一个祖先条目（BFS 序） */
export interface LineageEntry {
  nodeId: string
  name: string
  /** 到达该祖先的直接父边角色（depth=1 = 本卡引用它时用的角色） */
  role?: MediaRefRole
  /** 1 = 直接参考，2 = 参考的参考…… */
  depth: number
}

/**
 * 卡片的血脉链（递归祖先，BFS 序、防环、可截断）。
 * 生成事实可能在激活版本投影里成环（A←B 后又 B←A 的 ping-pong 迭代合法），
 * visited 去重保证终止。maxDepth/maxNodes 截断保证上下文摘要体积可控。
 */
export function deriveLineage(
  nodeId: string,
  nodes: readonly CanvasNode[],
  opts?: { maxDepth?: number; maxNodes?: number }
): LineageEntry[] {
  const maxDepth = opts?.maxDepth ?? 3
  const maxNodes = opts?.maxNodes ?? 8
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visited = new Set<string>([nodeId])
  const entries: LineageEntry[] = []
  let queue: { id: string; role?: MediaRefRole; depth: number }[] = [{ id: nodeId, depth: 0 }]
  while (queue.length > 0 && entries.length < maxNodes) {
    const next: { id: string; role?: MediaRefRole; depth: number }[] = []
    for (const item of queue) {
      if (item.depth >= maxDepth) continue
      const node = byId.get(item.id)
      if (!node) continue
      for (const ref of getCardReferences(node, nodes)) {
        if (visited.has(ref.sourceNodeId)) continue
        const source = byId.get(ref.sourceNodeId)
        if (!source) continue
        visited.add(ref.sourceNodeId)
        if (entries.length >= maxNodes) break
        entries.push({ nodeId: source.id, name: source.data.name, role: ref.role, depth: item.depth + 1 })
        next.push({ id: source.id, role: ref.role, depth: item.depth + 1 })
      }
    }
    queue = next
  }
  return entries
}

/** 血脉链的紧凑中文文本：`图A(首帧)、图B(参考图) ← 图C(首帧)`（按深度分组，空链 = ''） */
export function formatLineageText(entries: readonly LineageEntry[]): string {
  if (entries.length === 0) return ''
  const byDepth = new Map<number, string[]>()
  for (const entry of entries) {
    const label = entry.role ? `${entry.name}(${REF_ROLE_LABEL[entry.role]})` : entry.name
    const group = byDepth.get(entry.depth) ?? []
    group.push(label)
    byDepth.set(entry.depth, group)
  }
  return [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, labels]) => labels.join('、'))
    .join(' ← ')
}
