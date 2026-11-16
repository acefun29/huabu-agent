/**
 * 模型能力参数编辑（可选，新增供应商 / 供应商详情两处复用）。
 * 声明后生成卡片的比例与时长档位、垫图上限按这里走；留空 = 用兜底。
 */

import { useState } from 'react'
import {
  MEDIA_GEN_MODES,
  MEDIA_MODE_LABEL,
  MEDIA_RATIOS,
  REF_ROLE_LABEL,
  type MediaGenMode,
  type MediaRatio,
  type MediaRefRole,
  type ModelCapabilities
} from '@shared/media'
import type { MediaKind } from '../../../types'
import { Field, inputCls } from '../ui'
import { REF_ROLE_NOTE, legacyQuota, rolesForKind } from './shared'

export function ModelCapsFields({
  kind,
  caps,
  costHint,
  onChange
}: {
  kind: MediaKind
  caps: ModelCapabilities
  costHint: string
  onChange: (next: { capabilities: ModelCapabilities; costHint: string }) => void
}) {
  const [durationsText, setDurationsText] = useState(() => (caps.durations ?? []).join(', '))
  const isAudio = kind === 'audio'

  const toggleRatio = (r: MediaRatio) => {
    const ratios = caps.ratios?.includes(r) ? caps.ratios.filter((x) => x !== r) : [...(caps.ratios ?? []), r]
    onChange({ capabilities: { ...caps, ...(ratios.length > 0 ? { ratios } : {}) }, costHint })
  }

  // 时长档位：逗号/空格分隔的随手输入，边打边解析（主进程 sanitize 再排序去重）
  const onDurationsText = (text: string) => {
    setDurationsText(text)
    const parsed = text
      .split(/[,，\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0)
    onChange({ capabilities: { ...caps, ...(parsed.length > 0 ? { durations: parsed } : {}) }, costHint })
  }

  /** 逐角色配额：留空 = 该角色不接受（与"接受但没声明上限"是两件事，后者走兜底 4 张） */
  const setRoleMax = (role: MediaRefRole, value: number | string) => {
    const list = (caps.refQuota ?? []).filter((q) => q.role !== role)
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) list.push({ role, max: Math.floor(n) })
    onChange({ capabilities: { ...caps, ...(list.length > 0 ? { refQuota: list } : {}) }, costHint })
  }

  const toggleMode = (mode: MediaGenMode) => {
    const list = caps.refModes ?? []
    const next = list.includes(mode) ? list.filter((m) => m !== mode) : [...list, mode]
    onChange({ capabilities: { ...caps, ...(next.length > 0 ? { refModes: next } : {}) }, costHint })
  }

  const patchVoices = (voices: { id: string; label: string }[]) =>
    onChange({ capabilities: { ...caps, ...(voices.length > 0 ? { voices } : {}) }, costHint })

  return (
    <div className="space-y-2.5 rounded-xl bg-(--surface-input) p-2.5">
      <div className="text-[10px] leading-relaxed text-(--on-surface-muted)">
        可选。声明后生成卡片的比例 / 时长档位与参考素材配额按这里走；留空则用兜底（全部比例、默认时长档、最多 4 张参考图）。
      </div>
      {isAudio ? (
        <div>
          <div className="mb-1 text-[11px] font-medium text-(--on-surface-variant)">
            可用音色（TTS 的 voice 字段；不填 = 用网关默认音色）
          </div>
          {(caps.voices ?? []).map((v, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-1.5">
              <input
                value={v.id}
                onChange={(e) =>
                  patchVoices((caps.voices ?? []).map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))
                }
                placeholder="音色 id，如 alloy"
                className={inputCls}
              />
              <input
                value={v.label}
                onChange={(e) =>
                  patchVoices((caps.voices ?? []).map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                }
                placeholder="展示名"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => patchVoices((caps.voices ?? []).filter((_, j) => j !== i))}
                className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-(--on-surface-muted) ring-1 ring-(--outline-soft) hover:text-(--danger)"
              >
                删除
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => patchVoices([...(caps.voices ?? []), { id: '', label: '' }])}
            className="cursor-pointer rounded-full px-2 py-0.5 text-[11px] text-(--accent) ring-1 ring-(--outline-soft) hover:bg-(--surface-chip)"
          >
            + 添加音色
          </button>
        </div>
      ) : (
        <>
          <div>
            <div className="mb-1 text-[11px] font-medium text-(--on-surface-variant)">支持的比例（不声明 = 全部）</div>
            <div className="flex flex-wrap gap-1.5">
              {MEDIA_RATIOS.map((r) => {
                const on = caps.ratios?.includes(r) ?? false
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => toggleRatio(r)}
                    className={`rounded-full px-2 py-0.5 text-[11px] ring-1 transition-colors ${
                      on
                        ? 'bg-(--surface-chip) font-medium text-(--on-surface) ring-(--outline)'
                        : 'text-(--on-surface-muted) ring-(--outline-soft) hover:text-(--on-surface)'
                    }`}
                  >
                    {r}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="时长档位（秒，逗号分隔）">
              <input
                value={durationsText}
                onChange={(e) => onDurationsText(e.target.value)}
                placeholder="如 5, 10, 15"
                className={inputCls}
              />
            </Field>
            <Field label="参考素材总条数上限（不声明 = 各角色之和）">
              <input
                type="number"
                min={1}
                max={64}
                value={caps.refTotal ?? ''}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  onChange({
                    capabilities: { ...caps, ...(Number.isFinite(n) && n > 0 ? { refTotal: Math.floor(n) } : {}) },
                    costHint
                  })
                }}
                placeholder="如 20"
                className={inputCls}
              />
            </Field>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-(--on-surface-variant)">
              参考素材配额（留空 = 该角色不接受；超出条数会截断并在卡片上留痕）
            </div>
            <div className="flex flex-col gap-1.5">
              {rolesForKind(kind).map((role) => {
                // 只显示存量老字段折算出来的配额（不改写 caps；用户一动配额键就落成新形状）
                const legacy = legacyQuota(kind, caps.maxRefImages)
                const source = caps.refQuota?.length ? caps.refQuota : legacy
                const entry = source.find((q) => q.role === role)
                return (
                  <div key={role} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-[11px] text-(--on-surface-variant)">{REF_ROLE_LABEL[role]}</span>
                    <input
                      type="number"
                      min={1}
                      max={64}
                      value={entry?.max ?? ''}
                      onChange={(e) => setRoleMax(role, e.target.value)}
                      placeholder="不接受"
                      className={`${inputCls} w-24`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[10px] text-(--on-surface-muted)" title={REF_ROLE_NOTE[role]}>
                      {REF_ROLE_NOTE[role]}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-(--on-surface-variant)">
              支持的用法（一个都不选 = 按上面的配额自动推导）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {MEDIA_GEN_MODES.filter((m) =>
                kind === 'image' ? m === 't2i' || m === 'i2i' : m === 't2v' || m === 'i2v_first' || m === 'i2v_fl' || m === 'r2v'
              ).map((mode) => {
                const on = caps.refModes?.includes(mode) ?? false
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => toggleMode(mode)}
                    className={`rounded-full px-2 py-0.5 text-[11px] ring-1 transition-colors ${
                      on
                        ? 'bg-(--surface-chip) font-medium text-(--on-surface) ring-(--outline)'
                        : 'text-(--on-surface-muted) ring-(--outline-soft) hover:text-(--on-surface)'
                    }`}
                  >
                    {MEDIA_MODE_LABEL[mode]}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
      <Field label="成本提示（可选，展示在参数面板）">
        <input
          value={costHint}
          onChange={(e) => onChange({ capabilities: caps, costHint: e.target.value })}
          placeholder="如 约 ¥0.4/秒"
          className={inputCls}
        />
      </Field>
    </div>
  )
}
