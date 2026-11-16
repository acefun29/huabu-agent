/**
 * 会话 ↔ 任务绑定（运行期，一次交付的归属）。
 *
 * 为什么需要这一层：一个工作区可以同时有多个会话在跑，而任务事实只有 journal 一份。
 * 「我现在在做哪个任务」其实是**会话级**的问题——取全局「最近开工的 doing」时，
 * A 会话开了任务、B 会话再开一个，A 继续写文件就会记到 B 的任务上。
 *
 * 绑定同时按 **工作区 + 会话** 定位：
 * - 只按 nodeId 会跨工作区漏记——两个工作区里同名会话（画布节点 id 可重复）会共享
 *   同一条绑定，切走后重开的会话直接继承了别的工作区的任务；
 * - 工作区切换会成批释放该工作区的绑定（见 clearSessionTasksForWorkspace）。
 *
 * 这里只放内存映射：任务事实仍只有 journal（不引入第二份持久任务状态）；
 * 未绑定/绑定已失效的会话没有归属，产物只落盘不记账——宁可少记，也不记错人。
 */
import type { WorkState } from '../store/tasks'
import type { Task } from '../core/task'

interface SessionBinding {
  /** 绑定发生在哪个工作区（路径即身份；两个工作区即使内容复制自同一份也互不相通） */
  workspaceDir: string
  taskId: string
}

const bindings = new Map<string, SessionBinding>()

/** 任务开工/继续时绑定到会话 */
export function bindSessionTask(nodeId: string, workspaceDir: string, taskId: string): void {
  if (!nodeId || !workspaceDir) return
  bindings.set(nodeId, { workspaceDir, taskId })
}

/**
 * 解绑。带 taskId 时只在仍指向该任务时解绑——收工 A 不能顺手抹掉同一会话
 * 后来绑上的 B（交错执行时事件顺序不保证）。
 */
export function unbindSessionTask(nodeId: string, taskId?: string): void {
  const bound = bindings.get(nodeId)
  if (!bound) return
  if (taskId && bound.taskId !== taskId) return
  bindings.delete(nodeId)
}

/** 该会话在**这个工作区**里绑定的任务号；工作区不符即视为未绑定（旧工作区的绑定不复用） */
export function sessionTaskId(nodeId: string | undefined, workspaceDir: string | null): string | undefined {
  if (!nodeId || !workspaceDir) return undefined
  const bound = bindings.get(nodeId)
  if (!bound || bound.workspaceDir !== workspaceDir) return undefined
  return bound.taskId
}

/**
 * 这个会话当前在执行的任务：只看会话绑定，**不回退全局**。
 *
 * 为什么坚决不回退：未绑定的会话（刚恢复、或刚收工）继续写文件时，
 * 全局「最近开工」可能是**另一个会话**的任务——产物会被记错人、那个任务被
 * 伪造成「有产出」。没有绑定就没有归属；要继续旧任务，用 start_task 按 id
 * 显式接续（journal 照常可读）。
 */
export function taskForSession(
  state: WorkState,
  nodeId: string | undefined,
  workspaceDir: string | null
): Task | undefined {
  const boundId = sessionTaskId(nodeId, workspaceDir)
  if (!boundId) return undefined
  const bound = state.tasks.find((task) => task.id === boundId)
  return bound?.status === 'doing' ? bound : undefined
}

/**
 * 工作区生命周期收口：切工作区/删工作区时把该工作区的绑定整批释放。
 *
 * 只清该工作区——别的窗口/工作区的会话不受影响。不传工作区（进程退出）时全清。
 */
export function clearSessionTasksForWorkspace(workspaceDir?: string): void {
  if (!workspaceDir) {
    bindings.clear()
    return
  }
  for (const [nodeId, bound] of bindings) {
    if (bound.workspaceDir === workspaceDir) bindings.delete(nodeId)
  }
}

/** 仅测试用：清空绑定表（模块级状态不能在用例之间串） */
export function resetSessionTasks(): void {
  bindings.clear()
}
