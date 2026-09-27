import type { ChatContextBreakdownInfo, ChatContextBucket } from '../../shared/ipc'

/**
 * 上下文占用分布的分桶估算（计划 T3）——纯函数，pi 的估算函数由调用方注入。
 *
 * 为什么不用 pi 的 estimateContextTokens：它未在包根导出（只有 compaction 内部
 * 可见），而本模块必须能在纯 Node 自检里跑（scripts/context-breakdown-check.mjs）。
 * 这里按 compaction.js:131-156 的语义本地复刻校准总量，分桶则按同一 chars/4
 * 与「图片块恒 1200 token」的口径逐 entry 归类——两者相减的差值进「未归因」桶，
 * 包含系统提示词、工具定义与估算误差，如实命名，不臆造精确值。
 *
 * 输入是「当前分支、压缩后视图」的 entries（SessionManager.buildContextEntries 的
 * 产物，由 host 传入）：压缩点之前的旧 entry 不在其中，自然不计入分布。
 */

/** pi 的估算口径：图片块恒按 4800 字符 = 1200 token 计（compaction.js ESTIMATED_IMAGE_CHARS/4） */
const IMAGE_TOKENS = 1200

/** 工具桶按工具名细分的上限 */
const TOOL_TOP_N = 5

export interface BreakdownDeps {
  /** pi 包根导出的 estimateTokens：chars/4 启发式，图片块按 1200 token */
  estimateTokens: (message: unknown) => number
  /** pi 包根导出的 calculateContextTokens：usage → 上下文 token */
  calculateContextTokens: (usage: unknown) => number
}

interface BucketAccumulator {
  user: number
  assistantText: number
  thinking: number
  toolCall: number
  toolResult: number
  images: number
  imageCount: number
  compaction: number
  toolCallByName: Map<string, number>
  toolResultByName: Map<string, number>
  latestCompactionSummary?: string
}

function ceilDiv4(chars: number): number {
  return Math.ceil(chars / 4)
}

/** content 里 text 块的总字符数（pi 的 estimateTextAndImageContentChars，去掉图片部分） */
function textChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content) {
    const typed = block as { type?: string; text?: string } | null
    if (typed?.type === 'text' && typeof typed.text === 'string') chars += typed.text.length
  }
  return chars
}

/** content 里 image 块的数量 */
function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content) {
    if ((block as { type?: string } | null)?.type === 'image') count += 1
  }
  return count
}

/** 安全的 JSON 长度（pi 的 estimateTokens 对 toolCall 直接 stringify，这里防循环引用） */
function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/** assistant 消息逐块归类（text/thinking/toolCall 三类，与 pi 的 usage 估算口径一致） */
function estimateAssistantBlocks(
  content: unknown,
  acc: BucketAccumulator
): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    const typed = block as {
      type?: string
      text?: string
      thinking?: string
      name?: string
      arguments?: unknown
    } | null
    if (!typed || typeof typed !== 'object') continue
    if (typed.type === 'text' && typeof typed.text === 'string') {
      acc.assistantText += ceilDiv4(typed.text.length)
    } else if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
      acc.thinking += ceilDiv4(typed.thinking.length)
    } else if (typed.type === 'toolCall') {
      const name = typeof typed.name === 'string' ? typed.name : 'unknown'
      const tokens = ceilDiv4(name.length + jsonLength(typed.arguments))
      acc.toolCall += tokens
      acc.toolCallByName.set(name, (acc.toolCallByName.get(name) ?? 0) + tokens)
    }
  }
}

function bumpTools(map: Map<string, number>, name: string, tokens: number): void {
  map.set(name, (map.get(name) ?? 0) + tokens)
}

function topTools(map: Map<string, number>): Array<{ name: string; tokens: number }> | undefined {
  if (map.size === 0) return undefined
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOOL_TOP_N)
    .map(([name, tokens]) => ({ name, tokens }))
}

/**
 * 本地复刻 estimateContextTokens 的校准语义（compaction.js:131-156）：
 * 末条有效 assistant usage（非 aborted/error 且 contextTokens>0）的
 * calculateContextTokens + 其后全部消息的 estimateTokens 之和。
 * 没有任何有效 usage 时返回 null（无从校准，不硬编一个总数）。
 */
function calibratedTotal(entries: readonly unknown[], deps: BreakdownDeps): number | null {
  let lastUsageIndex = -1
  let usageTokens = 0
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as { type?: string; message?: { role?: string; stopReason?: string; usage?: unknown } } | null
    if (entry?.type !== 'message') continue
    const message = entry.message
    if (message?.role !== 'assistant') continue
    if (message.stopReason === 'aborted' || message.stopReason === 'error') continue
    // 无 usage 的 assistant（流式中间态/旧数据）跳过——pi 的 getLastAssistantUsageInfo 同样守卫
    if (!message.usage) continue
    const tokens = deps.calculateContextTokens(message.usage)
    if (tokens > 0) {
      lastUsageIndex = i
      usageTokens = tokens
    }
  }
  if (lastUsageIndex < 0) return null
  let trailing = 0
  for (let i = lastUsageIndex + 1; i < entries.length; i += 1) {
    const entry = entries[i] as { type?: string; message?: unknown; summary?: unknown } | null
    if (entry?.type === 'message' && entry.message) {
      trailing += deps.estimateTokens(entry.message)
    } else if (entry && (entry.type === 'compaction' || entry.type === 'branch_summary')) {
      // 视图里的压缩/分支摘要 entry 会以 compactionSummary/branchSummary 消息形态
      // 进模型上下文，pi 按 summary.length/4 估算——保持同一口径
      trailing += ceilDiv4(typeof entry.summary === 'string' ? entry.summary.length : 0)
    }
  }
  return usageTokens + trailing
}

/**
 * 分桶估算。桶合计与校准总量的差值进 unattributed（可为负：桶口径偏大时如实呈现，
 * UI 对 ≤0 的未归因桶不渲染）。
 */
export function computeContextBreakdown(
  entries: readonly unknown[],
  deps: BreakdownDeps,
  contextWindow?: number | null
): ChatContextBreakdownInfo {
  const acc: BucketAccumulator = {
    user: 0,
    assistantText: 0,
    thinking: 0,
    toolCall: 0,
    toolResult: 0,
    images: 0,
    imageCount: 0,
    compaction: 0,
    toolCallByName: new Map(),
    toolResultByName: new Map()
  }

  for (const raw of entries) {
    const entry = raw as {
      type?: string
      message?: {
        role?: string
        content?: unknown
        toolName?: string
      }
      summary?: unknown
    } | null
    if (!entry || typeof entry !== 'object') continue

    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      if (typeof entry.summary === 'string' && entry.summary.length > 0) {
        acc.compaction += ceilDiv4(entry.summary.length)
        acc.latestCompactionSummary = entry.summary
      }
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue

    const message = entry.message
    if (message.role === 'user') {
      acc.user += ceilDiv4(textChars(message.content))
      acc.imageCount += imageCount(message.content)
    } else if (message.role === 'assistant') {
      estimateAssistantBlocks(message.content, acc)
    } else if (message.role === 'toolResult') {
      const tokens = ceilDiv4(textChars(message.content))
      acc.toolResult += tokens
      const name = typeof message.toolName === 'string' ? message.toolName : 'unknown'
      bumpTools(acc.toolResultByName, name, tokens)
      const count = imageCount(message.content)
      acc.imageCount += count
    }
    // bashExecution / custom 等角色不进桶，差值由校准侧吸收进 unattributed
  }
  acc.images = acc.imageCount * IMAGE_TOKENS

  const total = calibratedTotal(entries, deps)
  const buckets: ChatContextBucket[] = []
  const push = (
    key: ChatContextBucket['key'],
    tokens: number,
    extra?: Partial<ChatContextBucket>
  ): void => {
    buckets.push({ key, tokens, share: 0, ...extra })
  }
  push('user', acc.user)
  push('assistant_text', acc.assistantText)
  push('thinking', acc.thinking)
  const callTop = topTools(acc.toolCallByName)
  const resultTop = topTools(acc.toolResultByName)
  push('tool_call', acc.toolCall, callTop ? { tools: callTop } : undefined)
  push('tool_result', acc.toolResult, resultTop ? { tools: resultTop } : undefined)
  if (acc.imageCount > 0) push('images', acc.images, { images: acc.imageCount })
  push(
    'compaction',
    acc.compaction,
    acc.latestCompactionSummary
      ? {
          summary:
            acc.latestCompactionSummary.length > 2000
              ? `${acc.latestCompactionSummary.slice(0, 2000)}…`
              : acc.latestCompactionSummary
        }
      : undefined
  )

  const bucketSum = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)
  const unattributed = total === null ? null : total - bucketSum
  push('unattributed', unattributed ?? 0)

  const denominator = total !== null && total > 0 ? total : bucketSum
  for (const bucket of buckets) {
    bucket.share = denominator > 0 ? bucket.tokens / denominator : 0
  }
  return {
    buckets: buckets.filter((bucket) => bucket.tokens !== 0 || bucket.key === 'unattributed'),
    totalTokens: total,
    contextWindow: typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null
  }
}
