import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, FileText, Loader2, RefreshCw } from 'lucide-react'
import type {
  ChatHistoryBlock,
  ExpertLiveTranscript,
  SuperAgentConversationAttempt,
  SuperAgentTaskConversation,
  SuperAgentTaskView
} from '@shared/ipc'
import { applyExpertStreamEvent, expertLiveSize } from '@shared/expertStream'
import type { ChatMessageBlock } from '../../chatBlocks'
import { useCanvasStore } from '../../store/canvasStore'
import { ChatMessageBlocks } from './ChatMessageBlocks'
import { ExpertAvatar } from './ExpertAvatar'

/**
 * 专家内部对话（任务板点开后占据整块对话坞，不再用弹窗）。
 *
 * 实时性：任务运行中由主进程把 agent.stream 的 text/reasoning/tool 事件经
 * task:event 推过来，这里与主对话一样边流边显示；同时 conversation IPC 会
 * 返回主进程保留的流式快照，保证「中途才点开」也能补看已经输出的部分。
 * memory 落库后的完整历史只在任务结束后回拉一次，不再靠轮询。
 *
 * 头部（工作区 / 专家）由 ChatDock 负责；这里只保留任务状态条、尝试切换、
 * 消息流和只读脚注，方便与主对话共用同一个对话壳。
 */
export function ExpertConversationView({
  task,
  running
}: {
  task: SuperAgentTaskView
  running: boolean
}) {
  const loadConversation = useCanvasStore((s) => s.loadSuperAgentConversation)
  const experts = useCanvasStore((s) => s.superAgentExperts)
  const [data, setData] = useState<SuperAgentTaskConversation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeAttempt, setActiveAttempt] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  /** 当前运行中的实时块（memory 落库前） */
  const [live, setLive] = useState<ExpertLiveTranscript | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 先订阅再拉快照：订阅之后到达的增量不会漏；快照只用来补齐订阅前的内容
  useEffect(() => {
    return window.huabu.superagent.onTaskEvent((event) => {
      if (event.taskId !== task.taskId || !event.type.startsWith('task.expert_')) return
      setLive((previous) => applyExpertStreamEvent(previous ?? undefined, event) ?? null)
    })
  }, [task.taskId])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void (async () => {
      const result = await loadConversation(task.taskId)
      if (!alive) return
      if (result.ok) {
        setData(result.value)
        setError(null)
        const snapshot = result.value.live
        if (snapshot) {
          // 快照与已收到的增量取更完整的一方，避免手动刷新把屏幕上已有的内容回退
          setLive((previous) =>
            previous && previous.attempt === snapshot.attempt && expertLiveSize(previous) > expertLiveSize(snapshot)
              ? previous
              : snapshot
          )
        }
        if (!running && result.value.attempts.some((attempt) => attempt.messages.length > 0)) {
          setLive(null)
        }
        setActiveAttempt((previous) => {
          const items = result.value.attempts
          // 用户已经手动选了某次尝试时不要因为刷新跳回实时线程
          if (
            previous !== null &&
            (items.some((item) => item.attempt === previous) || previous === snapshot?.attempt)
          ) {
            return previous
          }
          if (snapshot) return snapshot.attempt
          if (items.length === 0) return previous
          return items[items.length - 1]!.attempt
        })
      } else {
        setError(result.error)
      }
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [task.taskId, running, reloadKey, loadConversation])

  const expertLabel = useMemo(() => {
    const hit = experts.find((expert) => expert.id === task.expert)
    return hit?.label ?? task.expert ?? '专家'
  }, [experts, task.expert])

  const currentAttempt: SuperAgentConversationAttempt | undefined = data?.attempts.find(
    (attempt) => attempt.attempt === activeAttempt
  )
  const messages = currentAttempt?.messages ?? []

  const liveForCurrent = live && (activeAttempt === null || live.attempt === activeAttempt) ? live : null
  const liveBlocks = liveForCurrent ? toRenderBlocks(liveForCurrent.blocks) : []
  const liveVisible = liveBlocks.length > 0 && (running || messages.length === 0)
  const liveTab =
    live && running && data && !data.attempts.some((attempt) => attempt.attempt === live.attempt)
      ? live.attempt
      : null
  const liveSignal = liveVisible ? expertLiveSize(liveForCurrent ?? undefined) : 0

  useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [messages.length, liveSignal, activeAttempt])

  return (
    <div data-testid="expert-conversation-view" className="flex min-h-0 flex-1 flex-col">
      {/* 任务状态条：任务身份 + 刷新（状态徽标在 ChatDock 头部） */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-(--outline-soft) px-3 py-1.5 text-[10px] text-(--on-surface-muted)">
        <span className="font-mono text-[9px] opacity-70">{task.taskId}</span>
        {task.scope ? (
          <>
            <span>·</span>
            <span className="min-w-0 truncate">{task.scope}</span>
          </>
        ) : null}
        {task.attempts > 0 ? <span className="shrink-0">· 已试 {task.attempts} 次</span> : null}
        <button
          onClick={() => setReloadKey((value) => value + 1)}
          className="ml-auto shrink-0 rounded-md p-0.5 transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface)"
          title="刷新对话"
          aria-label="刷新对话"
        >
          <RefreshCw size={11} className={loading && data ? 'animate-spin' : undefined} />
        </button>
      </div>

      {/* 任务说明：默认收起，展开后内部滚动，不挤占消息区 */}
      <details className="group shrink-0 border-b border-(--outline-soft)">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-[10.5px] text-(--on-surface-muted) transition-colors hover:text-(--on-surface) [&::-webkit-details-marker]:hidden">
          <FileText size={10} />
          任务说明
          <ChevronRight size={10} className="ml-auto transition-transform group-open:rotate-90" />
        </summary>
        <div
          data-scrollable=""
          className="max-h-40 selectable overflow-y-auto whitespace-pre-wrap px-3 pb-3 text-[11.5px] leading-relaxed text-(--on-surface-variant)"
        >
          {task.prompt || task.title || '（任务没有留下描述）'}
        </div>
        {task.accept && task.accept.length > 0 ? (
          <div className="flex flex-wrap gap-1 px-3 pb-2.5">
            {task.accept.map((item, index) => (
              <span
                key={`${index}-${item}`}
                className="rounded-full bg-(--surface-chip) px-2 py-0.5 text-[10px] text-(--on-surface-muted)"
              >
                {item}
              </span>
            ))}
          </div>
        ) : null}
      </details>

      {/* 尝试切换：验收失败重试会换新线程，分段查看比串成一条更接近事实 */}
      {data && (data.attempts.length > 1 || liveTab !== null) ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-(--outline-soft) px-3 py-1.5" data-scrollable="">
          {data.attempts.map((attempt) => (
            <button
              key={attempt.attempt}
              onClick={() => setActiveAttempt(attempt.attempt)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[10.5px] font-medium transition-colors ${
                attempt.attempt === activeAttempt
                  ? 'bg-(--accent)/12 text-(--accent)'
                  : 'text-(--on-surface-muted) hover:bg-(--surface-chip) hover:text-(--on-surface)'
              }`}
            >
              第 {attempt.attempt} 次尝试
            </button>
          ))}
          {liveTab !== null ? (
            <button
              onClick={() => setActiveAttempt(liveTab)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[10.5px] font-medium transition-colors ${
                liveTab === activeAttempt
                  ? 'bg-(--accent)/12 text-(--accent)'
                  : 'text-(--on-surface-muted) hover:bg-(--surface-chip) hover:text-(--on-surface)'
              }`}
            >
              第 {liveTab} 次尝试 · 进行中
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 消息流 */}
      <div ref={bodyRef} data-scrollable="" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl bg-(--danger)/8 px-3 py-2 text-[12px] text-(--danger)">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">读取专家对话失败：{error}</span>
          </div>
        ) : null}

        {liveVisible ? (
          <div className="flex flex-col gap-3">
            <div className="flex justify-end">
              <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-(--surface-chip) px-3 py-2 text-[12.5px] leading-relaxed text-(--on-surface)">
                {task.prompt || task.title || '执行任务'}
              </div>
            </div>
            <div className="flex items-start gap-2">
              <ExpertAvatar
                seed={task.expert ?? 'expert-visual'}
                size={18}
                radius="30%"
                status={running ? 'running' : 'idle'}
                label={expertLabel}
              />
              <div className="min-w-0 flex-1 pt-0.5">
                <ChatMessageBlocks blocks={liveBlocks} streaming={running} />
              </div>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <EmptyConversation
            loading={loading}
            running={running}
            status={task.status}
            hasAttempts={(data?.attempts.length ?? 0) > 0}
            lastReason={data?.lastReason ?? task.lastReason}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message, index) => {
              if (message.role === 'user') {
                return (
                  <div key={index} className="flex justify-end">
                    <div
                      title={message.at ? new Date(message.at).toLocaleString() : undefined}
                      className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-(--surface-chip) px-3 py-2 text-[12.5px] leading-relaxed text-(--on-surface)"
                    >
                      {message.text}
                    </div>
                  </div>
                )
              }
              const blocks = toRenderBlocks(message.blocks ?? [])
              return (
                <div key={index} className="flex items-start gap-2">
                  <ExpertAvatar
                    seed={task.expert ?? 'expert-visual'}
                    size={18}
                    radius="30%"
                    status="idle"
                    label={expertLabel}
                  />
                  <div
                    className="min-w-0 flex-1 pt-0.5"
                    title={message.at ? new Date(message.at).toLocaleString() : undefined}
                  >
                    {blocks.length > 0 ? (
                      <ChatMessageBlocks blocks={blocks} />
                    ) : (
                      <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-(--on-surface)">
                        {message.text}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyConversation({
  loading,
  running,
  status,
  hasAttempts,
  lastReason
}: {
  loading: boolean
  running: boolean
  status: SuperAgentTaskView['status']
  hasAttempts: boolean
  lastReason?: string
}) {
  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-(--on-surface-muted)">
        <Loader2 size={18} className="animate-spin text-(--accent)" />
        正在读取专家对话…
      </div>
    )
  }
  if (running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[12px] leading-relaxed text-(--on-surface-muted)">
        <Loader2 size={18} className="animate-spin text-(--accent)" />
        <div className="font-medium text-(--on-surface-variant)">专家正在执行第一轮</div>
        <div>输出会实时显示在这里。</div>
      </div>
    )
  }
  const title =
    status === 'todo'
      ? '任务还没开工'
      : hasAttempts
        ? '这次尝试没有留下消息'
        : status === 'blocked'
          ? '任务在执行前被拦下'
          : '没有找到专家对话'
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[12px] leading-relaxed text-(--on-surface-muted)">
      <div className="font-medium text-(--on-surface-variant)">{title}</div>
      <div>
        {status === 'todo'
          ? '专家接到任务后才会建立自己的会话线程。'
          : hasAttempts
            ? '该线程尚未落库任何可回放的消息。'
            : '专家线程可能尚未创建，或任务在派单阶段就被拒绝。'}
      </div>
      {lastReason ? <div className="max-w-lg break-words text-[11px]">原因：{lastReason}</div> : null}
    </div>
  )
}

/** 共享块类型与渲染块结构同构；这里显式映射，避免两套类型以后各自漂移 */
function toRenderBlocks(blocks: ChatHistoryBlock[]): ChatMessageBlock[] {
  return blocks.map((block) => {
    if (block.kind === 'tool') return { kind: 'tool', toolCall: { ...block.toolCall } }
    return block
  })
}
