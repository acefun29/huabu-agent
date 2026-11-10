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
  const experts = useCanvasStore((s) => s.superAgentExperts)
  const refresh = useCanvasStore((s) => s.refreshSuperAgent)
  const cancelTask = useCanvasStore((s) => s.cancelSuperAgentTask)
  const panelRef = useRef<HTMLDivElement>(null)

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
