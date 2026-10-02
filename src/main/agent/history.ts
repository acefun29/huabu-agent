import type {
  ChatCompactionDivider,
  ChatHistoryBlock,
  ChatHistoryMessage,
  ChatHistoryToolCall,
  ChatToolArgs
} from '../../shared/ipc'
import { isInjectionHeaderLine } from '../../shared/injection'
import { toResultText, toStopReason, toToolArgs } from './serialize'

/**
 * 会话 JSONL 的结构化回放解析（计划 T4）——纯函数层。
 *
 * 与旧实现的本质区别：旧 readSessionHistory 只抽 user/assistant 的纯文本，
 * 工具/thinking/图块/压缩条目全丢。这里解析全部 entry，并按 pi 的
 * buildContextEntries 语义（由调用方注入，本文件不得静态导入 pi——主进程
 * 禁止对 pi 的值导入，见 serialize.ts 头注）对齐「模型实际持有的上下文」：
 *
 * - 压缩截断/非当前分支的消息标 inContext:false（回放的核心价值）；
 * - CompactionEntry / BranchSummaryEntry 重建为压缩分隔条（与流式侧本地合成同形）；
 * - user 消息按自产文本头拆出「正文 / 本轮上下文」（三处同源常量，见 shared/injection.ts）；
 * - toolResult 按 toolCallId 配对进工具卡（status=done/error、resultText 8000 截断）；
 * - 图片块只登记槽位（HistoryImageSlot），base64 原图不出本层——缩略由 host 用
 *   nativeImage 完成后回填，本文件不知道 electron 的存在。
 */

/** 回放工具结果文本的截断上限，与流式链路的 RESULT_TEXT_LIMIT 同一量级 */
const HISTORY_RESULT_TEXT_LIMIT = 8000

/** 回放压缩摘要的截断上限 */
const HISTORY_SUMMARY_LIMIT = 2000

/** 一个待缩略的图片槽位：宿主缩略后按坐标回填到 messages 里 */
export interface HistoryImageSlot {
  /** 目标消息在 messages 数组里的下标 */
  messageIndex: number
  /** 有值 = 挂到该消息 blocks 里对应工具卡的 images；无值 = 挂到消息级 images（user 图片） */
  toolCallId?: string
  /** chip 文案：工具图片带配对 toolCall 参数里的源路径，user 图片为固定说明 */
  label: string
  /** 原图 base64（不出主进程） */
  data: string
  mimeType: string
}

export interface BuiltHistory {
  messages: ChatHistoryMessage[]
  images: HistoryImageSlot[]
}

interface ToolCallRef {
  messageIndex: number
  toolCall: ChatHistoryToolCall
}

/** 从工具参数里挑一个像路径的字符串当 chip 文案（read_media / generate_* 的源路径） */
function labelFromArgs(args: ChatToolArgs, toolName: string): string {
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.length > 0) {
      const looksLikePath = value.includes('/') || value.includes('\\')
      if (looksLikePath) return value
    }
  }
  return `工具 ${toolName} 的图片`
}

/**
 * 把用户消息文本切成「正文 / 本轮注入段」。
 *
 * 注入段由 sendMessage 逐轮拼在正文后（`\n\n` + 载荷），头部来自
 * shared/injection.ts 的自产文本头。拆分是纯文本操作：找到最早的行首注入头，
 * 之前是正文、之后整段折叠。载荷总以 `\n\n` 拼在正文后，注入头前必有空行——
 * 因此只有「前一行是空行」的注入头才认作切分点，用户正文里恰好有一行以
 * `[素材库清单]` 开头的文本（前一行非空）不会被误拆；折叠占位形态
 * （头 + 「（与上轮一致，未变化）」单行）同样按头前缀命中，无需特殊处理。
 * 正文为空（理论不该发生）时不拆，整条按正文展示。
 */
export function splitUserInjection(text: string): { body: string; contextPayload?: string } {
  if (!text) return { body: text }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!isInjectionHeaderLine(lines[i])) continue
    // 切分点收紧：注入头前必有空行（载荷以 `\n\n` 拼在正文后）；前一行非空的
    // 注入头样式的行视为用户正文的一部分，不拆
    if (i === 0 || lines[i - 1].trim() !== '') continue
    const body = lines
      .slice(0, i)
      .join('\n')
      .replace(/\n+$/, '')
    if (!body.trim()) return { body: text }
    return { body, contextPayload: lines.slice(i).join('\n') }
  }
  return { body: text }
}

/** user 消息的文本与图片块（content: string | (Text|Image)[]） */
function userContentParts(content: unknown): { text: string; images: Array<{ data: string; mimeType: string }> } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const texts: string[] = []
  const images: Array<{ data: string; mimeType: string }> = []
  for (const block of content) {
    const typed = block as { type?: string; text?: string; data?: string; mimeType?: string } | null
    if (typed?.type === 'text' && typeof typed.text === 'string') texts.push(typed.text)
    else if (typed?.type === 'image' && typeof typed.data === 'string') {
      images.push({ data: typed.data, mimeType: typeof typed.mimeType === 'string' ? typed.mimeType : 'image/png' })
    }
  }
  return { text: texts.join(''), images }
}

/**
 * 解析 JSONL 全 entry 并映射为回放消息。
 *
 * @param entries 逐行 JSON.parse 的产物（不筛类型）
 * @param buildContextEntries pi 的同名函数（包根导出）：分支路径 + 压缩截断视图
 */
export function buildSessionHistory(
  entries: readonly unknown[],
  buildContextEntries: (list: unknown[]) => unknown
): BuiltHistory {
  let view: Array<Record<string, unknown>> = []
  try {
    view = (buildContextEntries([...entries]) ?? []) as Array<Record<string, unknown>>
  } catch {
    // 视图构建失败时不放弃回放：全部按 inContext=false 处理（宁淡化不丢失）
    view = []
  }
  const contextIds = new Set(view.map((entry) => (typeof entry?.id === 'string' ? entry.id : '')))

  const messages: ChatHistoryMessage[] = []
  const images: HistoryImageSlot[] = []
  /** toolCallId → 工具卡引用（配对 toolResult 用） */
  const toolCalls = new Map<string, ToolCallRef>()

  const inContextFlag = (entryId: unknown): { inContext?: false } =>
    typeof entryId === 'string' && contextIds.has(entryId) ? {} : { inContext: false }

  for (const raw of entries) {
    const entry = (raw ?? {}) as Record<string, unknown>
    const type = entry.type

    if (type === 'compaction' || type === 'branch_summary') {
      // 压缩分界分隔条：BranchSummaryEntry 与 CompactionEntry 同形（计划 §2.1）
      const summary = typeof entry.summary === 'string' ? entry.summary : ''
      if (!summary) continue
      const divider: ChatCompactionDivider = { summary: summary.slice(0, HISTORY_SUMMARY_LIMIT) }
      if (typeof entry.tokensBefore === 'number') divider.tokensBefore = entry.tokensBefore
      if (typeof entry.estimatedTokensAfter === 'number') divider.estimatedTokensAfter = entry.estimatedTokensAfter
      messages.push({
        role: 'model',
        text: divider.summary,
        entryKind: 'compaction',
        compaction: divider,
        ...inContextFlag(entry.id)
      })
      continue
    }

    if (type !== 'message') continue // session 头 / thinking_level_change / model_change / file / custom
    const message = (entry.message ?? {}) as Record<string, unknown>
    const role = message.role

    if (role === 'user') {
      const { text, images: userImages } = userContentParts(message.content)
      if (!text.trim() && userImages.length === 0) continue
      const split = splitUserInjection(text)
      const messageIndex = messages.length
      messages.push({
        role: 'user',
        text: split.body,
        ...(split.contextPayload ? { contextPayload: split.contextPayload } : {}),
        ...inContextFlag(entry.id)
      })
      // user 图片挂消息级（用户输入里的图在 huabu 里少见，但契约上存在）
      for (const image of userImages) {
        images.push({
          messageIndex,
          label: '随消息发送的图片',
          data: image.data,
          mimeType: image.mimeType
        })
      }
      continue
    }

    if (role === 'assistant') {
      const blocks: ChatHistoryBlock[] = []
      const texts: string[] = []
      const rawContent = Array.isArray(message.content) ? message.content : []
      for (const block of rawContent) {
        const typed = block as {
          type?: string
          text?: string
          thinking?: string
          id?: string
          name?: string
          arguments?: unknown
        } | null
        if (!typed || typeof typed !== 'object') continue
        if (typed.type === 'text' && typeof typed.text === 'string') {
          texts.push(typed.text)
          blocks.push({ kind: 'text', text: typed.text })
        } else if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
          blocks.push({ kind: 'thinking', text: typed.thinking })
        } else if (typed.type === 'toolCall') {
          const toolCallId = typeof typed.id === 'string' ? typed.id : `unknown-${toolCalls.size}`
          const toolCall: ChatHistoryToolCall = {
            id: toolCallId,
            name: typeof typed.name === 'string' ? typed.name : 'unknown',
            args: toToolArgs(typed.arguments),
            // 先按 done 落位；本条结果在本文件后文配到就改写，始终没配到说明执行记录丢失
            status: 'done'
          }
          blocks.push({ kind: 'tool', toolCall })
          toolCalls.set(toolCallId, { messageIndex: messages.length, toolCall })
        }
      }
      if (blocks.length === 0) continue
      messages.push({
        role: 'model',
        text: texts.join(''),
        blocks,
        stopReason: toStopReason(message.stopReason),
        ...(typeof message.model === 'string' ? { model: message.model } : {}),
        ...inContextFlag(entry.id)
      })
      continue
    }

    if (role === 'toolResult') {
      const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      const isError = message.isError === true
      let resultText = toResultText(message)
      if (resultText.length > HISTORY_RESULT_TEXT_LIMIT) {
        resultText = `${resultText.slice(0, HISTORY_RESULT_TEXT_LIMIT)}\n…（已截断）`
      }
      const paired = toolCallId ? toolCalls.get(toolCallId) : undefined
      if (paired) {
        paired.toolCall.status = isError ? 'error' : 'done'
        paired.toolCall.resultText = resultText
        const content = Array.isArray(message.content) ? message.content : []
        for (const block of content) {
          const typed = block as { type?: string; data?: string; mimeType?: string } | null
          if (typed?.type !== 'image' || typeof typed.data !== 'string') continue
          images.push({
            messageIndex: paired.messageIndex,
            toolCallId,
            label: labelFromArgs(paired.toolCall.args, paired.toolCall.name),
            data: typed.data,
            mimeType: typeof typed.mimeType === 'string' ? typed.mimeType : 'image/png'
          })
        }
      }
      // 配不到的 toolResult（toolCall 记录丢失）没有可挂的卡片，静默跳过——
      // 与流式链路一致：卡片跟随发起它的 assistant 消息
      continue
    }

    // bashExecution / custom / branchSummary / compactionSummary 等消息角色不进回放
  }

  // 没等到结果的工具卡（会话中断等）：宁可标失败也不留一个假「完成」
  for (const { toolCall } of toolCalls.values()) {
    if (toolCall.status === 'done' && toolCall.resultText === undefined) {
      toolCall.status = 'error'
      toolCall.resultText = '（无工具结果记录）'
    }
  }

  return { messages, images }
}
