import { describe, expect, it } from 'vitest'
import { confirmCloseFlush, requestCloseFlushConfirmation } from './closeFlush'

/**
 * 关窗放行信号：只认「本次关闭请求」的渲染端回执。
 *
 * 这条回归针对的是一个真实竞态：主进程合并窗口里若已有一份更早的快照，
 * 它的落盘事件会在渲染端回执之前发生——如果拿全局落盘当放行证据，
 * 就会在最新编辑还没交上来时 destroy。这里断言放行只由回执/超时决定。
 */
describe('关窗冲刷确认', () => {
  it('先挂等待者、再收到回执 → 放行', async () => {
    const confirmed = requestCloseFlushConfirmation(1_000)
    confirmCloseFlush()
    expect(await confirmed).toBe(true)
  })

  it('没有回执 → 超时返回 false（不把退出挂死）', async () => {
    const confirmed = requestCloseFlushConfirmation(30)
    expect(await confirmed).toBe(false)
  })

  it('回执只放行一次：重复回执不会给下一次关闭「提前放行」', async () => {
    const first = requestCloseFlushConfirmation(1_000)
    confirmCloseFlush()
    confirmCloseFlush() // 迟到/重复的回执
    expect(await first).toBe(true)

    const second = requestCloseFlushConfirmation(30)
    expect(await second).toBe(false)
  })
})
