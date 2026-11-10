/**
 * 专家对话回放测试：线程命名、尝试次数还原、Mastra 消息 → 历史块转换。
 * 这些是 UI 详情的数据契约，不依赖真实 memory/LibSQL。
 */

import { describe, expect, it } from 'vitest'
import type { JournalEvent } from './journal'
import {
  expertThreadId,
  startedAttempts,
  toConversationMessages,
  type StoredExpertMessage
} from './conversation'

function journalEvent(
  type: JournalEvent['type'],
  taskId: string,
  payload: Record<string, unknown> = {}
): JournalEvent {
  return {
    id: `${type}-${taskId}`,
    at: new Date(2026, 0, 1).toISOString(),
    type,
    taskId,
    actor: 'expert',
    payload,
    v: 1
  }
}

describe('专家线程命名与尝试还原', () => {
  it('首次尝试无后缀，重试换 -r<attempt> 线程', () => {
    expect(expertThreadId('expert-visual', 'task-1', 1)).toBe('expert-expert-visual-task-1')
    expect(expertThreadId('expert-visual', 'task-1', 2)).toBe('expert-expert-visual-task-1-r2')
  })

  it('task.started 按 attempt 去重；缺 attempt 时按出现顺序兜底；忽略其它任务', () => {
    const events: JournalEvent[] = [
      journalEvent('task.created', 'task-1'),
      journalEvent('task.started', 'task-1', { attempt: 1 }),
      journalEvent('task.started', 'task-2', { attempt: 1 }),
      journalEvent('task.started', 'task-1', { attempt: 2 }),
      journalEvent('task.started', 'task-1', { attempt: 2 }),
      journalEvent('task.started', 'task-1', {})
    ]
    expect(startedAttempts(events, 'task-1')).toEqual([1, 2, 3])
    expect(startedAttempts(events, 'missing')).toEqual([])
  })
})

describe('Mastra 消息 → 对话历史块', () => {
  it('保留文本 / 思考 / 工具调用顺序，忽略 system 与空消息', () => {
    const messages: StoredExpertMessage[] = [
      { role: 'system', content: { format: 2, parts: [{ type: 'text', text: '系统提示' }] } },
      {
        role: 'user',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        content: { format: 2, parts: [{ type: 'text', text: '画一张分镜' }] }
      },
      {
        role: 'assistant',
        createdAt: '2026-01-01T00:00:01.000Z',
        content: {
          format: 2,
          parts: [
            { type: 'reasoning', reasoning: '先看参考图' },
            { type: 'text', text: '开始生成。' },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'result',
                toolCallId: 'call-1',
                toolName: 'generate_image',
                args: { prompt: '夜巷', ratio: '16:9', nested: { seed: 7 } },
                result: { text: '已生成 1 张' }
              }
            },
            { type: 'step-start' }
          ]
        }
      },
      { role: 'assistant', content: { format: 2, parts: [] } }
    ]

    const out = toConversationMessages(messages)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ role: 'user', text: '画一张分镜', at: '2026-01-01T00:00:00.000Z' })
    expect(out[1]?.role).toBe('model')
    expect(out[1]?.text).toBe('开始生成。')
    expect(out[1]?.blocks?.map((block) => block.kind)).toEqual(['thinking', 'text', 'tool'])
    const tool = out[1]?.blocks?.[2]
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.toolCall).toMatchObject({
        id: 'call-1',
        name: 'generate_image',
        status: 'done',
        resultText: '已生成 1 张',
        args: { prompt: '夜巷', ratio: '16:9' }
      })
      // 嵌套对象降级为字符串，ChatToolArgs 只允许标量
      expect(typeof tool.toolCall.args.nested).toBe('string')
    }
  })

  it('工具失败标记为 error；错误块转成可读文本；纯字符串内容兼容', () => {
    const out = toConversationMessages([
      { role: 'user', content: '直接文本' },
      {
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'output-error',
                isError: true,
                toolCallId: 'call-2',
                toolName: 'generate_video',
                args: {},
                errorText: '超时'
              }
            },
            { type: 'error', error: { message: '供应商返回 500' } }
          ]
        }
      }
    ])
    const blocks = out[1]?.blocks ?? []
    expect(blocks[0]).toMatchObject({ kind: 'tool', toolCall: { status: 'error' } })
    expect(blocks[1]).toMatchObject({ kind: 'text', text: '⚠️ 供应商返回 500' })
  })
})
