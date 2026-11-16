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

  /* ---------- 多任务共享 task:event 通道（D12 的测试缺口） ---------- */

  it('多任务交错：两张快照各自累积，互不污染（共享通道按 taskId 路由）', () => {
    const A = 'task-a'
    const B = 'task-b'
    const of = (id: string) => (type: TaskEvent['type'], extra: Record<string, unknown>) =>
      ({ type, taskId: id, ...extra }) as TaskEvent

    // 主进程持 live: Map<taskId, snapshot>，渲染端先按 taskId 过滤再调用 —— 这里模拟同一条通道上交错到达
    const live = new Map<string, ReturnType<typeof applyExpertStreamEvent>>()
    const feed = (id: string, type: TaskEvent['type'], extra: Record<string, unknown>): void => {
      live.set(id, applyExpertStreamEvent(live.get(id), of(id)(type, extra)))
    }

    feed(A, 'task.expert_start', { attempt: 1, expert: 'expert-visual' })
    feed(B, 'task.expert_start', { attempt: 1, expert: 'expert-visual' })
    feed(A, 'task.expert_delta', { attempt: 1, channel: 'text', text: 'A 的正文' })
    feed(B, 'task.expert_delta', { attempt: 1, channel: 'text', text: 'B 的正文' })
    feed(A, 'task.expert_tool_start', { attempt: 1, toolCallId: 'ca', toolName: 'generate_image', args: { prompt: 'a' } })
    feed(B, 'task.expert_tool_end', { attempt: 1, toolCallId: 'cb', toolName: 'generate_image', resultText: 'b 完成' })

    expect(live.get(A)?.blocks).toEqual([
      { kind: 'text', text: 'A 的正文' },
      { kind: 'tool', toolCall: expect.objectContaining({ id: 'ca', status: 'running' }) }
    ])
    expect(live.get(B)?.blocks).toEqual([
      { kind: 'text', text: 'B 的正文' },
      { kind: 'tool', toolCall: expect.objectContaining({ id: 'cb', status: 'done' }) }
    ])
  })

  it('task.expert_start 不按 taskId 过滤：误喂别的任务会清空快照（调用方必须先过滤）', () => {
    // 这条测试记录的是**隐式契约**而不是理想行为：函数本身没有 taskId 可比对
    // （ExpertLiveTranscript 不带 taskId），所以「只喂自己任务的事件」是调用方的责任。
    // 主进程按 Map<taskId, live> 存、渲染端按 event.taskId 过滤，两处都做到了。
    let live = applyExpertStreamEvent(undefined, event('task.expert_start', { attempt: 1, expert: 'expert-visual' }))
    live = applyExpertStreamEvent(live, event('task.expert_delta', { attempt: 1, channel: 'text', text: '已有正文' }))
    expect(live?.blocks).toHaveLength(1)

    // 另一个任务的 start 混进来（调用方漏过滤）→ 快照被重置为空
    const foreign = { type: 'task.expert_start', taskId: 'task-other', attempt: 1, expert: 'expert-visual' } as TaskEvent
    expect(applyExpertStreamEvent(live, foreign)).toEqual({ attempt: 1, blocks: [] })
  })
})
