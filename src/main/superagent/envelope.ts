/**
 * 专家信封（Envelope，Mastra 迁移计划 v1.2 §7.4/§9.3，SuperAgent Phase 4 基础）。
 *
 * 专家不继承主会话全文：只拿信封 + 允许的资产切片（引用，不含 bytes）。
 * 资产切片有硬上限（budget.maxRefs），超出按「角色/场景 > 道具 > 上一版 > 风格/参考」
 * 裁剪并记录丢弃原因（可观测，不是黑盒）。
 */

/** 资产引用（计划 §7.4 AssetRef 的引用子集：绝不携带文件内容） */
export interface EnvelopeAssetRef {
  assetId: string
  path: string
  version: string
  kind: 'image' | 'video' | 'audio' | 'text'
  role: 'character' | 'location' | 'prop' | 'style' | 'previous_take' | 'reference'
  status: 'active' | 'stale' | 'pending'
  width?: number
  height?: number
  durationS?: number
}

export interface Envelope {
  taskId: string
  scope: string
  /** 承担任务的专家 id（board 投影与事件总线按它归组；缺省由编排层回落默认专家） */
  expert?: string
  promptLayers: { level: string; prompt: string }[]
  /** 出场角色/场景/道具 */
  entities: EnvelopeAssetRef[]
  /** 邻接镜/上一版 */
  adjacent: EnvelopeAssetRef[]
  negative: string[]
  accept: string[]
  /** 允许写的路径前缀（lane 白名单，专家写区） */
  lane: string[]
  budget: { maxRefs: number; maxTokens: number }
}

/** 裁剪优先级：数字越大越先保留（character/location > prop > 上一版 > style/reference） */
const ROLE_PRIORITY: Record<EnvelopeAssetRef['role'], number> = {
  character: 6,
  location: 5,
  prop: 4,
  previous_take: 3,
  style: 2,
  reference: 1,
}

export interface ClampResult {
  envelope: Envelope
  /** 被裁掉的引用及原因（进 journal / tracing，裁剪可观测） */
  dropped: { assetId: string; reason: string }[]
  /** 预检拒绝注入的引用（计划 §8.4：stale/missing 不进生成） */
  rejected: { assetId: string; reason: string }[]
}

/**
 * 信封预检 + 裁剪（纯函数）：
 * 1. stale/pending 引用拒绝注入（模型不得基于过期/未就绪版本生成）；
 * 2. entities+adjacent 合并后超 budget.maxRefs 按 ROLE_PRIORITY 裁剪（稳定序）；
 * 3. accept 标准是字符串数组，不占 maxRefs 份额。
 */
export function clampEnvelope(input: Envelope): ClampResult {
  const dropped: ClampResult['dropped'] = []
  const rejected: ClampResult['rejected'] = []

  const usableEntities: EnvelopeAssetRef[] = []
  const usableAdjacent: EnvelopeAssetRef[] = []
  const gate = (ref: EnvelopeAssetRef, into: EnvelopeAssetRef[]): void => {
    if (ref.status === 'stale') {
      rejected.push({ assetId: ref.assetId, reason: 'stale：资产版本已过期，需重新解析' })
      return
    }
    if (ref.status === 'pending') {
      rejected.push({ assetId: ref.assetId, reason: 'pending：资产尚未就绪' })
      return
    }
    into.push(ref)
  }
  for (const ref of input.entities) gate(ref, usableEntities)
  for (const ref of input.adjacent) gate(ref, usableAdjacent)

  const usable = [...usableEntities, ...usableAdjacent]
  const limit = Math.max(0, input.budget.maxRefs)
  if (usable.length <= limit) {
    return { envelope: { ...input, entities: usableEntities, adjacent: usableAdjacent }, dropped, rejected }
  }

  // 稳定排序：优先级降序，同优先级按原始顺序；保留下标便于回填两个列表
  const ranked = usable
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => ROLE_PRIORITY[b.ref.role] - ROLE_PRIORITY[a.ref.role] || a.index - b.index)
  const keepIndexes = new Set(ranked.slice(0, limit).map((entry) => entry.index))
  for (const entry of ranked.slice(limit)) {
    dropped.push({
      assetId: entry.ref.assetId,
      reason: `超出 maxRefs=${limit}，按角色优先级裁剪（role=${entry.ref.role}）`,
    })
  }
  return {
    envelope: {
      ...input,
      entities: usableEntities.filter((_, index) => keepIndexes.has(index)),
      adjacent: usableAdjacent.filter((_, index) => keepIndexes.has(usableEntities.length + index)),
    },
    dropped,
    rejected,
  }
}
