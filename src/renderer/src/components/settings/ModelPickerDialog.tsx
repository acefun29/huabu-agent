// 大面积模型选择弹窗：替代单行 truncate 的下拉——模型名长短不一，下拉里永远看不全，
// 这里按供应商分组、两行布局完整展示模型名与复合 id，带搜索过滤（媒体配置强制化配套）。

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Search, X } from 'lucide-react'
import type { MediaProviderInfo } from '@shared/ipc'
import { toModelRef } from '@shared/mediaResolve'
import type { MediaKind } from '../../types'
import { KIND_LABEL } from '../../types'
import { useEsc } from '../../lib/hooks'
import { inputCls } from './ui'

/**
 * 默认模型选择弹窗（每类媒体一个实例，由 MediaDefaultsView 按需挂载）。
 *
 * - 分组按 mediaProviders 顺序（合并层语义：内置在前、用户自建在后），组内保持目录顺序；
 * - 每行主文案 = 完整展示名，副文案 = `provider:模型id` 复合串（实际写入存储的记法）；
 * - 供应商组头带凭据状态点：未配 Key 仍可选（选择与凭据是两件事，提交层会拦），但明确标出；
 * - Escape 用 capture 相位 + swallow：面板本体也监听 Esc，弹窗必须先吃掉事件，
 *   否则一次 Escape 会把弹窗和设置面板一起关掉。
 */
export function ModelPickerDialog({
  kind,
  providers,
  selectedRef,
  onPick,
  onClose,
}: {
  kind: MediaKind
  providers: MediaProviderInfo[]
  /** 当前选中的复合串；空串 = 未选择 */
  selectedRef: string
  onPick: (ref: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  useEsc(true, onClose, { capture: true, swallow: true })

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return providers
      .map((p) => ({
        provider: p,
        models: p.models.filter(
          (m) =>
            m.kind === kind &&
            (!q || `${p.label} ${m.label ?? m.id} ${p.id}/${m.id}`.toLowerCase().includes(q))
        )
      }))
      .filter((g) => g.models.length > 0)
  }, [providers, kind, query])

  const kindLabel = KIND_LABEL[kind]
  const searching = query.trim().length > 0

  return createPortal(
    <div
      data-testid="model-picker-dialog"
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/25 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="ctx-menu flex h-[70vh] max-h-[560px] w-full max-w-2xl flex-col overflow-hidden rounded-[24px] bg-(--surface) shadow-2xl ring-1 ring-(--outline)"
      >
        {/* 头部：标题 + 搜索 + 关闭 */}
        <div className="flex items-center gap-3 border-b border-(--outline-soft) px-5 py-4">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-(--on-surface)">{kindLabel}默认模型</div>
            <div className="mt-0.5 text-[11px] text-(--on-surface-muted)">
              选择哪个模型生成{kindLabel}由你决定；选择即时写入当前工作区
            </div>
          </div>
          <div className="relative ml-auto w-56 shrink-0">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-(--on-surface-muted)" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型名 / id"
              className={`${inputCls} pl-7`}
            />
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-full p-1.5 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface)"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>

        {/* 分组列表：完整模型名 + 复合 id，绝不单行截断 */}
        <div data-scrollable="" className="flex-1 overflow-y-auto p-3">
          {groups.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <div className="text-[13px] text-(--on-surface-muted)">
                {searching ? '没有匹配的模型，换个关键词试试' : `所有供应商都没有${kindLabel}模型`}
              </div>
              {!searching && (
                <div className="text-[11px] text-(--on-surface-muted)">
                  可以在左侧供应商详情里给供应商添加模型，或新增一家供应商
                </div>
              )}
            </div>
          ) : (
            groups.map(({ provider, models }) => (
              <div key={provider.id} className="mb-4 last:mb-0">
                <div className="flex items-center gap-1.5 px-2 pb-1.5">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      provider.configured ? 'bg-(--success-dot)' : 'bg-(--on-surface-muted)'
                    }`}
                  />
                  <span className="truncate text-[12px] font-semibold text-(--on-surface)">{provider.label}</span>
                  {!provider.configured && (
                    <span className="rounded-full bg-(--surface-chip) px-1.5 py-0.5 text-[10px] text-(--on-surface-muted)">
                      未配置凭据
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {models.map((m) => {
                    const ref = toModelRef(provider.id, m.id)
                    const selected = ref === selectedRef
                    return (
                      <button
                        key={ref}
                        onClick={() => onPick(ref)}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                          selected ? 'bg-(--surface-chip)' : 'hover:bg-(--outline-soft)'
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium leading-snug text-(--on-surface)">
                            {m.label ?? m.id}
                            {m.status === 'beta' && (
                              <span className="ml-1.5 rounded bg-(--active-tint) px-1 py-0.5 align-middle text-[9px] font-medium text-(--accent)">
                                beta
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block break-all font-mono text-[10.5px] leading-snug text-(--on-surface-muted)">
                            {ref}
                          </span>
                        </span>
                        {selected && <Check size={15} className="shrink-0 text-(--accent)" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 底部说明：选择与凭据分属两道闸，未配 Key 的选择会被提交层拦截并指引 */}
        <div className="border-t border-(--outline-soft) px-5 py-3 text-[11px] leading-relaxed text-(--on-surface-muted)">
          绿点 = 供应商已录入 Key。选择「未配置凭据」的模型可以保存，但生成会被拦截——先去供应商详情录入 API Key。
        </div>
      </div>
    </div>,
    document.body
  )
}
