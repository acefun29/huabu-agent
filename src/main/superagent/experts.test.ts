/**
 * 专家注册表测试：id 命中 / 未知 id 回落 / 默认专家 / 工具面声明。
 *
 * 回落语义是派单健壮性的关键：主 Agent 把 expert 拼错（或引用了一个已删除的专家）
 * 不应该让任务整单失败，但回落必须是**可观测**的（fellBack=true 让 journal 记下原始 id）。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPERT_ID, EXPERT_REGISTRY, findExpert, listExperts, resolveExpert } from './experts'

describe('专家注册表', () => {
  it('内置两个薄核心：视觉（挂媒体工具）与执行（纯文本）', () => {
    const experts = listExperts()
    expect(experts.map((expert) => expert.id)).toEqual(['expert-visual', 'expert-exec'])
    expect(findExpert('expert-visual')?.tools).toEqual(['media'])
    expect(findExpert('expert-visual')?.favors).toContain('image')
    expect(findExpert('expert-exec')?.tools).toEqual(['files'])
    expect(findExpert('expert-exec')?.favors).toEqual(['text'])
  })

  it('每个专家都有非空 label / role / instructions，id 唯一', () => {
    const ids = new Set<string>()
    for (const expert of EXPERT_REGISTRY) {
      expect(expert.id).toBeTruthy()
      expect(expert.label).toBeTruthy()
      expect(expert.role).toBeTruthy()
      expect(expert.instructions.length).toBeGreaterThan(20)
      expect(ids.has(expert.id)).toBe(false)
      ids.add(expert.id)
    }
  })

  it('resolveExpert：显式命中不回落', () => {
    const resolved = resolveExpert('expert-exec')
    expect(resolved.expert.id).toBe('expert-exec')
    expect(resolved.fellBack).toBe(false)
  })

  it('resolveExpert：未指定（undefined）回落默认专家，但不算「回落」', () => {
    const resolved = resolveExpert(undefined)
    expect(resolved.expert.id).toBe(DEFAULT_EXPERT_ID)
    expect(resolved.fellBack).toBe(false)
  })

  it('resolveExpert：拼错的 id 回落默认专家，并标记 fellBack（journal 可记原始 id）', () => {
    const resolved = resolveExpert('expert-nope')
    expect(resolved.expert.id).toBe(DEFAULT_EXPERT_ID)
    expect(resolved.fellBack).toBe(true)
    // 空白 id 视同未指定
    expect(resolveExpert('   ').fellBack).toBe(false)
  })

  it('id 前后空格被容忍（工具参数常见形态）', () => {
    expect(findExpert(' expert-exec ')?.id).toBe('expert-exec')
  })
})
