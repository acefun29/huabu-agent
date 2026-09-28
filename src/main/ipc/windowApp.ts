/**
 * app + window 域 IPC（M1 落地 app 域）。
 *
 * 覆盖通道：app:ping / app:version / window:control / window:state。
 * 自绘标题栏（无边框窗口）走 window:control 与 window:state。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import {
  IpcChannel,
  type AppVersionInfo,
  type WindowControlAction,
  type WindowStateInfo
} from '../../shared/ipc'
import type { IpcContext } from './shared'

export function registerWindowAppIpc(_ctx: IpcContext): void {
  ipcMain.handle(IpcChannel.AppPing, () => 'pong')

  ipcMain.handle(IpcChannel.AppVersion, (): AppVersionInfo => {
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      chrome: process.versions.chrome ?? 'unknown',
      isPackaged: app.isPackaged
    }
  })

  // ---------------------------------------------------------------- window 域（自绘标题栏）

  ipcMain.handle(IpcChannel.WindowControl, (event, action: WindowControlAction) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (action === 'minimize') window.minimize()
    else if (action === 'toggle-maximize') {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    } else if (action === 'close') window.close()
  })

  ipcMain.handle(IpcChannel.WindowState, (event): WindowStateInfo => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return { maximized: window?.isMaximized() ?? false }
  })
}
