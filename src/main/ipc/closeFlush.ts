/**
 * 关窗收口：等渲染端**本次**的冲刷回执。
 *
 * 为什么不能等 WorkspaceStore 的落盘事件：关闭那一刻合并窗口里可能已经躺着
 * 一份更早的快照，它的 200ms 定时器会先落盘并放行——此时最新编辑还在渲染端
 * 防抖定时器里没发出来，直接 destroy 就丢。
 *
 * 回执携带保存结果；超时或保存失败返回 false，由关闭流程决定如何提示用户。
 * 模块级只有一份等待者：同时只会有一个窗口走关闭流程。
 */
let waiter: ((saved: boolean) => void) | null = null

/**
 * 发起一次等待。调用方必须**先**调用它再发事件，否则渲染端的回执可能先到。
 * 返回是否在超时内收到保存成功的回执。
 */
export function requestCloseFlushConfirmation(timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      waiter = null
      resolve(false)
    }, timeoutMs)
    waiter = (saved) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      waiter = null
      resolve(saved)
    }
  })
}

/** 渲染端回执入口（windowApp 的 IPC handler 调用） */
export function confirmCloseFlush(saved = true): void {
  waiter?.(saved)
}
