/**
 * Task —— 一次交付请求（原子 2/3）。见施工计划 §3。
 *
 * 四个状态，就这些：
 *   todo ──► doing ──► done
 *     ▲         │
 *     └─────────┘   （这一轮没产出，回到 todo，可重来）
 *   任意非终态 ──► dropped
 *
 * **没有 review / validating / attention**：判定是动作（模型看图 / 用户看图），
 * 不满意就再产出一个 Artifact —— 那条路径不需要任何状态。
 *
 * 状态只服务两件事：重启后知道哪些在途、界面上知道做到哪了。**不服务质量判断。**
 *
 * 本模块是纯的：所有迁移都是 (Task, 参数) → 新 Task，不改原对象、不碰 IO。
 */

export type TaskStatus = 'todo' | 'doing' | 'done' | 'dropped'

/** 决定工具集与默认写区的任务类型（原「能力 profile」落到一个字段） */
export type TaskKind = 'image' | 'video' | 'text'

export interface Task {
  readonly id: string
  readonly title: string
  /** 要做什么。验收口径也写在这里，是给模型的说明，不是待勾选的清单。 */
  readonly brief: string
  /** 可写范围（工作区相对路径前缀）；越界写入不产生产物 */
  readonly lane: string
  readonly kind: TaskKind
  readonly status: TaskStatus
  /** 依次产出的产物 id，最后一个是当前版 */
  readonly artifacts: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface TaskInput {
  title: string
  brief: string
  lane: string
  kind: TaskKind
}

export interface TaskMeta {
  id: string
  createdAt: string
}

/** 非法迁移（终态不可重开、todo 上不能记产物等）一律抛错，不静默兜底 */
export class TaskTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskTransitionError'
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'done' || status === 'dropped'
}

export function createTask(input: TaskInput, meta: TaskMeta): Task {
  const title = input.title.trim()
  const brief = input.brief.trim()
  if (!title) throw new TaskTransitionError('任务标题不能为空')
  if (!brief) throw new TaskTransitionError('任务 brief 不能为空（没有说明就没有交付目标）')
  // 类型层挡不住运行时数据：journal 回放、模型入参都可能送进任意字符串
  if (!['image', 'video', 'text'].includes(input.kind)) {
    throw new TaskTransitionError(`未知任务类型：${String(input.kind)}（只能是 image / video / text）`)
  }
  const lane = input.lane.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!lane) throw new TaskTransitionError('任务 lane 不能为空（写区是交付的边界）')
  return {
    id: meta.id,
    title,
    brief,
    lane,
    kind: input.kind,
    status: 'todo',
    artifacts: [],
    createdAt: meta.createdAt,
    updatedAt: meta.createdAt
  }
}

/** todo → doing。已在 doing 幂等；终态不可重开。 */
export function startTask(task: Task, at: string): Task {
  if (task.status === 'doing') return task
  if (isTerminal(task.status)) {
    throw new TaskTransitionError(`任务 ${task.id} 已是终态 ${task.status}，不能重新开始`)
  }
  return { ...task, status: 'doing', updatedAt: at }
}

/**
 * 记一次产物。只允许落在 `doing` 的任务上——产物必须归属一个正在执行的任务，
 * 否则「这条文件是干什么的」就无从追溯。
 */
export function recordArtifact(task: Task, artifactId: string, at: string): Task {
  if (task.status !== 'doing') {
    throw new TaskTransitionError(`任务 ${task.id} 处于 ${task.status}，只有 doing 的任务能记产物`)
  }
  const id = artifactId.trim()
  if (!id) throw new TaskTransitionError('产物 id 不能为空')
  return { ...task, artifacts: [...task.artifacts, id], updatedAt: at }
}

/**
 * 收工。
 *
 * - 有产物 → done（这一轮结束了，东西留下了）
 * - 无产物 → 回到 todo（没做出东西，不算完成；重启后不会被当成在途）
 *
 * 这就是「任务完成 = 有产物且这一轮结束」的全部实现（计划 §9 规则 2）。
 */
export function finishTask(task: Task, at: string): Task {
  if (task.status === 'done') return task
  if (task.status === 'dropped') {
    throw new TaskTransitionError(`任务 ${task.id} 已放弃，不能收工`)
  }
  if (task.status === 'todo') {
    throw new TaskTransitionError(`任务 ${task.id} 还没开始，不能收工`)
  }
  const nextStatus: TaskStatus = task.artifacts.length > 0 ? 'done' : 'todo'
  return { ...task, status: nextStatus, updatedAt: at }
}

/** 放弃。终态 done 不可撤销（东西已经交付，要撤只能新建任务）。 */
export function dropTask(task: Task, at: string): Task {
  if (task.status === 'dropped') return task
  if (task.status === 'done') {
    throw new TaskTransitionError(`任务 ${task.id} 已完成，不能放弃`)
  }
  return { ...task, status: 'dropped', updatedAt: at }
}

/** 当前版本 = 最后一个产物。没有产物时返回 undefined。 */
export function currentArtifactId(task: Task): string | undefined {
  return task.artifacts.length > 0 ? task.artifacts[task.artifacts.length - 1] : undefined
}

/** 产物是否落在任务的写区内（前缀匹配，按路径段对齐，避免 `assets/a` 命中 `assets/ab`） */
export function isWithinLane(lane: string, path: string): boolean {
  const normalizedLane = lane.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const normalizedPath = path.trim().replace(/\\/g, '/').replace(/^\/+/g, '')
  if (!normalizedLane || !normalizedPath) return false
  return normalizedPath === normalizedLane || normalizedPath.startsWith(`${normalizedLane}/`)
}
