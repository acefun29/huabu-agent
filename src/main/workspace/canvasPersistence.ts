/**
 * 画布快照的延迟合并写入。
 *
 * 每次保存只保留最新快照；切换工作区和关窗需要确认落盘时，由调用方冲刷并等待结果。
 */

import type { CanvasSnapshot } from '../../shared/ipc'
import { atomicWriteSync } from '../fsutil/atomic'

const WRITE_DELAY_MS = 200
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024

/** 合并画布写入；失败时保留最新快照，供后续保存或显式冲刷重试。 */
export class CanvasPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: { file: string; snapshot: CanvasSnapshot } | null = null

  schedule(file: string, snapshot: CanvasSnapshot): void {
    if (this.pending && this.pending.file !== file) this.flush()
    this.pending = { file, snapshot }
    if (this.timer) return
    this.timer = setTimeout(() => {
      try {
        this.flush()
      } catch (error) {
        console.error('[workspace] canvas.json 写盘失败：', error)
      }
    }, WRITE_DELAY_MS)
  }

  /** 同步写入待保存的快照；失败时抛错并保留待写数据。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const pending = this.pending
    if (!pending) return
    const serialized = JSON.stringify(pending.snapshot)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
      throw new Error('画布快照超过 32 MB 上限')
    }
    atomicWriteSync(pending.file, serialized)
    this.pending = null
  }
}
