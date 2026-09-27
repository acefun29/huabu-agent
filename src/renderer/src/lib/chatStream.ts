import type { ChatAssistantSnapshot, ChatCompactionDivider, ChatContextUsage, ChatEvent, ChatStopReason } from '../../../shared/ipc'
import type { ChatMessage, ChatMessageBlock, ChatToolCallView } from '../types'

/**
 * chat:event → 可渲染状态的归约层（纯函数，无副作用、无 IPC）。
 *
 * 独立成文件的原因：这里是 M3 最容易出错的地方，而它对 Pi 事件时序的假设全部来自
 * scripts/m3-tool-probe.cjs 的实测，不是文档推演。把它做成纯函数，
 * 出问题时只需要看输入事件与输出状态，不必同时排查 React 渲染与 IPC。
 *
 * 三条实测时序（决定了本文件的设计）：
 * 1. 一次 prompt 有多个 turn（实测 ls+read 并行 → write → 文本收尾 = 3 个 turn），
 *    `agent_end` 才是整轮终点，所以 running 状态只能由它解除。
 * 2. 工具事件在 assistant 消息**定稿之后**才到（message_end → tool_execution_start → end），
 *    因此定稿快照里的 toolCall 块初始状态是 running，而不是 done。
 * 3. 被安全过滤的思维链不发 delta，只在定稿快照里出现，所以定稿必须整块重建而不能只补差。
 */

/** 流式草稿块。文本用数组累积，避免 `content += delta` 在长回复时的 O(n²) 字符串重建 */
type DraftBlock =
  | { kind: 'text'; contentIndex: number; parts: string[] }
  | { kind: 'thinking'; contentIndex: number; parts: string[] }
  | { kind: 'tool'; toolCall: ChatToolCallView }

export interface ChatDraft {
  /** 定稿后直接作为 ChatMessage.id 使用 */
  id: string
  messageIndex: number
  blocks: DraftBlock[]
  /** 收到定稿快照后置 true */
  settled: boolean
  stopReason?: ChatStopReason
  errorMessage?: string
  model?: string
}

export interface ChatStreamState {
  /** 本轮生成产生的草稿消息，按 messageIndex 升序 */
  drafts: ChatDraft[]
  /** 是否正在生成。只由 agent_start / agent_end / host_error 改变 */
  running: boolean
  stopReason?: ChatStopReason
  errorMessage?: string
  /**
   * 最近一次上下文水位（context_usage 事件，T1）。放在流状态里而不是直接写
   * ChatData，是为了保持「事件 → 纯函数归约 → 一次性入 store」的管道形态。
   */
  contextUsage?: ChatContextUsage
  /** 压缩进行中（compaction_start..compaction_end）。独立于 running：自动压缩在 turn 之间发生 */
  compacting?: boolean
  /**
   * 本地合成消息（T2 的压缩分隔条），渲染在 drafts 之后。放 tail 而不是直接
   * append 进 history：syncChatHistory 每次都会用 [history.slice(0, baseLen),
   * ...drafts] 整段重建，只有 tail 能在多次 flush 之间存活；下一次 sendMessage
   * 重置流状态时它已固化在 baseLen 之下。
   */
  tail: ChatMessage[]
}

export function createStreamState(): ChatStreamState {
  return { drafts: [], running: false, tail: [] }
}

function newDraft(messageIndex: number): ChatDraft {
  return { id: crypto.randomUUID(), messageIndex, blocks: [], settled: false }
}

/** 取指定 messageIndex 的草稿，不存在则按序补建（防御事件丢失或乱序） */
function ensureDraft(drafts: ChatDraft[], messageIndex: number): ChatDraft[] {
  if (drafts.some((draft) => draft.messageIndex === messageIndex)) return drafts
  const next = [...drafts]
  // 中间缺号时一并补齐，保证 drafts 始终按 messageIndex 有序且可直接按下标渲染
  for (let index = 0; index <= messageIndex; index += 1) {
    if (!next.some((draft) => draft.messageIndex === index)) next.push(newDraft(index))
  }
  return next.sort((a, b) => a.messageIndex - b.messageIndex)
}

/** 按 toolCallId 在所有草稿里更新工具卡片状态，返回新的 drafts */
function patchToolCall(
  drafts: ChatDraft[],
  toolCallId: string,
  patch: Partial<ChatToolCallView>
): ChatDraft[] {
  let patched = false
  const next = drafts.map((draft) => {
    let changed = false
    const blocks = draft.blocks.map((block) => {
      if (block.kind !== 'tool' || block.toolCall.id !== toolCallId) return block
      changed = true
      return { ...block, toolCall: { ...block.toolCall, ...patch } }
    })
    if (!changed) return draft
    patched = true
    return { ...draft, blocks }
  })
  return patched ? next : drafts
}

/** 工具卡片该挂在哪条草稿上：优先最后一条，因为工具总是紧跟发起它的 assistant 消息 */
function lastDraft(drafts: ChatDraft[]): ChatDraft | undefined {
  return drafts.length > 0 ? drafts[drafts.length - 1] : undefined
}

function appendToolCard(drafts: ChatDraft[], toolCall: ChatToolCallView): ChatDraft[] {
  const target = lastDraft(drafts)
  if (!target) {
    // 极端情况：工具事件先于任何 assistant 消息到达。建一条 0 号草稿承接，
    // 宁可多一个空气泡也不能让工具调用凭空消失
    const draft = newDraft(0)
    draft.blocks = [{ kind: 'tool', toolCall }]
    return [draft]
  }
  return drafts.map((draft) =>
    draft === target ? { ...draft, blocks: [...draft.blocks, { kind: 'tool', toolCall }] } : draft
  )
}

/**
 * 用定稿快照重建一条草稿的块序列。
 *
 * 快照的 content 数组是权威顺序（Pi 用它喂回模型），所以整块替换而不是补差。
 * 但工具的执行状态不在快照里（快照产生时工具还没跑），必须从旧块里继承，
 * 否则 tool_end 先于定稿到达时状态会被回退成 running。
 */
function rebuildFromSnapshot(draft: ChatDraft, snapshot: ChatAssistantSnapshot): ChatDraft {
  const knownTools = new Map<string, ChatToolCallView>()
  for (const block of draft.blocks) {
    if (block.kind === 'tool') knownTools.set(block.toolCall.id, block.toolCall)
  }

  const blocks: DraftBlock[] = snapshot.content.map((block, index) => {
    if (block.type === 'text') {
      return { kind: 'text', contentIndex: index, parts: [block.text ?? ''] }
    }
    if (block.type === 'thinking') {
      return { kind: 'thinking', contentIndex: index, parts: [block.thinking ?? ''] }
    }
    const toolCallId = block.toolCallId ?? `unknown-${index}`
    const existing = knownTools.get(toolCallId)
    const toolCall: ChatToolCallView = existing ?? {
      id: toolCallId,
      name: block.toolName ?? 'unknown',
      args: block.args ?? {},
      // 定稿时工具尚未执行（实测 tool_execution_start 在 message_end 之后）
      status: 'running'
    }
    return { kind: 'tool', toolCall }
  })

  const next: ChatDraft = {
    ...draft,
    blocks,
    settled: true,
    stopReason: snapshot.stopReason,
    model: snapshot.responseModel ?? snapshot.model
  }
  if (snapshot.errorMessage) next.errorMessage = snapshot.errorMessage
  return next
}

/** 归约一个事件，返回新状态（永远不改入参，React 需要新引用） */
export function reduceChatEvent(state: ChatStreamState, event: ChatEvent): ChatStreamState {
  switch (event.type) {
    case 'agent_start':
      // 新一轮 drafts 清零；分隔条 tail 与水位保留（压缩分界跨轮持续可见）
      return { drafts: [], running: true, tail: state.tail, contextUsage: state.contextUsage }

    case 'delta': {
      const drafts = ensureDraft(state.drafts, event.messageIndex)
      const kind: 'thinking' | 'text' = event.stream === 'thinking' ? 'thinking' : 'text'
      const next = drafts.map((draft) => {
        if (draft.messageIndex !== event.messageIndex) return draft
        const existing = draft.blocks.find(
          (block): block is Extract<DraftBlock, { kind: 'text' | 'thinking' }> =>
            (block.kind === 'text' || block.kind === 'thinking') &&
            block.contentIndex === event.contentIndex
        )
        if (existing && existing.kind === kind) {
          // 同一条消息内可能出现多个 text 块（被 toolCall 隔开），靠 contentIndex 区分，
          // 命中同号但类型不同的块时必须新建，否则思维链会串进正文
          const blocks = draft.blocks.map((block) =>
            block === existing ? { ...block, parts: [...block.parts, event.delta] } : block
          )
          return { ...draft, blocks }
        }
        return {
          ...draft,
          blocks: [...draft.blocks, { kind, contentIndex: event.contentIndex, parts: [event.delta] }]
        }
      })
      return { ...state, drafts: next }
    }

    case 'tool_start': {
      const toolCall: ChatToolCallView = {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: 'running'
      }
      // 定稿快照通常已经建好了这个 toolCallId 的卡片，此时只更新 args（快照里的更全）
      const existing = state.drafts.some((draft) =>
        draft.blocks.some((block) => block.kind === 'tool' && block.toolCall.id === event.toolCallId)
      )
      const drafts = existing
        ? patchToolCall(state.drafts, event.toolCallId, { status: 'running', args: event.args })
        : appendToolCard(state.drafts, toolCall)
      return { ...state, drafts }
    }

    case 'tool_end':
      return {
        ...state,
        drafts: patchToolCall(state.drafts, event.toolCallId, {
          status: event.isError ? 'error' : 'done',
          resultText: event.resultText,
          // 收尾清进度文本：卡片只保留最终结果
          progressText: undefined
        })
      }

    case 'tool_update':
      // 长任务（bash / 媒体生成）执行中的进度；卡片还没建（tool_start 丢失）时静默丢弃
      return {
        ...state,
        drafts: patchToolCall(state.drafts, event.toolCallId, { progressText: event.text })
      }

    case 'message': {
      const drafts = ensureDraft(state.drafts, event.message.messageIndex)
      return {
        ...state,
        drafts: drafts.map((draft) =>
          draft.messageIndex === event.message.messageIndex
            ? rebuildFromSnapshot(draft, event.message)
            : draft
        )
      }
    }

    case 'agent_end': {
      // 本轮结束时仍在 running 的工具卡片说明它没能执行完（多见于中止），
      // 留一个永久转圈的卡片比标成未完成更糟
      const closed = state.drafts.map((draft) => {
        if (!draft.blocks.some((block) => block.kind === 'tool' && block.toolCall.status === 'running')) {
          return draft
        }
        return {
          ...draft,
          blocks: draft.blocks.map((block) =>
            block.kind === 'tool' && block.toolCall.status === 'running'
              ? {
                  ...block,
                  toolCall: { ...block.toolCall, status: 'error' as const, resultText: '本轮已结束，工具未完成执行' }
                }
              : block
          )
        }
      })
      /*
       * 结束原因必须落到草稿上，不能只放在 state 里：draftToMessage 读的是 draft.stopReason。
       * 中止时 Pi 不保证补发最后一条消息的定稿快照，那样草稿就没有 stopReason，
       * 定稿消息会被渲染成「正常结束」，用户分不清是自己停的还是模型说完了。
       * 只兜底缺失或仍为 pending 的草稿：草稿自带的 stopReason（如 toolUse）
       * 描述的是这一条消息，比整轮的结论更精确，不该被覆盖。
       */
      const lastIndex = closed.length - 1
      const drafts = closed.map((draft, index) => {
        if (index !== lastIndex) return draft
        const missingReason = !draft.stopReason || draft.stopReason === 'pending'
        if (!missingReason && (draft.errorMessage || !event.errorMessage)) return draft
        const next: ChatDraft = { ...draft }
        if (missingReason) next.stopReason = event.stopReason
        if (event.errorMessage && !next.errorMessage) next.errorMessage = event.errorMessage
        return next
      })
      const next: ChatStreamState = { ...state, drafts, running: false, stopReason: event.stopReason }
      if (event.errorMessage) next.errorMessage = event.errorMessage
      else delete next.errorMessage
      return next
    }

    case 'host_error':
      return { ...state, running: false, stopReason: 'error', errorMessage: event.message }

    case 'context_usage':
      // T1：主进程在 agent_end / compaction_end / create 后推送；tokens=null 如实保存
      return {
        ...state,
        contextUsage: { tokens: event.tokens, contextWindow: event.contextWindow, percent: event.percent }
      }

    case 'compaction_start':
      return { ...state, compacting: true }

    case 'compaction_end': {
      // 分隔条只在真的压缩出结果时插入（aborted/失败无 result，不留空分隔条）；
      // 摘要与 token 数字段与 T4 回放从 CompactionEntry 重建的形态一致。
      // id 用内容哈希而非随机数：同一压缩被归约两次（竞态/重复投递）也只产生同一个 id，
      // 由 mergeStreamHistory 按 id 去重，绝不出现重复 key。
      const tail =
        !event.aborted && event.summary
          ? [
              ...state.tail,
              {
                id: compactionDividerId(event.summary, event.tokensBefore, event.estimatedTokensAfter),
                role: 'model' as const,
                content: event.summary,
                compaction: {
                  summary: event.summary,
                  ...(typeof event.tokensBefore === 'number' ? { tokensBefore: event.tokensBefore } : {}),
                  ...(typeof event.estimatedTokensAfter === 'number'
                    ? { estimatedTokensAfter: event.estimatedTokensAfter }
                    : {})
                } satisfies ChatCompactionDivider
              } satisfies ChatMessage
            ]
          : state.tail
      return { ...state, compacting: false, tail }
    }

    // turn_start / turn_end 对 M3 的 UI 无意义（多 turn 已由消息序列自然呈现）
    case 'turn_start':
    case 'turn_end':
      return state

    default:
      return state
  }
}

/** 把草稿块转成与定稿消息一致的形态，让流式与历史走同一套渲染代码 */
export function toRenderBlocks(draft: ChatDraft): ChatMessageBlock[] {
  return draft.blocks.map((block) => {
    if (block.kind === 'tool') return { kind: 'tool' as const, toolCall: block.toolCall }
    return { kind: block.kind, text: block.parts.join('') }
  })
}

/** 草稿定稿为可持久化的消息（写入 store 的 history，M5 会序列化到 canvas.json） */
export function draftToMessage(draft: ChatDraft): ChatMessage {
  const blocks = toRenderBlocks(draft)
  const message: ChatMessage = {
    id: draft.id,
    role: 'model',
    content: blocks
      .filter((block): block is Extract<ChatMessageBlock, { kind: 'text' }> => block.kind === 'text')
      .map((block) => block.text)
      .join('')
  }
  if (blocks.length > 0) message.blocks = blocks
  if (draft.stopReason) message.stopReason = draft.stopReason
  if (draft.errorMessage) message.errorMessage = draft.errorMessage
  if (draft.model) message.model = draft.model
  return message
}

/** 结束原因的语义分组，决定显示「完成 / 已中止 / 出错」 */
export function stopReasonKind(reason?: ChatStopReason): 'pending' | 'done' | 'aborted' | 'error' {
  if (!reason || reason === 'pending') return 'pending'
  if (reason === 'aborted') return 'aborted'
  if (reason === 'error') return 'error'
  // stop / length / toolUse / deferred 都是正常结束。
  // toolUse 尤其不能当异常：它只表示「这条消息以工具调用收尾，后面还有 turn」
  return 'done'
}

/**
 * 压缩分隔条的稳定 id：djb2(摘要 + token 数字段)。
 *
 * 不能用 crypto.randomUUID：分隔条经 tail 在多次 flush 之间存活并被同步进
 * history 前缀，一旦同一压缩事件被归约两次（异步竞态/重复投递），随机 id 会
 * 让同一条分隔条以两个不同 id 各出现一次；内容哈希让两次归约得到同一个 id，
 * mergeStreamHistory 按 id 去重后只保留一条。
 */
export function compactionDividerId(
  summary: string,
  tokensBefore?: number,
  estimatedTokensAfter?: number
): string {
  let hash = 5381
  const source = `${tokensBefore ?? '-'}|${estimatedTokensAfter ?? '-'}|${summary}`
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0
  }
  return `compaction-${(hash >>> 0).toString(36)}`
}

/**
 * history 的三段合并（前缀 + 本轮草稿 + 本地合成 tail），按 id 保首个去重。
 *
 * tail 分隔条在跨 flush 存活的同时也可能已被某次同步"固化"进前缀（baseLen 在
 * 下一次发送时抬高越过它）——此时再从 tail 追加就是重复消息（React key 冲突，
 * 真机日志实锤过）。前缀里的份是权威（位次已定），tail 里的重复份一律丢弃。
 */
export function mergeStreamHistory(
  prefix: ChatMessage[],
  drafts: ChatMessage[],
  tail: ChatMessage[]
): ChatMessage[] {
  const seen = new Set<string>()
  const out: ChatMessage[] = []
  for (const message of [...prefix, ...drafts, ...tail]) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    out.push(message)
  }
  return out
}

/**
 * 手动压缩的门控（T2）。SDK 语义：compact 会先 abort 当前 agent 操作且不续跑
 * 被打断的 turn——running 时必须禁用入口并把后果说清楚，不能让用户误点；
 * 压缩进行中同样禁用（不允许并发压缩）。
 */
export function compactGate(running?: boolean, compacting?: boolean): { disabled: boolean; reason?: string } {
  if (compacting) return { disabled: true, reason: '正在压缩中' }
  if (running) return { disabled: true, reason: '生成中不可压缩（会打断当前生成且不续跑）' }
  return { disabled: false }
}
