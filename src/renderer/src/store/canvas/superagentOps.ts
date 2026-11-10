import type {
  SuperAgentBoardSnapshot,
  SuperAgentExpertInfo,
  SuperAgentTaskView
} from '@shared/ipc'
import type { CanvasState } from '../canvasStore'
import type { StoreSet } from './chatRuntime'
import { BRIDGE_AVAILABLE } from './shared'

/**
 * SuperAgent 协作域（架构图 to-be ② 的渲染端）：任务板 + 专家池 + 取消/改需求。
 *
 * 事实源在主进程的 journal，这里只保存「最近一次投影」：
 * - 收到 task:event 就重新拉一次 board（不自己推演状态，避免投影分叉）；
 * - 任务板浮层打开时也主动刷新一次（用户手动打开要看到最新）；
 * - 运行中标记以主进程的 runningTaskIds 为准（进程重启后不会残留假「在跑」）。
 */

export interface SuperAgentOpsDeps {
  set: StoreSet
  get: () => CanvasState
  showToast: CanvasState['showToast']
}

/** 页面上最多保留的任务行（journal 可以很长，浮层只展示最近的） */
const MAX_TASK_ROWS = 60

export function createSuperAgentOps(deps: SuperAgentOpsDeps) {
  const { set, get, showToast } = deps

  const applySnapshot = (snapshot: SuperAgentBoardSnapshot | undefined | null): void => {
    // 浏览器预览等环境下 IPC 可能返回空值：按「没有任务」处理，不让面板崩掉
    if (!snapshot || !Array.isArray(snapshot.tasks)) return
    const running = new Set(snapshot.runningTaskIds ?? [])
    const tasks = snapshot.tasks
      .slice(-MAX_TASK_ROWS)
      .map((task) => ({ task, running: running.has(task.taskId) }))
      .reverse()
    set({ superAgentTasks: tasks, superAgentRunning: snapshot.runningTaskIds ?? [] })
  }

  /** 拉取任务板投影（事件触发 / 浮层打开 / 工作区切换后都走它） */
  const refreshSuperAgent = async (): Promise<void> => {
    if (!BRIDGE_AVAILABLE || !get().workspace) return
    const result = await window.huabu.superagent.board()
    if (!result.ok) {
      // 未打开工作区是常态（选择页），不当错误提示
      return
    }
    applySnapshot(result.value)
  }

  /** 专家池清单（注册表是静态的，工作区切换后拉一次即可） */
  const refreshSuperAgentExperts = async (): Promise<void> => {
    if (!BRIDGE_AVAILABLE || !get().workspace) return
    const result = await window.huabu.superagent.experts()
    if (!result.ok) return
    set({ superAgentExperts: Array.isArray(result.value) ? result.value : [] })
  }

  /** 取消运行中的任务（界面上任务板 attention/running 行的「停止」） */
  const cancelSuperAgentTask = async (taskId: string): Promise<void> => {
    if (!BRIDGE_AVAILABLE) return
    const result = await window.huabu.superagent.cancelTask(taskId)
    if (!result.ok) {
      showToast(result.error)
      return
    }
    showToast('已请求取消，任务会转为止步（blocked）')
    await refreshSuperAgent()
  }

  /**
   * 用户直连专家改需求：追加 user.changed 事实（不改任务状态）。
   * 主 Agent 下一轮读到 journal 就能感知，不需要用户再去对话里复述一遍。
   */
  const appendSuperAgentUserChange = async (taskId: string, prompt: string): Promise<boolean> => {
    if (!BRIDGE_AVAILABLE) return false
    const result = await window.huabu.superagent.appendUserChange({ taskId, prompt })
    if (!result.ok) {
      showToast(`改需求失败：${result.error}`)
      return false
    }
    showToast('已记录需求变更，主 Agent 下一轮会读到')
    return true
  }

  /** 任务事件 → 重拉投影（事件本身只是「有变化」的信号，不参与状态推导） */
  const handleTaskEvent = (): void => {
    void refreshSuperAgent()
  }

  /**
   * 重派 attention/blocked 任务：用原 scope/prompt/accept 再派一次（新 taskId）。
   * 原任务的失败原因仍留在 journal，重派是追加事实而不是覆盖——可回放性不受影响。
   */
  const redispatchSuperAgentTask = async (task: SuperAgentTaskView): Promise<void> => {
    if (!BRIDGE_AVAILABLE) return
    const prompt = task.prompt ?? task.title ?? ''
    if (!task.scope || !prompt) {
      showToast('这条任务缺少原始描述，无法自动重派；请在对话里重新说明需求')
      return
    }
    const result = await window.huabu.superagent.runTask({
      scope: task.scope,
      prompt,
      accept: task.accept ?? [],
      ...(task.expert ? { expert: task.expert } : {})
    })
    if (!result.ok) {
      showToast(`重派失败：${result.error}`)
      return
    }
    showToast(`已重派为 ${result.value.taskId}`)
    await refreshSuperAgent()
  }

  return {
    superAgentTasks: [] as Array<{ task: SuperAgentTaskView; running: boolean }>,
    superAgentExperts: [] as SuperAgentExpertInfo[],
    superAgentRunning: [] as string[],
    refreshSuperAgent,
    refreshSuperAgentExperts,
    cancelSuperAgentTask,
    redispatchSuperAgentTask,
    appendSuperAgentUserChange,
    handleTaskEvent,
    /** @internal 供工作区切换清理用 */
    resetSuperAgent: (): void => set({ superAgentTasks: [], superAgentRunning: [] })
  }
}

export type { SuperAgentTaskView }
