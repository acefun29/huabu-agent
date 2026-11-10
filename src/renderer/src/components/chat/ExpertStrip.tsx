import { memo, useMemo } from 'react'
import { ChevronDown, Users } from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { ExpertAvatar } from './ExpertAvatar'

/**
 * 对话栏底部的专家团状态条（架构图 to-be ② 的「状态可见」）：
 * `▲ N 位在跑 · 共 M 个任务` + 在跑专家的像素头像。点击展开任务板浮层（由父级控制）。
 *
 * 为什么放在输入框上方而不是头部：它是「当前这轮协作的进行态」，与消息流同一层；
 * 头部留给会话身份（会话名/水位/新建删除），不放会随任务变化的高频信息。
 */
export const ExpertStrip = memo(function ExpertStrip({
  expanded,
  onToggle
}: {
  expanded: boolean
  onToggle: () => void
}) {
  const tasks = useCanvasStore((s) => s.superAgentTasks)
  const running = useCanvasStore((s) => s.superAgentRunning)

  const stats = useMemo(() => {
    // 「待处理」= 需要主 Agent/用户决策的任务：验收失败（attention）与受阻（blocked）都算。
    // 只统计 attention 会让 blocked 任务在状态条上凭空消失（写着「N 个已完成」却漏一条）
    const needsAction = tasks.filter(
      (entry) => entry.task.status === 'attention' || entry.task.status === 'blocked'
    ).length
    const done = tasks.filter((entry) => entry.task.status === 'done').length
    // 在跑的专家（按 taskId 顺序去重）：状态条上最多展示 5 个头像，其余折成 +N
    const runningExperts = tasks
      .filter((entry) => entry.running)
      .map((entry) => ({ taskId: entry.task.taskId, expert: entry.task.expert ?? 'expert-visual' }))
    const unique = new Map<string, { taskId: string; expert: string }>()
    for (const item of runningExperts) if (!unique.has(item.expert)) unique.set(item.expert, item)
    return {
      running: running.length,
      needsAction,
      done,
      avatars: [...unique.values()].slice(0, 5),
      overflow: Math.max(0, unique.size - 5)
    }
  }, [tasks, running])

  // 一条任务都没派过时不占位置：空状态条只会让人以为哪儿坏了
  if (tasks.length === 0) return null

  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid="expert-strip"
      className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors ${
        expanded ? 'bg-(--surface-chip)' : 'hover:bg-(--surface-chip)'
      }`}
      title={expanded ? '收起任务板' : '展开任务板（专家团进度）'}
    >
      <span className="flex items-center gap-1 text-[11px] font-medium text-(--on-surface-variant)">
        <Users size={11} />
        {stats.running > 0 ? (
          <>
            <b className="text-(--accent)">{stats.running}</b>
            <span>位在跑</span>
          </>
        ) : (
          <span>专家团</span>
        )}
      </span>

      {stats.avatars.length > 0 ? (
        <span className="flex items-center -space-x-1.5">
          {stats.avatars.map((entry) => (
            <ExpertAvatar key={entry.taskId} seed={entry.expert} size={18} radius="50%" status="running" />
          ))}
          {stats.overflow > 0 ? (
            <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-(--surface-chip) px-1 text-[9px] font-semibold text-(--on-surface-muted) ring-1 ring-(--outline-soft)">
              +{stats.overflow}
            </span>
          ) : null}
        </span>
      ) : null}

      <span className="min-w-0 flex-1 truncate text-[10.5px] text-(--on-surface-muted)">
        {stats.running > 0
          ? '自动校验中 · 完成即激活版本'
          : stats.needsAction > 0
            ? `${stats.needsAction} 个待处理`
            : `${stats.done} 个已完成`}
      </span>

      <ChevronDown
        size={12}
        className={`shrink-0 text-(--on-surface-muted) transition-transform ${expanded ? 'rotate-180' : ''}`}
      />
    </button>
  )
})
