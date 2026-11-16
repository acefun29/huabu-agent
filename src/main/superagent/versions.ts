/**
 * 版本槽投影（Mastra 迁移计划 v1.2 §7.5/§9.4，SuperAgent Phase 4 基础）。
 *
 * 版本只追加、不覆盖：`artifact.ready` 落 staging（验收前候选，不作为正式版本），
 * `validation.passed` + `version.activated` 之后才 active（下游可引用）。
 * 投影对非法激活防御性忽略：没有对应 validation.passed 的 version.activated
 * 不产生 active 版本（单一事实源上的顺序校验，保证「版本只在 accept 后 active」
 * 是重建出来的不变量，不靠调用方自觉——计划 §16.3-13）。
 */

import type { JournalEvent } from './journal'

export interface VersionRecord {
  /** 事件携带的全部证据（accept 时含 acceptCriteria/diff/artifactId/contextHash） */
  artifactId: string
  version: string
  activatedAt?: string
  accept?: {
    acceptCriteria: string[]
    diff: unknown
    contextHash: string
  }
}

export interface AssetVersions {
  staging: VersionRecord[]
  active: VersionRecord[]
}

export type VersionSlots = Record<string, AssetVersions>

/**
 * journal → 版本槽投影（纯函数）。
 * 约定 payload 字段：artifact.ready {artifactId, assetId, version}；
 * validation.passed {artifactId, acceptCriteria, diff, contextHash}；
 * version.activated {assetId, version, artifactId}。
 */
export function projectVersions(events: readonly JournalEvent[]): VersionSlots {
  const slots: VersionSlots = {}
  const assetOf = (assetId: string): AssetVersions => (slots[assetId] ??= { staging: [], active: [] })

  /**
   * taskId+artifactId → 已 accept 的证据（激活时反查）。
   * 除证据本身，还记下这次 accept 针对的 assetId/version 与是否 shadow（C4/C19）：
   * 此前只按 taskId+artifactId 反查，激活时可以填任意 assetId/version——于是
   * 「A 资产的验收结论」能激活 B 资产的版本；shadow 任务也能被事后补一条激活。
   */
  const accepted = new Map<
    string,
    { taskId: string; assetId?: string; version?: string; shadow: boolean; accept: NonNullable<VersionRecord['accept']> }
  >()
  /** 已激活过的 assetId:version（C20：同一版本不得重复激活，active 只应单调追加） */
  const activated = new Set<string>()

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>
    switch (event.type) {
      case 'artifact.ready': {
        const assetId = str(payload.assetId)
        const artifactId = str(payload.artifactId)
        const version = str(payload.version)
        if (!assetId || !artifactId || !version) break
        assetOf(assetId).staging.push({ artifactId, version })
        break
      }
      case 'validation.passed': {
        const artifactId = str(payload.artifactId)
        if (!artifactId) break
        accepted.set(`${event.taskId}:${artifactId}`, {
          taskId: event.taskId,
          ...(str(payload.assetId) ? { assetId: str(payload.assetId) } : {}),
          ...(str(payload.version) ? { version: str(payload.version) } : {}),
          shadow: payload.shadow === true,
          accept: {
            acceptCriteria: (payload.acceptCriteria as string[]) ?? [],
            diff: payload.diff,
            contextHash: str(payload.contextHash) ?? '',
          },
        })
        break
      }
      case 'version.activated': {
        const assetId = str(payload.assetId)
        const version = str(payload.version)
        const artifactId = str(payload.artifactId)
        if (!assetId || !version || !artifactId) break
        // 防御：没有 accept 证据的激活不生效（不变量由投影保证）
        const accept = accepted.get(`${event.taskId}:${artifactId}`)
        if (!accept) break
        // shadow 任务的验收结论不构成激活资格（C19）：shadow 的唯一区别就是「不切 active」，
        // 若事后补一条 version.activated 就能激活，那条约束只活在 orchestrator 的 if 里
        if (accept.shadow) break
        // 激活必须针对被验收的那一份产物（C4）：accept 记了 assetId/version 就必须一致，
        // 否则「A 的验收」可以给 B 上版本
        if (accept.assetId && accept.assetId !== assetId) break
        if (accept.version && accept.version !== version) break
        // 同一版本重复激活不产生第二条 active（C20）
        const slotKey = `${assetId}:${version}`
        if (activated.has(slotKey)) break
        activated.add(slotKey)
        assetOf(assetId).active.push({
          artifactId,
          version,
          activatedAt: event.at,
          accept: accept.accept,
        })
        break
      }
      default:
        break
    }
  }
  return slots
}

/** 某 asset 当前生效版本（active 最后一个；无则 undefined——下游不得引用 staging） */
export function activeVersion(slots: VersionSlots, assetId: string): VersionRecord | undefined {
  return slots[assetId]?.active.at(-1)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
