/**
 * 会话 ↔ 任务绑定（运行期，一次交付的归属）。
 *
 * 为什么需要这一层：一个工作区可以同时有多个会话在跑，而任务事实只有 journal 一份。
 * 「我现在在做哪个任务」其实是**会话级**的问题——取全局「最近开工的 doing」时，
 * A 会话开了任务、B 会话再开一个，A 继续写文件就会记到 B 的任务上（B 一开工就
 * 改写了 A 的归属），A 反而因为没产物退回待办。
 *
 * 这里只放内存映射：
 * - 任务事实仍只有 journal（不引入第二份持久任务状态，重启也不会与磁盘打架）；
 * - 未绑定/绑定已失效（任务收工、被别处放弃）时回退全局最近开工，保留旧行为；
 * - 继续旧任务由 `start_task` 显式按 id 绑定，不按创建顺序猜。
 */
import type { WorkState } from '../store/tasks'
import type { Task } from '../core/task'

const bindings = new Map<string, string>()

/** 任务开工/继续时绑定到会话 */
export function bindSessionTask(nodeId: string, taskId: string): void {
  if (nodeId) bindings.set(nodeId, taskId)
}

/**
 * 解绑。带 taskId 时只在仍指向该任务时解绑——收工 A 不能顺手抹掉同一会话
 * 后来绑上的 B（交错执行时事件顺序不保证）。
 */
export function unbindSessionTask(nodeId: string, taskId?: string): void {
  const bound = bindings.get(nodeId)
  if (!bound) return
  if (taskId && bound !== taskId) return
  bindings.delete(nodeId)
}

export function sessionTaskId(nodeId: string | undefined): string | undefined {
  return nodeId ? bindings.get(nodeId) : undefined
}

/**
 * 这个会话当前在执行的任务：只看会话绑定，**不回退全局**。
 *
 * 为什么坚决不回退：未绑定的会话（刚恢复、或刚收工）继续写文件时，
 * 全局「最近开工」可能是**另一个会话**的任务——产物会被记错人、那个任务被
 * 伪造成「有产出」。没有绑定就没有归属，产物只落盘不记账；要继续旧任务，
 * 用 start_task 按 id 显式接续（journal 照常可读）。
 */
export function taskForSession(state: WorkState, nodeId: string | undefined): Task | undefined {
  const boundId = sessionTaskId(nodeId)
  if (!boundId) return undefined
  const bound = state.tasks.find((task) => task.id === boundId)
  return bound?.status === 'doing' ? bound : undefined
}

/** 仅测试用：清空绑定表（模块级状态不能在用例之间串） */
export function resetSessionTasks(): void {
  bindings.clear()
}
