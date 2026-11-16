import { describe, expect, it } from 'vitest'
import {
  REPLAY_MAX_FRAMES,
  REPLAY_TTL_MS,
  ReplayBuffer,
  isHighVolumeEvent
} from './replayBuffer'

/**
 * 断线重放缓冲（D6）。
 *
 * 这条链路只在 `pnpm web`（headless）下活跃，所以此前完全没被测试碰过。三个不变量：
 * 只留非增量帧、有界、过期即弃。
 */

describe('增量帧过滤', () => {
  it('delta / tool_update 视为高体积增量，不重放', () => {
    expect(isHighVolumeEvent({ type: 'delta', delta: 'x' })).toBe(true)
    expect(isHighVolumeEvent({ type: 'tool_update', text: '进度' })).toBe(true)
  })

  it('生命周期帧要重放（message / agent_end / 工具 / 压缩 / 任务）', () => {
    for (const type of ['agent_start', 'message', 'agent_end', 'tool_start', 'tool_end', 'compaction_end', 'task.status']) {
      expect(isHighVolumeEvent({ type })).toBe(false)
    }
  })

  it('没有 type 的载荷按生命周期帧处理（媒体进度之类体积小）', () => {
    expect(isHighVolumeEvent({ progress: 0.5 })).toBe(false)
    expect(isHighVolumeEvent(null)).toBe(false)
    expect(isHighVolumeEvent('str')).toBe(false)
  })
})

describe('ReplayBuffer', () => {
  it('drain 取出全部并清空（只重放一次）', () => {
    const buffer = new ReplayBuffer()
    buffer.push('{"a":1}')
    buffer.push('{"b":2}')
    expect(buffer.drain()).toEqual(['{"a":1}', '{"b":2}'])
    expect(buffer.size).toBe(0)
    expect(buffer.drain()).toEqual([])
  })

  it('超上限丢最旧的：保住最近的终态事件', () => {
    const buffer = new ReplayBuffer(3)
    for (const frame of ['a', 'b', 'c', 'd', 'e']) buffer.push(frame)
    expect(buffer.size).toBe(3)
    expect(buffer.drain()).toEqual(['c', 'd', 'e'])
  })

  it('过期帧丢弃（标签页关几小时后重开，不该重放陈旧终态）', () => {
    let clock = 0
    const buffer = new ReplayBuffer(REPLAY_MAX_FRAMES, REPLAY_TTL_MS, () => clock)
    buffer.push('old')
    clock = REPLAY_TTL_MS - 1
    buffer.push('fresh')
    clock = REPLAY_TTL_MS + 1
    // old 已过期（存活 TTL+1），fresh 仍有效
    expect(buffer.drain()).toEqual(['fresh'])
  })

  it('clear 丢弃全部（关闭桥时调用）', () => {
    const buffer = new ReplayBuffer()
    buffer.push('a')
    buffer.clear()
    expect(buffer.size).toBe(0)
    expect(buffer.drain()).toEqual([])
  })
})
