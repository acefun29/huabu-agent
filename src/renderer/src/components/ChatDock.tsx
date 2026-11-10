import { memo, useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  ChevronRight,
  FileCode,
  FileText,
  FoldVertical,
  Image as ImageIcon,
  MessageSquare,
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
import { Composer } from './Composer'

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
  const activeSessionId = useCanvasStore((s) => s.activeSessionId)
  // 压缩/fork 走输入框 / 命令（用户裁决）；头部只留 + 新建对话、删除；停止在 Composer 的发送按钮上
  const { createSession, requestRemoveSession } = useCanvasStore.getState()
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

  // 新消息 / 流式回填自动滚到底部
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history])

  void activeSessionId

  const usageTitle = usage
    ? usage.tokens === null
      ? '上下文水位待更新（压缩后需一轮新响应）'
      : `上下文约占 ${Math.round(usage.percent ?? 0)}%（${usage.tokens}/${usage.contextWindow} tokens）`
    : undefined

  return (
    <div className="pointer-events-auto flex h-full min-h-0 w-full flex-col">
      {/* 头部（原型 .chat-head）：头像 + 会话名/Agent 身份 + 水位 + 新建/删除。
          右栏常驻，没有折叠态，所以不再有"把手行"。 */}
      <div
        data-testid="chat-dock"
        className="flex shrink-0 items-center gap-2.5 border-b border-(--outline-soft) px-3 py-2.5"
      >
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[13px] font-semibold leading-tight text-(--on-surface)"
            title={session ? `会话 ID：${session.id}${session.sessionFile ? `
会话文件：${session.sessionFile}` : ''}` : undefined}
          >
            {session?.title ?? '对话'}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-(--on-surface-muted)">
            <span>{fullHistory.length} 条</span>
            {session ? <span className="font-mono text-[9.5px] opacity-70">#{session.id.slice(0, 6)}</span> : null}
            {running ? <span className="text-(--accent)">· 生成中…</span> : null}
            {compacting ? <span className="text-(--accent)">· 压缩中…</span> : null}
          </div>
        </div>
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
      </div>

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

      {/* 底部输入区（原型 .chat-footer）：一条分隔线 + Composer */}
      <div className="shrink-0 border-t border-(--outline-soft) px-3 pb-3 pt-2.5">
        <Composer />
      </div>
    </div>
  )
}
