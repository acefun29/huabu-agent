import type { SuperAgentTaskStatus } from '@shared/ipc'
import type { ExpertStatus } from './ExpertAvatar'

/**
 * 任务板状态的可视元数据（状态条 / 任务板 / 专家对话详情共用）。
 * 放在独立模块里：详情弹窗复用同一套文案与颜色，避免两处各写一份状态映射。
 */
export const TASK_STATUS_META: Record<
  SuperAgentTaskStatus,
  { label: string; className: string; dot: ExpertStatus }
> = {
  todo: { label: '待开工', className: 'bg-(--surface-chip) text-(--on-surface-muted)', dot: 'idle' },
  active: { label: '执行中', className: 'bg-(--accent)/12 text-(--accent)', dot: 'running' },
  validating: { label: '验收中', className: 'bg-(--accent)/12 text-(--accent)', dot: 'running' },
  attention: { label: '待重派', className: 'bg-[#e8590c]/12 text-[#e8590c]', dot: 'attention' },
  blocked: { label: '受阻', className: 'bg-[#c92a2a]/12 text-[#c92a2a]', dot: 'attention' },
  done: { label: '已完成', className: 'bg-(--surface-chip) text-(--on-surface-variant)', dot: 'idle' }
}

/** 时间戳 → 「3 分钟前」；解析失败原样返回空串（不显示假时间） */
export function relativeTime(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}
