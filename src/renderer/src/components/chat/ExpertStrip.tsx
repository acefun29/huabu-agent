import { memo, useMemo } from 'react'
import { ChevronDown, Users } from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { ExpertAvatar, type ExpertStatus } from './ExpertAvatar'

/**
 * 对话栏底部的专家团状态条（架构图 to-be ② 的「状态可见」）：
 * 目前在处理的专家按从左到右排开（头像 + 名称 + 任务数），点击展开任务板浮层。
 *
 * 为什么不再收敛成「专家团」三个字：用户需要一眼看到「当前是哪些专家在干活」，
 * 名称比一个泛化的团队标签更有信息量；专家多时横向滚动，不再用 +N 折叠。
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
  const experts = useCanvasStore((s) => s.superAgentExperts)

  const stats = useMemo(() => {
    // 「待处理」= 需要主 Agent/用户决策的任务：验收失败（attention）与受阻（blocked）都算。
    // 只统计 attention 会让 blocked 任务在状态条上凭空消失（写着「N 个已完成」却漏一条）
    const needsAction = tasks.filter(
      (entry) => entry.task.status === 'attention' || entry.task.status === 'blocked'
    ).length
    const done = tasks.filter((entry) => entry.task.status === 'done').length

    const labels = new Map(experts.map((expert) => [expert.id, expert.label]))
    const groups = new Map<
      string,
      {
        id: string
        label: string
        count: number
        running: boolean
        active: boolean
        needsAction: boolean
        /** 首次出现顺序：同状态专家保持任务板里的相对顺序 */
        order: number
      }
    >()
    tasks.forEach((entry, index) => {
      const id = entry.task.expert ?? 'expert-visual'
      const group = groups.get(id) ?? {
        id,
        label: labels.get(id) ?? id,
        count: 0,
        running: false,
        active: false,
        needsAction: false,
        order: index
      }
      group.count += 1
      group.running = group.running || entry.running
      group.active = group.active || entry.task.status === 'active' || entry.task.status === 'validating'
      group.needsAction = group.needsAction || entry.task.status === 'attention' || entry.task.status === 'blocked'
      groups.set(id, group)
    })

    // 在跑 / 执行中的专家优先靠左，其次待处理，最后是已完成；同组按任务板顺序
    const ordered = [...groups.values()].sort((a, b) => {
      const weight = (item: typeof a): number => (item.running ? 3 : item.active ? 2 : item.needsAction ? 1 : 0)
      return weight(b) - weight(a) || a.order - b.order
    })

    return {
      running: running.length,
      needsAction,
      done,
      experts: ordered
    }
  }, [tasks, running, experts])

  // 空任务板仍然保留入口：此前 tasks.length===0 直接 return null，导致「派过单才有入口、
  // 入口没了就不知道还能派单」——可发现性全靠记忆。空态改成一行提示，点击仍能打开任务板。
  const empty = tasks.length === 0

  const summary = empty
    ? '还没有任务 · 点开查看任务板'
    : stats.running > 0
      ? `${stats.running} 个在跑`
      : stats.needsAction > 0
        ? `${stats.needsAction} 个待处理`
        : `${stats.done} 个已完成`

  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid="expert-strip"
      className={`mb-1.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left ring-1 transition-colors ${
        expanded
          ? 'bg-(--surface-chip) ring-(--outline)'
          : stats.running > 0
            ? 'bg-(--accent)/8 ring-(--accent)/25 hover:bg-(--accent)/14'
            : 'bg-(--surface-chip)/60 ring-(--outline-soft) hover:bg-(--surface-chip)'
      } ${empty ? 'opacity-70 hover:opacity-100' : ''}`}
      title={expanded ? '收起任务板' : '展开任务板（专家团进度）'}
    >
      {stats.experts.length === 0 ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-(--on-surface-variant)">
          <Users size={11} />
          <span>专家团</span>
        </span>
      ) : (
        <span
          data-scrollable=""
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {stats.experts.map((expert) => {
            const status: ExpertStatus =
              expert.running || expert.active ? 'running' : expert.needsAction ? 'attention' : 'idle'
            const tone =
              status === 'running'
                ? 'bg-(--accent)/8 text-(--accent) ring-(--accent)/25'
                : status === 'attention'
                  ? 'bg-[#e8590c]/8 text-[#e8590c] ring-[#e8590c]/20'
                  : 'bg-(--surface-card)/70 text-(--on-surface-variant) ring-(--outline-soft)'
            const statusLabel =
              status === 'running' ? '执行中' : status === 'attention' ? '待处理' : '已完成/空闲'
            return (
              <span
                key={expert.id}
                title={`${expert.label} · ${expert.count} 个任务 · ${statusLabel}`}
                className={`flex shrink-0 items-center gap-1 rounded-full py-0.5 pl-0.5 pr-1.5 ring-1 ${tone}`}
              >
                <ExpertAvatar seed={expert.id} size={18} radius="50%" status={status} label={expert.label} />
                <span className="max-w-[84px] truncate text-[10.5px] font-medium">{expert.label}</span>
                {expert.count > 1 ? (
                  <span className="shrink-0 text-[9px] font-semibold opacity-70">×{expert.count}</span>
                ) : null}
              </span>
            )
          })}
        </span>
      )}

      <span className="shrink-0 text-[10px] text-(--on-surface-muted)">{summary}</span>

      <span className="flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-(--on-surface-muted)">
        任务板
        <ChevronDown
          size={12}
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </span>
    </button>
  )
})
