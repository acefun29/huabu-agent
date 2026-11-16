/**
 * 媒体生成前的确认闸门（变更前确认模式）。
 *
 * 每次请求生成一个 requestId 并挂起等待渲染端回执；窗口关闭或超时按未确认处理，
 * 结算后立即从挂起表移除，迟到的重复回执不会影响下一次请求。
 */

import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { MediaApprovalInfo } from '../agent/mediaTools'
import { forwardEvent } from '../webBridge/server'
import { IpcChannel, type MediaConfirmPayload } from '../../shared/ipc'

type PendingApproval = { nodeId: string; resolve: (accepted: boolean) => void }

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
const pendingApprovals = new Map<string, PendingApproval>()

/** 同时通知 Electron 窗口和 Web 客户端；窗口关闭不影响其他接收方。 */
function broadcastApproval(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      window.webContents.send(channel, payload)
    } catch {
      // 窗口可能正在销毁。
    }
  }
  forwardEvent(channel, payload)
}

/** 请求用户确认；回执、中止、会话关闭或超时只会结算一次。 */
export function requestMediaApproval(
  kind: 'image' | 'video' | 'audio',
  info: MediaApprovalInfo,
  nodeId: string,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const requestId = randomUUID()
  return new Promise<boolean>((resolve) => {
    let settled = false
    const abort = (): void => settle(false)
    const settle = (accepted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      pendingApprovals.delete(requestId)
      resolve(accepted)
      broadcastApproval(IpcChannel.MediaConfirmResolvedEvent, { requestId })
    }
    const timeout = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS)
    pendingApprovals.set(requestId, { nodeId, resolve: settle })

    const payload = {
      requestId,
      nodeId,
      kind,
      prompt: info.prompt,
      ...(info.provider ? { provider: info.provider } : {}),
      ...(info.model ? { model: info.model } : {}),
      ...(info.ratio ? { ratio: info.ratio } : {}),
      ...(info.durationSeconds ? { durationSeconds: info.durationSeconds } : {}),
      refSummary: info.refSummary
    } satisfies MediaConfirmPayload
    broadcastApproval(IpcChannel.MediaConfirmRequest, payload)
    if (signal?.aborted) settle(false)
    else if (!settled) signal?.addEventListener('abort', abort, { once: true })
  })
}

/** 迟到或重复的回执可以安全忽略。 */
export function resolveMediaApproval(requestId: string, accepted: boolean): void {
  pendingApprovals.get(requestId)?.resolve(accepted)
}

/** 会话关闭时拒绝其尚未处理的请求。 */
export function settleApprovalsForNode(nodeId: string): void {
  for (const entry of pendingApprovals.values()) {
    if (entry.nodeId === nodeId) entry.resolve(false)
  }
}
