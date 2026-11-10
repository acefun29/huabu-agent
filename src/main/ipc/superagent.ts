/**
 * superagent 域 IPC（架构图 to-be ② 的「事件总线 + 任务板 + 专家池」落地层）。
 *
 * 覆盖通道：superagent:board / run-task / cancel-task / journal /
 * append-user-change / experts；任务进度经 shared.ts 的 broadcastTaskEvent 推送。
 *
 * 本层只做载荷校验与形态转换：编排、模型解析、工具装配、AbortController 全在
 * `SuperAgentRunner` 里（Agent 工具 `delegate_tasks` 走同一个 runner，两条入口不分叉）。
 */

import { ipcMain } from './ipcMainBridge'
import type { SuperAgentRunner } from '../superagent/runner'
import type { EnvelopeAssetRef } from '../superagent/envelope'
import {
  IpcChannel,
  type ChatResult,
  type SuperAgentAssetRef,
  type SuperAgentBoardSnapshot,
  type SuperAgentExpertInfo,
  type SuperAgentJournalEntry,
  type SuperAgentRunTaskAccepted,
  type SuperAgentRunTaskRequest,
  type SuperAgentTaskView,
  type SuperAgentVersionView
} from '../../shared/ipc'
import type { IpcContext } from './shared'
import { invalidPayload, isNonEmptyString } from './shared'

/** 验收标准条数上限（过长会让信封提示词失衡） */
const MAX_ACCEPT_ITEMS = 12
/** 单次载荷里的引用条数上限（与信封预算 maxRefs 同量级，超出无意义） */
const MAX_REFS = 32

/** 载荷里的引用 → 信封引用；非法条目跳过并回报原因（不整单失败） */
function toEnvelopeRefs(raw: unknown): { refs: EnvelopeAssetRef[]; dropped: string[] } {
  const dropped: string[] = []
  const refs: EnvelopeAssetRef[] = []
  if (!Array.isArray(raw)) return { refs, dropped }
  for (const item of raw.slice(0, MAX_REFS)) {
    const ref = item as Partial<SuperAgentAssetRef> | null
    if (
      !ref ||
      typeof ref.assetId !== 'string' ||
      typeof ref.path !== 'string' ||
      !ref.path.trim() ||
      typeof ref.version !== 'string'
    ) {
      dropped.push(`引用形状不合法：${JSON.stringify(item).slice(0, 80)}`)
      continue
    }
    if (!['image', 'video', 'audio', 'text'].includes(String(ref.kind))) {
      dropped.push(`${ref.assetId}：kind 非法（${String(ref.kind)}）`)
      continue
    }
    if (!['character', 'location', 'prop', 'style', 'previous_take', 'reference'].includes(String(ref.role))) {
      dropped.push(`${ref.assetId}：role 非法（${String(ref.role)}）`)
      continue
    }
    refs.push({
      assetId: ref.assetId,
      path: ref.path,
      version: ref.version,
      kind: ref.kind as EnvelopeAssetRef['kind'],
      role: ref.role as EnvelopeAssetRef['role'],
      status: ref.status === 'stale' || ref.status === 'pending' ? ref.status : 'active',
      ...(typeof ref.width === 'number' ? { width: ref.width } : {}),
      ...(typeof ref.height === 'number' ? { height: ref.height } : {}),
      ...(typeof ref.durationS === 'number' ? { durationS: ref.durationS } : {})
    })
  }
  return { refs, dropped }
}

export function registerSuperAgentIpc(ctx: IpcContext): void {
  const { currentDir } = ctx
  const runner: SuperAgentRunner = ctx.superAgent

  /** 统一入口：取当前工作区目录，或返回明确的「未打开工作区」失败 */
  const withDir = async <T>(fn: (dir: string) => Promise<ChatResult<T>>): Promise<ChatResult<T>> => {
    const dir = currentDir()
    if (!dir) return { ok: false, code: 'cwd_rejected', error: '尚未打开工作区' }
    try {
      return await fn(dir)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'unknown', error: message.length > 500 ? `${message.slice(0, 500)}…` : message }
    }
  }

  ipcMain.handle(IpcChannel.SuperAgentRunTask, (_event, payload: unknown) =>
    withDir(async (dir) => {
      const request = payload as Partial<SuperAgentRunTaskRequest> | null
      if (!isNonEmptyString(request?.scope)) return invalidPayload('superagent:run-task 需要 scope')
      if (!isNonEmptyString(request?.prompt)) return invalidPayload('superagent:run-task 需要 prompt')
      if (!Array.isArray(request?.accept)) return invalidPayload('superagent:run-task 需要 accept 数组')
      if (request.accept.length > MAX_ACCEPT_ITEMS) {
        return invalidPayload(`superagent:run-task 的 accept 最多 ${MAX_ACCEPT_ITEMS} 条`)
      }

      const entities = toEnvelopeRefs(request.entities)
      const adjacent = toEnvelopeRefs(request.adjacent)
      const accept = (request.accept as unknown[])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
      const promptLayers = Array.isArray(request.promptLayers)
        ? request.promptLayers
            .filter((layer) => layer && isNonEmptyString(layer.prompt))
            .slice(0, 8)
            .map((layer) => ({ level: String(layer.level ?? 'layer'), prompt: String(layer.prompt) }))
        : []
      const negative = Array.isArray(request.negative)
        ? request.negative.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 12)
        : []
      const lane = Array.isArray(request.lane)
        ? request.lane.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 8)
        : []

      const started = await runner.start(dir, {
        scope: request.scope,
        prompt: request.prompt,
        accept,
        ...(promptLayers.length > 0 ? { promptLayers } : {}),
        ...(entities.refs.length > 0 ? { entities: entities.refs } : {}),
        ...(adjacent.refs.length > 0 ? { adjacent: adjacent.refs } : {}),
        ...(negative.length > 0 ? { negative } : {}),
        ...(lane.length > 0 ? { lane } : {}),
        ...(isNonEmptyString(request.expert) ? { expert: request.expert } : {}),
        shadow: request.shadow === true
      })
      if (!started.ok) {
        return { ok: false, code: started.error.code === 'cwd_rejected' ? 'cwd_rejected' : 'model_unavailable', error: started.error.message }
      }
      const dropped = [...entities.dropped, ...adjacent.dropped]
      const accepted: SuperAgentRunTaskAccepted = {
        taskId: started.value.taskId,
        expert: started.value.expert,
        ...(dropped.length > 0 ? { rejected: dropped } : {})
      }
      return { ok: true, value: accepted }
    })
  )

  ipcMain.handle(IpcChannel.SuperAgentCancelTask, (_event, payload: unknown) =>
    withDir(async (dir) => {
      const taskId = (payload as { taskId?: unknown } | null)?.taskId
      if (!isNonEmptyString(taskId)) return invalidPayload('superagent:cancel-task 需要 taskId')
      const cancelled = runner.cancel(dir, String(taskId))
      return cancelled
        ? { ok: true, value: undefined }
        : { ok: false, code: 'unknown', error: '该任务不在运行中（可能已完成或已取消）' }
    })
  )

  ipcMain.handle(IpcChannel.SuperAgentBoard, () =>
    withDir(async (dir) => {
      const { tasks, versions, eventCount, runningTaskIds } = await runner.board(dir)
      const taskViews: SuperAgentTaskView[] = tasks.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        ...(task.title ? { title: task.title } : {}),
        ...(task.scope ? { scope: task.scope } : {}),
        ...(task.prompt ? { prompt: task.prompt } : {}),
        ...(task.accept ? { accept: task.accept } : {}),
        ...(task.expert ? { expert: task.expert } : {}),
        attempts: task.attempts,
        ...(task.lastArtifactId ? { lastArtifactId: task.lastArtifactId } : {}),
        ...(task.lastReason ? { lastReason: task.lastReason } : {}),
        updatedAt: task.updatedAt
      }))
      const versionViews: SuperAgentBoardSnapshot['versions'] = {}
      for (const [assetId, slot] of Object.entries(versions)) {
        const toView = (record: (typeof slot.staging)[number]): SuperAgentVersionView => ({
          artifactId: record.artifactId,
          version: record.version,
          ...(record.activatedAt ? { activatedAt: record.activatedAt } : {}),
          ...(record.accept
            ? { accept: { acceptCriteria: record.accept.acceptCriteria, contextHash: record.accept.contextHash } }
            : {})
        })
        versionViews[assetId] = { staging: slot.staging.map(toView), active: slot.active.map(toView) }
      }
      const snapshot: SuperAgentBoardSnapshot = {
        tasks: taskViews,
        versions: versionViews,
        eventCount,
        runningTaskIds
      }
      return { ok: true, value: snapshot }
    })
  )

  ipcMain.handle(IpcChannel.SuperAgentJournal, () =>
    withDir(async (dir) => {
      const events = await runner.journal(dir)
      // journal 事件是可序列化结构；v/id/at 原样保留（审计与回放都靠它们）
      return { ok: true, value: events as unknown as SuperAgentJournalEntry[] }
    })
  )

  ipcMain.handle(IpcChannel.SuperAgentAppendUserChange, (_event, payload: unknown) =>
    withDir(async (dir) => {
      const request = payload as { taskId?: unknown; prompt?: unknown; accept?: unknown } | null
      if (!isNonEmptyString(request?.taskId)) return invalidPayload('superagent:append-user-change 需要 taskId')
      if (!isNonEmptyString(request?.prompt)) return invalidPayload('superagent:append-user-change 需要 prompt')
      const accept = Array.isArray(request.accept)
        ? request.accept.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, MAX_ACCEPT_ITEMS)
        : undefined
      await runner.appendUserChange(dir, {
        taskId: String(request.taskId),
        prompt: String(request.prompt),
        ...(accept && accept.length > 0 ? { accept } : {})
      })
      return { ok: true, value: undefined }
    })
  )

  ipcMain.handle(IpcChannel.SuperAgentExperts, () => {
    const experts: SuperAgentExpertInfo[] = runner.experts().map((expert) => ({
      id: expert.id,
      label: expert.label,
      role: expert.role,
      resident: expert.resident
    }))
    return { ok: true, value: experts } as ChatResult<SuperAgentExpertInfo[]>
  })
}
