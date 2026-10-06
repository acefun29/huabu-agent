import { memo } from 'react'
import { Check, GitFork, MessageSquare, Trash2 } from 'lucide-react'
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
  /** 批量管理模式：点击行 = 切换选中，悬停操作与切换会话停用 */
  manageMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: string) => void
}

/**
 * 单个会话行（memo）：props 里除 session/active 外全是恒定回调，
 * 会话清单或激活态变化时只有内容有变的行重渲。
 */
export const SessionItem = memo(function SessionItem({
  session: s,
  active,
  onSwitch,
  onFork,
  onRemove,
  manageMode = false,
  selected = false,
  onToggleSelect
}: SessionItemProps) {
  const managing = manageMode && Boolean(onToggleSelect)
  return (
    <div
      data-testid="session-item"
      data-selected={managing && selected ? 'true' : undefined}
      onClick={() => (managing ? onToggleSelect?.(s.id) : onSwitch(s.id))}
      title={`${s.title}\n会话 ID：${s.id}${s.sessionFile ? `\n会话文件：${s.sessionFile}` : ''}`}
      className={`group mb-0.5 cursor-pointer rounded-2xl px-3 py-2 transition-colors ${
        managing
          ? selected
            ? 'bg-(--accent)/12 ring-1 ring-(--accent)/45'
            : 'hover:bg-(--outline-soft)'
          : active
            ? 'bg-(--surface-chip) ring-1 ring-(--accent)/30'
            : 'hover:bg-(--outline-soft)'
      }`}
    >
      <div className="flex items-center gap-2">
        <MessageSquare size={13} className={`shrink-0 ${!managing && active ? 'text-(--accent)' : 'text-(--on-surface-muted)'}`} />
        <span
          title={s.title}
          className={`min-w-0 flex-1 truncate text-[12.5px] ${
            !managing && active
              ? 'font-semibold text-(--on-surface)'
              : selected
                ? 'font-medium text-(--on-surface)'
                : 'font-medium text-(--on-surface-variant)'
          }`}
        >
          {s.title}
        </span>
        {managing ? (
          // 行本身是点击目标，框只做状态呈现（对齐悬停钮「常驻占位不抖动」的思路）
          <span
            className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
              selected ? 'border-(--accent) bg-(--accent) text-white' : 'border-(--outline) bg-transparent text-transparent'
            }`}
          >
            <Check size={11} strokeWidth={2.5} />
          </span>
        ) : (
          // 常驻占位 + 只切换透明度：悬停不改变任何尺寸，避免列表跳动
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
        )}
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
        {/* 独立会话 ID（短码）：jobs.json 的 sourceChatId 与日志里的 nodeId 就是它，
            排查问题时按此对号；悬停行可见完整 ID 与会话文件 */}
        <span
          className="ml-auto shrink-0 font-mono text-[9px] tracking-tight opacity-75"
          title={`会话 ID：${s.id}`}
          onClick={(e) => {
            e.stopPropagation()
            void navigator.clipboard?.writeText(s.id)
          }}
        >
          #{s.id.slice(0, 6)}
        </span>
      </div>
    </div>
  )
})
