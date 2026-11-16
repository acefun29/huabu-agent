import { describe, expect, it } from 'vitest'
import { activeVersionOf } from './mediaReferenceGraph'
import type { CanvasNode, GenerateVersion } from '../types'

/**
 * 激活版本解析（A01）。
 *
 * 这条回退规则曾是 A01 的隐形后门：`activeVersionId` 缺失时回退 `versions[0]`，
 * 而候选版本恰好插在队首 —— 于是「画布不写 activeVersionId」并不能阻止候选成为
 * 当前版本。候选必须从解析里排除，下游引用才真的看不到未经验收的产物。
 */

function version(id: string, extra: Partial<GenerateVersion> = {}): GenerateVersion {
  return {
    id,
    storage: 'ws',
    path: `scenes/s3/${id}.png`,
    name: id,
    prompt: 'p',
    createdAt: 't',
    ...extra
  }
}

function card(versions: GenerateVersion[], activeVersionId?: string): CanvasNode {
  return {
    id: 'n1',
    type: 'asset',
    x: 0,
    y: 0,
    width: 240,
    height: 230,
    zIndex: 1,
    data: { kind: 'image', name: 'n', versions, ...(activeVersionId ? { activeVersionId } : {}) }
  } as unknown as CanvasNode
}

describe('activeVersionOf', () => {
  it('按 activeVersionId 取；缺失时回退最新正式版本', () => {
    const v1 = version('v1')
    const v2 = version('v2')
    expect(activeVersionOf(card([v2, v1], 'v1'))?.id).toBe('v1')
    expect(activeVersionOf(card([v2, v1]))?.id).toBe('v2')
  })

  it('候选版本永不参与解析（即使它在队首、即使被写成 activeVersionId）', () => {
    const active = version('live')
    const candidate = version('cand', { candidate: true, taskId: 'task-1' })
    // 队首是候选、且没有 activeVersionId：必须回退到正式版本而不是候选
    expect(activeVersionOf(card([candidate, active]))?.id).toBe('live')
    // activeVersionId 指向候选（历史脏数据）：同样不认
    expect(activeVersionOf(card([candidate, active], 'cand'))?.id).toBe('live')
  })

  it('只有候选时没有激活版本（卡片处于待验收状态）', () => {
    expect(activeVersionOf(card([version('c1', { candidate: true })]))).toBeUndefined()
  })

  it('无版本 → undefined', () => {
    expect(activeVersionOf(card([]))).toBeUndefined()
  })
})
