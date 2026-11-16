import { describe, expect, it } from 'vitest'
import { EVENT_CHANNEL_ALLOWLIST } from './eventChannels'
import { IpcChannel } from './ipc'

/**
 * 事件通道白名单的回归点。
 *
 * 这份清单曾经有两份手工副本，且 Web 桥那份把 `window:state-changed` 抄成了
 * `workspace:state-changed`——一个既不会报错也永远不会生效的死字符串（A18）。
 * 下面这几条断言就是防止它再悄悄长回来。
 */
describe('事件通道白名单（preload 与 Web 桥共用一份）', () => {
  it('每一项都是真实存在的 IpcChannel 值（不允许死字符串）', () => {
    const known = new Set<string>(Object.values(IpcChannel))
    for (const channel of EVENT_CHANNEL_ALLOWLIST) {
      expect(known.has(channel), `${channel} 不是已定义的 IpcChannel`).toBe(true)
    }
  })

  it('窗口状态变化是 window:state-changed，不是 workspace:state-changed', () => {
    expect(EVENT_CHANNEL_ALLOWLIST).toContain(IpcChannel.WindowStateChanged)
    expect(IpcChannel.WindowStateChanged).toBe('window:state-changed')
    expect(EVENT_CHANNEL_ALLOWLIST).not.toContain('workspace:state-changed')
  })

  it('媒体确认卡的两条通道在列（Web 模式的确认闸门依赖它们经桥转发）', () => {
    expect(EVENT_CHANNEL_ALLOWLIST).toContain(IpcChannel.MediaConfirmRequest)
    expect(EVENT_CHANNEL_ALLOWLIST).toContain(IpcChannel.MediaConfirmResolvedEvent)
  })

  it('没有重复项', () => {
    expect(new Set(EVENT_CHANNEL_ALLOWLIST).size).toBe(EVENT_CHANNEL_ALLOWLIST.length)
  })
})
