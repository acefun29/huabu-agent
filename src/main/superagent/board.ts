/**
 * 任务板投影（Mastra 迁移计划 v1.2 §9.4，SuperAgent Phase 4 基础）。
 *
 * board 不是事实源：由 journal 事件纯函数重建（同事件序列投影结果恒等）。
 * 状态机：todo → active → validating → done；失败带 diff 退回 attention
 * （主 Agent 重派/专家重试），缺参考/预算耗尽转 blocked。**没有 review 状态**
 * （计划 §1.1-3：不引入人工审批流水线）。
 */

import type { JournalEvent } from './journal'

/** 任务状态（计划 §9.4：不使用 review） */
export type BoardStatus = 'todo' | 'active' | 'validating' | 'blocked' | 'done' | 'attention'

export interface BoardTask {
  taskId: string
  status: BoardStatus
  /** 标题/描述（task.created payload.title） */
  title?: string
  /** 派单范围（task.created payload.scope；UI 上显示「第03集/第2场」） */
  scope?: string
  /** 完整任务描述（task.created payload.prompt；重派时原样复用） */
  prompt?: string
  /** 验收标准（task.created payload.accept；重派时原样复用） */
  accept?: string[]
  /** 允许写的路径前缀（task.created/assigned payload.lane，专家写区白名单） */
  lane?: string
  /** 被指派的专家（task.assigned payload.expert） */
  expert?: string
  /** shadow 任务（只出候选、不激活版本）：完成语义 = 验收通过，没有激活环节（R03） */
  shadow?: boolean
  /** 验收轮次（validation.failed 计数，超限由主 Agent 转 blocked） */
  attempts: number
  /** 最近一次候选产物（artifact.ready payload.artifactId） */
  lastArtifactId?: string
  /** 最近一次验收结论（validation.passed/failed payload.reason） */
  lastReason?: string
  /**
   * 用户直连专家改需求的时刻（user.changed）。
   *
   * 此前 user.changed 是纯 no-op：投影既不更新 prompt/accept，也不留痕。后果很实在——
   * 用户在专家对话里改了需求，`redispatchSuperAgentTask` 与主 Agent 的 list_tasks
   * 仍然读到旧 prompt，重派等于按旧需求重做一遍（C13）。
   */
  requirementChangedAt?: string
  /**
   * 需求版本号（A05）：`task.created` 记 1，每次 `user.changed` +1。
   *
   * 执行尝试、候选产物、验收结论与激活都必须绑定同一个 revision——否则「按 16:9 跑完、
   * 用户中途改成 4:3、旧结果照样按旧标准通过并激活」这条链就成立。投影只负责计数，
   * 比较与拦截在编排器。
   */
  requirementRevision: number
  updatedAt: string
}

/**
 * journal → board 投影（纯函数）。未识别事件不影响已有状态（向前兼容）。
 * 非法顺序（如未 created 就 started）按事件语义尽力推进——journal 是事实源，
 * 投影不做拒绝，只保证可重建。
 */
export function projectBoard(events: readonly JournalEvent[]): BoardTask[] {
  const tasks = new Map<string, BoardTask>()
  const apply = (event: JournalEvent) => {
    const base = (): BoardTask => {
      const existing = tasks.get(event.taskId)
      if (existing) return existing
      const created: BoardTask = { taskId: event.taskId, status: 'todo', attempts: 0, requirementRevision: 0, updatedAt: event.at }
      tasks.set(event.taskId, created)
      return created
    }
    // user.changed 只对已存在的任务有语义：用户对一条不存在/已清理的任务改需求，
    // 不该在任务板上凭空长出一条空 todo 行（投影不做拒绝，但也不该无中生有）
    if (event.type === 'user.changed' && !tasks.has(event.taskId)) return
    const task = base()
    const payload = event.payload as Record<string, unknown>
    /*
     * 终态保护（C12）：done 之后到达的重复 / 迟到 / 收尾事件都不得把任务打回
     * todo / validating / attention / blocked。journal 是 append-only 的，重放、
     * 重派、跨进程补写、取消竞态都会产生这类事件，投影必须收敛而不是摇摆——
     * 否则「已交付」的卡片会莫名回到「待开工」或被标成受阻。
     * blocked 不在保护对象之列：它本来就表示「可被重派救回来」。
     */
    if (
      task.status === 'done' &&
      (event.type === 'task.created' ||
        event.type === 'artifact.ready' ||
        event.type === 'validation.failed' ||
        event.type === 'task.cancelled' ||
        event.type === 'task.timed_out' ||
        event.type === 'task.superseded')
    ) {
      task.updatedAt = event.at
      return
    }
    switch (event.type) {
      case 'task.created': {
        task.status = 'todo'
        if (typeof payload.title === 'string') task.title = payload.title
        if (typeof payload.lane === 'string') task.lane = payload.lane
        if (typeof payload.scope === 'string') task.scope = payload.scope
        if (typeof payload.prompt === 'string') task.prompt = payload.prompt
        if (Array.isArray(payload.accept)) task.accept = payload.accept.map(String)
        // 需求基线（A05）：创建即 revision 1，之后每次 user.changed +1
        task.requirementRevision = 1
        if (payload.shadow === true) task.shadow = true
        break
      }
      case 'task.assigned': {
        // 重派不改运行状态：todo/attention 下的指派回到 todo
        if (task.status === 'todo' || task.status === 'attention') task.status = 'todo'
        if (typeof payload.expert === 'string') task.expert = payload.expert
        if (typeof payload.lane === 'string') task.lane = payload.lane
        break
      }
      case 'task.started': {
        if (task.status !== 'done') task.status = 'active'
        break
      }
      case 'artifact.ready': {
        // 候选产物就绪 → 进入机器验收（不是人工 review）
        task.status = 'validating'
        if (typeof payload.artifactId === 'string') task.lastArtifactId = payload.artifactId
        break
      }
      case 'artifact.rejected': {
        // 专家自身判定无法产出（缺参考等）→ blocked，交主 Agent 处理
        task.status = 'blocked'
        if (typeof payload.reason === 'string') task.lastReason = payload.reason
        break
      }
      case 'validation.passed': {
        /*
         * 完成状态要对应**完成事实**（R03）：正式交付的完成是 ersion.activated，
         * 验收通过只是「已验收、待激活」。此前在这里就置 done，随后取消分支追加的
         * task.cancelled 会被 done 终态保护忽略——runTask 返回 blocked、看板却显示完成。
         * shadow 没有激活环节，它的完成事实就是验收通过。
         */
        task.status = task.shadow ? 'done' : 'validating'
        task.lastReason = undefined
        break
      }
      case 'validation.failed': {
        // 失败带 diff 退回 attention（计划 §9.2：主 Agent 重派 / 专家重试）
        task.attempts += 1
        task.status = 'attention'
        if (typeof payload.reason === 'string') task.lastReason = payload.reason
        break
      }
      case 'requirement.stale': {
        /*
         * 需求在验收前后变了（A05）：产物按旧需求验收通过，但不得据此激活。
         * 退回 attention 让主 Agent / 用户决定——插话重做、重派，或把需求改回去。
         */
        task.status = 'attention'
        if (typeof payload.reason === 'string') task.lastReason = payload.reason
        break
      }
      case 'version.activated': {
        // 正式交付完成：非 shadow 任务的 done 由这里产生（R03）
        task.status = 'done'
        break
      }
      case 'user.changed': {
        /*
         * 用户直连专家改了需求：把新的 prompt/accept 落到投影上（任务不变态）。
         * 这一步不是记账，是修 bug——重派（redispatchSuperAgentTask）与主 Agent 的
         * list_tasks 都从投影读 prompt/accept，不更新就等于按旧需求重做一遍（C13）。
         */
        if (typeof payload.prompt === 'string' && payload.prompt.trim()) task.prompt = payload.prompt
        if (Array.isArray(payload.accept)) task.accept = payload.accept.map(String)
        task.requirementChangedAt = event.at
        task.requirementRevision += 1
        break
      }
      // 终态事件（C5）：取消 / 超时 / 被重派顶替。统一投影为 blocked——
      // 它已经表示「停下来、等主 Agent 处置」，且不扩宽 SuperAgentTaskStatus 这条
      // 对外契约；三种原因的区分留在 journal（事实源）与 lastReason 里。
      case 'task.cancelled':
      case 'task.timed_out':
      case 'task.superseded': {
        task.status = 'blocked'
        if (typeof payload.reason === 'string') task.lastReason = payload.reason
        break
      }
    }
    task.updatedAt = event.at
  }
  for (const event of events) apply(event)
  return [...tasks.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
}

/** 幂等重建校验（开发期断言用）：同一事件序列两次投影必须恒等 */
export function boardProjectionIsStable(events: readonly JournalEvent[]): boolean {
  const a = JSON.stringify(projectBoard(events))
  const b = JSON.stringify(projectBoard([...events]))
  return a === b
}
