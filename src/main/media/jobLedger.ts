/**
 * 媒体任务账本（`<媒体目录>/jobs.json`）的读取与原子写入。
 *
 * 账本按媒体目录分文件；读取时先做崩溃恢复，格式无法识别时保留原文件并抛出错误。
 */

import { mkdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { MediaJobStatus } from '../../shared/media'
import { atomicWriteSync, recoverAtomicBackup } from '../fsutil/atomic'

/** 读取账本；内容不可识别时抛错，调用方不得覆盖原文件。 */
export function readJobLedger(mediaDir: string): MediaJobStatus[] {
  const file = resolve(mediaDir, 'jobs.json')
  try {
    recoverAtomicBackup(file)
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { jobs?: unknown }).jobs)) {
      throw new Error('账本格式不正确')
    }
    const jobs = (parsed as { jobs: unknown[] }).jobs
    if (!jobs.every(isPersistedJob)) throw new Error('账本包含不完整或无法识别的任务')
    if (new Set(jobs.map((job) => job.jobId)).size !== jobs.length) throw new Error('账本包含重复的任务 ID')
    return jobs
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取媒体任务账本，已保留原文件，请检查 ${file}：${reason}`)
  }
}

/** 原子写入单个媒体目录的任务快照。 */
export function writeJobLedger(mediaDir: string, jobs: readonly MediaJobStatus[]): void {
  mkdirSync(mediaDir, { recursive: true })
  const persisted = jobs.map(({ workspacePath: _workspace, persistenceWarning: _warning, persistenceScope: _scope, ...job }) => job)
  const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), jobs: persisted })
  atomicWriteSync(resolve(mediaDir, 'jobs.json'), payload)
}

function isPersistedJob(value: unknown): value is MediaJobStatus {
  if (!value || typeof value !== 'object') return false
  const job = value as Partial<MediaJobStatus>
  return typeof job.jobId === 'string' && job.jobId.length > 0 &&
    typeof job.provider === 'string' && typeof job.model === 'string' &&
    (job.kind === 'image' || job.kind === 'video' || job.kind === 'audio') &&
    typeof job.prompt === 'string' && typeof job.progress === 'number' &&
    typeof job.createdAt === 'string' && typeof job.updatedAt === 'string' &&
    (job.state === 'queued' || job.state === 'running' || job.state === 'succeeded' ||
      job.state === 'failed' || job.state === 'cancelled')
}
