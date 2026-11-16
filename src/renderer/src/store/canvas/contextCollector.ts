import type { AssetLibrary, ProjectSnapshot } from '@shared/ipc'
import type { AssetData, CanvasNode, MessageAttachment } from '../../types'
import { assetAbsPath } from '../../harness/assetCategories'
import { activeVersionOf, deriveLineage, formatLineageText, getCardReferences } from '../../lib/mediaReferenceGraph'
import {
  CANVAS_DIGEST_HEADER,
  DIGEST_UNCHANGED_NOTE,
  LIBRARY_DIGEST_HEADER,
  PROJECT_DIGEST_HEADER,
  QUEUE_DIGEST_HEADER,
  SCOPE_DIGEST_HEADER
} from '@shared/injection'

/**
 * 每轮发送前的上下文采集（T8 从 sendMessage 抽出；T9/T10/T11 的落点）。
 *
 * 引用契约（T1 裁决）：素材只发绝对路径、文件内容不随消息携带；本模块是
 * 「这轮对话带什么上下文」的**唯一组装口**，全部产物逐轮动态注入
 * （拼进 outbound 消息文本），不进静态系统提示词：
 *
 * - 引用载荷（attachments）：画布选中/已注入卡片 + 临时上传 inbox 文件；
 *   带生成历史的卡片携带结构化 genSummary（激活版本提示词/参数 + 血脉链），
 *   让人和 Agent 都能知晓引用链条（生成事实的只读投影）；
 * - 素材库摘要（T9）：库名 + 文件相对路径，条数上限 + 截断；
 * - 画布态势摘要（T10）：卡片清单（类型/路径/选中态/生成历史与血脉），
 *   含生成中的占位卡（它们进不了引用载荷，但 Agent 应当知道它们存在）。
 *
 * 纯函数：输入是发送瞬间的状态快照，输出是附件与注入文本；不做 IPC、不读 store，
 * 因此能被 Node 自检直接断言（scripts/context-digest-check.mjs）。逐轮去重（token
 * 经济）所需的跨轮状态（上轮摘要全文 / 已携带的 genSummary 签名）同样全部由调用方
 * 传入、经出参整表交还，本模块不持有任何跨轮记忆。
 */

export interface MessageContextInput {
  /** 画布上当前选中的卡片（发送时固化为「已注入」） */
  selectedAssetIds: string[]
  /** 历史轮次注入后保留的 chip（既成事实，持续引用） */
  injectedAssetIds: string[]
  /** 画布节点（按 id 找卡片数据；调用方传发送瞬间的 nodes） */
  nodes: CanvasNode[]
  /** 拖进输入框的临时文件（inbox 绝对路径，工作区之外） */
  tempAttachments: MessageAttachment[]
  /** 工作区根（media 形态卡片解析绝对路径用） */
  workspaceDir: string
  /** 卡片的生成运行态（jobStates 快照：画布态势里标注生成中的占位卡） */
  jobStates?: Record<string, { status: string; progress: number; error?: string }>
}

export interface RoundContextInput extends MessageContextInput {
  /** 素材库清单（store.libraries 快照；随 asset:changed 即时刷新） */
  libraries: AssetLibrary[]
  /** 项目结构快照（常驻段/轮换段来源；未打开或没有项目时省略） */
  project?: ProjectSnapshot | null
  /** 任务板投影（队列段来源：attention 队列 + 最近任务；没有派过单时省略） */
  taskBoard?: ContextTaskBoard | null
  /** 上轮注入的完整摘要全文（逐轮去重：与本轮全文一致则折叠为占位行；缺省 = 首轮，发全文） */
  previousDigests?: { library?: string; canvas?: string; project?: string; scope?: string; queue?: string }
  /** 上轮已携带的 genSummary 签名表（卡片 id → 签名；缺省 = 首轮，全部携带） */
  genSummarySeen?: Record<string, string>
  /** 本轮注入文本的字符预算（缺省 CONTEXT_CHAR_BUDGET_DEFAULT；调用方按会话 contextWindow 派生） */
  charBudget?: number
}

/** 队列段输入（只取渲染端需要的字段，避免把 IPC 类型灌进纯函数） */
export interface ContextTaskBoard {
  tasks: Array<{
    taskId: string
    status: string
    title?: string
    scope?: string
    expert?: string
    attempts: number
    lastReason?: string
    /** 用户直连专家改过需求的时刻（有值 = 投影里的 prompt/accept 已是新版） */
    requirementChangedAt?: string
  }>
  runningTaskIds: string[]
}

export interface ContextSegments {
  /** 常驻：项目身份 + 层级结构 + 实体索引（变化极少） */
  resident: string
  /** 轮换：当前 scope 的子节点 + 面包屑 + 聚合统计 */
  rotating: string
  /** 队列：attention 待处理 + 在跑 + 最近完成 */
  queue: string
  /** 注入：素材库清单 + 画布态势（原有两段，语义不变） */
  injected: string
}

export interface CollectedRoundContext {
  /** 随消息载荷发送的附件（仅路径；顺序 = 工作区素材在前、临时上传在后） */
  attachments: MessageAttachment[]
  /** 因单轮附件上限被丢弃的引用数（>0 时载荷里会带一行说明） */
  attachmentOverflow: number
  /** 四段装配后的上下文文本（常驻 → 轮换 → 队列 → 注入），拼进消息尾部。
   * 与上轮全文一致的段折叠为「头 + DIGEST_UNCHANGED_NOTE」单行占位（token 经济） */
  contextText: string
  /** 分段结果（调试/自检用；注入了占位行之后的最终形态） */
  segments: ContextSegments
  /**
   * 本轮各段**真正发出去**的完整全文（供调用方存为下轮的 previousDigests）。
   * 因预算整段省略的段**不写入**——没送达就不能记成「已发」，否则下一轮会把它
   * 折叠成「与上轮一致」的占位行，模型永远拿不到全文（与 B4 同一条纪律）。
   */
  digests: { library?: string; canvas?: string; project?: string; scope?: string; queue?: string }
  /** 本轮已携带的 genSummary 签名表（卡片 id → 签名；只含当前仍在附件集合里的卡片，
   * 调用方整表存回，离场的卡片自然出局） */
  genSummarySeen: Record<string, string>
}

/* ---------------- 截断预算（T9/T10 共用，防上下文被清单吃掉） ---------------- */

/** 每库最多列出的文件数，超出折叠为「另有 N 个」 */
export const LIBRARY_DIGEST_FILES_PER_LIB = 8
/** 最多列出的库数（含内置画布素材库），超出折叠 */
export const LIBRARY_DIGEST_MAX_LIBS = 12
/** 画布态势最多列出的卡片数，超出折叠 */
export const CANVAS_DIGEST_MAX_CARDS = 30

/**
 * 单轮注入文本的字符预算（B2）。
 *
 * 为什么需要除了条数上限之外的总量上限：条数上限只管「每类最多几条」，
 * 而单条内容没有上界（长路径、长标题、长 genSummary），且四段是叠加的——
 * 极端情况下注入文本会吃掉大半个窗口。真到了那一步，`TokenLimiterProcessor`
 * 会对整个 prompt 做 best-fit 裁剪，单条超预算直接 TripWire，请求直接失败。
 * 按 chars/2.5 的保守比例估算 token：20000 字 ≈ 8000 tokens。
 */
export const CONTEXT_CHAR_BUDGET_DEFAULT = 20_000
/** 单轮附件上限：`injectedAssetIds` 会跨轮累积（取消选中后 chip 仍保留），必须封顶 */
export const MAX_ROUND_ATTACHMENTS = 40

/** 各段的落盘头（省略占位行必须以本段头开头，否则主进程回放拆分认不出来） */
const SEGMENT_HEADER: Record<keyof ContextSegments, string> = {
  resident: PROJECT_DIGEST_HEADER,
  rotating: SCOPE_DIGEST_HEADER,
  queue: QUEUE_DIGEST_HEADER,
  injected: LIBRARY_DIGEST_HEADER
}

/**
 * 总量预算裁剪：按「注入 → 常驻 → 轮换」的顺序整段省略，队列段永不舍弃
 * （那是等主 Agent 决策的 attention/blocked，丢掉就等于让它继续瞎猜）。
 * 省略后换成同样以段头开头的单行说明，回放拆分与「未变化」折叠都无需感知。
 */
function applyCharBudget(
  segments: ContextSegments,
  budget: number
): { segments: ContextSegments; omitted: Array<keyof ContextSegments> } {
  const order: Array<keyof ContextSegments> = ['injected', 'resident', 'rotating']
  let next = { ...segments }
  const omitted: Array<keyof ContextSegments> = []
  const total = () => next.resident.length + next.rotating.length + next.queue.length + next.injected.length
  for (const key of order) {
    if (total() <= budget) break
    const text = next[key]
    if (!text) continue
    omitted.push(key)
    next = {
      ...next,
      [key]: `${SEGMENT_HEADER[key]}（本轮因上下文预算省略 ${text.length} 字；需要时请聚焦到更小的范围再问）`
    }
  }
  // 兜底：三段都省掉还超（只会发生在队列段本身异常膨胀时），硬截断
  const joined = [next.resident, next.rotating, next.queue, next.injected].filter(Boolean).join('\n\n')
  if (joined.length > budget) {
    next.queue = `${next.queue.slice(0, Math.max(0, budget))}\n（上下文超预算，已截断）`
  }
  return { segments: next, omitted }
}

export function collectRoundContext(input: RoundContextInput): CollectedRoundContext {
  const assetNodes = Array.from(new Set([...input.selectedAssetIds, ...input.injectedAssetIds]))
    .map((id) => input.nodes.find((n) => n.id === id))
    .filter((n): n is CanvasNode => Boolean(n))
  // genSummary 逐轮去重（token 经济）：签名与上轮一致的卡片不再重复携带括注；
  // 签名表输出整表交由调用方存回，只含本轮仍在附件集合里的卡片（离场即出局）
  const seenGenSigs = input.genSummarySeen ?? {}
  const carriedGenSigs: Record<string, string> = {}
  const allAttachments: MessageAttachment[] = [
    ...assetNodes      .map((n) => ({ nodeId: n.id, data: n.data }))
      .filter(({ data }) => Boolean(data.path) && Boolean(data.storage))
      .flatMap(({ nodeId, data }) => {
        // 解析口径唯一：media 形态的 path 相对产物目录（见 AssetData.pathRoot），
        // 直接按工作区根拼会得出 <工作区>/<裸文件名>，Agent 侧只表现为"引用文件不存在"
        const absPath = assetAbsPath(data, input.workspaceDir)
        if (!absPath) return []
        const node = input.nodes.find((n) => n.id === nodeId) as CanvasNode
        const genSig = node.data.versions?.length ? genSummarySignature(node, input.nodes) : undefined
        if (genSig !== undefined) carriedGenSigs[nodeId] = genSig
        return [
          {
            id: `att-${crypto.randomUUID()}`,
            name: data.name,
            kind: data.kind,
            absPath,
            origin: 'workspace-asset' as const,
            // 生成历史回喂：Agent 拿到的不只是一个路径，还有这张卡片的来龙去脉与血脉链
            //（引用卡片进上下文即携带血缘信息，人与 Agent 都能知晓引用链条）；
            // 签名与上轮一致时省去 genSummary 括注（未变内容不逐轮重复计 token）
            ...(node.data.versions?.length && seenGenSigs[nodeId] !== genSig
              ? { genSummary: genSummaryFor(node, input.nodes) }
              : {})
          }
        ]
      }),
    ...input.tempAttachments
  ]
  // 单轮附件封顶（B2）：`injectedAssetIds` 跨轮累积（取消选中后 chip 仍保留），
  // 不封顶的话引用载荷会随会话时长单调膨胀，最终把窗口吃掉
  const attachments = allAttachments.slice(0, MAX_ROUND_ATTACHMENTS)
  const attachmentOverflow = allAttachments.length - attachments.length
  const libraryDigest = buildLibraryDigest(input.libraries, input.workspaceDir)
  const canvasDigest = buildCanvasDigest(input.nodes, input.selectedAssetIds, input.injectedAssetIds, input.jobStates)
  // 四段装配（架构图 to-be ①）：常驻 / 轮换 / 队列 / 注入。
  // 前两段来自项目结构快照（project.json 的投影），第三段来自任务板（journal 的投影），
  // 第四段是原有的素材库 + 画布两段（语义与逐轮去重机制不变）。
  const projectDigest = buildProjectDigest(input.project ?? null)
  const scopeDigest = buildScopeDigest(input.project ?? null)
  const queueDigest = buildQueueDigest(input.taskBoard ?? null)
  // 摘要逐轮去重（token 经济）：与上轮全文一致的段折叠为「头 + 未变化后缀」单行占位
  // （占位行仍以头前缀开头，isInjectionHeaderLine 按前缀匹配，回放拆分无需感知）；
  // digests 出参始终存本轮全文，供调用方作为下轮的 previousDigests
  const prev = input.previousDigests
  const fold = (digest: string, header: string, previous: string | undefined): string =>
    digest !== '' && digest === previous ? `${header}${DIGEST_UNCHANGED_NOTE}` : digest
  const segments: ContextSegments = {
    resident: fold(projectDigest, PROJECT_DIGEST_HEADER, prev?.project),
    rotating: fold(scopeDigest, SCOPE_DIGEST_HEADER, prev?.scope),
    queue: fold(queueDigest, QUEUE_DIGEST_HEADER, prev?.queue),
    injected: [
      fold(libraryDigest, LIBRARY_DIGEST_HEADER, prev?.library),
      fold(canvasDigest, CANVAS_DIGEST_HEADER, prev?.canvas)
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  // 总量预算（B2）：四段叠加后的字符上限，超出按「注入 → 常驻 → 轮换」整段省略
  const { segments: finalSegments, omitted } = applyCharBudget(
    segments,
    input.charBudget ?? CONTEXT_CHAR_BUDGET_DEFAULT
  )
  const contextText = [
    finalSegments.resident,
    finalSegments.rotating,
    finalSegments.queue,
    finalSegments.injected
  ]
    .filter(Boolean)
    .join('\n\n')
  // 只有真正发出去的段才记 digest：被预算省略的段若记成「已发」，下一轮会折叠成
  // 「与上轮一致」的占位行，而模型从未见过全文（与 B4「失败不回滚去重状态」同一条纪律）
  const delivered = (key: keyof ContextSegments): boolean => !omitted.includes(key)
  const digests: CollectedRoundContext['digests'] = {}
  if (delivered('resident')) digests.project = projectDigest
  if (delivered('rotating')) digests.scope = scopeDigest
  if (delivered('queue')) digests.queue = queueDigest
  if (delivered('injected')) {
    digests.library = libraryDigest
    digests.canvas = canvasDigest
  }
  return {
    attachments,
    attachmentOverflow,
    contextText,
    segments: finalSegments,
    digests,
    genSummarySeen: carriedGenSigs
  }
}

/* ---------------- 常驻段：项目身份 + 层级结构 + 实体索引 ---------------- */

/** 常驻段最多列出的实体节点数（只给 title + id，不含正文） */
export const PROJECT_DIGEST_MAX_ENTITIES = 40

/**
 * 常驻段（架构图 to-be ①「常驻」）：项目是什么、层级怎么分、有哪些实体。
 * 这部分变化极少，逐轮去重命中率最高——折叠后每轮只花一行 token。
 *
 * 数据源是 `snapshot.indexNodes`（**全树**轻量索引），不是 `snapshot.nodes`
 * （当前 scope 的子节点）。此前两段共用 `nodes`，下钻一次实体索引就整段变，
 * 「变化极少」的前提直接不成立，逐轮去重永远命中不了（B10）。
 *
 * 刻意不含节点正文与提示词：那些属于轮换段（当前 scope）与注入段（被引用的卡片），
 * 常驻段膨胀会让每一轮都为「不在这轮工作集里」的内容付费。
 */
export function buildProjectDigest(snapshot: ProjectSnapshot | null): string {
  if (!snapshot?.project) return ''
  const project = snapshot.project
  const lines: string[] = [
    `${PROJECT_DIGEST_HEADER}（项目「${project.name}」${project.kind ? ` · ${project.kind}` : ''}${project.tagline ? `：${project.tagline}` : ''}）`,
    `- 层级：${project.levels.map((level, index) => `${index + 1}.${level.label}（${level.plural}）`).join(' → ')}`
  ]
  // 全树索引：跨 scope 稳定，下钻不会让常驻段变脸
  const index = snapshot.indexNodes ?? []
  const containers = index.filter((node) => node.level < project.levels.length)
  const total = snapshot.projects.length
  lines.push(
    `- 项目共 ${total} 个（当前生效「${project.name}」）；本项目全树 ${index.length} 个节点` +
      `${containers.length > 0 ? `（其中 ${containers.length} 个可下钻容器）` : ''}`
  )
  // 其它项目的名字给出来：Agent 才知道「用户说的另一个项目」是否存在
  const others = snapshot.projects.filter((entry) => entry.id !== project.id).slice(0, 6)
  if (others.length > 0) {
    lines.push(`- 其它项目：${others.map((entry) => `${entry.name}${entry.summary ? `（${entry.summary}）` : ''}`).join('、')}`)
  }
  // 实体索引：title + id，供「把第3场那几个镜头…」这类指代落到具体节点
  const entities = index.slice(0, PROJECT_DIGEST_MAX_ENTITIES)
  if (entities.length > 0) {
    lines.push('- 节点索引（id → 标题 → 状态）：')
    for (const node of entities) {
      const levelLabel = project.levels[node.level - 1]?.plural ?? `L${node.level}`
      const stats = node.stats ? `，完成 ${node.stats.done}/${node.stats.total}` : ''
      lines.push(`  · ${node.id} → ${node.title}（${levelLabel}，${node.status}${stats}）`)
    }
    const rest = index.length - entities.length
    if (rest > 0) lines.push(`  ·（另有 ${rest} 个节点未列出）`)
  }
  if (snapshot.promptLayers.length > 0) {
    lines.push(
      `- 当前生效的提示词层：${snapshot.promptLayers.map((layer) => `${layer.label}${layer.prompt ? '' : '（空）'}`).join(' → ')}`
    )
  }
  return lines.join('\n')
}

/* ---------------- 轮换段：当前 scope 的子节点 + 聚合 ---------------- */

/** 轮换段最多列出的子节点数，超出折叠 */
export const SCOPE_DIGEST_MAX_NODES = 24

/**
 * 轮换段（架构图 to-be ①「轮换」）：当前 scope 下的一层 children + 面包屑。
 * scope 由调用方（当前浏览/聚焦的容器）决定；切换 scope 即换工作集，
 * 这就是「轮换」与「常驻」的区别——它按轮次自然变化，不跨轮硬留。
 */
export function buildScopeDigest(snapshot: ProjectSnapshot | null): string {
  if (!snapshot?.project) return ''
  const breadcrumb = snapshot.breadcrumb.map((crumb) => crumb.title).join(' / ')
  const depth = snapshot.breadcrumb.length - 1
  const level = snapshot.project.levels[depth]
  const lines: string[] = [
    `${SCOPE_DIGEST_HEADER}（${breadcrumb || snapshot.project.rootLabel}${level ? ` · ${level.label}层` : ''}，共 ${snapshot.nodes.length} 个子节点）`
  ]
  if (snapshot.nodes.length === 0) {
    lines.push('- 这一层还没有节点。')
    return lines.join('\n')
  }
  const shown = snapshot.nodes.slice(0, SCOPE_DIGEST_MAX_NODES)
  for (const node of shown) {
    const bits: string[] = [node.title, node.status]
    if (node.subtitle) bits.push(node.subtitle)
    const fields = Object.entries(node.fields ?? {})
      .filter(([, value]) => String(value ?? '').trim())
      .slice(0, 3)
      .map(([key, value]) => `${key}=${String(value).slice(0, 24)}`)
    if (fields.length > 0) bits.push(fields.join(' '))
    if (node.stats) bits.push(`完成 ${node.stats.done}/${node.stats.total}`)
    if (node.assetId) bits.push(`素材 ${node.assetId}`)
    lines.push(`- ${node.id}｜${bits.join('｜')}`)
  }
  const rest = snapshot.nodes.length - shown.length
  if (rest > 0) lines.push(`-（另有 ${rest} 个未列出；用 scope 聚焦到更具体的层级查看）`)
  // 提示词继承链只给「有哪些层」，正文由 Agent 在需要时通过项目工具读取（避免每轮重发）
  if (snapshot.promptLayers.length > 0) {
    lines.push(`- 提示词继承：${snapshot.promptLayers.map((layer) => layer.label).join(' → ')}`)
  }
  return lines.join('\n')
}

/* ---------------- 队列段：任务板投影 ---------------- */

/** 队列段最多列出的任务数 */
export const QUEUE_DIGEST_MAX_TASKS = 10

/**
 * 队列段（架构图 to-be ①「队列」）：需要主 Agent 处理的任务与在跑任务。
 *
 * 选型：attention（验收失败待重派）/ blocked（缺参考或越权）是「等主 Agent 决策」的，
 * 必须每轮可见；active 只报数量（具体进度看板上有，不必逐轮塞 token）；
 * done 只报最近几条，用于「上一批做完了吗」这类追问。
 */
export function buildQueueDigest(board: ContextTaskBoard | null): string {
  if (!board) return ''
  const running = new Set(board.runningTaskIds)
  const needsAction = board.tasks.filter((task) => task.status === 'attention' || task.status === 'blocked')
  const active = board.tasks.filter((task) => task.status === 'active' || task.status === 'validating')
  const done = board.tasks.filter((task) => task.status === 'done')
  if (needsAction.length === 0 && active.length === 0 && done.length === 0) return ''
  const lines: string[] = [
    `${QUEUE_DIGEST_HEADER}（共 ${board.tasks.length} 个任务${running.size > 0 ? `，${running.size} 个在跑` : ''}）`
  ]
  const shownAction = needsAction.slice(-QUEUE_DIGEST_MAX_TASKS)
  for (const task of shownAction) {
    const status = task.status === 'attention' ? '待重派' : '受阻'
    lines.push(
      `- [${status}] ${task.taskId} ${task.scope ? `· ${task.scope}` : ''}${task.title ? `「${task.title.slice(0, 40)}」` : ''}` +
        `${task.attempts > 0 ? `，已试 ${task.attempts} 次` : ''}${task.lastReason ? `，原因：${task.lastReason.slice(0, 60)}` : ''}`
    )
  }
  if (needsAction.length > shownAction.length) {
    lines.push(`-（另有 ${needsAction.length - shownAction.length} 个待处理任务）`)
  }
  if (active.length > 0) {
    const names = active
      .slice(0, 5)
      .map((task) => task.scope || task.title || task.taskId)
      .join('、')
    lines.push(`- 执行中 ${active.length} 个：${names}${active.length > 5 ? ' …' : ''}（完成后自动验收并激活版本）`)
  }
  // 用户直连专家改过需求的任务（C13）：重派前必须知道需求已变更，
  // 否则会拿投影里的旧 prompt 重做一遍。这里给出名单，细节让 Agent 调 list_tasks 取。
  const changed = board.tasks.filter((task) => task.requirementChangedAt)
  if (changed.length > 0) {
    const names = changed
      .slice(-5)
      .map((task) => `${task.taskId}${task.scope ? `·${task.scope}` : ''}`)
      .join('、')
    lines.push(`- 用户已直连改需求 ${changed.length} 个：${names}（重派前用 list_tasks 取最新 prompt/accept）`)
  }
  if (done.length > 0) {
    const recent = done.slice(-3).map((task) => task.scope || task.title || task.taskId)
    lines.push(`- 最近完成：${recent.join('、')}`)
  }
  return lines.join('\n')
}

/* ---------------- 生成历史回喂摘要（含血脉链） ---------------- */

/** 血脉段截断预算：递归祖先最多 3 层 / 8 个节点（deriveLineage 默认值同源） */
const LINEAGE_MAX_DEPTH = 3
const LINEAGE_MAX_NODES = 8

/**
 * 带生成历史卡片的回喂摘要：激活版本的提示词/参数 + 血脉链（递归祖先，
 * 防环截断）。血脉来自生成事实（版本 inputs）的只读投影，人和 Agent 都能
 * 据此知晓这张卡"从哪来"。
 */
function genSummaryFor(node: CanvasNode, nodes: readonly CanvasNode[]): string {
  const d = node.data
  const active = activeVersionOf(node)
  const inputs = active?.inputs
  const params: string[] = [inputs?.params.ratio ? `比例 ${inputs.params.ratio}` : '比例 自动']
  if (inputs?.params.durationSeconds) params.push(`${inputs.params.durationSeconds}s`)
  if (inputs?.model) params.push(`模型 ${inputs.provider}:${inputs.model}`)
  const lineage = deriveLineage(node.id, nodes, { maxDepth: LINEAGE_MAX_DEPTH, maxNodes: LINEAGE_MAX_NODES })
  const lineageText = formatLineageText(lineage)
  return [
    `「${d.name}」由${inputs ? `${inputs.provider}:${inputs.model} 生成` : '历史生成'}，${params.join(' · ')}`,
    inputs?.prompt ? `提示词"${inputs.prompt.slice(0, 80)}"` : '',
    `共 ${d.versions?.length ?? 0} 版，当前版本即本附件`,
    lineageText ? `血脉：${lineageText}` : ''
  ]
    .filter(Boolean)
    .join('，')
}

/**
 * genSummary 的去重签名（逐轮 token 经济）：`激活版本|版本数|提示词|血脉指纹`，
 * 覆盖 Agent 关心的变化——版本切换/追加、提示词改写、上游血脉更新（祖先卡
 * 再生成即换版本，指纹随之变化）；参数微调不单独触发重发。
 */
function genSummarySignature(node: CanvasNode, nodes: readonly CanvasNode[]): string {
  const active = activeVersionOf(node)
  const lineage = deriveLineage(node.id, nodes, { maxDepth: LINEAGE_MAX_DEPTH, maxNodes: LINEAGE_MAX_NODES })
  const lineageFingerprint = lineage.map((e) => `${e.nodeId}@${e.depth}`).join('|')
  return `${node.data.activeVersionId ?? active?.id ?? ''}|${node.data.versions?.length ?? 0}|${active?.inputs?.prompt ?? ''}|${lineageFingerprint}`
}

/* ---------------- T9：素材库清单摘要 ---------------- */

/**
 * 库名 + 文件相对路径（截断规则见常量）。文件给的是「库路径/文件名」形态并注明
 * 工作区根——模型引用时仍应发绝对路径（引用契约），摘要的作用是"知道库里有什么、
 * 文件大概在哪"，不是让它凭空拼路径：条目行同时给出绝对路径，可直接复制进引用。
 */
export function buildLibraryDigest(libraries: AssetLibrary[], workspaceDir: string): string {
  const usable = libraries.filter((l) => l.files.length > 0 || l.isPublic || l.builtin || l.path)
  if (usable.length === 0) return ''
  const root = workspaceDir.replace(/\/+$/, '')
  const lines: string[] = [`${LIBRARY_DIGEST_HEADER}（共 ${usable.length} 库；引用任一文件时请在消息中给出它的绝对路径）`]
  const libs = usable.slice(0, LIBRARY_DIGEST_MAX_LIBS)
  for (const lib of libs) {
    if (lib.files.length === 0) {
      lines.push(`- ${lib.name}（${lib.path}/，暂无文件）`)
      continue
    }
    const shown = lib.files.slice(0, LIBRARY_DIGEST_FILES_PER_LIB)
    for (const f of shown) {
      lines.push(`- ${lib.name} / ${f.relPath} → ${root}/${f.relPath}`)
    }
    const rest = lib.files.length - shown.length
    if (rest > 0) lines.push(`- ${lib.name}（另有 ${rest} 个文件未列出，可用 ls 查看 ${lib.path}/）`)
  }
  if (usable.length > libs.length) {
    lines.push(`-（另有 ${usable.length - libs.length} 个素材库未列出）`)
  }
  return lines.join('\n')
}

/* ---------------- T10：画布态势摘要 ---------------- */

/**
 * 当前画布上有什么卡片（类型/路径/选中态/生成历史与血脉）。选中/注入集合负责
 * "用户正在指哪张"——「把选中的这张垫给下一张」类指代靠它成立；空画布返回空串。
 */
export function buildCanvasDigest(
  nodes: CanvasNode[],
  selectedAssetIds: string[],
  injectedAssetIds: string[],
  jobStates?: Record<string, { status: string; progress: number; error?: string }>
): string {
  if (nodes.length === 0) return ''
  const selected = new Set(selectedAssetIds)
  const injected = new Set(injectedAssetIds)
  const lines: string[] = [`${CANVAS_DIGEST_HEADER}（画布上共 ${nodes.length} 张卡片；「已选中」是用户当前正在指的卡片）`]
  const shown = nodes.slice(0, CANVAS_DIGEST_MAX_CARDS)
  for (const node of shown) {
    const d = node.data
    const tags: string[] = []
    if (selected.has(node.id)) tags.push('已选中')
    else if (injected.has(node.id)) tags.push('已注入上下文')
    const runtime = jobStates?.[node.id]
    if (runtime?.status === 'queued' || runtime?.status === 'running') {
      // 生成中的占位卡：还没有产物，进不了引用载荷，但 Agent 应当知道它存在
      const pct = runtime.status === 'running' ? `（${Math.round(runtime.progress * 100)}%）` : ''
      lines.push(`- 卡片「${d.name}」（${kindLabel(d.kind)}，生成中${pct}，${tags.join('，') || '无标记'}）`)
      continue
    }
    if (d.versions?.length) {
      const active = activeVersionOf(node)
      const inputs = active?.inputs
      const refs = getCardReferences(node, nodes)
      const lineageText = formatLineageText(
        deriveLineage(node.id, nodes, { maxDepth: LINEAGE_MAX_DEPTH, maxNodes: LINEAGE_MAX_NODES })
      )
      lines.push(
        `- 卡片「${d.name}」（${kindLabel(d.kind)}，${d.path ?? '（无路径）'}，${['生成产物', ...tags].join('，')}${inputs?.prompt ? `，提示词"${inputs.prompt.slice(0, 60)}"` : ''}，参考 ${refs.length} 张，共 ${d.versions.length} 版${lineageText ? `，血脉：${lineageText}` : ''}）`
      )
      continue
    }
    if (runtime?.status === 'failed') {
      lines.push(`- 卡片「${d.name}」（${kindLabel(d.kind)}，生成失败，${tags.join('，') || '无标记'}）`)
      continue
    }
    lines.push(`- 卡片「${d.name}」（${kindLabel(d.kind)}，${d.path ?? '（无路径）'}${tags.length > 0 ? `，${tags.join('，')}` : ''}）`)
  }
  const rest = nodes.length - shown.length
  if (rest > 0) lines.push(`-（另有 ${rest} 张卡片未列出）`)
  return lines.join('\n')
}

function kindLabel(kind: AssetData['kind']): string {
  const table: Record<string, string> = { image: '图片', video: '视频', audio: '音频', doc: '文档', code: '代码', other: '文件' }
  return table[kind] ?? kind
}
