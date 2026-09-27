import { memo, useState } from 'react'
import type { JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import { AlertTriangle, Brain, Check, ChevronRight, Image as ImageIcon, Loader2, Wrench } from 'lucide-react'
import type { ChatMessageBlock, ChatToolCallView } from '../../types'

/**
 * 消息内容块渲染。
 *
 * 流式草稿与已定稿的历史消息都走这里：lib/chatStream.ts 的 toRenderBlocks
 * 会把草稿转成与 ChatMessage.blocks 相同的形态，因此不需要两套渲染代码。
 */

/** 工具卡的结果图片（仅回放：主进程已缩 ≤256px；缩略失败的是带源路径的 chip） */
function ToolCallImages({ toolCall }: { toolCall: ChatToolCallView }): JSX.Element | null {
  const images = toolCall.images
  if (!images || images.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 border-t border-(--outline-soft) px-2.5 py-1.5" data-testid="tool-call-images">
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

/** 工具调用卡片：工具名 + 状态 + 可展开的参数与结果 */
function ToolCallCard({ toolCall }: { toolCall: ChatToolCallView }): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const statusIcon =
    toolCall.status === 'running' ? (
      <Loader2 size={12} className="animate-spin text-(--accent)" />
    ) : toolCall.status === 'done' ? (
      <Check size={12} className="text-(--success-text)" />
    ) : (
      <AlertTriangle size={12} className="text-(--danger)" />
    )

  const statusText =
    toolCall.status === 'running' ? '执行中' : toolCall.status === 'done' ? '完成' : '失败'

  const args = Object.entries(toolCall.args ?? {})
  const hasBody = args.length > 0 || Boolean(toolCall.resultText)

  return (
    <div
      data-testid="tool-call"
      data-tool-name={toolCall.name}
      data-status={toolCall.status}
      className={`my-1.5 rounded-lg border text-xs ${
        toolCall.status === 'error'
          ? 'border-(--danger)/30 bg-(--danger)/5'
          : 'border-(--outline-soft) bg-(--surface-chip)/60'
      }`}
    >
      <button
        onClick={() => hasBody && setExpanded((value) => !value)}
        disabled={!hasBody}
        data-testid="tool-call-toggle"
        data-expanded={expanded ? 'true' : 'false'}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default"
        title={hasBody ? (expanded ? '收起' : '展开参数与结果') : '暂无可展开内容'}
      >
        {hasBody ? (
          <ChevronRight
            size={12}
            className={`shrink-0 text-(--on-surface-muted) transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Wrench size={12} className="shrink-0 text-(--on-surface-muted)" />
        <span className="font-mono font-medium text-(--on-surface)">{toolCall.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-(--on-surface-muted)">
          {statusIcon}
          {statusText}
        </span>
      </button>

      {/* 长任务执行中的实时进度（媒体生成推送排队/生成中/完成百分比） */}
      {toolCall.status === 'running' && toolCall.progressText && (
        <div
          className="flex items-center gap-1.5 border-t border-(--outline-soft) px-2.5 py-1 text-[11px] text-(--on-surface-muted)"
          data-testid="tool-call-progress"
        >
          <span className="h-1 w-1 animate-pulse rounded-full bg-(--accent)" />
          {toolCall.progressText}
        </div>
      )}

      {/* 结果图片缩略（回放）；缩略失败/超上限的是带源路径的 chip */}
      <ToolCallImages toolCall={toolCall} />

      {expanded && hasBody && (
        <div data-testid="tool-call-detail" className="selectable space-y-2 border-t border-(--outline-soft) px-2.5 py-2">
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
              <pre data-scrollable="" className="max-h-48 overflow-auto rounded bg-(--surface-input) p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-(--on-surface-variant)">
                {toolCall.resultText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 思维链块，默认折叠（推理模型先思考再说话，折叠保证首个正文 token 前有反馈） */
function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // 先截 200 字符再清洗：流式期间 text 可达几十 KB 且每 32ms 重渲一次，对全文跑正则纯浪费。
  // 取舍：预览取自前 200 字符（首个非空白位置若更靠后，预览会比全文版略短），折叠态预览可接受。
  const preview = text.slice(0, 200).replace(/\s+/g, ' ').slice(0, 48)

  return (
    <div data-testid="thinking-block" className="my-1.5 rounded-lg border border-(--outline-soft) bg-(--surface-chip)/50 text-xs">
      <button
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        title={expanded ? '收起思维链' : '展开思维链'}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-(--on-surface-muted) transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <Brain size={12} className="shrink-0 text-(--accent)" />
        <span className="shrink-0 font-medium text-(--on-surface-variant)">思维链</span>
        {!expanded && (
          <span className="min-w-0 flex-1 truncate text-(--on-surface-muted)">
            {streaming && text.length === 0 ? '思考中' : preview}
          </span>
        )}
        {streaming && <Loader2 size={12} className="ml-auto shrink-0 animate-spin text-(--accent)" />}
      </button>
      {expanded && (
        <div data-scrollable="" className="selectable max-h-48 overflow-auto border-t border-(--outline-soft) px-2.5 py-2 whitespace-pre-wrap text-(--on-surface-variant)">
          {text}
        </div>
      )}
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
