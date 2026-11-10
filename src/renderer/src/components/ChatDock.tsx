import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  FileText,
  FoldVertical,
  Image as ImageIcon,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Trash2,
  Video,
} from 'lucide-react'
import type { AssetKind, ChatMessage } from '../types'
import type { ChatContextUsage, ChatHistoryImage } from '@shared/ipc'
import { useCanvasStore } from '../store/canvasStore'
import { bumpRender } from '../lib/perfProbe'
import { compactTokens } from '../lib/format'
import { ChatMessageBlocks } from './chat/ChatMessageBlocks'
import { ExpertAvatar } from './chat/ExpertAvatar'
import { ExpertConversationView } from './chat/ExpertConversationView'
import { ExpertStrip } from './chat/ExpertStrip'
import { TeamPopover } from './chat/TeamPopover'
import { TASK_STATUS_META, relativeTime } from './chat/taskBoardMeta'
import { Composer } from './Composer'
import { SessionsPanel } from './sidebar/SessionsPanel'

function assetIcon(kind: AssetKind) {
  if (kind === 'image') return <ImageIcon size={11} />
  if (kind === 'video') return <Video size={11} />
  if (kind === 'audio') return <AudioLines size={11} />
  if (kind === 'doc') return <FileText size={11} />
  return <FileCode size={11} />
}

/** 上下文 token 紧凑显示：算法与设置面板共用（lib/format），0 也要显示成 "0" */
const formatTokens = (value: number): string => compactTokens(value) ?? String(value)

/** 压缩分隔条：本地合成（T2）与回放重建（T4）同形，摘要默认折叠 */
const CompactionDivider = memo(function CompactionDivider({
  message,
  faded,
}: {
  message: ChatMessage
  faded?: boolean
}) {
  /** 右栏常驻展开（折叠语义在结构视图里由外层控制） */
  const expanded = true
  const [compactOpen, setCompactOpen] = useState(false)
  const divider = message.compaction!
  return (
    <div
      className={`flex items-start gap-2 py-1 ${faded ? 'opacity-50' : ''}`}
      data-testid="compaction-divider"
      title={faded ? '此压缩分界已不在当前上下文中' : undefined}
    >
      <div className="flex-1 border-t border-dashed border-(--outline)" />
      <div className="max-w-[85%] rounded-full bg-(--surface-chip) px-2.5 py-1 text-[10.5px] leading-relaxed text-(--on-surface-muted)">
        <button
          onClick={() => setCompactOpen((v) => !v)}
          className="flex items-center gap-1 font-medium"
          title={compactOpen ? '收起压缩摘要' : '展开压缩摘要'}
        >
          <FoldVertical size={10} className="shrink-0 text-(--accent)" />
          上下文已压缩
          {typeof divider.tokensBefore === 'number' && (
            <span className="font-mono">
              {' '}
              {formatTokens(divider.tokensBefore)}
              {typeof divider.estimatedTokensAfter === 'number'
                ? ` → ${formatTokens(divider.estimatedTokensAfter)}`
                : ''}
            </span>
          )}
          <ChevronRight size={10} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
        {expanded && (
          <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-[10.5px] text-(--on-surface-variant)" data-scrollable="">
            {divider.summary}
          </div>
        )}
      </div>
      <div className="flex-1 border-t border-dashed border-(--outline)" />
    </div>
  )
})

/** 回放图片：缩略图或退化 chip（带源路径） */
function ReplayImages({ images, alignEnd }: { images: ChatHistoryImage[]; alignEnd?: boolean }) {
  if (images.length === 0) return null
  return (
    <div className={`mb-1.5 flex flex-wrap gap-1 ${alignEnd ? 'justify-end' : ''}`}>
      {images.map((image, index) =>
        image.thumbBase64 ? (
          <img
            key={index}
            src={`data:image/jpeg;base64,${image.thumbBase64}`}
            alt={image.label ?? '历史图片'}
            title={image.label}
            className="h-14 w-14 rounded-lg object-cover ring-1 ring-(--outline-soft)"
          />
        ) : (
          <span
            key={index}
            title={image.label}
            className="flex max-w-[200px] items-center gap-1 rounded-full bg-(--surface-card) px-2 py-0.5 text-[10.5px] font-medium text-(--on-surface-variant) ring-1 ring-(--outline-soft)"
          >
            <ImageIcon size={11} />
            <span className="truncate">{image.label ?? '历史图片'}</span>
          </span>
        )
      )}
    </div>
  )
}

/** 单条消息气泡：模型消息走富块渲染（思维链/工具卡片/markdown），用户消息纯文本 + 引用 chip */
const MessageBubble = memo(function MessageBubble({ m, expanded }: { m: ChatMessage; expanded: boolean }) {
  if (m.compaction) {
    return <CompactionDivider message={m} faded={m.inContext === false} />
  }
  if (m.role === 'user') {
    const faded = m.inContext === false
    return (
      <div className={`flex justify-end ${faded ? 'opacity-55' : ''}`} title={faded ? '已压缩 · 不在当前模型上下文中' : undefined}>
        <div
          data-testid="chat-message-user"
          data-streaming={m.streaming ? 'true' : 'false'}
          className={`max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md px-3 py-2 text-[13px] leading-relaxed ${
            expanded ? 'bg-(--surface-chip)' : 'bg-(--drawer-peek-bubble)'
          }`}
        >
          {/* 回放图片（用户消息里的 image 块缩略） */}
          {m.images && m.images.length > 0 && <ReplayImages images={m.images} alignEnd />}
          {/* 引用素材回显：Agent 实际收到的是绝对路径（悬停可看），文件内容不进会话 */}
          {m.attachments && m.attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-1">
              {m.attachments.map((a) => (
                <span
                  key={a.id}
                  title={`${a.origin === 'temp-upload' ? '临时上传' : '工作区素材'}\n${a.absPath}`}
                  className={`flex max-w-[200px] items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium text-(--on-surface-variant) ${
                    a.origin === 'temp-upload'
                      ? 'border border-dashed border-(--accent) bg-(--surface-card)'
                      : 'bg-(--surface-card) ring-1 ring-(--outline-soft)'
                  }`}
                >
                  {assetIcon(a.kind)}
                  <span className="truncate">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {m.content}
        </div>
      </div>
    )
  }

  const faded = m.inContext === false
  return (
    <div
      className={`flex justify-start ${faded ? 'opacity-55' : ''}`}
      data-testid="chat-message-model"
      data-streaming={m.streaming ? 'true' : 'false'}
      title={faded ? '已压缩 · 不在当前模型上下文中' : undefined}
    >
      <div className="max-w-[95%] px-1 text-[13px] leading-relaxed text-(--on-surface)">
        {m.blocks && m.blocks.length > 0 ? (
          <ChatMessageBlocks blocks={m.blocks} streaming={Boolean(m.streaming)} />
        ) : (
          <div className="whitespace-pre-wrap">
            {m.content}
            {m.streaming && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-(--accent) align-middle" />
            )}
          </div>
        )}
        {m.errorMessage && <div className="mt-1 text-[12px] text-(--danger)">{m.errorMessage}</div>}
        {m.stopReason === 'length' && (
          <div className="mt-1 text-[11px] text-(--on-surface-muted)">（输出到达长度上限，可发送「继续」补全）</div>
        )}
      </div>
    </div>
  )
})

/**
 * 底部对话坞 = 对话抽屉 + 全局对话输入框。
 * 抽屉默认折叠：半透明毛玻璃、自适应收紧到最近一两轮对话，流式输出照常滚动可见；
 * 点把手或向上拖动即展开为可滚动的完整历史，iOS 风格弹簧动画、圆角。
 */
export function ChatDock() {
  bumpRender('chatDock')
  // 流式热路径：只订当前会话的 ChatData；会话头只订当前 meta（对象身份稳定）
  const activeChat = useCanvasStore((s) => (s.activeSessionId ? (s.chatsMap[s.activeSessionId] ?? null) : null))
  const session = useCanvasStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null)
  const sessions = useCanvasStore((s) => s.sessions)
  const workspace = useCanvasStore((s) => s.workspace)
  const expertEntries = useCanvasStore((s) => s.superAgentTasks)
  const experts = useCanvasStore((s) => s.superAgentExperts)
  // 压缩/fork 走输入框 / 命令（用户裁决）；头部只留 + 新建对话、删除；停止在 Composer 的发送按钮上
  const { createSession, requestRemoveSession, requestRemoveSessions, switchSession } = useCanvasStore.getState()
  /** 会话切换菜单（原型 .session-menu）：点了标题才展开，选完即收 */
  const [menuOpen, setMenuOpen] = useState(false)
  /** 专家团任务板浮层：从底部状态条向上展开 */
  const [teamOpen, setTeamOpen] = useState(false)
  /**
   * 当前对话坞展示的是哪条专家对话（null = 主对话）。
   * 进入后整块对话坞变成专家的只读历史，头部面包屑负责切回主对话或换一个专家。
   */
  const [expertTaskId, setExpertTaskId] = useState<string | null>(null)
  /** 菜单内的批量管理模式：点行 = 勾选（不进菜单即不存在选中集） */
  const [manageMode, setManageMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const menuRef = useRef<HTMLDivElement>(null)
  /** 右栏常驻展开（折叠语义在结构视图里由外层控制） */
  const expanded = true
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const fullHistory = activeChat?.history ?? []
  const running = Boolean(activeChat?.running)
  const compacting = Boolean(activeChat?.compacting)
  const usage: ChatContextUsage | undefined = activeChat?.contextUsage
  // 水位告警线：窗口 − 16384（pi 自动压缩保留量，见实施计划 2.1）≈ 87% 起显眼
  const usageCritical = usage?.percent !== null && usage !== undefined && (usage.percent ?? 0) >= 80
  // 折叠态只渲染尾部几条（DOM 里不再挂着全部历史靠 CSS 裁剪）；展开态才全量
  const history = fullHistory

  const expertEntry = expertTaskId
    ? (expertEntries.find((entry) => entry.task.taskId === expertTaskId) ?? null)
    : null
  const expertTask = expertEntry?.task ?? null
  const expertRunning = expertEntry?.running ?? false
  const expertLabelOf = useMemo(() => {
    const labels = new Map(experts.map((expert) => [expert.id, expert.label]))
    return (id: string | undefined): string => (id ? (labels.get(id) ?? id) : '专家')
  }, [experts])
  const expertLabel = expertTask ? expertLabelOf(expertTask.expert) : ''
  const expertMeta = expertTask ? TASK_STATUS_META[expertTask.status] : null
  const workspaceName = workspace?.name ?? '工作区'
  const workspaceInitial = workspaceName.trim().slice(0, 1).toUpperCase() || 'H'

  // 工作区切换后任务板会被清空：旧专家视图必须一起退出，不能把上一个工作区的线程留在画面上
  useEffect(() => {
    setExpertTaskId(null)
    setTeamOpen(false)
  }, [workspace?.path])

  // 任务从 board 投影里消失（理论上只在切换工作区/清理时发生）：退回主对话
  useEffect(() => {
    if (!expertTaskId) return
    if (expertEntries.length > 0 && !expertEntries.some((entry) => entry.task.taskId === expertTaskId)) {
      setExpertTaskId(null)
    }
  }, [expertTaskId, expertEntries])

  // 新消息 / 流式回填自动滚到底部（专家视图打开时主对话隐藏，不抢滚动位置）
  useEffect(() => {
    if (expertTask) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history, expertTask])

  const usageTitle = usage
    ? usage.tokens === null
      ? '上下文水位待更新（压缩后需一轮新响应）'
      : `上下文约占 ${Math.round(usage.percent ?? 0)}%（${usage.tokens}/${usage.contextWindow} tokens）`
    : undefined

  const allSelected = sessions.length > 0 && selectedIds.size >= sessions.length

  /** 关菜单即退出管理态：选中集只在菜单可见时有意义 */
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setManageMode(false)
    setSelectedIds(new Set())
  }, [])

  // 会话菜单：点外部 / Esc 收起（与 Dropdown chip 同一交互语言）
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      closeMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, closeMenu])

  return (
    <div className="pointer-events-auto flex h-full min-h-0 w-full flex-col">
      {/* 头部（原型 .chat-head）：会话名/Agent 身份 + 水位 + 新建/删除。
          右栏常驻，没有折叠态，所以不再有"把手行"。
          会话名兼作会话列表入口（原来的浮层已随「素材库改页面」一并移除）。 */}
      <div
        data-testid="chat-dock"
        // 与素材库页头部同高（56px）：切换页面时内容起点不跳
        className="relative flex min-h-14 shrink-0 items-center gap-2.5 border-b border-(--outline-soft) px-3 py-2.5"
      >
        <div className="flex min-w-0 shrink items-center gap-1 self-start text-[11px] leading-none text-(--on-surface-muted)">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] bg-(--on-surface) text-[9.5px] font-semibold text-(--surface-card)">
            {workspaceInitial}
          </span>
          {expertTask ? (
            <button
              onClick={() => {
                setExpertTaskId(null)
                closeMenu()
              }}
              className="max-w-[88px] truncate rounded px-0.5 transition-colors hover:text-(--on-surface)"
              title="返回主对话"
            >
              {workspaceName}
            </button>
          ) : (
            <span className="max-w-[88px] truncate">{workspaceName}</span>
          )}
          <span className="shrink-0 text-(--outline)">/</span>
        </div>

        <div ref={menuRef} className="min-w-0 flex-1">
          {!expertTask ? (
            <>
              <button
                onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                data-testid="session-menu-trigger"
                title={session ? `会话 ID：${session.id}${session.sessionFile ? `
会话文件：${session.sessionFile}` : ''}\n点击切换会话` : '切换会话'}
                className="flex max-w-full items-center gap-1 text-left"
              >
                <span className="truncate text-[13px] font-semibold leading-tight text-(--on-surface)">
                  {session?.title ?? '对话'}
                </span>
                <ChevronDown
                  size={11}
                  className={`shrink-0 text-(--on-surface-muted) transition-transform ${menuOpen ? 'rotate-180' : ''}`}
                />
              </button>
              <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-(--on-surface-muted)">
                <span>{fullHistory.length} 条</span>
                {session ? <span className="font-mono text-[9.5px] opacity-70">#{session.id.slice(0, 6)}</span> : null}
                {running ? <span className="text-(--accent)">· 生成中…</span> : null}
                {compacting ? <span className="text-(--accent)">· 压缩中…</span> : null}
              </div>
            </>
          ) : (
            <>
              <button
                onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                data-testid="expert-menu-trigger"
                title="切换主对话 / 专家对话"
                className="flex max-w-full items-center gap-1.5 text-left"
              >
                <ExpertAvatar
                  seed={expertTask.expert ?? 'expert-visual'}
                  size={16}
                  radius="30%"
                  status={expertRunning ? 'running' : (expertMeta?.dot ?? 'idle')}
                  label={expertLabel}
                />
                <span className="truncate text-[13px] font-semibold leading-tight text-(--on-surface)">
                  {expertLabel}
                </span>
                {expertMeta ? (
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-[1px] text-[9.5px] font-medium ${expertMeta.className}`}
                  >
                    {expertRunning && expertTask.status !== 'done' ? '在跑' : expertMeta.label}
                  </span>
                ) : null}
                <ChevronDown
                  size={11}
                  className={`shrink-0 text-(--on-surface-muted) transition-transform ${menuOpen ? 'rotate-180' : ''}`}
                />
              </button>
              <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10.5px] text-(--on-surface-muted)">
                <span className="min-w-0 truncate">
                  {expertTask.scope || expertTask.title || expertTask.taskId}
                </span>
                <span className="shrink-0">· {relativeTime(expertTask.updatedAt)}</span>
              </div>
            </>
          )}

          {/* 会话切换浮层（原型 .session-menu）：贴着头部下沿，绝对定位盖住消息流 */}
          {menuOpen && (!expertTask ? (
            <div
              role="menu"
              data-testid="session-menu"
              className="absolute left-3 right-3 top-[calc(100%-2px)] z-50 max-h-[min(400px,60vh)] overflow-y-auto rounded-2xl bg-(--surface-card) p-1.5 shadow-[0_16px_40px_rgba(0,0,0,.16)] ring-1 ring-(--outline-soft)"
              data-scrollable=""
            >
              <div className="flex items-center justify-between px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">
                <span>会话</span>
                <span className="flex items-center gap-1.5 font-normal normal-case">
                  <span>{sessions.length} 个</span>
                  {/* 批量删除：进入管理态后点行 = 勾选（原有浮层面的能力，入口一并搬到这里） */}
                  <button
                    onClick={() => {
                      setManageMode((v) => !v)
                      setSelectedIds(new Set())
                    }}
                    className={`rounded-md px-1.5 py-0.5 text-[10px] transition-colors ${
                      manageMode
                        ? 'bg-(--accent) text-white'
                        : 'text-(--on-surface-variant) hover:bg-(--outline-soft) hover:text-(--on-surface)'
                    }`}
                    title={manageMode ? '退出批量管理' : '批量删除会话（不删除素材文件）'}
                  >
                    {manageMode ? '完成' : '管理'}
                  </button>
                </span>
              </div>
              {manageMode && (
                <div className="flex items-center gap-1 px-1.5 pb-1">
                  <button
                    onClick={() => setSelectedIds(allSelected ? new Set() : new Set(sessions.map((s) => s.id)))}
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
                  >
                    <ListChecks size={11} />
                    {allSelected ? '取消全选' : '全选'}
                  </button>
                  <button
                    onClick={() => {
                      if (selectedIds.size === 0) return
                      // 确认弹窗由 store 接管；成功后退出管理态，取消则保留多选
                      requestRemoveSessions(
                        [...selectedIds],
                        () => {
                          setManageMode(false)
                          setSelectedIds(new Set())
                        }
                      )
                    }}
                    disabled={selectedIds.size === 0}
                    className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-(--on-surface-variant) transition-colors hover:bg-(--danger)/10 hover:text-(--danger) disabled:cursor-default disabled:opacity-40"
                    title="删除所选会话（对话历史移除；画布与素材文件不受影响）"
                  >
                    <Trash2 size={11} />
                    删除 {selectedIds.size > 0 ? selectedIds.size : ''}
                  </button>
                </div>
              )}
              <SessionsPanel
                manageMode={manageMode}
                selectedIds={selectedIds}
                onToggleSelect={(id) =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(id)) next.delete(id)
                    else next.add(id)
                    return next
                  })
                }
                onSwitch={(id) => {
                  switchSession(id)
                  setMenuOpen(false)
                }}
              />
            </div>
          ) : (
            <div
              role="menu"
              data-testid="expert-switch-menu"
              className="absolute left-3 right-3 top-[calc(100%-2px)] z-50 max-h-[min(420px,62vh)] overflow-y-auto rounded-2xl bg-(--surface-card) p-1.5 shadow-[0_16px_40px_rgba(0,0,0,.16)] ring-1 ring-(--outline-soft)"
              data-scrollable=""
            >
              <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">
                切换对话
              </div>

              {/* 主对话：回到当前会话（会话之间的切换仍在主对话头部） */}
              <button
                onClick={() => {
                  setExpertTaskId(null)
                  closeMenu()
                }}
                className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors ${
                  !expertTaskId ? 'bg-(--surface-chip)' : 'hover:bg-(--surface-chip)'
                }`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-(--surface-chip) text-(--on-surface-muted)">
                  <MessageSquare size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-(--on-surface)">主对话</span>
                  <span className="mt-0.5 block truncate text-[10px] text-(--on-surface-muted)">
                    {session?.title ?? '当前会话'}
                  </span>
                </span>
                {!expertTaskId ? <Check size={12} className="shrink-0 text-(--accent)" /> : null}
              </button>

              <div className="mt-1 border-t border-(--outline-soft) px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">
                专家对话
              </div>
              {expertEntries.length === 0 ? (
                <div className="px-2 pb-2 text-[11px] leading-relaxed text-(--on-surface-muted)">
                  还没有派过单。在对话里描述要产出的镜头，Agent 会派给专家团执行。
                </div>
              ) : (
                expertEntries.map(({ task, running: taskRunning }) => {
                  const meta = TASK_STATUS_META[task.status]
                  const selected = task.taskId === expertTaskId
                  return (
                    <button
                      key={task.taskId}
                      onClick={() => {
                        setExpertTaskId(task.taskId)
                        closeMenu()
                      }}
                      className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors ${
                        selected ? 'bg-(--surface-chip)' : 'hover:bg-(--surface-chip)'
                      }`}
                    >
                      <ExpertAvatar
                        seed={task.expert ?? 'expert-visual'}
                        size={24}
                        radius="30%"
                        status={taskRunning ? 'running' : meta.dot}
                        label={expertLabelOf(task.expert)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium text-(--on-surface)">
                            {expertLabelOf(task.expert)}
                          </span>
                          <span className={`shrink-0 rounded-full px-1.5 py-[1px] text-[9px] font-medium ${meta.className}`}>
                            {taskRunning && task.status !== 'done' ? '在跑' : meta.label}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-(--on-surface-muted)">
                          {task.scope || task.title || task.taskId}
                          <span className="ml-1 font-mono opacity-70">· {task.taskId}</span>
                        </span>
                      </span>
                      {selected ? <Check size={12} className="shrink-0 text-(--accent)" /> : null}
                    </button>
                  )
                })
              )}
            </div>
          ))}
        </div>
        {expertTask ? (
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => {
                setExpertTaskId(null)
                closeMenu()
              }}
              className="rounded-lg p-1.5 text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface)"
              title="返回主对话"
              data-testid="expert-back-button"
            >
              <ArrowLeft size={14} />
            </button>
            <button
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
              onMouseDown={(event) => event.stopPropagation()}
              className="rounded-lg p-1.5 text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface)"
              title="切换主对话 / 专家对话"
              data-testid="expert-more-button"
            >
              <MoreHorizontal size={14} />
            </button>
          </span>
        ) : (
          <>
            {usage?.contextWindow ? (
              <span
                data-testid="context-usage"
                className={`shrink-0 font-mono text-[10px] ${
                  usageCritical ? 'font-medium text-(--danger)' : 'text-(--on-surface-muted)'
                }`}
                title={usageTitle}
              >
                {usage.tokens === null ? '—' : `${Math.round(usage.percent ?? 0)}%`}
              </span>
            ) : null}
            {session && (
              <span className="flex shrink-0 items-center gap-0.5">
                <button
                  onClick={() => createSession()}
                  className="rounded-lg p-1.5 text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface)"
                  title="新建对话（画布与素材不受影响）"
                  data-testid="new-session-button"
                >
                  <Plus size={13} />
                </button>
                <button
                  onClick={() => requestRemoveSession(session.id)}
                  className="rounded-lg p-1.5 text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft) hover:text-(--danger)"
                  title="删除会话（不删除素材文件）"
                >
                  <Trash2 size={13} />
                </button>
              </span>
            )}
          </>
        )}
      </div>

      {/* 主对话视图：专家视图打开时只隐藏不卸载（Composer 草稿/滚动位置都要保留） */}
      <div className={expertTask ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
      {/* 消息流（原型 .chat-scroll）：全高、独立滚动，不做折叠 */}
      <div ref={bodyRef} data-scrollable="" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3.5">
        <div ref={contentRef} className="flex min-h-full flex-col gap-2.5">
          {history.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
              <div className="mb-1 grid h-10 w-10 place-items-center rounded-xl bg-(--surface-chip) text-(--on-surface-muted)">
                <MessageSquare size={18} />
              </div>
              <div className="text-[13px] font-semibold text-(--on-surface)">开始一轮对话</div>
              <div className="max-w-[260px] text-[12px] leading-relaxed text-(--on-surface-muted)">
                选中画布资源、拖入文件（临时引用）或直接描述需求；当前层级的节点会作为上下文。
              </div>
            </div>
          ) : null}
          {history.map((m) => (
            <MessageBubble key={m.id} m={m} expanded={expanded} />
          ))}
        </div>
      </div>

      {/* 底部输入区（原型 .chat-footer）：专家团状态条 + 一条分隔线 + Composer。
          任务板浮层从状态条向上展开（absolute bottom-full），不挤压消息流。 */}
      <div className="relative shrink-0 border-t border-(--outline-soft) px-3 pb-3 pt-2.5">
        <div className="relative">
          {teamOpen && (
            <TeamPopover
              onClose={() => setTeamOpen(false)}
              onOpenConversation={(taskId) => {
                setExpertTaskId(taskId)
                setTeamOpen(false)
                setMenuOpen(false)
              }}
            />
          )}
          <ExpertStrip expanded={teamOpen} onToggle={() => setTeamOpen((v) => !v)} />
        </div>
        <Composer />
      </div>
      </div>

      {expertTask ? (
        <ExpertConversationView
          key={expertTask.taskId}
          task={expertTask}
          running={expertRunning}
        />
      ) : null}
    </div>
  )
}
