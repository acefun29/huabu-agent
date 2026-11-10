import { describe, expect, it } from 'vitest'
import type { TaskEvent } from './ipc'
import { applyExpertStreamEvent, expertLiveSize } from './expertStream'

const taskId = 'task-live'

function event<T extends TaskEvent['type']>(
  type: T,
  extra: Record<string, unknown>
): TaskEvent {
  return { type, taskId, ...extra } as TaskEvent
}

describe('专家流式实时块', () => {
  it('text/thinking 连续增量合并，工具调用有 running → done 生命周期', () => {
    let live = applyExpertStreamEvent(undefined, event('task.expert_start', { attempt: 1, expert: 'expert-visual' }))
    expect(live).toEqual({ attempt: 1, blocks: [] })

    live = applyExpertStreamEvent(live, event('task.expert_delta', { attempt: 1, channel: 'thinking', text: '先看' }))
    live = applyExpertStreamEvent(live, event('task.expert_delta', { attempt: 1, channel: 'thinking', text: '参考' }))
    live = applyExpertStreamEvent(live, event('task.expert_delta', { attempt: 1, channel: 'text', text: '开始生成' }))
    expect(live?.blocks).toEqual([
      { kind: 'thinking', text: '先看参考' },
      { kind: 'text', text: '开始生成' }
    ])

    live = applyExpertStreamEvent(
      live,
      event('task.expert_tool_start', {
        attempt: 1,
        toolCallId: 'call-1',
        toolName: 'generate_image',
        args: { prompt: '夜巷', ratio: '16:9' }
      })
    )
    const running = live?.blocks.at(-1)
    expect(running).toMatchObject({ kind: 'tool', toolCall: { id: 'call-1', status: 'running' } })

    live = applyExpertStreamEvent(
      live,
      event('task.expert_tool_end', {
        attempt: 1,
        toolCallId: 'call-1',
        toolName: 'generate_image',
        resultText: '已生成'
      })
    )
    expect(live?.blocks.at(-1)).toMatchObject({
      kind: 'tool',
      toolCall: { id: 'call-1', status: 'done', resultText: '已生成' }
    })
    expect(expertLiveSize(live)).toBeGreaterThan(0)
  })

  it('不同 attempt 的增量不会混入当前尝试；错误转成可读文本块', () => {
    let live = applyExpertStreamEvent(undefined, event('task.expert_start', { attempt: 2, expert: 'expert-visual' }))
    const same = applyExpertStreamEvent(live, event('task.expert_delta', { attempt: 1, channel: 'text', text: '旧线程' }))
    expect(same).toBe(live)

    live = applyExpertStreamEvent(live, event('task.expert_error', { attempt: 2, message: '供应商 500' }))
    expect(live?.blocks).toEqual([{ kind: 'text', text: '⚠️ 供应商 500' }])
  })

  it('工具结果先于调用到达时也能落成终态卡（事件丢失兜底）', () => {
    const live = applyExpertStreamEvent(
      undefined,
      event('task.expert_tool_end', {
        attempt: 1,
        toolCallId: 'call-2',
        toolName: 'read_media',
        resultText: '图片内容',
        isError: true
      })
    )
    // 没有 start 事件时无法确定 attempt，返回 undefined（不凭空造消息）
    expect(live).toBeUndefined()
    const started = applyExpertStreamEvent(undefined, event('task.expert_start', { attempt: 1, expert: 'expert-visual' }))
    const ended = applyExpertStreamEvent(
      started,
      event('task.expert_tool_end', {
        attempt: 1,
        toolCallId: 'call-2',
        toolName: 'read_media',
        resultText: '图片内容',
        isError: true
      })
    )
    expect(ended?.blocks[0]).toMatchObject({
      kind: 'tool',
      toolCall: { id: 'call-2', status: 'error', resultText: '图片内容' }
    })
  })
})
