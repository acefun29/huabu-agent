/**
 * 任务状态的投影与持久化（施工计划 v4 §3、§7）。
 *
 * **不另起一套日志**：任务事实仍然写进 `.huabu/journal.jsonl`（唯一事实源，§4 事实层）。
 * 本模块只做两件事：
 * 1. 把 journal 里 `work.*` / `artifact.recorded` 五类事件**投影**成 Task / Artifact（纯函数）；
 * 2. 提供一个薄薄的追加入口，让工具层能写这三类事件。
 *
 * 设计取向（v4 反复强调的那条）：状态只服务「恢复」与「展示」，不服务质量判断。
 * 因此这里没有 verdict、没有 review、没有 validating——只有四个状态和产物列表。
 */

import type { Artifact, ArtifactKind } from '../core/artifact'
import { createArtifact } from '../core/artifact'
import {
  createTask,
  dropTask,
  finishTask,
  recordArtifact,
  startTask,
  type Task,
  type TaskKind
} from '../core/task'
import type { JournalEvent } from '../superagent/journal'

/** 新任务模型读写的事件类型（旧 `task.*` 仍由 board.ts 投影，过渡期并存） */
export const WORK_EVENT_TYPES = [
  'work.created',
  'work.started',
  'artifact.recorded',
  'work.finished',
  'work.dropped'
] as const

export type WorkEventType = (typeof WORK_EVENT_TYPES)[number]

export function isWorkEvent(event: JournalEvent): boolean {
  return (WORK_EVENT_TYPES as readonly string[]).includes(event.type)
}

export interface WorkState {
  /** 按创建顺序 */
  tasks: Task[]
  artifacts: Artifact[]
  /** 回放时无法应用的事件（历史事实不可撤销，但必须让人看见） */
  ignored: Array<{ eventId: string; type: string; reason: string }>
}

const TASK_KINDS: readonly TaskKind[] = ['image', 'video', 'text']
const ARTIFACT_KINDS: readonly ArtifactKind[] = ['image', 'video', 'audio', 'text']

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * journal → 任务与产物（纯函数）。
 *
 * 回放遇到非法迁移（例如对一个已 done 的任务再 start）不中断：把它记进 `ignored`
 * 继续往下走。历史事件是既成事实，投影要做的是**如实报告**，而不是假装没发生。
 */
export function projectWork(events: readonly JournalEvent[]): WorkState {
  const tasks = new Map<string, Task>()
  const order: string[] = []
  const artifacts: Artifact[] = []
  const ignored: WorkState['ignored'] = []

  const ignore = (event: JournalEvent, reason: string): void => {
    ignored.push({ eventId: event.id, type: event.type, reason })
  }

  for (const event of events) {
    try {
      switch (event.type) {
        case 'work.created': {
          if (tasks.has(event.taskId)) {
            ignore(event, '同一任务重复创建')
            break
          }
          const kind = asString(event.payload.kind) as TaskKind
          if (!TASK_KINDS.includes(kind)) {
            ignore(event, `未知任务类型：${String(event.payload.kind)}`)
            break
          }
          const task = createTask(
            {
              title: asString(event.payload.title),
              brief: asString(event.payload.brief),
              lane: asString(event.payload.lane),
              kind
            },
            { id: event.taskId, createdAt: event.at }
          )
          tasks.set(task.id, task)
          order.push(task.id)
          break
        }
        case 'work.started': {
          const task = tasks.get(event.taskId)
          if (!task) {
            ignore(event, '任务不存在')
            break
          }
          tasks.set(task.id, startTask(task, event.at))
          break
        }
        case 'artifact.recorded': {
          const task = tasks.get(event.taskId)
          if (!task) {
            ignore(event, '任务不存在')
            break
          }
          const kind = asString(event.payload.kind) as ArtifactKind
          if (!ARTIFACT_KINDS.includes(kind)) {
            ignore(event, `未知产物类型：${String(event.payload.kind)}`)
            break
          }
          const artifact = createArtifact(
            {
              path: asString(event.payload.path),
              kind,
              mime: asString(event.payload.mime) || 'application/octet-stream',
              bytes: typeof event.payload.bytes === 'number' ? event.payload.bytes : 0,
              ...(event.payload.params && typeof event.payload.params === 'object'
                ? { params: event.payload.params as Record<string, unknown> }
                : {}),
              taskId: task.id
            },
            { id: event.id, createdAt: event.at }
          )
          // 先迁移任务再落产物：recordArtifact 会因「任务不在 doing」抛错，
          // 那时产物不能已经进了状态（否则状态里会多出一个没人认领的文件）
          const next = recordArtifact(task, artifact.id, event.at)
          artifacts.push(artifact)
          tasks.set(task.id, next)
          break
        }
        case 'work.finished': {
          const task = tasks.get(event.taskId)
          if (!task) {
            ignore(event, '任务不存在')
            break
          }
          tasks.set(task.id, finishTask(task, event.at))
          break
        }
        case 'work.dropped': {
          const task = tasks.get(event.taskId)
          if (!task) {
            ignore(event, '任务不存在')
            break
          }
          tasks.set(task.id, dropTask(task, event.at))
          break
        }
        default:
          break
      }
    } catch (error) {
      ignore(event, error instanceof Error ? error.message : String(error))
    }
  }

  return { tasks: order.map((id) => tasks.get(id)!), artifacts, ignored }
}

/**
 * 投影里「最近开工」的那个 doing。
 *
 * **不要用它决定产物归属**：一个工作区可以同时有多个会话在跑，任务归属是会话级的
 * （见 loop/sessionTask.ts）。用它当「当前任务」会把 A 的产物记给 B 刚开的任务。
 * 保留它只作为投影层的通用查询（列表、调试、测试）。
 */
export function activeTask(state: WorkState): Task | undefined {
  for (let index = state.tasks.length - 1; index >= 0; index -= 1) {
    const task = state.tasks[index]!
    if (task.status === 'doing') return task
  }
  return undefined
}

/** 按 id 找产物 */
export function artifactOf(state: WorkState, artifactId: string | undefined): Artifact | undefined {
  if (!artifactId) return undefined
  return state.artifacts.find((artifact) => artifact.id === artifactId)
}

/** 某个任务的全部产物（按产出顺序） */
export function artifactsOfTask(state: WorkState, task: Task): Artifact[] {
  return task.artifacts
    .map((id) => artifactOf(state, id))
    .filter((artifact): artifact is Artifact => artifact !== undefined)
}
