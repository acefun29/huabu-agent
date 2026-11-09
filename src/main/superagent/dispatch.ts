/**
 * 任务信封生成器（Mastra 迁移计划 v1.2 §9.3，Phase 4 编排）。
 *
 * 从「主 Agent 的派单意图 + 画布/任务上下文」生成专家可执行的信封：
 * 专家不继承主会话全文，只拿信封 + 允许的资产切片（引用，不含 bytes）。
 * 生成后立即做预检与裁剪（clampEnvelope）——stale/pending 拒绝注入、
 * 超预算按角色优先级裁剪，丢弃原因随信封一起返回（可观测）。
 */

import { clampEnvelope, type ClampResult, type Envelope, type EnvelopeAssetRef } from './envelope'

/** 派单意图（主 Agent 产出，或测试/用户直连时直接给） */
export interface TaskIntent {
  taskId: string
  /** 任务范围标识（如 `scene/s3`），进 journal 与信封 */
  scope: string
  /** 给专家的任务描述（单场/单批） */
  prompt: string
  /** prompt 分层（项目级 → 范围级 → 镜头级），越具体越靠后 */
  promptLayers?: { level: string; prompt: string }[]
  /** 必须出现的资产（角色/场景/道具） */
  entities?: EnvelopeAssetRef[]
  /** 邻接镜 / 上一版 */
  adjacent?: EnvelopeAssetRef[]
  /** 负面约束 */
  negative?: string[]
  /** 机器可判定的验收标准（比例/尺寸/时长/格式等） */
  accept: string[]
  /** 专家可写的路径前缀（lane 白名单），默认按 scope 派生 */
  lane?: string[]
  /** 预算（缺省给保守值） */
  budget?: { maxRefs: number; maxTokens: number }
}

const DEFAULT_BUDGET = { maxRefs: 8, maxTokens: 8_000 }

/**
 * 生成信封（纯函数）：intent → Envelope + 预检/裁剪结果。
 * lane 缺省从 scope 派生（`scenes/s3` → `scenes/s3/`），确保专家只能写自己的写区。
 */
export function buildEnvelope(intent: TaskIntent): ClampResult {
  const lane = intent.lane ?? [`${intent.scope.replace(/\/+$/, '')}/`]
  const envelope: Envelope = {
    taskId: intent.taskId,
    scope: intent.scope,
    promptLayers: [...(intent.promptLayers ?? []), { level: 'task', prompt: intent.prompt }],
    entities: intent.entities ?? [],
    adjacent: intent.adjacent ?? [],
    negative: intent.negative ?? [],
    accept: intent.accept,
    lane,
    budget: intent.budget ?? DEFAULT_BUDGET,
  }
  return clampEnvelope(envelope)
}

/**
 * 信封 → 专家系统提示（确定性拼装，不含主会话历史）。
 * 分层顺序固定：项目 → 范围 → 镜头 → 任务，越靠后越具体。
 */
export function envelopeToInstructions(envelope: Envelope): string {
  const lines: string[] = [
    '你是花布 SuperAgent 的专家 Agent。你只负责当前这一个任务，不读主会话，不越界。',
    '',
    '## 任务',
  ]
  for (const layer of envelope.promptLayers) {
    lines.push(`- [${layer.level}] ${layer.prompt}`)
  }
  if (envelope.negative.length) {
    lines.push('', '## 禁止', ...envelope.negative.map((item) => `- ${item}`))
  }
  if (envelope.accept.length) {
    lines.push('', '## 验收标准（机器判定，必须逐条满足）', ...envelope.accept.map((item) => `- ${item}`))
  }
  lines.push(
    '',
    '## 写区（lane）',
    `只能写入以下路径前缀，越界写入会被拒绝：${envelope.lane.join('、')}`,
    '',
    '## 资产引用',
    '只能使用下列已解析的资产引用；需要看图片内容时用 read_media 按需读取，不要臆测画面。'
  )
  const refs = [...envelope.entities, ...envelope.adjacent]
  if (refs.length === 0) {
    lines.push('- （无）')
  } else {
    for (const ref of refs) {
      lines.push(`- [${ref.role}] ${ref.assetId} @ ${ref.version} → ${ref.path}（${ref.kind}）`)
    }
  }
  lines.push('', '完成产物后，用一句话回执：产出路径 + 关键参数。不要输出无关内容。')
  return lines.join(String.fromCharCode(10))
}

/** lane 白名单校验：写路径必须落在允许前缀内（专家写区硬约束，计划 §9.3） */
export function isPathAllowed(envelope: Envelope, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  return envelope.lane.some((prefix) => normalized.startsWith(prefix.replace(/\\/g, '/')))
}
