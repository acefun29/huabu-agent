/**
 * SuperAgent 领域服务组装点（Mastra 迁移计划 v1.2 §9，Phase 4 基础）。
 *
 * journal 是协作事实源；board / 版本槽是纯函数投影；验收器是确定性代码。
 * 编排层（Mastra supervisor + 专家池 + 事件总线）落在这些不变量之上——
 * 先把「事实可回放、版本只在 accept 后 active、裁剪可观测」的地基钉死。
 */

import { join } from 'node:path'
import { projectBoard, type BoardTask } from './board'
import { WorkspaceJournal, type JournalEvent, type JournalEventType, type JournalActor } from './journal'
import { projectVersions, activeVersion, type VersionSlots, type VersionRecord } from './versions'

export { WorkspaceJournal } from './journal'
export type { JournalEvent, JournalEventType, JournalActor, AcceptEvidence } from './journal'
export { projectBoard } from './board'
export type { BoardTask, BoardStatus } from './board'
export { projectVersions, activeVersion } from './versions'
export type { VersionSlots, VersionRecord, AssetVersions } from './versions'
export { clampEnvelope } from './envelope'
export type { Envelope, EnvelopeAssetRef, ClampResult } from './envelope'
export { validateArtifact } from './validator'
export type { ArtifactCandidate, ValidationResult, ValidationCheck } from './validator'
export { buildEnvelope, envelopeToInstructions, isPathAllowed } from './dispatch'
export type { TaskIntent } from './dispatch'
export { runTask, createLlmExpertRunner, parseArtifactFromReceipt } from './orchestrator'
export type { ExpertRunner, ExpertRunResult, RunTaskOptions, RunTaskResult } from './orchestrator'

/** 工作区 journal 落点（计划 §7.6 存储布局） */
export function journalFileFor(workspaceDir: string): string {
  return join(workspaceDir, '.huabu', 'journal.jsonl')
}

/**
 * 工作区级 SuperAgent 服务：持有 journal 实例（写入串行化），投影按需重建
 * （journal 是事实源，board/versions 不缓存长驻状态——重建便宜且永不漂移）。
 */
export class SuperAgentService {
  readonly journal: WorkspaceJournal
  /** 工作区根：验收器要按它把回执里的相对路径解析成真实文件（C1） */
  readonly workspaceDir: string

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir
    this.journal = new WorkspaceJournal(journalFileFor(workspaceDir))
  }

  append(type: JournalEventType, taskId: string, actor: JournalActor, payload?: Record<string, unknown>): Promise<JournalEvent> {
    return this.journal.append(type, taskId, actor, payload)
  }

  async events(): Promise<JournalEvent[]> {
    return this.journal.read()
  }

  async board(): Promise<BoardTask[]> {
    return projectBoard(await this.events())
  }

  async versionSlots(): Promise<VersionSlots> {
    return projectVersions(await this.events())
  }

  async activeVersion(assetId: string): Promise<VersionRecord | undefined> {
    return activeVersion(await this.versionSlots(), assetId)
  }

  /**
   * 启动对账（C5）：journal 里停在 active / validating 的任务说明上次进程没把它跑完
   * ——`task.started` 之后崩溃，而事件全集里原本没有任何能收掉的终态事件。重启后
   * running 表是空的，cancel 也拿不到 controller，这条任务再也改不动，任务板就永久
   * 挂着一条幽灵「执行中」，用户只能删工作区。
   *
   * 补一条 `task.timed_out` 把它收成 blocked（可被重派救回）。
   *
   * `liveTaskIds` 用于排除本进程正在跑的任务：对账与第一轮派单可能交错，
   * 不能把刚起步的任务当成孤儿。返回本次收口的 taskId 列表（0 条是常态）。
   */
  async reconcile(liveTaskIds: ReadonlySet<string> = new Set()): Promise<string[]> {
    const tasks = await this.board()
    const orphaned = tasks.filter(
      (task) => (task.status === 'active' || task.status === 'validating') && !liveTaskIds.has(task.taskId)
    )
    const closed: string[] = []
    for (const task of orphaned) {
      try {
        await this.append('task.timed_out', task.taskId, 'system', {
          reason: '任务未收尾（进程重启后对账收口）',
          fromStatus: task.status,
        })
        closed.push(task.taskId)
      } catch {
        // journal 不可写时整批都会失败：放弃本轮对账，下次启动再试
        break
      }
    }
    return closed
  }
}
