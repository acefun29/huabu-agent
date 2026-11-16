import { useEffect, useMemo, useRef } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { ExpertAvatar } from './ExpertAvatar'
import { TASK_STATUS_META as STATUS_META, relativeTime } from './taskBoardMeta'

/**
 * 任务板浮层（架构图 to-be ② 的「任务板投影」可视面）：专家团状态条点开后的面板。
 *
 * 每行 = 头像 + 任务（title/scope）+ 状态标签。数据全部来自主进程 board 投影
 * （journal 是事实源），这里不推演状态；收到 task:event 时父层已触发重拉，浮层自动更新。
 *
 * 操作边界：
 * - 点任务行直接打开该任务的专家内部对话（只读回放），不再单设「打开对话/重派/编辑」按钮；
 * - 「停止」只对在跑的任务出现，用标准红色方形中止按钮（外层圆角方块 + 内层实心方块）。
 */
export function TeamPopover({
  onClose,
  onOpenConversation
}: {
  onClose: () => void
  /** 点任务行：把右侧对话坞切到该任务的专家对话 */
  onOpenConversation: (taskId: string) => void
}) {
  const tasks = useCanvasStore((s) => s.superAgentTasks)
  const workItems = useCanvasStore((s) => s.workItems)
  const refreshWorkItems = useCanvasStore((s) => s.refreshWorkItems)
  const dropWorkItem = useCanvasStore((s) => s.dropWorkItem)
  const experts = useCanvasStore((s) => s.superAgentExperts)
  const refresh = useCanvasStore((s) => s.refreshSuperAgent)
  const cancelTask = useCanvasStore((s) => s.cancelSuperAgentTask)
  const panelRef = useRef<HTMLDivElement>(null)

  // 新任务模型的事件不推送，打开面板时拉一次就够（投影很便宜）
  useEffect(() => {
    void refreshWorkItems()
  }, [refreshWorkItems])

  const expertLabel = useMemo(() => {
    const map = new Map(experts.map((expert) => [expert.id, expert.label]))
    return (id: string | undefined): string => (id ? (map.get(id) ?? id) : '未指派')
  }, [experts])

  // 打开即刷新一次：用户主动打开面板时要看到最新，而不是等下一个事件
  useEffect(() => {
    void refresh()
  }, [refresh])

  // 点外面/按 Esc 关闭（与项目其它浮层同一交互约定）
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="任务板"
      data-testid="team-popover"
      className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[min(420px,60vh)] overflow-y-auto rounded-2xl bg-(--surface-card) p-1.5 shadow-[0_16px_40px_rgba(0,0,0,.16)] ring-1 ring-(--outline-soft)"
      data-scrollable=""
    >
      <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">
        任务板 · {tasks.length}
      </div>

      {/*
       * 新任务模型（施工计划 v4）：`work.*` 投影。与下面的旧板并存——
       * 过渡期两套都在，删旧路径之后这一段就是唯一的任务列表。
       * 没有"通过/驳回"：判定是动作（不满意就再做一版），这里只显示进度。
       */}
      {workItems.length > 0 && (
        <div className="mb-1 rounded-xl bg-(--surface-chip)/50 px-1.5 py-1">
          <div className="px-1 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">
            工作项 · {workItems.filter((item) => item.status !== 'done' && item.status !== 'dropped').length} 个未完成
          </div>
          <ul className="flex flex-col gap-0.5">
            {workItems
              .slice()
              .reverse()
              .slice(0, 8)
              .map((item) => {
                const tone =
                  item.status === 'done'
                    ? 'text-(--on-surface-muted)'
                    : item.status === 'doing'
                      ? 'text-(--accent)'
                      : item.status === 'dropped'
                        ? 'text-(--on-surface-muted) line-through'
                        : 'text-(--on-surface)'
                const label =
                  item.status === 'done'
                    ? '已完成'
                    : item.status === 'doing'
                      ? '进行中'
                      : item.status === 'dropped'
                        ? '已放弃'
                        : '待办'
                return (
                  <li key={item.id} className="flex items-center gap-2 rounded-lg px-1 py-1">
                    <span className={`min-w-0 flex-1 truncate text-[12px] font-medium ${tone}`}>
                      {item.title || item.id}
                      {item.artifacts.length > 0 ? (
                        <span className="ml-1 text-[10px] font-normal text-(--on-surface-muted)">
                          {item.artifacts.length} 版
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-[10px] text-(--on-surface-muted)">{label}</span>
                    {item.status === 'todo' || item.status === 'doing' ? (
                      <button
                        type="button"
                        onClick={() => void dropWorkItem(item.id)}
                        title="放弃这个任务（终态，不会删除已有产物）"
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--on-surface)"
                      >
                        放弃
                      </button>
                    ) : null}
                  </li>
                )
              })}
          </ul>
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] leading-relaxed text-(--on-surface-muted)">
          还没有派过单。
          <br />
          在对话里描述要批量产出的镜头，Agent 会派给专家团执行。
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {tasks.map(({ task, running }) => {
            const meta = STATUS_META[task.status]
            return (
              <li
                key={task.taskId}
                onClick={() => onOpenConversation(task.taskId)}
                title="打开专家对话"
                className="cursor-pointer rounded-xl px-2 py-1.5 transition-colors hover:bg-(--surface-chip)"
              >
                <div className="flex items-start gap-2">
                  <ExpertAvatar
                    seed={task.expert ?? 'expert-visual'}
                    size={22}
                    radius="30%"
                    status={running ? 'running' : meta.dot}
                    label={`${expertLabel(task.expert)} · ${task.taskId}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12px] font-medium leading-tight text-(--on-surface)">
                        {/* 主标题用 scope：它是「这条任务做什么」的最短可读标识；
                            prompt 全文放在下面一行截断（title 存的是 prompt 前 200 字，直接展示会挤爆） */}
                        {task.scope || task.title || task.taskId}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-[1px] text-[9.5px] font-medium ${meta.className}`}
                      >
                        {running && task.status !== 'done' ? '在跑' : meta.label}
                      </span>
                    </div>
                    {task.title && task.title !== task.scope ? (
                      <div className="mt-0.5 line-clamp-1 text-[10.5px] leading-snug text-(--on-surface-variant)">
                        {task.title}
                      </div>
                    ) : null}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-(--on-surface-muted)">
                      <span className="font-mono text-[9px] opacity-70">{task.taskId}</span>
                      <span>· {expertLabel(task.expert)}</span>
                      {task.attempts > 0 ? <span>· 已试 {task.attempts} 次</span> : null}
                      <span>· {relativeTime(task.updatedAt)}</span>
                    </div>
                    {task.lastReason ? (
                      <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-(--on-surface-muted)">
                        原因：{task.lastReason}
                      </div>
                    ) : null}
                  </div>

                  {running ? (
                    <button
                      onClick={(event) => {
                        event.stopPropagation()
                        void cancelTask(task.taskId)
                      }}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-(--danger)/10 text-(--danger) transition-colors hover:bg-(--danger) hover:text-white"
                      title="停止任务（中止专家对话）"
                      aria-label="停止任务"
                      data-testid="task-stop-button"
                    >
                      <span className="h-[9px] w-[9px] rounded-[1.5px] bg-current" />
                    </button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
