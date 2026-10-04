import { memo } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { SessionItem } from './SessionItem'
import { Stagger } from './Stagger'

/**
 * 会话面板内容：精确订阅 sessions/activeSessionId（壳只订数量供头部计数），
 * 行抽成 memo 的 SessionItem —— 激活态切换时只有新旧两行重渲。
 * onSwitch 由壳注入（切换会话并收起面板）；fork/remove 直接用恒定的 store action。
 * 批量管理模式由壳驱动（头部按钮/计数在此模式壳自己渲染）：点行 = 勾选，不切换不收面板。
 */
export const SessionsPanel = memo(function SessionsPanel({
  onSwitch,
  manageMode = false,
  selectedIds,
  onToggleSelect
}: {
  onSwitch: (id: string) => void
  manageMode?: boolean
  selectedIds?: ReadonlySet<string>
  onToggleSelect?: (id: string) => void
}) {
  const sessions = useCanvasStore((s) => s.sessions)
  const activeSessionId = useCanvasStore((s) => s.activeSessionId)
  // actions 恒定引用
  const { forkSession, requestRemoveSession } = useCanvasStore.getState()

  return (
    <>
      {sessions.length === 0 && (
        <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-(--on-surface-muted)">
          还没有会话
          <br />
          点标题栏的 + 新建一个
        </div>
      )}
      {sessions.map((s, i) => {
        const active = s.id === activeSessionId
        return (
          <Stagger key={s.id} index={i}>
            <SessionItem
              session={s}
              active={active}
              onSwitch={onSwitch}
              onFork={forkSession}
              onRemove={requestRemoveSession}
              manageMode={manageMode}
              selected={selectedIds?.has(s.id) ?? false}
              onToggleSelect={onToggleSelect}
            />
          </Stagger>
        )
      })}
    </>
  )
})
