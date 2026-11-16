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
  /**
   * 终态事件（C5）：`task.started` 之后进程崩溃 / 用户取消 / 超时 / 被重派顶替，
   * journal 原本没有任何事件能把 active 收掉，投影就永久挂着一条幽灵 active——
   * 重启后 running 表为空，cancel 也拿不到 controller，这条任务再也改不动。
   * 三个终态各自成事件（而不是复用 artifact.rejected），因为语义不同：
   * 前者是「任务没跑完」，后者是「专家判明做不出」。
   */
  | 'task.cancelled'
  | 'task.timed_out'
  | 'task.superseded'
  /**
   * 需求在验收前后发生变化（A05）：产物按**旧**需求验收通过，但不能据此激活——
   * 活化前必须核对需求版本。单独成事件而不是复用 validation.failed，因为语义不同：
   * 前者是「结果过时」，后者是「结果不达标」。
   */
  | 'requirement.stale'
  /**
   * 新任务模型的四类事实（施工计划 v4 §3）。用 `work.*` 而不是复用 `task.*`：
   * 旧的 `task.created` / `task.started` 属于扁平看板，payload 与状态机都不同，
   * 同名会让人分不清是哪套模型投影出来的。旧事件在过渡期照旧可读（步骤 6 清理）。
   *
   * - `work.created`  payload {title, brief, lane, kind} → 建一个 todo 任务
   * - `work.started`  → doing
   * - `artifact.recorded` payload {path, kind, mime, bytes, params?} → 记一版产物
   * - `work.finished` → 有产物则 done，否则回到 todo（没做出来不算完成）
   * - `work.dropped`  → 放弃
   */
  | 'work.created'
  | 'work.started'
  | 'artifact.recorded'
  | 'work.finished'
  | 'work.dropped'

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
  /** 验收所依据的需求版本（A05）：与当前版本不一致即不得激活 */
  requirementRevision?: number
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
    // 按 id 去重（C9）：journal 被外部复制/合并，或调用方拿同一 taskId 重跑时会出现
    // 重复行；投影按条数累加（attempts++ / staging.push）照样会膨胀。事实源里同一
    // 条事实只应生效一次。
    const seen = new Set<string>()
    for (const line of raw.split(String.fromCharCode(10))) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as JournalEvent
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && typeof parsed.type === 'string') {
          if (seen.has(parsed.id)) continue
          seen.add(parsed.id)
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
  } catch (error) {
    // 只有「文件还不存在」才算干净起点。其它错误（EMFILE 之类的 fd 耗尽、权限）不能
    // 假装干净：若末尾其实是残行，补一个换行的代价是多一个空行（read 会跳过），
    // 不补则下一条 append 会粘进坏行，整条事实被 read() 丢弃（C11）。
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  }
  try {
    const { size } = await fh.stat()
    if (size === 0) return true
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    return buf[0] === 10
  } catch {
    return false
  } finally {
    await fh?.close()
  }
}
