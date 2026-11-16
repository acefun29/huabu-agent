/**
 * 断线期间的事件重放缓冲（D6）。
 *
 * ## 问题
 *
 * `webBridge` 的 `broadcast` 只往 `readyState === OPEN` 的 socket 上写。浏览器刷新、
 * 网络抖动、`pnpm web` 页面被挂起时 socket 会短暂断开，而客户端**没有状态重取**——
 * 掉的这一窗事件就是永久丢失。丢 `agent_start` 会让后续 delta 无处可落；丢
 * `agent_end` 则让会话永远停在「生成中」，只能刷新页面才能恢复。
 *
 * ## 为什么只留「非增量帧」
 *
 * - `delta` / `tool_update` 是逐字增量，重放它们只有在客户端**完整保留**了断线前的
 *   累积状态时才有意义；一次页面刷新就会让它们叠到一份全新的空状态上，产生重复文本。
 * - 生命周期帧（`agent_start` / `message` / `agent_end` / 工具事件 / 压缩事件）在渲染端
 *   是**幂等**的：`message` 走 `rebuildFromSnapshot`（重建而非追加），`agent_end` 在草稿
 *   已清空时是 no-op。重放它们能把界面拉回正确终态，且不会重复显示。
 *
 * 所以策略是：**丢掉中间的逐字动画，保证最终状态正确**——用户看不到断线期间的打字
 * 过程（本来也看不到），但不会卡在「生成中」。
 *
 * ## 有界
 *
 * 条数与存活时间都设上限：浏览器标签关掉几小时后重新打开时，不该把几小时前的
 * `agent_end` 重放进一个已经由 `chat:history` 重新同步过的界面。
 */

/** 重放缓冲保留的最大帧数（超出丢最旧的：保住最近的终态事件） */
export const REPLAY_MAX_FRAMES = 64
/** 帧存活时间：足够覆盖 1.5s 重连与一次页面刷新，又不至于重放陈旧终态 */
export const REPLAY_TTL_MS = 30_000

/**
 * 高体积增量事件：断线期间不保留。
 *
 * 判定用 payload 上的 `type` 字段——ChatEvent 与 TaskEvent 都带它；没有 `type`
 * 的载荷（例如媒体进度）体积小且低频，按生命周期帧处理。
 */
const HIGH_VOLUME_TYPES = new Set(['delta', 'tool_update'])

export function isHighVolumeEvent(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const type = (payload as { type?: unknown }).type
  return typeof type === 'string' && HIGH_VOLUME_TYPES.has(type)
}

interface BufferedFrame {
  frame: string
  at: number
}

export class ReplayBuffer {
  private readonly frames: BufferedFrame[] = []

  constructor(
    private readonly max: number = REPLAY_MAX_FRAMES,
    private readonly ttlMs: number = REPLAY_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  get size(): number {
    return this.frames.length
  }

  /** 记一帧（调用方已判定为非增量事件） */
  push(frame: string): void {
    this.frames.push({ frame, at: this.now() })
    // 超上限丢最旧：最近的终态事件（agent_end）比开头的 agent_start 更有价值
    while (this.frames.length > this.max) this.frames.shift()
  }

  /** 取出并清空可重放的帧（过期的丢弃） */
  drain(): string[] {
    const cutoff = this.now() - this.ttlMs
    const live = this.frames.filter((entry) => entry.at >= cutoff)
    this.frames.length = 0
    return live.map((entry) => entry.frame)
  }

  clear(): void {
    this.frames.length = 0
  }
}
