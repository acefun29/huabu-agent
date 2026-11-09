/**
 * 结构视图的右侧对话栏（原型 index-projects.html 的 chat-panel）。
 *
 * 与底部 ChatDock 的差异（按原型）：
 * - 位置：右侧常驻 400px 栏，不是底部悬浮条；
 * - 头部：当前范围 chip（「当前范围 全剧索引」+ 结构入口）+ Agent 身份；
 * - 正文：Agent 消息（含结构/统计回执）；
 * - 底部：输入框（复用现有 Composer 的视觉，但不接 Electron IPC 时给友好提示）。
 *
 * 消息来源：跨越范围时展示「当前范围」与 Agent 的最近回执；真实会话内容仍由
 * ChatDock 承载（自由画布模式）。本栏聚焦结构视图的任务上下文，不做第二套会话系统。
 */

import { useEffect, useRef, useState } from 'react'
import { Layers, Send } from 'lucide-react'

export interface StructureChatRailProps {
  /** 当前 scope 标题（如「全剧索引」/「EP01 雨夜进站」） */
  scopeTitle: string
  /** 返回画布 */
  onBack: () => void
}

interface RailMessage {
  id: string
  role: 'agent' | 'user'
  text: string
  /** 结构类回执的附加信息行（原型里的小字元信息） */
  meta?: string[]
}

export function StructureChatRail({ scopeTitle, onBack }: StructureChatRailProps) {
  const [messages, setMessages] = useState<RailMessage[]>([])
  const [draft, setDraft] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  /** 已播报过的范围（防重复回执） */
  const announced = useRef<Set<string>>(new Set())

  // 范围变化时，Agent 记一条「已切到某范围」的结构回执（同范围只播一次）
  useEffect(() => {
    if (announced.current.has(scopeTitle)) return
    announced.current.add(scopeTitle)
    setMessages((prev) => [
      ...prev,
      {
        id: `scope-${Date.now().toString(36)}`,
        role: 'agent',
        text: `当前范围已切到「${scopeTitle}」。这个范围下的节点会作为上下文；需要对某一层做什么，直接说。`,
        meta: ['范围随面包屑同步', '生成前会先做上下文预检'],
      },
    ])
  }, [scopeTitle])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now().toString(36)}`, role: 'user', text },
      {
        id: `a-${Date.now().toString(36)}`,
        role: 'agent',
        text: '收到。结构视图下的派单/生成链路已就绪：需要的是「范围 + 验收标准」，我会按信封发给专家并在通过后落成已生成。',
        meta: ['当前为结构演示数据', '真实生成需在工作区内配置模型凭据'],
      },
    ])
  }

  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-(--outline-soft) bg-(--surface-card)">
      {/* 头部：Agent 身份（原型 chat-head） */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-(--outline-soft) px-3 py-2.5">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-(--surface-chip) text-(--on-surface-variant) ring-1 ring-(--outline-soft)">
          <Layers size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight text-(--on-surface)">结构 Agent</div>
          <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-(--on-surface-muted)">
            <span className="font-medium text-(--on-surface-variant)">主 Agent</span>
            <span className="opacity-55">·</span>
            <span>按范围派单</span>
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-full border border-(--outline-soft) px-2 py-[3px] text-[10px] text-(--on-surface-muted) hover:text-(--on-surface-variant)"
          onClick={onBack}
        >
          画布
        </button>
      </div>

      {/* 当前范围 chip（原型「当前范围 全剧索引 | 结构」） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-(--outline-soft) px-3 py-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-(--surface-chip) px-2 py-[3px] text-[10.5px] text-(--on-surface-variant)">
          <span className="text-(--accent)">◎</span>
          当前范围
          <span className="font-medium">{scopeTitle}</span>
        </span>
      </div>

      {/* 消息区 */}
      <div ref={bodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] rounded-[14px] bg-[#2f6bd8] px-3 py-1.5 text-[12px] leading-relaxed text-white">
                {m.text}
              </div>
            ) : (
              <div className="max-w-full">
                <p className="text-[12px] leading-[1.62] text-(--on-surface)">{m.text}</p>
                {m.meta?.length ? (
                  <ul className="mt-1.5 space-y-0.5">
                    {m.meta.map((line) => (
                      <li key={line} className="flex items-center gap-1 text-[10.5px] text-(--on-surface-muted)">
                        <span className="opacity-60">↳</span>
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 输入区（原型 composer） */}
      <div className="shrink-0 border-t border-(--outline-soft) px-3 py-2.5">
        <div className="rounded-[14px] border border-(--outline-soft) bg-(--surface) px-2.5 py-2 focus-within:border-(--outline)">
          <textarea
            className="block max-h-[132px] w-full resize-none bg-transparent text-[12.5px] leading-relaxed text-(--on-surface) outline-none placeholder:text-(--on-surface-muted)"
            rows={2}
            placeholder="向 Agent 描述你的需求；当前层级的节点会作为上下文…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="mt-1 flex items-center gap-1">
            <span className="inline-flex items-center gap-1 rounded-full px-1 text-[10.5px] text-(--on-surface-muted)">
              <span className="text-(--accent)">✓</span>
              完全访问
            </span>
            <button
              type="button"
              className="ml-auto grid h-7 w-7 place-items-center rounded-full bg-(--accent) text-white disabled:opacity-40"
              disabled={!draft.trim()}
              onClick={send}
              aria-label="发送"
            >
              <Send size={13} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
