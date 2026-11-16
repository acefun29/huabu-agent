import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_RUNTIME, normalizeAgentRuntime } from './runtime'

/**
 * 运行时选择（Pi 移除后只剩一个运行时，这里记录的是**迁移遗留字段的读取语义**）。
 *
 * `workspace.json` 的 `agent.runtime` 曾经用于按工作区灰度/回滚。Pi 运行时删除后，
 * 这个字段不再有消费者；`normalizeAgentRuntime` 暂时保留，供读盘清洗用，
 * 未知值一律回落到默认（Mastra），不会因为历史文件里有脏值而崩。
 */
describe('normalizeAgentRuntime', () => {
  it('默认运行时是 mastra —— 改动必须显式', () => {
    expect(DEFAULT_AGENT_RUNTIME).toBe('mastra')
  })

  it('只认 pi / mastra 两个字面量，其余一律回落默认', () => {
    expect(normalizeAgentRuntime('mastra')).toBe('mastra')
    expect(normalizeAgentRuntime('pi')).toBe('pi')
    expect(normalizeAgentRuntime(undefined)).toBe(DEFAULT_AGENT_RUNTIME)
    expect(normalizeAgentRuntime(null)).toBe(DEFAULT_AGENT_RUNTIME)
    expect(normalizeAgentRuntime('Mastra')).toBe(DEFAULT_AGENT_RUNTIME)
    expect(normalizeAgentRuntime(42)).toBe(DEFAULT_AGENT_RUNTIME)
  })
})
