import { describe, expect, it } from 'vitest'
import { matchOmBinding } from './memory'

/**
 * OM 后台模型的路由规则（A17）。
 *
 * 这段逻辑此前是「永远取最近登记的会话」——同工作区跨模型开会话时，
 * A 会话的压缩会用 B 会话的模型。现在先按 requestContext 里的线程 id 精确路由，
 * 内部 observer/reflector 的 `<线程>-<agentId>` 身份再按最长前缀还原。
 * 这里把规则钉住：它退化成「永远取最近」不会有任何报错，只会悄悄错配模型。
 */
describe('OM 后台模型路由（A17）', () => {
  const bindings = new Map<string, { nodeId: string }>([
    ['node-a', { nodeId: 'a' }],
    ['node-b', { nodeId: 'b' }],
    // 故意造一个「另一个线程 id 是它的前缀」的场景，验证取最长前缀
    ['node-b-extra', { nodeId: 'b-extra' }]
  ])

  it('精确命中线程时用该会话自己的绑定', () => {
    expect(matchOmBinding(bindings, 'node-a')?.nodeId).toBe('a')
    expect(matchOmBinding(bindings, 'node-b')?.nodeId).toBe('b')
  })

  it('内部 agent 身份 `<线程>-<agentId>` 按最长前缀还原', () => {
    // node-b-observe → 应还原到 node-b，而不是 node-b-extra
    expect(matchOmBinding(bindings, 'node-b-observe')?.nodeId).toBe('b')
    // node-b-extra-reflect → 命中更长的 node-b-extra
    expect(matchOmBinding(bindings, 'node-b-extra-reflect')?.nodeId).toBe('b-extra')
  })

  it('命中不了时返回 undefined（由调用方回落并告警，而不是瞎猜）', () => {
    expect(matchOmBinding(bindings, 'node-zzz')).toBeUndefined()
    expect(matchOmBinding(bindings, '')).toBeUndefined()
    // 前缀相同但没有 `-` 分隔的不算命中，避免 node-b 吞掉 node-bbbb
    expect(matchOmBinding(bindings, 'node-bbbb')).toBeUndefined()
  })
})
