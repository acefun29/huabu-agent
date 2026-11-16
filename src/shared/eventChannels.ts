import { IpcChannel } from './ipc'

/**
 * 允许经桥订阅 / 转发的事件通道（单一事实来源）。
 *
 * 此前这份清单存在两份、各自手工维护：
 * 1. `preload/index.ts` 的 `EVENT_CHANNEL_ALLOWLIST`（Electron 渲染端订阅白名单，
 *    未登记即抛错）；
 * 2. `webBridge/server.ts` 的 `EVENT_CHANNELS`（Web WS 桥转发白名单）。
 *
 * 两份已经漂了：webBridge 那份里写的是 `'workspace:state-changed'`，而真实通道是
 * `window:state-changed`。它是个死字符串——既不会转发出任何东西，也不会报错，
 * 所以谁都没发现（A18）。用 `IpcChannel` 常量构造后，改通道名两处一起变，
 * 从结构上不可能再漂。
 *
 * 注意：**在这里登记 ≠ 一定会被转发**。主进程发事件有两条路径——
 * `forwardEvent`（走桥）与 `webContents.send`（只到窗口）。只走后者的事件
 * （曾经包括 media:confirm-*）即便登记了，Web 模式也收不到；新增事件时必须
 * 两边都发（见 `ipc/mediaApproval.ts` 的 requestMediaApproval）。
 */
export const EVENT_CHANNEL_ALLOWLIST: readonly string[] = [
  IpcChannel.ChatEvent,
  IpcChannel.MediaJobEvent,
  IpcChannel.MediaConfirmRequest,
  IpcChannel.MediaConfirmResolvedEvent,
  IpcChannel.McpStatusEvent,
  IpcChannel.AssetChanged,
  IpcChannel.WindowStateChanged,
  IpcChannel.ProjectChanged,
  IpcChannel.TaskEvent,
  IpcChannel.WorkChanged,
  IpcChannel.AppFlushBeforeClose
]
