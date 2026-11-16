/**
 * 生成默认值编辑页：Agent 工具与画布生成卡片共用同一套默认值，
 * 写入当前工作区的 workspace.json。
 */

import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useMediaSettings } from '../../../store/settingsStore'
import { useCanvasStore } from '../../../store/canvasStore'
import {
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_MEDIA_DURATION_S,
  DEFAULT_MEDIA_RATIO,
  MEDIA_RATIOS
} from '@shared/media'
import { assessMediaReadiness, shortModelLabel } from '@shared/mediaResolve'
import { MEDIA_ROOT_REL } from '../../../harness/assetCategories'
import type { MediaKind } from '../../../types'
import { KIND_LABEL } from '../../../types'
import { Field, Select, Toggle, inputCls } from '../ui'
import { ModelPickerDialog } from '../ModelPickerDialog'
import { displayNameOfRef, normalizeStoredRef } from './shared'

/** 完成度清单的单格：label 固定，状态文案随评估结果（绿=就绪 / 红=拦截 / 灰=豁免） */
function ReadinessChip({ label, ok, muted, text }: { label: string; ok: boolean; muted?: boolean; text: string }) {
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] ${
        muted ? 'bg-(--surface-chip) text-(--on-surface-muted)' : ok ? 'bg-(--success-bg) text-(--success-text)' : 'bg-(--danger)/10 text-(--danger)'
      }`}
    >
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
    </div>
  )
}

export function MediaDefaultsView() {
  const { mediaProviders, mediaStatus, confirmVideo, updateMediaConfig, resolveMediaModel } = useMediaSettings()
  const libraries = useCanvasStore((s) => s.libraries)
  const [outputDirDraft, setOutputDirDraft] = useState<string | null>(null)
  const [saveHint, setSaveHint] = useState<string | null>(null)
  /** 当前打开的模型选择弹窗（大面积完整展示模型名；null = 关闭） */
  const [pickerKind, setPickerKind] = useState<MediaKind | null>(null)
  const outputDir = mediaStatus?.outputDir ?? MEDIA_ROOT_REL
  const imageFallback = resolveMediaModel('image')
  /** 落库默认值：未配置 = 画布素材（按类型归类）；特殊值 builtin-assets / none 与主进程校验对齐 */
  const defaultLibraryId = mediaStatus?.defaultLibraryId ?? 'builtin-assets'

  const agentProviderId = mediaStatus?.agentProvider ?? ''
  // 完成度评估：供应商选择 + 三类默认模型（选择与 Key 分开呈现；unavailable 豁免不算未完成）
  const readiness = useMemo(
    () =>
      assessMediaReadiness(mediaProviders, {
        agentProvider: mediaStatus?.agentProvider,
        agentModels: mediaStatus?.agentModels
      }),
    [mediaProviders, mediaStatus]
  )
  const refOf = (kind: MediaKind) => normalizeStoredRef(kind, mediaStatus?.agentModels?.[kind] ?? '', mediaProviders, agentProviderId)
  const nameOf = (ref: string) => displayNameOfRef(ref, mediaProviders)

  /** 弹窗选中：写入后立即关闭（agentModels 整对象替换，带上其他类的现有值） */
  const handlePick = (ref: string) => {
    if (!pickerKind) return
    void updateMediaConfig({ agentModels: { ...mediaStatus?.agentModels, [pickerKind]: ref } })
    setPickerKind(null)
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[15px] font-semibold text-(--on-surface)">生成默认值</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-(--on-surface-muted)">
          Agent 工具与画布上的生成卡片共用这套默认值（卡片指定 → 各类默认模型，均需显式选择；
          未选择默认模型的类型，其生成会被拦截）；全部改动即时写入当前工作区
        </div>
      </div>

      {/* 配置完成度清单：强制填写的四项（选择是闸门，Key 缺失由提交层拦截并指引） */}
      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)" data-testid="media-readiness">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] font-semibold text-(--on-surface)">配置完成度</span>
          <span className={`text-[11px] font-medium ${readiness.complete ? 'text-(--success-text)' : 'text-(--danger)'}`}>
            {readiness.complete ? '已就绪，可以生成' : '未完成'}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <ReadinessChip
            label="Agent 供应商"
            ok={readiness.provider.state === 'ok'}
            text={
              readiness.provider.state === 'ok'
                ? (mediaProviders.find((p) => p.id === readiness.provider.ref)?.label ?? '已选择')
                : readiness.provider.state === 'stale'
                  ? '已失效，请重新选择'
                  : '待选择'
            }
          />
          {(['image', 'video', 'audio'] as MediaKind[]).map((kind) => {
            const state = readiness.kinds[kind].state
            const ref = readiness.kinds[kind].ref ?? ''
            return (
              <ReadinessChip
                key={kind}
                label={`${KIND_LABEL[kind]}默认模型`}
                ok={state === 'ok' || state === 'unavailable'}
                muted={state === 'unavailable'}
                text={
                  state === 'ok'
                    ? (nameOf(ref) ?? '已选择')
                    : state === 'no-key'
                      ? `${nameOf(ref) ?? '已选择'}（供应商未配 Key）`
                      : state === 'unselected'
                        ? '待选择'
                        : state === 'stale'
                          ? '已失效，请重新选择'
                          : '无可用模型（不拦截其他类型）'
                }
              />
            )
          })}
        </div>
        {!readiness.complete && (
          <div className="mt-2 text-[11px] leading-relaxed text-(--danger)">
            配置未完成：
            {readiness.blockingKinds.length > 0
              ? `${readiness.blockingKinds.map((k) => KIND_LABEL[k]).join('、')}生成将被拦截`
              : 'Agent 供应商待选择'}
            （Agent 工具与画布卡片同样受限）。
          </div>
        )}
      </div>

      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label="Agent 使用的供应商">
            <Select
              value={agentProviderId}
              onChange={(v) => void updateMediaConfig({ agentProvider: v })}
              options={[
                // 未选择时给占位项（强制填写）；存量配置指向已删供应商时如实展示失效态
                ...(agentProviderId
                  ? mediaProviders.some((p) => p.id === agentProviderId)
                    ? []
                    : [{ value: agentProviderId, label: `${agentProviderId}（已失效，请重新选择）` }]
                  : [{ value: '', label: '请选择供应商' }]),
                ...mediaProviders.map((p) => ({ value: p.id, label: p.label }))
              ]}
            />
          </Field>
          {(['image', 'video', 'audio'] as MediaKind[]).map((kind) => {
            const stored = mediaStatus?.agentModels?.[kind] ?? ''
            const ref = refOf(kind)
            const state = readiness.kinds[kind].state
            // 显示名解析不出但存储值还在 = 该模型已失效（供应商被删/模型隐藏），如实展示
            const buttonLabel =
              state === 'unavailable'
                ? '无可用模型'
                : (nameOf(ref) ?? (stored ? '已失效，请重新选择' : '未选择'))
            return (
              <Field key={kind} label={`${KIND_LABEL[kind]}默认模型`}>
                <button
                  type="button"
                  onClick={() => setPickerKind(kind)}
                  disabled={state === 'unavailable'}
                  data-testid={`media-default-model-${kind}`}
                  className={`${inputCls} flex items-center justify-between gap-2 text-left ${
                    state === 'unavailable' ? 'cursor-not-allowed opacity-50' : ''
                  }`}
                >
                  <span className={`min-w-0 text-[13px] leading-snug ${nameOf(ref) ? 'text-(--on-surface)' : 'text-(--danger)'}`}>
                    {buttonLabel}
                  </span>
                  <ChevronDown size={14} className="shrink-0 text-(--on-surface-muted)" />
                </button>
              </Field>
            )
          })}
          <Field label="新建卡片默认比例">
            <Select
              value={mediaStatus?.defaultRatio ?? DEFAULT_MEDIA_RATIO}
              onChange={(v) => void updateMediaConfig({ defaultRatio: v as (typeof MEDIA_RATIOS)[number] })}
              options={MEDIA_RATIOS.map((r) => ({ value: r, label: r }))}
            />
          </Field>
          <Field label="默认时长（秒）">
            <input
              type="number"
              min={1}
              max={60}
              value={mediaStatus?.defaultDuration ?? DEFAULT_MEDIA_DURATION_S}
              onChange={(e) => void updateMediaConfig({ defaultDuration: Math.max(1, Math.min(60, Number(e.target.value) || DEFAULT_MEDIA_DURATION_S)) })}
              className={inputCls}
            />
          </Field>
          <Field label="并发任务上限">
            <input
              type="number"
              min={1}
              max={8}
              value={mediaStatus?.concurrency ?? DEFAULT_MEDIA_CONCURRENCY}
              onChange={(e) => void updateMediaConfig({ concurrency: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
              className={inputCls}
            />
          </Field>
          <Field label="默认落库素材库（生成产物的归档位置）">
            <Select
              value={defaultLibraryId}
              onChange={(v) =>
                void updateMediaConfig({ defaultLibraryId: v }).then((error) =>
                  setSaveHint(error ? `保存失败：${error}` : '默认落库已更新，对新生成生效')
                )
              }
              testId="default-library-select"
              options={[
                { value: 'builtin-assets', label: '画布素材（按类型自动归类）' },
                ...libraries
                  .filter((l) => !l.builtin)
                  .map((l) => ({ value: l.id, label: `${l.name}${l.isPublic ? '（公共库）' : ''}` })),
                { value: 'none', label: '仅产物目录（不进素材库）' },
              ]}
            />
          </Field>
          <Field label="产物输出目录（未落素材库时的兜底；相对工作区根）">
            <div className="flex gap-1.5">
              <input
                value={outputDirDraft ?? outputDir}
                onChange={(e) => setOutputDirDraft(e.target.value)}
                className={inputCls}
              />
              <button
                onClick={async () => {
                  const error = await updateMediaConfig({ outputDir: (outputDirDraft ?? outputDir).trim() })
                  setSaveHint(error ? `保存失败：${error}` : '输出目录已更新')
                  setOutputDirDraft(null)
                }}
                className="shrink-0 rounded-lg bg-(--fab-bg) px-3 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90"
              >
                保存
              </button>
            </div>
          </Field>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-(--outline-soft) pt-3">
          <div className="text-[12px] text-(--on-surface-muted)">
            Agent 生成视频前需确认<span className="ml-1 text-[11px]">（成本护栏：generate_video 先在对话中征得同意才提交）</span>
          </div>
          <Toggle checked={confirmVideo} onChange={(v) => void updateMediaConfig({ confirmVideo: v })} />
        </div>
        {saveHint && (
          <div className={`mt-2 text-[11px] ${saveHint.includes('失败') ? 'text-(--danger)' : 'text-(--on-surface-muted)'}`}>
            {saveHint}
          </div>
        )}
      </div>

      {pickerKind && (
        <ModelPickerDialog
          kind={pickerKind}
          providers={mediaProviders}
          selectedRef={refOf(pickerKind)}
          onPick={handlePick}
          onClose={() => setPickerKind(null)}
        />
      )}

      <div className="rounded-2xl bg-(--surface-card) px-4 py-3 text-[12px] leading-relaxed text-(--on-surface-muted) ring-1 ring-(--outline-soft)">
        <span className="text-(--on-surface)">当前图片模型</span> →{' '}
        {imageFallback
          ? `${imageFallback.provider} · ${shortModelLabel(imageFallback.provider, imageFallback.model)}`
          : '未选择（图片生成将被拦截）'}
      </div>
    </div>
  )
}
