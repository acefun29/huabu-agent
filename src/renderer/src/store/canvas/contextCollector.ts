import type { AssetLibrary } from '@shared/ipc'
import type { AssetData, AssetGen, CanvasNode, MessageAttachment } from '../../types'
import { assetAbsPath } from '../../harness/assetCategories'
import { CANVAS_DIGEST_HEADER, DIGEST_UNCHANGED_NOTE, LIBRARY_DIGEST_HEADER } from '@shared/injection'

/**
 * 每轮发送前的上下文采集（T8 从 sendMessage 抽出；T9/T10/T11 的落点）。
 *
 * 引用契约（T1 裁决）：素材只发绝对路径、文件内容不随消息携带；本模块是
 * 「这轮对话带什么上下文」的**唯一组装口**，全部产物逐轮动态注入
 * （拼进 outbound 消息文本），不进静态系统提示词：
 *
 * - 引用载荷（attachments）：画布选中/已注入卡片 + 临时上传 inbox 文件；
 *   带生成状态的卡片携带结构化 genSummary（T11：当前版本产物路径 + 提示词 +
 *   参数 + 版本数），配合 read_media 让 Agent 能看自己产出的图；
 * - 素材库摘要（T9）：库名 + 文件相对路径，条数上限 + 截断；
 * - 画布态势摘要（T10）：卡片清单（类型/路径/选中态/生成状态与参数），
 *   含尚未产出产物的生成卡片（它们进不了引用载荷，但 Agent 应当知道它们存在）。
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
}

export interface RoundContextInput extends MessageContextInput {
  /** 素材库清单（store.libraries 快照；随 asset:changed 即时刷新） */
  libraries: AssetLibrary[]
  /** 上轮注入的完整摘要全文（逐轮去重：与本轮全文一致则折叠为占位行；缺省 = 首轮，发全文） */
  previousDigests?: { library?: string; canvas?: string }
  /** 上轮已携带的 genSummary 签名表（卡片 id → 签名；缺省 = 首轮，全部携带） */
  genSummarySeen?: Record<string, string>
}

export interface CollectedRoundContext {
  /** 随消息载荷发送的附件（仅路径；顺序 = 工作区素材在前、临时上传在后） */
  attachments: MessageAttachment[]
  /** T9 素材库摘要 + T10 画布态势，拼进消息尾部；两者皆空时为空串（零冗余注入）。
   * 与上轮全文一致的段折叠为「头 + DIGEST_UNCHANGED_NOTE」单行占位（token 经济） */
  contextText: string
  /** 本轮两段摘要的**完整全文**（供调用方存为下轮的 previousDigests；存全量而非占位） */
  digests: { library: string; canvas: string }
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

export function collectRoundContext(input: RoundContextInput): CollectedRoundContext {
  const assetNodes = Array.from(new Set([...input.selectedAssetIds, ...input.injectedAssetIds]))
    .map((id) => input.nodes.find((n) => n.id === id))
    .filter((n): n is CanvasNode => Boolean(n))
  // genSummary 逐轮去重（token 经济）：签名与上轮一致的卡片不再重复携带括注；
  // 签名表输出整表交由调用方存回，只含本轮仍在附件集合里的卡片（离场即出局）
  const seenGenSigs = input.genSummarySeen ?? {}
  const carriedGenSigs: Record<string, string> = {}
  const attachments: MessageAttachment[] = [
    ...assetNodes
      .map((n) => ({ nodeId: n.id, data: n.data }))
      .filter(({ data }) => Boolean(data.path) && Boolean(data.storage))
      .flatMap(({ nodeId, data }) => {
        // 解析口径唯一：media 形态的 path 相对产物目录（见 AssetData.pathRoot），
        // 直接按工作区根拼会得出 <工作区>/<裸文件名>，Agent 侧只表现为"引用文件不存在"
        const absPath = assetAbsPath(data, input.workspaceDir)
        if (!absPath) return []
        const genSig = data.gen ? genSummarySignature(data.gen) : undefined
        if (genSig !== undefined) carriedGenSigs[nodeId] = genSig
        return [
          {
            id: `att-${crypto.randomUUID()}`,
            name: data.name,
            kind: data.kind,
            absPath,
            origin: 'workspace-asset' as const,
            // T11：生成卡片的产物回喂——Agent 拿到的不只是一个路径，还有这张卡片的
            // 来龙去脉；签名与上轮一致时省去 genSummary 括注（未变内容不逐轮重复计 token）
            ...(data.gen && seenGenSigs[nodeId] !== genSig ? { genSummary: genSummaryFor(data) } : {})
          }
        ]
      }),
    ...input.tempAttachments
  ]
  const libraryDigest = buildLibraryDigest(input.libraries, input.workspaceDir)
  const canvasDigest = buildCanvasDigest(input.nodes, input.selectedAssetIds, input.injectedAssetIds)
  // 摘要逐轮去重（token 经济）：与上轮全文一致的段折叠为「头 + 未变化后缀」单行占位
  // （占位行仍以头前缀开头，isInjectionHeaderLine 按前缀匹配，回放拆分无需感知）；
  // digests 出参始终存本轮全文，供调用方作为下轮的 previousDigests
  const prev = input.previousDigests
  const libraryPart =
    libraryDigest !== '' && libraryDigest === prev?.library
      ? `${LIBRARY_DIGEST_HEADER}${DIGEST_UNCHANGED_NOTE}`
      : libraryDigest
  const canvasPart =
    canvasDigest !== '' && canvasDigest === prev?.canvas
      ? `${CANVAS_DIGEST_HEADER}${DIGEST_UNCHANGED_NOTE}`
      : canvasDigest
  const contextText = [libraryPart, canvasPart].filter(Boolean).join('\n\n')
  return {
    attachments,
    contextText,
    digests: { library: libraryDigest, canvas: canvasDigest },
    genSummarySeen: carriedGenSigs
  }
}

/* ---------------- T11：生成卡片的产物回喂摘要 ---------------- */

const GEN_STATUS_LABEL: Record<AssetGen['status'], string> = {
  idle: '待生成',
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败'
}

function genSummaryFor(d: AssetData): string {
  const gen = d.gen!
  const params: string[] = [`比例 ${gen.params.ratio}`]
  if (gen.params.durationSeconds) params.push(`${gen.params.durationSeconds}s`)
  if (gen.params.model) params.push(`模型 ${gen.params.model}`)
  return [
    `生成卡片「${d.name}」：${GEN_STATUS_LABEL[gen.status] ?? gen.status}`,
    gen.prompt ? `提示词"${gen.prompt.slice(0, 80)}"` : '（无提示词）',
    params.join(' · '),
    `共 ${gen.versions.length} 版，当前版本即本附件`,
    gen.versions.length > 1 ? '历史版本也在工作目录内，可按需读取' : ''
  ]
    .filter(Boolean)
    .join('，')
}

/**
 * genSummary 的去重签名（逐轮 token 经济）：`状态|版本数|提示词`，覆盖 Agent 关心的
 * 三类变化——状态流转（生成中→已完成）、版本追加、提示词改写；比例/模型等参数
 * 微调不触发重发（genSummary 里的参数段随状态段一起出现，单独变化不值得重发整段）。
 */
function genSummarySignature(gen: AssetGen): string {
  return `${gen.status}|${gen.versions.length}|${gen.prompt}`
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
 * 当前画布上有什么卡片（类型/路径/选中态/生成状态与参数）。选中/注入集合负责
 * "用户正在指哪张"——「把选中的这张垫给下一张」类指代靠它成立；空画布返回空串。
 */
export function buildCanvasDigest(
  nodes: CanvasNode[],
  selectedAssetIds: string[],
  injectedAssetIds: string[]
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
    if (d.gen) {
      const gen = d.gen
      tags.push(GEN_STATUS_LABEL[gen.status] ?? gen.status)
      const loc = d.path ? `${d.path}` : '（尚无产物）'
      lines.push(
        `- 卡片「${d.name}」（${kindLabel(d.kind)}，${loc}，${tags.join('，')}${gen.prompt ? `，提示词"${gen.prompt.slice(0, 60)}"` : ''}，参考 ${gen.refs.length} 张，${gen.versions.length} 版）`
      )
    } else {
      lines.push(`- 卡片「${d.name}」（${kindLabel(d.kind)}，${d.path ?? '（无路径）'}${tags.length > 0 ? `，${tags.join('，')}` : ''}）`)
    }
  }
  const rest = nodes.length - shown.length
  if (rest > 0) lines.push(`-（另有 ${rest} 张卡片未列出）`)
  return lines.join('\n')
}

function kindLabel(kind: AssetData['kind']): string {
  const table: Record<string, string> = { image: '图片', video: '视频', audio: '音频', doc: '文档', code: '代码', other: '文件' }
  return table[kind] ?? kind
}
