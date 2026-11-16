/**
 * 工作区 Loop 的读写边界（施工计划 v4 §7、§10 第 5 步）。
 *
 * 把「纯逻辑」和「碰磁盘」分开：`core/*` 与 `loop/context.ts` 只处理字符串与类型，
 * 真正读 `studio.md`、读 journal、写事件都在这里。这样上层可以单测，而这一层薄到
 * 一眼能看完。
 *
 * 一条硬约束：**任务事实写进既有的 `.huabu/journal.jsonl`**（§4 单一事实源）。
 * 因此这里不接受「自己 new 一个 journal」，而是要求调用方提供工作区已有的那个实例——
 * 同一个文件上有两个写入链会让追加顺序失去保证。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceJournal } from '../superagent/journal'
import { artifactOf, projectWork, type WorkEventType, type WorkState } from '../store/tasks'
import { taskForSession } from './sessionTask'
import { buildTurnContext } from './context'
import type { TaskToolDeps } from '../tools/taskTools'
import { STUDIO_FILE_REL } from '../core/memory'
import { currentArtifactId, type Task } from '../core/task'

/** 读常驻记忆；文件不存在按空处理（不是错误：新工作区还没有记忆文件） */
export async function readStudioContent(dir: string): Promise<string> {
  try {
    return await readFile(join(dir, STUDIO_FILE_REL), 'utf8')
  } catch {
    return ''
  }
}

/** 读 journal 并投影出任务与产物 */
export async function loadWorkState(journal: WorkspaceJournal): Promise<WorkState> {
  return projectWork(await journal.read())
}

/** 当前任务的当前版本路径（没有产物时不带这个字段） */
function currentArtifactPathOf(state: WorkState, task: Task): { currentArtifactPath?: string } {
  const artifact = artifactOf(state, currentArtifactId(task))
  return artifact ? { currentArtifactPath: artifact.path } : {}
}

/**
 * 装配本轮的上下文字符串（记忆 + 当前任务）。
 *
 * 顺序固定为「记忆在前、任务在后」：同一个任务的多轮之间前缀一致，只有尾部在变，
 * 让 prompt 缓存能命中。
 */
export async function buildWorkspaceContext(input: {
  dir: string
  journal: () => WorkspaceJournal
  /**
   * 会话 id：本轮上下文里展示的任务跟着会话走。
   * 同一工作区多会话并行时，全局「最近开工」会让 A 的上下文串成 B 的任务。
   */
  nodeId?: string
}): Promise<string> {
  const [studio, state] = await Promise.all([readStudioContent(input.dir), loadWorkState(input.journal())])
  const task = taskForSession(state, input.nodeId, input.dir)
  return buildTurnContext({
    studioContent: studio,
    ...(task ? { task, ...currentArtifactPathOf(state, task) } : {})
  })
}

/**
 * 任务工具的运行依赖。
 *
 * `currentDir` / `journal` 都是**惰性**的：切工作区后要指向新工作区，
 * 闭包住装配时的目录会让工具写进上一个工作区的 journal。
 */
export function taskToolDeps(options: {
  journal: () => WorkspaceJournal
  currentDir: () => string | null
  newTaskId: () => string
  /** 事实追加成功后通知渲染端（宿主播 `work:changed`） */
  onAppend?: () => void
  /** 任务开工/继续：把它绑定到当前会话（宿主注入，见 loop/sessionTask.ts） */
  onTaskStarted?: (taskId: string) => void
  /** 任务收工/放弃：解除该会话的绑定 */
  onTaskClosed?: (taskId: string) => void
}): TaskToolDeps {
  return {
    currentDir: options.currentDir,
    newTaskId: options.newTaskId,
    load: () => loadWorkState(options.journal()),
    append: async (type: WorkEventType, taskId: string, payload?: Record<string, unknown>) => {
      await options.journal().append(type, taskId, 'main', payload ?? {})
      options.onAppend?.()
    },
    ...(options.onTaskStarted ? { onTaskStarted: options.onTaskStarted } : {}),
    ...(options.onTaskClosed ? { onTaskClosed: options.onTaskClosed } : {})
  }
}
