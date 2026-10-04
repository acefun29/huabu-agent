import { memo, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { LucideIcon } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import {
  AlertTriangle,
  Brain,
  ChevronRight,
  Clapperboard,
  Eye,
  FileText,
  Film,
  Image as ImageIcon,
  ImagePlus,
  List,
  Loader2,
  Music2,
  Pencil,
  Plug,
  Wrench
} from 'lucide-react'
import type { ChatMessageBlock, ChatToolCallView } from '../../types'
import { Collapse } from '../Collapse'

/**
 * 消息内容块渲染（ZCode 式扁平行：无胶囊包裹，图标 + 标签 + 摘要内联，展开内容走左线缩进）。
 *
 * 流式草稿与已定稿的历史消息都走这里：lib/chatStream.ts 的 toRenderBlocks
 * 会把草稿转成与 ChatMessage.blocks 相同的形态，因此不需要两套渲染代码。
 */

/* -------------------------------------------------------------------------- */
/* 工具行的语义化图标 / 标签 / 摘要                                              */
/* -------------------------------------------------------------------------- */

/** 工具名 → 行内图标与中文动词标签（mcp_* 统一 Plug，名字去掉前缀） */
function toolVisual(name: string): { icon: LucideIcon; label: string } {
  if (name.startsWith('mcp_')) return { icon: Plug, label: name.slice(4) }
  switch (name) {
    case 'ls':
      return { icon: List, label: '列目录' }
    case 'read':
      return { icon: FileText, label: '读取' }
    case 'write':
      return { icon: Pencil, label: '写入' }
    case 'generate_image':
      return { icon: ImagePlus, label: '生成图片' }
    case 'generate_video':
      return { icon: Film, label: '生成视频' }
    case 'generate_audio':
      return { icon: Music2, label: '生成音频' }
    case 'read_media':
      return { icon: Eye, label: '读媒体' }
    case 'skim_video':
      return { icon: Clapperboard, label: '粗扫视频' }
    case 'read_video_frames':
      return { icon: Film, label: '读视频帧' }
    default:
      return { icon: Wrench, label: name }
  }
}

/** 从参数里提取行内摘要：路径拆成「文件名 + 目录」两段，其余取首个字符串值 */
function toolPreview(toolCall: ChatToolCallView): { primary: string; secondary?: string } {
  const args = (toolCall.args ?? {}) as Record<string, unknown>
  const pathKeys = ['path', 'file_path', 'file', 'relPath', 'artifactPath']
  const otherKeys = ['command', 'prompt', 'query', 'url', 'dir']
  for (const key of pathKeys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      const normalized = value.replace(/\\/g, '/')
      const cut = normalized.lastIndexOf('/')
      if (cut >= 0) return { primary: normalized.slice(cut + 1) || normalized, secondary: normalized.slice(0, cut + 1) }
      return { primary: normalized }
    }
  }
  for (const key of otherKeys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return { primary: value }
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return { primary: value }
  }
  return { primary: '' }
}

/** 工具卡的结果图片（仅回放：主进程已缩 ≤256px；缩略失败的是带源路径的 chip） */
function ToolCallImages({ toolCall }: { toolCall: ChatToolCallView }): JSX.Element | null {
  const images = toolCall.images
  if (!images || images.length === 0) return null
  return (
    <div className="ml-6 flex flex-wrap gap-1 py-1" data-testid="tool-call-images">
      {images.map((image, index) =>
        image.thumbBase64 ? (
          <img
            key={index}
            src={`data:image/jpeg;base64,${image.thumbBase64}`}
            alt={image.label ?? '工具图片'}
            title={image.label}
            className="h-16 w-16 rounded object-cover ring-1 ring-(--outline-soft)"
          />
        ) : (
          <span
            key={index}
            title={image.label}
            className="flex max-w-[220px] items-center gap-1 rounded-full bg-(--surface-card) px-2 py-0.5 text-[10.5px] text-(--on-surface-variant) ring-1 ring-(--outline-soft)"
          >
            <ImageIcon size={11} className="shrink-0" />
            <span className="truncate">{image.label ?? '工具图片'}</span>
          </span>
        )
      )}
    </div>
  )
}

/** 工具调用行：图标 + 动词标签 + 参数摘要，点击展开参数与结果（无底色无外框） */
function ToolCallCard({ toolCall }: { toolCall: ChatToolCallView }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // 详情首次展开才挂载；收起动画期间 Collapse 需要内容仍挂在 DOM 里
  const [openedOnce, setOpenedOnce] = useState(false)

  const { icon: Icon, label } = toolVisual(toolCall.name)
  const preview = toolPreview(toolCall)
  const args = Object.entries(toolCall.args ?? {})
  const hasBody = args.length > 0 || Boolean(toolCall.resultText)
  const isRunning = toolCall.status === 'running'
  const isError = toolCall.status === 'error'

  return (
    <div data-testid="tool-call" data-tool-name={toolCall.name} data-status={toolCall.status} >
      <button
        onClick={() => {
          if (!hasBody) return
          setExpanded((value) => !value)
          setOpenedOnce(true)
        }}
        disabled={!hasBody}
        data-testid="tool-call-toggle"
        data-expanded={expanded ? 'true' : 'false'}
        className={`flex w-full items-center gap-1.5 px-1 py-1 text-left text-xs ${
          hasBody ? 'cursor-pointer' : 'cursor-default'
        }`}
        title={hasBody ? (expanded ? '收起' : '展开参数与结果') : '暂无可展开内容'}
      >
        <Icon size={13} className={`shrink-0 ${isError ? 'text-(--danger)' : 'text-(--on-surface-muted)'}`} />
        <span className={`shrink-0 ${isError ? 'text-(--danger)' : 'text-(--on-surface-muted)'}`}>{label}</span>
        {preview.primary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-(--on-surface-muted)">{preview.primary}</span>
        )}
        {preview.secondary && (
          <span className="hidden max-w-[40%] shrink-0 truncate font-mono text-[11px] text-(--on-surface-muted) opacity-70 sm:block">
            {preview.secondary}
          </span>
        )}
        {isRunning && <Loader2 size={12} className="ml-auto shrink-0 animate-spin text-(--accent)" />}
        {isError && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-(--danger)">
            <AlertTriangle size={12} />
            失败
          </span>
        )}
      </button>

      {/* 长任务执行中的实时进度（媒体生成推送排队/生成中/完成百分比） */}
      {isRunning && toolCall.progressText && (
        <div
          className="ml-6 flex items-center gap-1.5 py-0.5 text-[11px] text-(--on-surface-muted)"
          data-testid="tool-call-progress"
        >
          <span className="h-1 w-1 animate-pulse rounded-full bg-(--accent)" />
          {toolCall.progressText}
        </div>
      )}

      {/* 结果图片缩略（回放）；缩略失败/超上限的是带源路径的 chip */}
      <ToolCallImages toolCall={toolCall} />

      <Collapse open={expanded}>
        {openedOnce && hasBody && (
          <div
            data-testid="tool-call-detail"
            className="selectable ml-2 space-y-2 border-l border-(--outline-soft) py-1 pl-3"
          >
            {args.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">参数</div>
                <dl className="space-y-1">
                  {args.map(([key, value]) => (
                    <div key={key} className="flex gap-2">
                      <dt className="shrink-0 font-mono text-(--on-surface-muted)">{key}</dt>
                      <dd className="min-w-0 flex-1 break-all whitespace-pre-wrap font-mono text-(--on-surface-variant)">
                        {String(value ?? '')}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {toolCall.resultText && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">结果</div>
                <pre
                  data-scrollable=""
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-(--on-surface-variant)"
                >
                  {toolCall.resultText}
                </pre>
              </div>
            )}
          </div>
        )}
      </Collapse>
    </div>
  )
}

/** 思维链块的持续时长文案（客户端实测：流式开始计时，落稿定格；历史回放无计时） */
function formatThinkingDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  if (total < 60) return `持续了 ${total} 秒`
  return `持续了 ${Math.floor(total / 60)} 分 ${total % 60} 秒`
}

/** 思维链：扁平行（思考 · 持续了 N 秒），展开内容走左线缩进；流式时行内流式预览 */
function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // 正文首次展开才挂载（没展开过的块保持零 DOM 成本）；收起动画期间 Collapse 需要内容仍挂在 DOM 里
  const [openedOnce, setOpenedOnce] = useState(false)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const startRef = useRef<number | null>(null)

  // 流式开始计时 → 落稿定格；历史回放（从未 streaming）不显示时长
  useEffect(() => {
    if (streaming) {
      if (startRef.current === null) startRef.current = Date.now()
    } else if (startRef.current !== null) {
      setDurationMs(Date.now() - startRef.current)
      startRef.current = null
    }
  }, [streaming])

  // 先截 200 字符再清洗：流式期间 text 可达几十 KB 且每 32ms 重渲一次，对全文跑正则纯浪费。
  // 取舍：预览取自前 200 字符（首个非空白位置若更靠后，预览会比全文版略短）。
  const preview = text.slice(0, 200).replace(/\s+/g, ' ').slice(0, 140)
  const showDuration = !streaming && durationMs !== null

  return (
    <div data-testid="thinking-block" >
      <button
        onClick={() => {
          setExpanded((value) => !value)
          setOpenedOnce(true)
        }}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-1 py-1 text-left text-xs"
        title={expanded ? '收起思维链' : '展开思维链'}
      >
        <Brain size={13} className="shrink-0 text-(--on-surface-muted)" />
        <span className="shrink-0 text-(--on-surface-muted)">{streaming ? '正在思考' : '思考'}</span>
        {streaming ? (
          preview && <span className="min-w-0 flex-1 truncate text-(--on-surface-muted)">{preview}</span>
        ) : (
          showDuration && <span className="shrink-0 text-(--on-surface-muted)">· {formatThinkingDuration(durationMs)}</span>
        )}
        {streaming ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-(--on-surface-muted)" />
        ) : (
          <ChevronRight
            size={12}
            className={`shrink-0 text-(--on-surface-muted) transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        )}
      </button>
      <Collapse open={expanded}>
        {openedOnce && (
          <div
            data-scrollable=""
            className="selectable ml-2 max-h-48 overflow-auto border-l border-(--outline-soft) py-1 pl-3 text-xs leading-relaxed whitespace-pre-wrap text-(--on-surface-variant)"
          >
            {text}
          </div>
        )}
      </Collapse>
    </div>
  )
}

/** 已定稿的文本块：markdown 解析结果按 text 缓存（memo 浅比较），流式刷新零重算 */
const MarkdownTextBlock = memo(function MarkdownTextBlock({ text }: { text: string }): JSX.Element {
  return <ReactMarkdown>{text}</ReactMarkdown>
})

/** 流式中的文本块：纯文本渲染，定稿后才升级 markdown */
function StreamingTextBlock({ text }: { text: string }): JSX.Element {
  return <span className="whitespace-pre-wrap">{text}</span>
}

export function ChatMessageBlocks({
  blocks,
  streaming = false,
}: {
  blocks: ChatMessageBlock[]
  streaming?: boolean
}): JSX.Element {
  return (
    <div className="space-y-0.5">
      {blocks.map((block, index) => {
        // 只有最后一个块在流式中，前面的块已经定稿
        const isActive = streaming && index === blocks.length - 1
        if (block.kind === 'thinking') {
          return <ThinkingBlock key={index} text={block.text} streaming={isActive} />
        }
        if (block.kind === 'tool') {
          return <ToolCallCard key={block.toolCall.id || index} toolCall={block.toolCall} />
        }
        return (
          <div key={index} className="markdown-body text-[13px] leading-relaxed">
            {isActive ? <StreamingTextBlock text={block.text} /> : <MarkdownTextBlock text={block.text} />}
            {/* 流式光标：没有它，模型思考或工具执行的间隙看起来像卡死 */}
            {isActive && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-(--accent) align-text-bottom" />
            )}
          </div>
        )
      })}
    </div>
  )
}
