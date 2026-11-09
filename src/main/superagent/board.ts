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
  /** 允许写的路径前缀（task.created/assigned payload.lane，专家写区白名单） */
  lane?: string
  /** 被指派的专家（task.assigned payload.expert） */
  expert?: string
  /** 验收轮次（validation.failed 计数，超限由主 Agent 转 blocked） */
  attempts: number
  /** 最近一次候选产物（artifact.ready payload.artifactId） */
  lastArtifactId?: string
  /** 最近一次验收结论（validation.passed/failed payload.reason） */
  lastReason?: string
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
      const created: BoardTask = { taskId: event.taskId, status: 'todo', attempts: 0, updatedAt: event.at }
      tasks.set(event.taskId, created)
      return created
    }
    const task = base()
    const payload = event.payload as Record<string, unknown>
    switch (event.type) {
      case 'task.created': {
        task.status = 'todo'
        if (typeof payload.title === 'string') task.title = payload.title
        if (typeof payload.lane === 'string') task.lane = payload.lane
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
        task.status = 'done'
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
      case 'version.activated': {
        // 版本激活是 accept 的下游事实：任务保持 done
        break
      }
      case 'user.changed': {
        // 用户直连专家会话的改动：不改任务状态，仅记录（回执经事件总线通知主 Agent）
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
