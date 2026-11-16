/**
 * 「编辑模型」对话框：改名 + 上下文/最大输出 + 推理开关。
 *
 * 内置与自定义走同一个口（`settings:model-edit`），分流在主进程 applyEditModel：自定义改条目本身，
 * 内置改名进 modelOverrides、改能力进同 id 补丁条目 —— 所以这里不判来源，只管把用户填的送过去。
 * 两条语义要留意：`name` 一律带上（清空 = 主动恢复目录默认名），能力字段留空 = 不动这一栏。
 */

import { useState } from 'react'
import { X } from 'lucide-react'
import { useChatSettings } from '../../../store/settingsStore'
import { useEsc } from '../../../lib/hooks'
import type { ManagedModelInfo, ThinkingLevelName } from '@shared/ipc'
import { Field, Row, Toggle, inputCls } from '../ui'
import { ThinkingLevelsField } from './ThinkingLevelsField'
import { ALL_EFFORT_LEVELS } from './shared'

export function EditModelDialog({
  providerId,
  model,
  onClose,
  onSaved
}: {
  providerId: string
  model: ManagedModelInfo
  onClose: () => void
  onSaved: () => void
}) {
  const { modelEdit } = useChatSettings()
  const [name, setName] = useState(model.name)
  const [contextWindow, setContextWindow] = useState(model.contextWindow ? String(model.contextWindow) : '')
  const [maxTokens, setMaxTokens] = useState(model.maxTokens ? String(model.maxTokens) : '')
  const [reasoning, setReasoning] = useState(model.reasoning)
  // 预填：目录已声明档位 → 勾选集；未声明（undefined/空）→ 全档（与主进程「无映射 = 全档」语义一致）
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevelName[]>(
    model.thinkingLevels && model.thinkingLevels.length > 0 ? (model.thinkingLevels as ThinkingLevelName[]) : ALL_EFFORT_LEVELS
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Esc 只关本对话框：捕获阶段拦截并吞掉，避免冒泡到设置面板把整个设置一起关掉
  useEsc(true, onClose, { capture: true, swallow: true })

  const ctxNum = Number(contextWindow)
  const maxNum = Number(maxTokens)
  const canSubmit =
    !submitting &&
    (contextWindow.trim() === '' || (Number.isFinite(ctxNum) && ctxNum > 0)) &&
    (maxTokens.trim() === '' || (Number.isFinite(maxNum) && maxNum > 0)) &&
    (!reasoning || thinkingLevels.length > 0)

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    const err = await modelEdit({
      providerId,
      modelId: model.id,
      name: name.trim(),
      ...(contextWindow.trim() ? { contextWindow: Math.round(ctxNum) } : {}),
      ...(maxTokens.trim() ? { maxTokens: Math.round(maxNum) } : {}),
      reasoning,
      // 档位整组替换：开推理带勾选集，关推理给空数组让主进程清掉映射
      thinkingLevels: reasoning ? thinkingLevels : []
    })
    setSubmitting(false)
    if (err) {
      setError(err)
      return
    }
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-(--surface) p-5 shadow-2xl ring-1 ring-(--outline)"
        data-testid="edit-model-dialog"
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[15px] font-semibold text-(--on-surface)">编辑模型</div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
            title="取消"
          >
            <X size={14} />
          </button>
        </div>
        <div className="mb-3 font-mono text-[11px] text-(--on-surface-muted)">{model.id}</div>

        <div className="space-y-3">
          <Field label={model.source === 'builtin' ? '显示名（留空 = 恢复目录默认名）' : '模型名称'}>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} autoFocus />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="上下文窗口（Token）">
              <input
                type="number"
                min={1}
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder={model.contextWindow ? String(model.contextWindow) : '128000'}
                className={inputCls}
              />
            </Field>
            <Field label="最大输出 Token">
              <input
                type="number"
                min={1}
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder={model.maxTokens ? String(model.maxTokens) : '8192'}
                className={inputCls}
              />
            </Field>
          </div>

          <Row
            title="推理模型"
            desc="关掉就不再期待思考输出；改上下文/最大输出只影响压缩阈值与输出上限"
            control={<Toggle checked={reasoning} onChange={setReasoning} />}
          />

          {reasoning && <ThinkingLevelsField value={thinkingLevels} onChange={setThinkingLevels} />}

          {model.source === 'builtin' && (
            <div className="text-[11px] leading-relaxed text-(--on-surface-muted)">
              内置模型改的是覆盖层（能力进补丁条目、名字进 modelOverrides），恢复默认只要把这一栏清空。
            </div>
          )}

          {error && <div className="text-[12px] text-(--danger)" data-testid="edit-model-error">{error}</div>}

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
              data-testid="edit-model-submit"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
