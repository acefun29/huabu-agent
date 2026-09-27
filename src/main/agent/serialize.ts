import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type {
  ChatAssistantSnapshot,
  ChatCompactionReason,
  ChatContentBlock,
  ChatEvent,
  ChatStopReason,
  ChatToolArgs,
  ChatUsage
} from '../../shared/ipc'

/**
 * Pi 事件 → IPC 载荷的翻译层（防腐层）。
 *
 * **这里只允许出现 `import type`。** pi 是纯 ESM 且不提供 require 入口，
 * 任何值导入都会让主进程在运行时抛 ERR_PACKAGE_PATH_NOT_EXPORTED（见 docs/m3-spike.md 第 1 节）。
 * 类型导入在编译后完全擦除，因此是安全的；pi 的实例只在 host.ts 里经 `await import()` 取得。
 *
 * 翻译依据全部来自实测，不是文档推演：
 * - 12 个 assistantMessageEvent 子类型（start / text_* / thinking_* / toolcall_* / done / error）
 * - 一次 prompt 会产生多个 turn（实测 ls+read 并行 → write → 文本收尾 = 3 个 turn）
 * - stopReason 共 7 态，其中 `toolUse` 是「本条消息以工具调用收尾」的正常状态
 * - `partial` 是共享的实时可变对象，**不是**事件时刻的独立快照，因此本层绝不读取或持有它
 * - 被安全过滤的思维链（redacted thinking）在 start 时就完整、不发 delta，
 *   只能靠 message_end 的定稿快照兜底 —— 这就是每次定稿都要发一次全量快照的原因
 */

/** 工具结果文本的截断上限。read 一个大文件可能返回上百 KB，不能整块塞进 IPC */
const RESULT_TEXT_LIMIT = 8000

/** 单个流式文本块的截断上限，防御异常超长 delta */
const DELTA_LIMIT = 64_000

function toStopReason(value: unknown): ChatStopReason {
  switch (value) {
    case 'pending':
    case 'stop':
    case 'length':
    case 'toolUse':
    case 'deferred':
    case 'aborted':
    case 'error':
      return value
    default:
      // pi 新增取值时退化成 error 会误报失败，退化成 stop 会掩盖问题；
      // 这里选择 stop 并在快照里保留原始串，让 UI 至少不崩
      return 'stop'
  }
}

export { toStopReason }

/** 压缩触发原因收敛：pi 三态之外的一律按 threshold 处理（UI 只标注不报错） */
function toCompactionReason(value: unknown): ChatCompactionReason {
  return value === 'manual' || value === 'overflow' ? value : 'threshold'
}

/** 压缩摘要的展示截断（与 errorMessage 同一量级；全文在 JSONL 里，回放侧再截 8000） */
const COMPACTION_SUMMARY_LIMIT = 2000

/**
 * 把 pi 的 getContextUsage() 快照收敛成 context_usage 事件载荷。
 *
 * 返回 null 表示「没有可说的」：会话没绑模型 / contextWindow 无效（pi 返回 undefined），
 * 此时连 contextWindow 都拿不到，发一个全空载荷只会让 UI 显示假窗口。
 * tokens/percent 为 null 时**如实透传**（压缩后待下一轮响应的真实语义），绝不补 0。
 */
export function toContextUsageEvent(nodeId: string, usage: unknown): ChatEvent | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  if (typeof u.contextWindow !== 'number' || u.contextWindow <= 0) return null
  const event: ChatEvent = {
    nodeId,
    type: 'context_usage',
    tokens: typeof u.tokens === 'number' ? u.tokens : null,
    contextWindow: u.contextWindow,
    percent: typeof u.percent === 'number' ? u.percent : null
  }
  return event
}

/** 把工具参数收窄成纯标量映射，数组与对象转 JSON 串（UI 按键值对展示） */
export function toToolArgs(args: unknown): ChatToolArgs {
  const out: ChatToolArgs = {}
  if (!args || typeof args !== 'object') return out
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      out[key] = null
    } else if (typeof value === 'string') {
      out[key] = value.length > RESULT_TEXT_LIMIT ? `${value.slice(0, RESULT_TEXT_LIMIT)}…` : value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else {
      try {
        const json = JSON.stringify(value) ?? String(value)
        out[key] = json.length > RESULT_TEXT_LIMIT ? `${json.slice(0, RESULT_TEXT_LIMIT)}…` : json
      } catch {
        out[key] = '[unserializable]'
      }
    }
  }
  return out
}

/** 从工具结果里抽出可展示文本。实测 ls/read/write 的 result 形如 { content: [{ type:'text', text }] } */
export function toResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) {
    // 结果结构变化时至少留个可读痕迹，不要静默返回空串让卡片看起来「成功但没内容」
    return typeof result === 'string' ? result.slice(0, RESULT_TEXT_LIMIT) : ''
  }
  const text = content
    .map((block) => {
      if (typeof block === 'string') return block
      const typed = block as { type?: string; text?: string }
      return typed?.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
  return text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}\n…（已截断）` : text
}

function toUsage(usage: unknown): ChatUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const num = (key: string): number => (typeof u[key] === 'number' ? (u[key] as number) : 0)
  return {
    input: num('input'),
    output: num('output'),
    reasoning: num('reasoning'),
    totalTokens: num('totalTokens')
  }
}

/** 序列化一条 assistant 消息为定稿快照 */
export function toAssistantSnapshot(message: unknown, messageIndex: number): ChatAssistantSnapshot {
  const msg = (message ?? {}) as Record<string, unknown>
  const rawContent = Array.isArray(msg.content) ? msg.content : []
  const content: ChatContentBlock[] = []

  for (const block of rawContent) {
    const typed = block as Record<string, unknown> | null
    if (!typed || typeof typed !== 'object') continue
    if (typed.type === 'text' && typeof typed.text === 'string') {
      content.push({ type: 'text', text: typed.text })
    } else if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
      content.push({ type: 'thinking', thinking: typed.thinking })
    } else if (typed.type === 'toolCall') {
      content.push({
        type: 'toolCall',
        toolCallId: typeof typed.id === 'string' ? typed.id : undefined,
        toolName: typeof typed.name === 'string' ? typed.name : undefined,
        args: toToolArgs(typed.arguments)
      })
    }
  }

  const snapshot: ChatAssistantSnapshot = {
    messageIndex,
    content,
    provider: typeof msg.provider === 'string' ? msg.provider : 'unknown',
    model: typeof msg.model === 'string' ? msg.model : 'unknown',
    stopReason: toStopReason(msg.stopReason),
    usage: toUsage(msg.usage)
  }
  if (typeof msg.responseModel === 'string') snapshot.responseModel = msg.responseModel
  if (typeof msg.errorMessage === 'string') snapshot.errorMessage = msg.errorMessage
  return snapshot
}

/**
 * 每个会话一个翻译器，跨多轮 prompt 复用，在 agent_start 时重置计数。
 *
 * messageIndex 由本层分配：Pi 的 assistant 消息没有稳定 id，
 * 渲染端需要一个键来定位「这条 delta 属于哪个气泡」。
 */
export class EventTranslator {
  private messageIndex = -1
  private turnIndex = -1

  constructor(private readonly nodeId: string) {}

  /** 翻译一个 Pi 事件，返回 0..n 个待发载荷（无意义事件返回空数组） */
  translate(event: AgentSessionEvent): ChatEvent[] {
    const nodeId = this.nodeId
    const raw = event as unknown as Record<string, any>

    switch (event.type) {
      case 'agent_start':
        // 一次新的生成开始，重置序号，避免上一轮的 index 与本轮混淆
        this.messageIndex = -1
        this.turnIndex = -1
        return [{ nodeId, type: 'agent_start' }]

      case 'turn_start':
        this.turnIndex += 1
        return [{ nodeId, type: 'turn_start', turnIndex: this.turnIndex }]

      case 'message_start':
        // 只给 assistant 消息分配序号；user / toolResult 消息由渲染端本地维护。
        // 不单独发事件：delta 与定稿快照都自带 messageIndex，渲染端首次见到就能建气泡。
        // 这样纯 toolCall 消息、以及不发 delta 的 redacted thinking 也都能正常出现。
        if (raw.message?.role === 'assistant') {
          this.messageIndex += 1
        }
        return []

      case 'message_update': {
        const ame = raw.assistantMessageEvent
        const subType: unknown = ame?.type
        // 只有 text_delta / thinking_delta 携带渲染端需要的增量。
        // toolcall_delta 是 JSON 片段，拼出来对 UI 无意义（完整参数在 tool_execution_start 里），
        // 各类 *_end 的 content 会在定稿快照里一次性给出，不必重复转发。
        if (subType === 'text_delta' || subType === 'thinking_delta') {
          const delta: unknown = ame.delta
          if (typeof delta !== 'string' || delta.length === 0) return []
          return [
            {
              nodeId,
              type: 'delta',
              messageIndex: Math.max(this.messageIndex, 0),
              contentIndex: typeof ame.contentIndex === 'number' ? ame.contentIndex : 0,
              stream: subType === 'text_delta' ? 'text' : 'thinking',
              delta: delta.length > DELTA_LIMIT ? delta.slice(0, DELTA_LIMIT) : delta
            }
          ]
        }
        return []
      }

      case 'message_end':
        // 定稿校正：用权威消息替换渲染端自己拼装的结果
        if (raw.message?.role === 'assistant') {
          return [
            {
              nodeId,
              type: 'message',
              message: toAssistantSnapshot(raw.message, Math.max(this.messageIndex, 0))
            }
          ]
        }
        return []

      case 'tool_execution_start':
        return [
          {
            nodeId,
            type: 'tool_start',
            toolCallId: String(raw.toolCallId ?? ''),
            toolName: String(raw.toolName ?? 'unknown'),
            args: toToolArgs(raw.args)
          }
        ]

      case 'tool_execution_end':
        return [
          {
            nodeId,
            type: 'tool_end',
            toolCallId: String(raw.toolCallId ?? ''),
            toolName: String(raw.toolName ?? 'unknown'),
            isError: raw.isError === true,
            resultText: toResultText(raw.result)
          }
        ]

      // tool_execution_update：长任务（bash / M13 媒体生成）的中间态。
      // 只透传首个 text 块当进度文本（媒体工具的 onUpdate 文本自带百分比）
      case 'tool_execution_update': {
        const partial = raw.partialResult as { content?: Array<{ type?: string; text?: string }> } | undefined
        const text = (partial?.content ?? []).find((block) => block?.type === 'text')?.text ?? ''
        if (!text) return []
        return [
          {
            nodeId,
            type: 'tool_update',
            toolCallId: String(raw.toolCallId ?? ''),
            toolName: String(raw.toolName ?? 'unknown'),
            text: text.length > 200 ? `${text.slice(0, 200)}…` : text
          }
        ]
      }

      case 'turn_end':
        return [{ nodeId, type: 'turn_end', turnIndex: Math.max(this.turnIndex, 0) }]

      case 'agent_end': {
        // agent_end 是整轮 prompt 的终点，「生成中」状态必须以它为准，
        // 用 turn_end / message_end 会在多 turn 的工具调用链路里提前解除加载态
        const messages: unknown[] = Array.isArray(raw.messages) ? raw.messages : []
        const lastAssistant = [...messages].reverse().find((m) => (m as any)?.role === 'assistant')
        const stopReason = toStopReason((lastAssistant as any)?.stopReason ?? 'stop')
        const payload: ChatEvent = { nodeId, type: 'agent_end', stopReason }
        const errorMessage = (lastAssistant as any)?.errorMessage
        if (typeof errorMessage === 'string' && errorMessage.length > 0) {
          payload.errorMessage = errorMessage.slice(0, 2000)
        }
        const usage = toUsage((lastAssistant as any)?.usage)
        if (usage) payload.usage = usage
        return [payload]
      }

      case 'compaction_start':
        // 压缩可能在 running=false 时到达（自动 threshold 压缩发生在 turn 之间），
        // 渲染端的压缩指示必须独立于 running 状态机
        return [{ nodeId, type: 'compaction_start', reason: toCompactionReason(raw.reason) }]

      case 'compaction_end': {
        // result 为 undefined = aborted 或失败：字段全缺省，aborted/errorMessage 照常透传
        const payload: ChatEvent = {
          nodeId,
          type: 'compaction_end',
          reason: toCompactionReason(raw.reason),
          aborted: raw.aborted === true
        }
        const result = (raw.result ?? null) as Record<string, unknown> | null
        if (result && typeof result.summary === 'string' && result.summary.length > 0) {
          payload.summary =
            result.summary.length > COMPACTION_SUMMARY_LIMIT
              ? `${result.summary.slice(0, COMPACTION_SUMMARY_LIMIT)}…`
              : result.summary
        }
        if (result && typeof result.tokensBefore === 'number') payload.tokensBefore = result.tokensBefore
        if (result && typeof result.estimatedTokensAfter === 'number') {
          payload.estimatedTokensAfter = result.estimatedTokensAfter
        }
        if (typeof raw.errorMessage === 'string' && raw.errorMessage.length > 0) {
          payload.errorMessage = raw.errorMessage.slice(0, 2000)
        }
        return [payload]
      }

      default:
        // agent_settled / entry_appended 等事件对 UI 无意义
        return []
    }
  }
}
