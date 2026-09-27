import { memo, useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileCode,
  FileText,
  FoldVertical,
  Image as ImageIcon,
  MessageSquare,
  Plus,
  Square,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import { motion } from 'motion/react'
import type { AssetKind, ChatMessage } from '../types'
import type { ChatContextBreakdownInfo, ChatContextUsage, ChatHistoryImage } from '@shared/ipc'
import { useCanvasStore } from '../store/canvasStore'
import { bumpRender } from '../lib/perfProbe'
import { ChatMessageBlocks } from './chat/ChatMessageBlocks'
import { Composer } from './Composer'

function assetIcon(kind: AssetKind) {
  if (kind === 'image') return <ImageIcon size={11} />
  if (kind === 'video') return <Video size={11} />
  if (kind === 'audio') return <AudioLines size={11} />
  if (kind === 'doc') return <FileText size={11} />
  return <FileCode size={11} />
}

/** 上下文 token 紧凑显示（与 SettingsPanel.compactTokens 同一思路） */
function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`
  }
  if (value % 1024 === 0) return `${value / 1024}K`
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

/** 压缩分隔条：本地合成（T2）与回放重建（T4）同形，摘要默认折叠 */
const CompactionDivider = memo(function CompactionDivider({
  message,
  faded,
}: {
  message: ChatMessage
  faded?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
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
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 font-medium"
          title={expanded ? '收起压缩摘要' : '展开压缩摘要'}
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

/** 用户消息里的注入段折叠（回放拆分产物：正文在上，注入的清单/态势默认收起） */
function UserContextPayload({ payload }: { payload: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mt-1.5 border-t border-dashed border-(--outline-soft) pt-1.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[10.5px] text-(--on-surface-muted)"
        title={expanded ? '收起本轮注入的上下文' : '展开本轮注入的上下文'}
      >
        <ChevronRight size={10} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        本轮注入的上下文
      </button>
      {expanded && (
        <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-left text-[10.5px] text-(--on-surface-variant)" data-scrollable="">
          {payload}
        </div>
      )}
    </div>
  )
}

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
          {m.contextPayload && <UserContextPayload payload={m.contextPayload} />}
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

/** 分布明细桶的展示名与说明（key 语义见 shared/ipc.ts ChatContextBucket） */
const BUCKET_LABEL: Record<ChatContextBreakdownInfo['buckets'][number]['key'], string> = {
  user: '用户消息',
  assistant_text: '助手文本',
  thinking: '思维链',
  tool_call: '工具调用',
  tool_result: '工具结果',
  images: '图片',
  compaction: '压缩摘要',
  unattributed: '未归因（系统提示词/工具定义/估算误差）'
}

/** 上下文占用分布面板（T3）：分桶条形 + 占比；全部是估算值 */
function BreakdownPanel({
  breakdown,
  onClose,
}: {
  breakdown: ChatContextBreakdownInfo
  onClose: () => void
}) {
  return (
    <div
      data-testid="context-breakdown"
      className="pointer-events-auto w-full max-w-3xl rounded-2xl bg-(--surface-card) p-3 shadow-xl ring-1 ring-(--outline)"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-medium text-(--on-surface)">上下文占用分布（估算）</span>
        <span className="text-[10.5px] text-(--on-surface-muted)">
          {breakdown.totalTokens !== null
            ? `合计约 ${formatTokens(breakdown.totalTokens)} tokens`
            : '暂无可校准的用量（发一轮对话后可校准）'}
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft)"
          title="收起分布明细"
        >
          <X size={12} />
        </button>
      </div>
      <div className="space-y-1.5">
        {breakdown.buckets.map((bucket) => (
          <div key={bucket.key} className="flex items-center gap-2" title={bucket.summary}>
            <span className="w-44 shrink-0 truncate text-[11px] text-(--on-surface-variant)" title={BUCKET_LABEL[bucket.key]}>
              {BUCKET_LABEL[bucket.key]}
              {bucket.images ? `（${bucket.images} 张）` : ''}
            </span>
            <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-(--surface-chip)">
              <div
                className={`h-full rounded-full ${bucket.key === 'unattributed' ? 'bg-(--outline)' : 'bg-(--accent)'}`}
                style={{ width: `${Math.min(100, Math.max(0, bucket.share * 100))}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-right font-mono text-[10.5px] text-(--on-surface-muted)">
              {bucket.tokens > 0 ? formatTokens(bucket.tokens) : '—'}
            </span>
            <span className="w-10 shrink-0 text-right font-mono text-[10.5px] text-(--on-surface-muted)">
              {bucket.share > 0.001 ? `${Math.round(bucket.share * 100)}%` : ''}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[10px] leading-relaxed text-(--on-surface-muted)">
        估算口径：字符数/4、图片 1200 token/张，并用最近一次用量校准；这是分布参考，不是精确账单。
        {breakdown.contextWindow ? ` 上下文窗口 ${formatTokens(breakdown.contextWindow)}。` : ''}
      </div>
    </div>
  )
}

/** 折叠态高度上限：恰好露出最近一到两轮对话；内容不足时高度自适应收紧 */
const COLLAPSED_MAX_H = 148
/** 折叠态渲染的尾部消息条数（溢出部分本来就被裁掉，不必进 DOM） */
const COLLAPSED_TAIL = 6
/** 把手行高度 + 底部留白 */
const HEADER_H = 42

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
  // 压缩/fork 走输入框 / 命令（用户裁决）；头部只留 + 新建对话、停止、删除
  const { createSession, requestRemoveSession, stopChat, fetchContextBreakdown } =
    useCanvasStore.getState()
  const [expanded, setExpanded] = useState(false)
  const [expandedH, setExpandedH] = useState(520)
  const [contentH, setContentH] = useState(0)
  const [breakdown, setBreakdown] = useState<ChatContextBreakdownInfo | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onResize = () => setExpandedH(Math.min(560, Math.round(window.innerHeight * 0.58)))
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const fullHistory = activeChat?.history ?? []
  const running = Boolean(activeChat?.running)
  const compacting = Boolean(activeChat?.compacting)
  const usage: ChatContextUsage | undefined = activeChat?.contextUsage
  // 水位告警线：窗口 − 16384（pi 自动压缩保留量，见实施计划 2.1）≈ 87% 起显眼
  const usageCritical = usage?.percent !== null && usage !== undefined && (usage.percent ?? 0) >= 80
  // 折叠态只渲染尾部几条（DOM 里不再挂着全部历史靠 CSS 裁剪）；展开态才全量
  const history = expanded ? fullHistory : fullHistory.slice(-COLLAPSED_TAIL)

  // 测量消息内容真实高度：折叠态抽屉随之收紧，不出现大块空白
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const update = () => setContentH(el.scrollHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 展开态下新消息 / 流式回填自动滚到底部
  useEffect(() => {
    if (!expanded) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history, expanded])

  // 切换会话后回到默认折叠态，分布面板随之关闭（数据是按会话拉的）
  useEffect(() => {
    setExpanded(false)
    setBreakdown(null)
  }, [activeSessionId])

  const toggleBreakdown = async () => {
    if (breakdown) {
      setBreakdown(null)
      return
    }
    if (!activeSessionId) return
    const data = await fetchContextBreakdown(activeSessionId)
    if (data) setBreakdown(data)
  }

  const collapsedH = Math.min(COLLAPSED_MAX_H, HEADER_H + contentH)
  const clipped = HEADER_H + contentH > COLLAPSED_MAX_H

  const usageTitle = usage
    ? usage.tokens === null
      ? '上下文水位待更新（压缩后需一轮新响应）'
      : `上下文约占 ${Math.round(usage.percent ?? 0)}%（${usage.tokens}/${usage.contextWindow} tokens）${expanded ? '\n点击查看分布明细' : ''}`
    : undefined

  return (
    <div className="pointer-events-none absolute bottom-4 left-[72px] right-4 z-30 flex flex-col items-center gap-2.5">
      {breakdown && <BreakdownPanel breakdown={breakdown} onClose={() => setBreakdown(null)} />}
      {history.length > 0 && (
        <motion.div
          data-testid="chat-dock"
          initial={false}
          animate={{ height: expanded ? expandedH : collapsedH }}
          transition={{ type: 'spring', stiffness: 360, damping: 36, mass: 0.9 }}
          style={{ transitionProperty: 'background-color, box-shadow' }}
          className={`pointer-events-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-[24px] backdrop-blur-md duration-200 ${
            expanded
              ? 'bg-(--surface-card) shadow-xl ring-1 ring-(--outline)'
              : 'bg-(--drawer-peek) shadow-sm ring-1 ring-(--outline-soft)'
          }`}
        >
          {/* 把手行：点击或上下拖动切换展开态；折叠态细到一条 */}
          <motion.div
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={0.12}
            onDragEnd={(_e, info) => {
              if (info.offset.y < -36) setExpanded(true)
              else if (info.offset.y > 36) setExpanded(false)
            }}
            onClick={() => setExpanded((v) => !v)}
            className="relative flex h-[34px] shrink-0 cursor-grab touch-none select-none items-center gap-2 px-4 active:cursor-grabbing"
            title={expanded ? '点击或向下拖动收起' : '点击或向上拖动展开全部历史'}
          >
            <span className="absolute left-1/2 top-[5px] h-1 w-9 -translate-x-1/2 rounded-full bg-(--outline)" />
            <MessageSquare size={12} className="mt-1 shrink-0 text-(--accent)" />
            <span className="mt-1 min-w-0 flex-1 truncate text-[11px] font-medium text-(--on-surface-muted)">
              {session?.title ?? '对话'} · {fullHistory.length} 条
              {running ? ' · 生成中…' : ''}
              {compacting ? ' · 正在压缩上下文…' : ''}
            </span>
            {/* 水位段（T1）：percent + tokens/window；≥80% 变色提示（接近 pi 自动压缩触发线） */}
            {usage?.contextWindow ? (
              <span
                onClick={(e) => {
                  e.stopPropagation()
                  if (expanded) void toggleBreakdown()
                }}
                data-testid="context-usage"
                className={`mt-1 flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10.5px] ${
                  usageCritical ? 'bg-(--danger)/10 font-medium text-(--danger)' : 'text-(--on-surface-muted)'
                }`}
                title={usageTitle}
              >
                {usage.tokens === null ? (
                  <span>— 待更新</span>
                ) : (
                  <>
                    <span>{Math.round(usage.percent ?? 0)}%</span>
                    <span className="opacity-70">
                      {formatTokens(usage.tokens ?? 0)}/{formatTokens(usage.contextWindow)}
                    </span>
                  </>
                )}
              </span>
            ) : null}
            {expanded && session && (
              <span className="mt-1 flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => createSession()}
                  className="rounded-full p-1.5 text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
                  title="新建对话（画布与素材不受影响）"
                  data-testid="new-session-button"
                >
                  <Plus size={12} />
                </button>
                {running && (
                  <button
                    onClick={() => void stopChat(session.id)}
                    className="flex items-center gap-1 rounded-full px-1.5 py-1 text-[10.5px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft) hover:text-(--danger)"
                    title="停止当前生成"
                  >
                    <Square size={11} />
                    停止
                  </button>
                )}
                <button
                  onClick={() => requestRemoveSession(session.id)}
                  className="rounded-full p-1.5 text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft) hover:text-(--danger)"
                  title="删除会话（不删除素材文件）"
                >
                  <Trash2 size={12} />
                </button>
              </span>
            )}
            <span className="mt-1 shrink-0 text-(--on-surface-muted)">
              {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </span>
          </motion.div>

          {/* 消息体：折叠态底部对齐（流式输出照常可见），内容被裁掉时才加顶部渐隐 */}
          <div
            ref={bodyRef}
            data-scrollable=""
            className={`min-h-0 flex-1 px-4 pb-2 ${
              expanded ? 'overflow-y-auto' : 'flex flex-col justify-end overflow-hidden'
            }`}
            style={
              !expanded && clipped
                ? {
                    maskImage: 'linear-gradient(to bottom, transparent, black 26px)',
                    WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 26px)',
                  }
                : undefined
            }
          >
            <div ref={contentRef} className="space-y-3 py-1">
              {history.map((m) => (
                <MessageBubble key={m.id} m={m} expanded={expanded} />
              ))}
            </div>
          </div>
        </motion.div>
      )}
      <Composer />
    </div>
  )
}
