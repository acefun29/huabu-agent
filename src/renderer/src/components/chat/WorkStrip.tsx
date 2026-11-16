import { memo, useMemo } from 'react'
import { ChevronUp } from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { buildWorkGroups } from '../../lib/workModel'

/**
 * 对话坞底部的工作项状态条：只回答「现在在做哪个任务」。
 *
 * 替代原来的专家条。空态也保留入口——否则用户既不知道有任务，也不知道从哪看。
 */
export const WorkStrip = memo(function WorkStrip({
  expanded,
  onToggle
}: {
  expanded: boolean
  onToggle: () => void
}) {
  const state = useCanvasStore((s) => s.workState)
  const groups = useMemo(() => buildWorkGroups(state), [state])

  const doing = groups.doing[0]
  const summary = doing
    ? `${doing.title} · 已出 ${doing.artifacts.length} 版`
    : groups.todo.length > 0
      ? `${groups.todo.length} 个待办`
      : '还没有任务'

  const empty = !doing && groups.todo.length === 0

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid="work-strip"
      title={expanded ? '收起工作项' : '展开工作项'}
      className={`mb-1.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left ring-1 transition-colors ${
        expanded
          ? 'bg-(--surface-chip) ring-(--outline)'
          : doing
            ? 'bg-(--accent)/8 ring-(--accent)/25 hover:bg-(--accent)/14'
            : 'bg-(--surface-chip)/60 ring-(--outline-soft) hover:bg-(--surface-chip)'
      } ${empty ? 'opacity-70 hover:opacity-100' : ''}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${
          doing ? 'bg-(--success-dot) shadow-[0_0_0_3px_rgba(52,168,83,.12)]' : 'bg-(--on-surface-muted)'
        }`}
      />
      <span className="min-w-0 flex-1 truncate text-[10.5px] text-(--on-surface-muted)">
        {doing ? (
          <>
            <b className="font-semibold text-(--on-surface-variant)">正在做：</b>
            {summary}
          </>
        ) : (
          summary
        )}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-(--on-surface-muted)">
        工作项
        <ChevronUp size={12} className={`transition-transform ${expanded ? '' : 'rotate-180'}`} />
      </span>
    </button>
  )
})
