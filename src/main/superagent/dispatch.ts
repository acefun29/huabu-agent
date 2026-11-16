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
  /** 承担任务的专家 id（缺省由调用方解析为默认专家） */
  expert?: string
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
    ...(intent.expert ? { expert: intent.expert } : {}),
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
  lines.push(
    '',
    '## 回执（必须遵守的格式）',
    '产物落到 lane 内之后，最后单独输出一行回执 JSON，字段名不可更改：',
    '{"artifactId":"<唯一 id>","assetId":"<可选：同一资产的后续版本填上一版的 id，首次交付可留空>","version":"<版本标记，如 v2>",' +
      '"kind":"image|video|audio|text","path":"<相对工作区的产物路径>","format":"<小写扩展名>",' +
      '"bytes":<字节数>,"width":<图片/视频宽>,"height":<高>,"durationS":<视频秒数>}',
    'artifactId、version、kind 必填；assetId 留空时系统按 artifactId 生成（不要为了填它去编造资产）。',
    '只有 path 落在 lane 内、且必填字段齐全的回执才能通过结构验收；不要省略 JSON 行，也不要用代码块包裹。'
  )
  return lines.join(String.fromCharCode(10))
}

/**
 * lane 白名单校验：写路径必须落在允许前缀内（专家写区硬约束，计划 §9.3）。
 *
 * 拒绝 `..` 段与绝对路径：此前用裸 `startsWith` 比较，`scenes/s3/../../etc/x` 能通过
 * 「前缀匹配」而在落盘时逃出写区——路径归一化在比较前完成，逃逸一律 false。
 */
export function isPathAllowed(envelope: Envelope, relativePath: string): boolean {
  const raw = relativePath.replace(/\\/g, '/').trim()
  if (!raw) return false
  // 绝对路径（Windows 盘符 / POSIX 根 / UNC）不属于工作区相对路径
  if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith('/') || raw.startsWith('//')) return false
  const segments: string[] = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      // 向上穿越：能抵消的前进段抵消，抵到根就是逃逸
      if (segments.length === 0) return false
      segments.pop()
      continue
    }
    segments.push(part)
  }
  if (segments.length === 0) return false
  const normalized = segments.join('/')
  return envelope.lane.some((prefix) => {
    const clean = prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!isWellFormedLanePrefix(clean)) return false
    return normalized === clean || normalized.startsWith(`${clean}/`)
  })
}

/**
 * lane 前缀自身的合法性（C6）。此前只归一化「被比较的路径」，前缀写什么都不校验：
 * `../etc/` 或 `C:/tmp` 这类前缀归一化后永远匹配不上，结果是**整体拒绝**（fail-closed），
 * 不会真的逃逸；但错误配置变成「永远不越界」的假象，排查时只看到任务莫名失败。
 * 显式拒绝能让派单阶段的配置错误直接暴露。
 */
function isWellFormedLanePrefix(clean: string): boolean {
  if (!clean || clean === '.') return false
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) return false
  return !clean.split('/').some((segment) => segment === '..')
}

/**
 * 从 journal 重建派单输入（A10）：重派不能只拿 scope/prompt/accept。
 *
 * `task.created` 里除了展示字段，还落了 `spec`（参考资产 / 邻接镜 / 负面约束 /
 * 分层提示 / 自定义 lane）。回放它就能得到与原始派单等价的输入；旧任务没有 spec
 * 时退化成「只有 scope/prompt/accept」——那是当时确实记下来的全部。
 *
 * 返回不含 taskId：重派要开新任务，新 id 由调用方生成。
 */
export function taskInputFromJournal(
  events: readonly { type: string; taskId: string; payload: Record<string, unknown> }[],
  taskId: string
): Omit<TaskIntent, 'taskId'> | null {
  const created = [...events].reverse().find((event) => event.taskId === taskId && event.type === 'task.created')
  if (!created) return null
  const payload = created.payload
  const scope = typeof payload.scope === 'string' ? payload.scope : ''
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
  if (!scope || !prompt) return null
  const accept = Array.isArray(payload.accept) ? payload.accept.map(String) : []
  const expert = typeof payload.expert === 'string' ? payload.expert : undefined
  const spec = (payload.spec ?? {}) as Record<string, unknown>
  /**
   * 需求变更（R05）：重派必须用**最新**需求，而不是创建时那份。
   *
   * `user.changed` 是用户直连专家改需求的唯一事实；投影（看板）已经按它更新了
   * prompt/accept，但这里此前只读 `task.created`，于是「用户改完需求再点重派」
   * 会按旧需求重做一遍。
   */
  let effectivePrompt = prompt
  let effectiveAccept = accept
  for (const event of events) {
    if (event.taskId !== taskId || event.type !== 'user.changed') continue
    const changed = event.payload
    if (typeof changed.prompt === 'string' && changed.prompt.trim()) effectivePrompt = changed.prompt
    if (Array.isArray(changed.accept)) effectiveAccept = changed.accept.map(String)
  }
  const strings = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const cleaned = value.map(String).filter((item) => item.trim())
    return cleaned.length > 0 ? cleaned : undefined
  }
  const layers = Array.isArray(spec.promptLayers)
    ? spec.promptLayers
        .filter((layer): layer is { level?: unknown; prompt?: unknown } => Boolean(layer) && typeof layer === 'object')
        .map((layer) => ({ level: String(layer.level ?? 'layer'), prompt: String(layer.prompt ?? '') }))
        .filter((layer) => layer.prompt.trim())
    : []
  const refs = (value: unknown): EnvelopeAssetRef[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const cleaned = value.filter(
      (item): item is EnvelopeAssetRef =>
        Boolean(item) && typeof item === 'object' && typeof (item as { assetId?: unknown }).assetId === 'string'
    )
    return cleaned.length > 0 ? cleaned : undefined
  }
  const lanes = strings(spec.lane)
  const negative = strings(spec.negative)
  const entities = refs(spec.entities)
  const adjacent = refs(spec.adjacent)
  return {
    scope,
    // 重派用的是「最新需求」（R05）：prompt/accept 取 user.changed 之后的值
    prompt: effectivePrompt,
    accept: effectiveAccept,
    ...(layers.length > 0 ? { promptLayers: layers } : {}),
    ...(entities ? { entities } : {}),
    ...(adjacent ? { adjacent } : {}),
    ...(negative ? { negative } : {}),
    ...(lanes ? { lane: lanes } : {}),
    ...(expert ? { expert } : {})
  }
}
