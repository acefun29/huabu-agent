import { describe, expect, it } from 'vitest'
import { createTask, recordArtifact, startTask, type Task } from '../core/task'
import { buildTurnContext } from './context'

/**
 * Context 装配：只拼两块（常驻记忆 + 当前任务）。
 *
 * 断言的重点不是文案，而是两条性质：
 * 1. 常驻记忆恒定在前（稳定前缀，利于缓存）；
 * 2. 任务块只在有任务时出现，且不泄漏无关字段。
 */

const meta = { id: 'V-02', createdAt: '2026-11-11T10:00:00.000Z' }

function imageTask(): Task {
  return createTask(
    {
      title: '主视觉 6 张',
      brief: '3 张产品正面 + 3 张场景融入',
      lane: 'assets/visual',
      kind: 'image'
    },
    meta
  )
}

describe('buildTurnContext', () => {
  it('纯对话回合（无任务）：只有常驻记忆块', () => {
    const context = buildTurnContext({ studioContent: '当前阶段：第 3 场' })
    expect(context).toContain('项目记忆')
    expect(context).toContain('当前阶段：第 3 场')
    expect(context).not.toContain('当前任务')
  })

  it('有任务：常驻记忆在前，任务说明在后', () => {
    const context = buildTurnContext({ studioContent: '硬约束：16:9', task: imageTask() })
    expect(context.indexOf('项目记忆')).toBeLessThan(context.indexOf('当前任务'))
    expect(context).toContain('编号：V-02')
    expect(context).toContain('要做什么：3 张产品正面 + 3 张场景融入')
    expect(context).toContain('写区：assets/visual/')
    expect(context).toContain('类型：image')
  })

  it('没有产物时不提版本；有产物时给出数量与当前版本', () => {
    const fresh = buildTurnContext({ studioContent: '', task: imageTask() })
    expect(fresh).not.toContain('已产出')

    const doing = startTask(imageTask(), '2026-11-11T10:01:00.000Z')
    const withOne = recordArtifact(doing, 'a1', '2026-11-11T10:01:00.000Z')
    const withTwo = recordArtifact(withOne, 'a2', '2026-11-11T10:02:00.000Z')
    const context = buildTurnContext({
      studioContent: '',
      task: withTwo,
      currentArtifactPath: 'assets/visual/s03-v2.png'
    })
    expect(context).toContain('已产出：2 个版本')
    expect(context).toContain('assets/visual/s03-v2.png')
  })

  it('常驻记忆为空时也给出该写什么的提示（不静默消失）', () => {
    const context = buildTurnContext({ studioContent: '', task: imageTask() })
    expect(context).toContain('空')
    expect(context).toContain('studio.md')
  })

  it('同样的记忆 + 同样的任务 → 同样的前缀（缓存友好）', () => {
    const a = buildTurnContext({ studioContent: '硬约束：16:9' })
    const b = buildTurnContext({ studioContent: '硬约束：16:9', task: imageTask() })
    expect(b.startsWith(a)).toBe(true)
  })
})
