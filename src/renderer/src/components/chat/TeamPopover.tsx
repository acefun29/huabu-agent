import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, PencilLine, RotateCcw, X } from 'lucide-react'
import type { SuperAgentTaskStatus } from '@shared/ipc'
import { useCanvasStore } from '../../store/canvasStore'
import { ExpertAvatar, type ExpertStatus } from './ExpertAvatar'

/**
 * 任务板浮层（架构图 to-be ② 的「任务板投影」可视面）：专家团状态条点开后的面板。
 *
 * 每行 = 头像 + 任务（title/scope）+ 状态标签 + 操作。数据全部来自主进程 board 投影
 * （journal 是事实源），这里不推演状态；收到 task:event 时父层已触发重拉，浮层自动更新。
 *
 * 操作边界：
 * - 「停止」只对在跑的任务出现（其它行点了也是明确失败，不做假按钮）；
 * - 「重派」对 attention/blocked 出现：派单是对外的写操作，但它是用户明确点击的重试意图，
 *   且与原任务同 scope/prompt——直接派，不弹二次确认（失败原因已显示在行内）。
 */

const STATUS_META: Record<SuperAgentTaskStatus, { label: string; className: string; dot: ExpertStatus }> = {
  todo: { label: '待开工', className: 'bg-(--surface-chip) text-(--on-surface-muted)', dot: 'idle' },
  active: { label: '执行中', className: 'bg-(--accent)/12 text-(--accent)', dot: 'running' },
  validating: { label: '验收中', className: 'bg-(--accent)/12 text-(--accent)', dot: 'running' },
  attention: { label: '待重派', className: 'bg-[#e8590c]/12 text-[#e8590c]', dot: 'attention' },
  blocked: { label: '受阻', className: 'bg-[#c92a2a]/12 text-[#c92a2a]', dot: 'attention' },
  done: { label: '已完成', className: 'bg-(--surface-chip) text-(--on-surface-variant)', dot: 'idle' }
}

/** 时间戳 → 「3 分钟前」；解析失败原样返回空串（不显示假时间） */
function relativeTime(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function TeamPopover({ onClose }: { onClose: () => void }) {
  const tasks = useCanvasStore((s) => s.superAgentTasks)
  const experts = useCanvasStore((s) => s.superAgentExperts)
  const refresh = useCanvasStore((s) => s.refreshSuperAgent)
  const cancelTask = useCanvasStore((s) => s.cancelSuperAgentTask)
  const redispatch = useCanvasStore((s) => s.redispatchSuperAgentTask)
  const appendUserChange = useCanvasStore((s) => s.appendSuperAgentUserChange)
  const panelRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

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
      <div className="flex items-center justify-between px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">
        <span>任务板 · {tasks.length}</span>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface)"
          title="关闭"
        >
          <X size={11} />
        </button>
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
            const canCancel = running
            const canRedo = task.status === 'attention' || task.status === 'blocked'
            return (
              <li key={task.taskId} className="rounded-xl px-2 py-1.5 transition-colors hover:bg-(--surface-chip)">
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

                    {editing === task.taskId ? (
                      <form
                        className="mt-1 flex items-center gap-1"
                        onSubmit={(event) => {
                          event.preventDefault()
                          const text = draft.trim()
                          if (!text) return
                          void appendUserChange(task.taskId, text).then((ok) => {
                            if (ok) {
                              setEditing(null)
                              setDraft('')
                            }
                          })
                        }}
                      >
                        <input
                          autoFocus
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          placeholder="新的需求描述…"
                          className="min-w-0 flex-1 rounded-lg bg-(--surface-input) px-2 py-1 text-[11px] text-(--on-surface) outline-none ring-1 ring-(--outline-soft) focus:ring-(--accent)"
                        />
                        <button
                          type="submit"
                          className="rounded-lg bg-(--accent) px-2 py-1 text-[10px] font-medium text-white"
                        >
                          提交
                        </button>
                      </form>
                    ) : null}
                  </div>

                  <span className="flex shrink-0 items-center gap-0.5">
                    {canRedo ? (
                      <>
                        <button
                          onClick={() => void redispatch(task)}
                          className="rounded-lg p-1 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--accent)"
                          title="重派（原 scope/描述/验收标准，新任务 id）"
                        >
                          <RotateCcw size={11} />
                        </button>
                        <button
                          onClick={() => {
                            setEditing(task.taskId)
                            setDraft('')
                          }}
                          className="rounded-lg p-1 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface)"
                          title="改需求（写入 user.changed，主 Agent 下一轮会读到）"
                        >
                          <PencilLine size={11} />
                        </button>
                      </>
                    ) : null}
                    {canCancel ? (
                      <button
                        onClick={() => void cancelTask(task.taskId)}
                        className="rounded-lg p-1 text-(--on-surface-muted) transition-colors hover:bg-(--danger)/10 hover:text-(--danger)"
                        title="停止这个任务"
                      >
                        <Ban size={11} />
                      </button>
                    ) : null}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
