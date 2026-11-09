/**
 * 协作事实日志（Mastra 迁移计划 v1.2 §7.5/§9.4，SuperAgent Phase 4 基础）。
 *
 * journal 是唯一事实源：append-only JSONL（`.huabu/journal.jsonl`），board / 版本槽
 * 都是可重建投影。约束（计划 §2-3/§2-8）：
 * - 只追加、不覆盖、不删除；写入串行化（单进程主进程内一条 promise 链足够）；
 * - 崩溃安全：读取容忍末尾残行（写一半的行丢弃，append-only 下不影响前序事实）；
 * - 任何 `validation.passed` 必须带 acceptCriteria / diff / artifactId / contextHash
 *   （accept 可回放的硬门槛，append 时拒绝缺失）；
 * - `version.activated` 只能在 accept 之后写入（由调用方编排保证，journal 侧校验
 *   payload 必备字段）。
 */

import { appendFile, open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/** 计划 §7.5 的事件类型全集（新增类型必须同步 board/versions 投影） */
export type JournalEventType =
  | 'task.created'
  | 'task.assigned'
  | 'task.started'
  | 'artifact.ready'
  | 'artifact.rejected'
  | 'validation.passed'
  | 'validation.failed'
  | 'version.activated'
  | 'user.changed'

export type JournalActor = 'main' | 'expert' | 'validator' | 'user' | 'system'

export interface JournalEvent<P = Record<string, unknown>> {
  id: string
  /** ISO 时间戳（append 时由 journal 生成，调用方不提供） */
  at: string
  type: JournalEventType
  taskId: string
  actor: JournalActor
  payload: P
  v: 1
}

/** append 入参（id/at 由 journal 生成） */
export type JournalEventInput<P = Record<string, unknown>> = Omit<JournalEvent<P>, 'id' | 'at' | 'v'>

/** accept 可回放的必备字段（计划 §7.5：任何 accept 必须带） */
export interface AcceptEvidence {
  acceptCriteria: string[]
  diff: unknown
  artifactId: string
  contextHash: string
}

const V1 = 1

export class WorkspaceJournal {
  private readonly file: string
  /** 写串行化：Electron main 单进程内一条链即可保证 append 顺序与原子性 */
  private writeChain: Promise<JournalEvent> = Promise.resolve(null as unknown as JournalEvent)

  constructor(file: string) {
    this.file = file
  }

  /** 追加一条事实。返回完整事件（含生成的 id/at）。校验失败抛错，不落盘。 */
  append(type: JournalEventType, taskId: string, actor: JournalActor, payload: Record<string, unknown> = {}): Promise<JournalEvent> {
    const input: JournalEventInput = { type, taskId, actor, payload }
    // 校验失败返回 rejected promise（不进写队列，事实源不落盘）
    try {
      validateForAppend(input)
    } catch (error) {
      return Promise.reject(error)
    }
    const run = this.writeChain.then(async () => {
      const event: JournalEvent = { ...input, id: randomUUID(), at: new Date().toISOString(), v: V1 }
      // 每行一个 JSON + 换行；appendFile 不改写已有内容（append-only 语义的文件层保证）。
      // 崩溃残留的半行会让下一条 append 粘进坏行——先检查末字节，残行后补换行再写
      const prefix = (await endsWithNewline(this.file)) ? '' : String.fromCharCode(10)
      await appendFile(this.file, prefix + JSON.stringify(event) + String.fromCharCode(10), 'utf8')
      return event
    })
    // 失败不让链条断掉：后续 append 仍可进行（失败的那条没有落盘，事实源未被污染）
    this.writeChain = run.catch(() => undefined as unknown as JournalEvent)
    return run
  }

  /** 全量读取（投影重建用）。容忍末尾残行：写一半的行直接丢弃。 */
  async read(): Promise<JournalEvent[]> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return []
    }
    const events: JournalEvent[] = []
    for (const line of raw.split(String.fromCharCode(10))) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as JournalEvent
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && typeof parsed.type === 'string') {
          events.push(parsed)
        }
      } catch {
        // 残行/坏行：append-only 下前序事实不受影响，跳过（与崩溃安全约定一致）
      }
    }
    return events
  }
}

/** append 前的硬校验：accept 类证据字段是可回放性的底线，缺失即拒绝 */
function validateForAppend(input: JournalEventInput): void {
  if (!input.taskId) throw new Error('journal: taskId 不能为空')
  if (input.type === 'validation.passed') {
    const payload = input.payload as Partial<AcceptEvidence>
    for (const field of ['acceptCriteria', 'diff', 'artifactId', 'contextHash'] as const) {
      if (payload[field] === undefined || payload[field] === null) {
        throw new Error(`journal: validation.passed 必须带 ${field}（accept 可回放硬门槛，计划 §7.5）`)
      }
    }
  }
  if (input.type === 'version.activated') {
    const payload = input.payload as { assetId?: string; version?: string }
    if (!payload.assetId || !payload.version) {
      throw new Error('journal: version.activated 必须带 assetId 与 version')
    }
  }
}

/** 文件末尾是否为换行（空文件/不存在视作干净起点；残行后 append 需先补换行） */
async function endsWithNewline(file: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, 'r')
    const { size } = await fh.stat()
    if (size === 0) return true
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    return buf[0] === 10
  } catch {
    return true
  } finally {
    await fh?.close()
  }
}
