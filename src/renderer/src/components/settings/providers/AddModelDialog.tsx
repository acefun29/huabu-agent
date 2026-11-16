/**
 * 「添加模型」对话框：模型 ID + 显示名 + 上下文/最大输出 + 输入类型（图片）+ 推理开关。
 * 字段语义与主进程 CustomModelInput 一一对应；错误就地显示，成功后回调刷新清单。
 */

import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { useChatSettings } from '../../../store/settingsStore'
import { useEsc } from '../../../lib/hooks'
import type { ThinkingLevelName } from '@shared/ipc'
import type { ChatModelApi } from '@shared/chatApi'
import { ApiSelect, Field, Row, Toggle, inputCls } from '../ui'
import { ThinkingLevelsField } from './ThinkingLevelsField'
import { ALL_EFFORT_LEVELS, MODEL_ID_PATTERN } from './shared'

export function AddModelDialog({
  providerId,
  onClose,
  onAdded,
}: {
  providerId: string
  onClose: () => void
  onAdded: () => void
}) {
  const { customAddModel } = useChatSettings()
  const [modelId, setModelId] = useState('')
  const [name, setName] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [supportsImage, setSupportsImage] = useState(false)
  const [reasoning, setReasoning] = useState(false)
  const [api, setApi] = useState<ChatModelApi | ''>('')
  // 档位声明只对 completions 形态有意义（responses/anthropic 的档位语义不同）
  const effortRelevant = api === '' || api === 'openai-completions'
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevelName[]>(ALL_EFFORT_LEVELS)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Esc 只关本对话框：捕获阶段拦截并吞掉，避免冒泡到设置面板把整个设置一起关掉
  useEsc(true, onClose, { capture: true, swallow: true })

  const trimmedId = modelId.trim()
  const idValid = MODEL_ID_PATTERN.test(trimmedId)
  const ctxNum = Number(contextWindow)
  const maxNum = Number(maxTokens)
  const canSubmit =
    idValid && !submitting && (contextWindow.trim() === '' || (Number.isFinite(ctxNum) && ctxNum > 0)) &&
    (maxTokens.trim() === '' || (Number.isFinite(maxNum) && maxNum > 0)) &&
    (!reasoning || !effortRelevant || thinkingLevels.length > 0)

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    const err = await customAddModel({
      providerId,
      id: trimmedId,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(contextWindow.trim() ? { contextWindow: Math.round(ctxNum) } : {}),
      ...(maxTokens.trim() ? { maxTokens: Math.round(maxNum) } : {}),
      ...(reasoning ? { reasoning: true } : {}),
      ...(api ? { api } : {}),
      input_modalities: supportsImage ? ['text', 'image'] : ['text'],
      ...(reasoning && effortRelevant ? { thinkingLevels } : {})
    })
    setSubmitting(false)
    if (err) {
      setError(err)
      return
    }
    onAdded()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-(--surface) p-5 shadow-2xl ring-1 ring-(--outline)"
        data-testid="add-model-dialog"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[15px] font-semibold text-(--on-surface)">添加模型</div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
            title="取消"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="模型 ID（发给 API 的标识，必填）">
            <input
              autoFocus
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder="deepseek-v4-pro"
              className={inputCls}
            />
            <span className="mt-1 block text-[10px] text-(--on-surface-muted)">
              字母/数字开头，可含 . _ - / :；冲突或重名会在保存时提示
            </span>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="模型名称（选填，列表显示名）">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="DeepSeek V4 Pro" className={inputCls} />
            </Field>
            <Field label="上下文窗口（Token）">
              <input
                type="number"
                min={1}
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder="128000"
                className={inputCls}
              />
            </Field>
          </div>

          <Field label="最大输出 Token（选填）">
            <input
              type="number"
              min={1}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder="8192"
              className={inputCls}
            />
          </Field>

          <Field label="输入类型">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full bg-(--surface-chip) px-3 py-1.5 text-[12px] text-(--on-surface)">
                <Check size={12} className="text-(--accent)" />
                文本
              </span>
              <button
                onClick={() => setSupportsImage((v) => !v)}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-colors ${
                  supportsImage
                    ? 'bg-(--surface-chip) text-(--on-surface) ring-1 ring-(--accent)'
                    : 'bg-(--surface-input) text-(--on-surface-muted) hover:bg-(--outline-soft)'
                }`}
                title="勾选后可在对话里发送图片（视觉模型）"
              >
                {supportsImage && <Check size={12} className="text-(--accent)" />}
                图片
              </button>
            </div>
          </Field>

          <Row
            title="推理模型"
            desc="模型支持思考/推理输出，会话里显示「思考」标记"
            control={<Toggle checked={reasoning} onChange={setReasoning} />}
          />

          {reasoning && effortRelevant && <ThinkingLevelsField value={thinkingLevels} onChange={setThinkingLevels} />}

          <Field label="协议（仅当一个网关同时暴露多种端点形态时才需要单独指定）">
            <ApiSelect value={api} onChange={setApi} allowFollow testId="add-model-api" />
          </Field>

          {error && <div className="text-[12px] text-(--danger)" data-testid="add-model-error">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="rounded-full bg-(--surface-chip) px-4 py-1.5 text-[12px] font-medium text-(--on-surface) transition-colors hover:bg-(--surface-hover)"
            >
              取消
            </button>
            <button
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="rounded-full bg-(--fab-bg) px-4 py-1.5 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90 disabled:opacity-30"
              data-testid="add-model-submit"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
