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

  constructor(workspaceDir: string) {
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
}
