import { memo } from 'react'
import type { ArtifactOwner } from '../../lib/artifactOwnership'

/**
 * 画布卡片上的归属角标：`V-02 · 第 2 版`。
 *
 * 只显示第几版，不显示「共几版」——后端 Task 没有「计划数量」这个字段，
 * 分母只能靠猜，猜出来的数字比没有更糟。
 */
export const TaskPill = memo(function TaskPill({
  owner,
  shifted = false
}: {
  owner: ArtifactOwner
  /** 选中时勾选角标占住左上角，角标下移让位 */
  shifted?: boolean
}) {
  return (
    <span
      data-testid="task-pill"
      title={`${owner.taskId} ${owner.title} · 第 ${owner.index} 版`}
      className={`pointer-events-none absolute left-2 z-10 flex items-center gap-1 rounded-md bg-[rgba(28,28,30,.62)] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide text-white backdrop-blur-sm transition-[top] duration-150 ${
        shifted ? 'top-9' : 'top-2'
      }`}
    >
      {owner.taskId}
      <i className="font-normal opacity-70">·</i>第 {owner.index} 版
    </span>
  )
})
