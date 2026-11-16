import type {
  ChatResult,
  SuperAgentBoardSnapshot,
  SuperAgentExpertInfo,
  SuperAgentTaskConversation,
  SuperAgentTaskView,
  SuperAgentWorkStateView,
  TaskEvent
} from '@shared/ipc'
import { buildOwnership, type ArtifactOwner } from '../../lib/artifactOwnership'
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
  let boardSequence = 0
  let workSequence = 0
  let expertsSequence = 0

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
    const dir = get().workspace?.path
    if (!BRIDGE_AVAILABLE || !dir) return
    const requestId = ++boardSequence
    const result = await window.huabu.superagent.board()
    if (!result.ok) {
      // 未打开工作区是常态（选择页），不当错误提示
      return
    }
    // 工作区已切换：旧请求的回包按「不属于当前画布」丢弃，不能把旧板刷回来
    if (requestId !== boardSequence || get().workspace?.path !== dir) return
    applySnapshot(result.value)
  }

  /**
   * 新任务模型的投影（施工计划 v4）。与旧板并存：旧板读 task.*，这里读 work.*。
   *
   * 一次拉取同时更新三样东西：原始投影、面板分组、产物归属表。
   * 归属表在这里算好，画布卡片按路径查，避免每张卡各算一遍。
   */
  const refreshWorkItems = async (): Promise<void> => {
    const dir = get().workspace?.path
    if (!BRIDGE_AVAILABLE || !dir) return
    const requestId = ++workSequence
    const result = await window.huabu.superagent.workState()
    if (!result.ok) return
    // 同上：切换工作区后到达的旧投影直接丢，否则新画布会短暂显示别的工作区的任务
    if (requestId !== workSequence || get().workspace?.path !== dir) return
    const state = result.value
    set({
      workState: state,
      workItems: state.tasks ?? [],
      artifactOwners: buildOwnership(state.tasks ?? [], state.artifacts ?? [])
    })
  }

  /** 放弃一个任务（用户的显式操作；已完成的任务主进程会拒绝） */
  const dropWorkItem = async (taskId: string): Promise<void> => {
    if (!BRIDGE_AVAILABLE) return
    const result = await window.huabu.superagent.dropTask(taskId)
    if (!result.ok) {
      showToast(`放弃失败：${result.error}`)
      return
    }
    showToast(`已放弃 ${taskId}`)
    await refreshWorkItems()
  }

  /** 专家池清单（注册表是静态的，工作区切换后拉一次即可） */
  const refreshSuperAgentExperts = async (): Promise<void> => {
    const dir = get().workspace?.path
    if (!BRIDGE_AVAILABLE || !dir) return
    const requestId = ++expertsSequence
    const result = await window.huabu.superagent.experts()
    if (!result.ok || requestId !== expertsSequence || get().workspace?.path !== dir) return
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
    // 超时未收口 ≠ 已停止（A08）：不能对用户宣称已经停了
    showToast(
      result.value?.state === 'stopping'
        ? '已发出取消请求，但任务还没收口（模型或工具仍在等待）；稍后确认看板状态'
        : '已取消，任务转为受阻（blocked）'
    )
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
  const handleTaskEvent = (event: TaskEvent): void => {
    // 专家流式片段只供详情页实时渲染，不触发 board 全量重拉
    if (event.type.startsWith('task.expert_')) return
    /*
     * 唯一权威激活入口（A01）：主进程在验收通过并写 `version.activated` 之后发这个事件。
     * 画布收到媒体任务成功时只记候选，等这里才把候选提升为正式版本——否则「未验收 /
     * 已取消 / shadow」的产物会被当成当前版本供下游引用。
     */
    if (event.type === 'task.activated') {
      // 用事件自带的产物路径定位（R01）：任务级激活会连带激活失败尝试的候选
      get().activateCandidateForTask(event.taskId, event.path ?? '')
    }
    void refreshSuperAgent()
  }

  /**
   * 读取某个任务的专家内部对话（只读回放）。
   * 不在 store 里缓存：任务板详情是短生命周期视图，打开/轮询时现拉最新，
   * 避免与主进程的 memory 落库产生第二份可能过期的投影。
   */
  const loadSuperAgentConversation = async (
    taskId: string
  ): Promise<ChatResult<SuperAgentTaskConversation>> => {
    if (!BRIDGE_AVAILABLE || !get().workspace) {
      return { ok: false, code: 'cwd_rejected', error: '尚未打开工作区' }
    }
    try {
      return await window.huabu.superagent.conversation(taskId)
    } catch (error) {
      // Web 桥在 channel 未注册/连接断开时是 reject 而不是 {ok:false}：
      // 统一折成 ChatResult，详情弹窗才能展示错误而不是留下未处理的 rejection。
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        code: 'unknown',
        error: message.length > 500 ? `${message.slice(0, 500)}…` : message
      }
    }
  }

  /**
   * 重派 attention/blocked 任务。
   *
   * 输入由主进程按 journal 的 `task.created.spec` 重建（A10）——渲染端只给旧 taskId，
   * 不再自己拼载荷。此前只传 scope/prompt/accept/expert，参考资产、邻接镜、负面约束、
   * 分层提示与自定义 lane 全丢，「重派」等于换了个任务重做。
   */
  const redispatchSuperAgentTask = async (task: SuperAgentTaskView): Promise<void> => {
    if (!BRIDGE_AVAILABLE) return
    const result = await window.huabu.superagent.redispatchTask(task.taskId)
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
    workItems: [] as SuperAgentWorkStateView['tasks'],
    workState: null as SuperAgentWorkStateView | null,
    artifactOwners: new Map<string, ArtifactOwner>(),
    refreshSuperAgent,
    refreshSuperAgentExperts,
    refreshWorkItems,
    dropWorkItem,
    cancelSuperAgentTask,
    redispatchSuperAgentTask,
    appendSuperAgentUserChange,
    loadSuperAgentConversation,
    handleTaskEvent,
    /** @internal 供工作区切换清理用 */
    resetSuperAgent: (): void => {
      boardSequence += 1
      workSequence += 1
      expertsSequence += 1
      set({ superAgentTasks: [], superAgentRunning: [], workItems: [], workState: null, artifactOwners: new Map() })
    }
  }
}

export type { SuperAgentTaskView }
