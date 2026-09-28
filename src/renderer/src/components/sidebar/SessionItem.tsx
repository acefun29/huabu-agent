import { memo } from 'react'
import { GitFork, MessageSquare, Trash2 } from 'lucide-react'
import type { SessionMeta } from '../../types'

function formatDay(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface SessionItemProps {
  session: SessionMeta
  active: boolean
  /** 切换会话（含收起浮层面板，由壳注入） */
  onSwitch: (id: string) => void
  /** 分叉新会话（store action，恒定引用） */
  onFork: (id: string) => void
  /** 删除会话（store action，恒定引用） */
  onRemove: (id: string) => void
}

/**
 * 单个会话行（memo）：props 里除 session/active 外全是恒定回调，
 * 会话清单或激活态变化时只有内容有变的行重渲。
 */
export const SessionItem = memo(function SessionItem({ session: s, active, onSwitch, onFork, onRemove }: SessionItemProps) {
  return (
    <div
      data-testid="session-item"
      onClick={() => onSwitch(s.id)}
      className={`group mb-0.5 cursor-pointer rounded-2xl px-3 py-2 transition-colors ${
        active ? 'bg-(--surface-chip) ring-1 ring-(--accent)/30' : 'hover:bg-(--outline-soft)'
      }`}
    >
      <div className="flex items-center gap-2">
        <MessageSquare size={13} className={`shrink-0 ${active ? 'text-(--accent)' : 'text-(--on-surface-muted)'}`} />
        <span
          title={s.title}
          className={`min-w-0 flex-1 truncate text-[12.5px] ${active ? 'font-semibold text-(--on-surface)' : 'font-medium text-(--on-surface-variant)'}`}
        >
          {s.title}
        </span>
        {/* 常驻占位 + 只切换透明度：悬停不改变任何尺寸，避免列表跳动 */}
        <span className="pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation()
              void onFork(s.id)
            }}
            className="rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--accent)"
            title="分叉新会话（复制本会话对话历史；画布为工作区公用，不受影响）"
          >
            <GitFork size={12} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRemove(s.id)
            }}
            className="rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--surface-card) hover:text-(--danger)"
            title="删除会话（不删除素材文件）"
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1 pl-[21px] text-[10px] text-(--on-surface-muted)">
        {s.forkedFromLabel ? (
          <span className="flex min-w-0 items-center gap-1">
            <GitFork size={9} className="shrink-0" />
            <span className="truncate">来自 {s.forkedFromLabel}</span>
          </span>
        ) : (
          <span>{formatDay(s.createdAt)} 创建</span>
        )}
      </div>
    </div>
  )
})
