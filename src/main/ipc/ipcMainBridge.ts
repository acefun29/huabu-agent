/**
 * `ipcMain` 的包装层：注册 handler 时同时登记到 Web 桥。
 *
 * 为什么这样做：80 个 ipcMain.handle 调用点分散在 7 个文件里，逐个改成
 * `register(channel, handler)` 侵入太大且容易漏。这里导出同名同签名的对象，
 * 各 IPC 模块只把 `import { ipcMain } from 'electron'` 换成从这里导入即可——
 * 行为与原生 ipcMain 完全一致（Electron 内仍是原生 IPC），额外把
 * channel → handler 记一份给 Web 桥复用（同一份业务逻辑，不重写）。
 *
 * 注意：`ipcMain.on` / `removeHandler` 等非 invoke 接口原样透传（桥只关心 invoke 类）。
 */

import { ipcMain as electronIpcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { registerBridgeChannel } from '../webBridge/server'

/** 传给桥的 handler：忽略 event 参数（现有 handler 都写 `_event`） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBridgeHandler(listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) {
  return (payload: unknown): unknown => {
    // 桥调用时给一个最小 event stub：现有 handler 全部忽略它，只为满足签名
    const stub = {} as IpcMainInvokeEvent
    return listener(stub, payload)
  }
}

export const ipcMain = {
  handle(
    channel: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void {
    electronIpcMain.handle(channel, listener as never)
    // 同 channel 重复登记时后注册覆盖（与 ipcMain.handle 语义一致）
    registerBridgeChannel(channel, toBridgeHandler(listener))
  },

  once: electronIpcMain.once.bind(electronIpcMain),
  on: electronIpcMain.on.bind(electronIpcMain),
  off: electronIpcMain.off.bind(electronIpcMain),
  removeHandler: electronIpcMain.removeHandler.bind(electronIpcMain),
  removeAllListeners: electronIpcMain.removeAllListeners.bind(electronIpcMain),
}
