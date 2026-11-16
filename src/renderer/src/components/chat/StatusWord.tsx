import { memo } from 'react'
import type { WorkItem } from '../../lib/workModel'

/**
 * 任务状态文案。
 *
 * 只有两种会出现在界面上：面板只列进行中和待办，已完成 / 已放弃不进列表，
 * 所以这里不给它们准备文案。
 */
export const StatusWord = memo(function StatusWord({ status }: { status: WorkItem['status'] }) {
  const label = status === 'doing' ? '进行中' : '待办'
  const tone =
    status === 'doing'
      ? 'bg-(--accent)/10 text-(--accent)'
      : 'bg-(--surface-chip) text-(--on-surface-muted)'
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium ${tone}`}>
      {label}
    </span>
  )
})
