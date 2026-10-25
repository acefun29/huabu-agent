// 设置面板「媒体生成」tab：生成默认值、新增供应商、全量模型库浏览、供应商详情（内部组件不导出，仅导出 MediaTab）

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ExternalLink, Plus, RotateCcw, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useSettings } from '../../store/settingsStore'
import { useCanvasStore } from '../../store/canvasStore'
import type { MediaCatalogBrowseItem, MediaProviderType } from '@shared/ipc'
import {
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_MEDIA_DURATION_S,
  DEFAULT_MEDIA_RATIO,
  MEDIA_GEN_MODES,
  MEDIA_MODE_LABEL,
  MEDIA_RATIOS,
  MEDIA_REF_ROLES,
  REF_ROLE_LABEL,
  type MediaGenMode,
  type MediaRatio,
  type MediaRefQuota,
  type MediaRefRole,
  type ModelCapabilities
} from '@shared/media'
import {
  assessMediaReadiness,
  matchBareModelId,
  parseModelRef,
  shortModelLabel
} from '@shared/mediaResolve'
import { MEDIA_ROOT_REL } from '../../harness/assetCategories'
import type { MediaKind } from '../../types'
import { KIND_LABEL } from '../../types'
import { Field, Select, Toggle, inputCls } from './ui'
import { ModelPickerDialog } from './ModelPickerDialog'

/* -------------------------------------------------------------------------- */
/* 媒体生成（真实 IPC：workspace.json media 段 + 网关凭据）                     */
/* -------------------------------------------------------------------------- */

/** 新增供应商可用的适配器类型（与主进程注册表对应；新增类型时两处同步） */
const ADAPTER_TYPE_OPTIONS: { value: MediaProviderType; label: string; baseUrlHint?: string }[] = [
  { value: 'gateway-openai-compat', label: 'OpenAI 兼容（图片 / 视频 / 语音合成）', baseUrlHint: 'https://api.openai.com/v1' },
  { value: 'gateway-dashscope', label: '阿里云百炼（异步任务）' },
  { value: 'gateway-token-plan', label: '阿里云 Token Plan（订阅制：文生图同步 / 文生视频异步）', baseUrlHint: 'https://token-plan.cn-beijing.maas.aliyuncs.com' },
  { value: 'gateway-volcark', label: '火山方舟' },
  { value: 'gateway-minimax', label: 'MiniMax（海螺视频 / 图片）' },
  { value: 'gateway-tencent', label: '腾讯混元（生图 / 生视频）' }
]

/**
 * 内置媒体供应商「创建 / 管理 API Key」页面的官方直达地址（2026-10 逐家官网核实）。
 * openai / dashscope 与对话供应商同一家（复用已核实地址）；火山方舟为控制台
 * 「API Key 管理」深链（登录后直达）；MiniMax / 腾讯云为各自控制台密钥页。
 * 用户自建的 gateway-* 供应商无固定官网，不在表内也就不显示链接。
 */
const MEDIA_API_KEY_URLS: Record<string, { url: string; label: string }> = {
  openai: { url: 'https://platform.openai.com/api-keys', label: 'OpenAI 平台' },
  dashscope: { url: 'https://bailian.console.aliyun.com/?apiKey=1', label: '阿里云百炼' },
  'token-plan': { url: 'https://bailian.console.aliyun.com/cn-beijing/subscription/overview', label: '百炼 Token Plan 订阅页' },
  volcark: { url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', label: '火山方舟' },
  minimax: { url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', label: 'MiniMax 开放平台' },
  tencent: { url: 'https://console.cloud.tencent.com/cam/capi', label: '腾讯云（API 密钥管理）' },
}

type MediaView = 'defaults' | 'add' | 'provider'

/** 存储值 → 规范化复合串：统一 `provider:模型id` 记法（旧裸 id 兼容映射，映射不到返回空） */
function normalizeStoredRef(
  kind: MediaKind,
  stored: string,
  providers: Parameters<typeof matchBareModelId>[0],
  agentProviderId: string
): string {
  if (!stored) return ''
  if (stored.includes(':')) return stored
  return matchBareModelId(providers, stored, kind, agentProviderId || undefined)?.ref ?? ''
}

/** 复合串 → 完整显示名（供应商 · 模型名）；供应商/模型已不在清单返回 null（已失效） */
function displayNameOfRef(ref: string, providers: Array<{ id: string; label: string; models: Array<{ id: string; label?: string }> }>): string | null {
  const parsed = parseModelRef(ref)
  if (!parsed) return null
  const provider = providers.find((p) => p.id === parsed.provider)
  const model = provider?.models.find((m) => m.id === parsed.model)
  if (!provider || !model) return null
  return `${provider.label} · ${model.label ?? model.id}`
}

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

/** 生成默认值编辑页：Agent 工具与画布生成卡片共用，写入当前工作区 workspace.json */
function MediaDefaultsView() {
  const { mediaProviders, mediaStatus, confirmVideo, updateMediaConfig, resolveMediaModel } = useSettings()
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

/** 全部媒体大类（矩阵通道异常时的兜底 = 不因数据缺失卡住表单） */
const ALL_KINDS: MediaKind[] = ['image', 'video', 'audio']

/** 凭据来源徽章：media:providers 的 authHint（workspace-store / environment:<NAME> / none） */
function authHintLabel(hint?: string): string {
  if (!hint || hint === 'none') return '未配置凭据'
  if (hint.startsWith('environment')) return `走环境变量 ${hint.slice('environment:'.length)}`
  return '加密存储'
}

/**
 * 表单态能力参数 → media:user-add-* 载荷：全空则不留字段（不声明，参数面板与
 * 编排层按兜底走）。去重升序在这里先做一遍，主进程 sanitizeCapabilities 再同源兜底。
 *
 * `maxRefImages` 是已废弃的老字段：新声明一律走 refQuota/refModes/refTotal，
 * 这里**不再写它**（存量配置仍由 normalizeMediaCaps 派生读取，零迁移）。
 */
function capsPayload(kind: MediaKind, caps: ModelCapabilities, costHint: string): { capabilities?: ModelCapabilities; costHint?: string } {
  const out: ModelCapabilities = {}
  if (caps.ratios?.length) out.ratios = [...new Set(caps.ratios)]
  if (caps.durations?.length) out.durations = [...new Set(caps.durations)].sort((a, b) => a - b)
  const refQuota = (caps.refQuota ?? [])
    .filter((q) => MEDIA_REF_ROLES.includes(q.role) && Number.isFinite(q.max) && q.max > 0)
    .map((q) => ({ role: q.role, max: Math.floor(q.max) }))
  // 存量只有 maxRefImages 的模型：编辑时按老语义搬成逐角色配额，不让它悄悄退回兜底 4 张
  if (refQuota.length === 0) refQuota.push(...legacyQuota(kind, caps.maxRefImages))
  if (refQuota.length > 0) out.refQuota = refQuota
  if (caps.refModes?.length) out.refModes = [...new Set(caps.refModes)]
  if (Number.isFinite(caps.refTotal) && (caps.refTotal ?? 0) > 0) out.refTotal = Math.floor(caps.refTotal!)
  const voices = (caps.voices ?? []).filter((v) => v.id.trim()).map((v) => ({ id: v.id.trim(), label: (v.label ?? v.id).trim() || v.id.trim() }))
  if (voices.length > 0) out.voices = voices
  return {
    ...(Object.keys(out).length > 0 ? { capabilities: out } : {}),
    ...(costHint.trim() ? { costHint: costHint.trim() } : {})
  }
}

/** 该模型大类下可声明的参考角色（音频通道今天没有任何参考输入） */
function rolesForKind(kind: MediaKind): MediaRefRole[] {
  if (kind === 'image') return ['reference_image']
  if (kind === 'video') {
    return ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio']
  }
  return []
}

/**
 * 老字段 `maxRefImages` 折算成逐角色配额（与主进程 normalizeMediaCaps 同一映射）：
 * 图片模型 = 参考图 N 张，视频模型 = 首帧 1 张。设置页据此显示与保存，不再写回老字段。
 */
function legacyQuota(kind: MediaKind, maxRefImages: number | undefined): MediaRefQuota[] {
  const n = Math.floor(Number(maxRefImages))
  if (!Number.isFinite(n) || n <= 0) return []
  return [{ role: kind === 'video' ? 'first_frame' : 'reference_image', max: n }]
}

/** 配额编辑器里每个角色的一句话说明（各家官方语义，避免把首帧当参考图填） */
const REF_ROLE_NOTE: Record<MediaRefRole, string> = {
  first_frame: '视频从这张图开始（图生视频的首帧）',
  last_frame: '视频在这张图结束，需与首帧同时给',
  reference_image: '垫图 / 风格参考，不决定构图边界',
  reference_video: '参考视频：方舟只收公网 URL，百炼需先上传换临时引用',
  reference_audio: '参考音频：百炼需先上传换临时引用'
}

/**
 * 模型能力参数编辑（可选，新增供应商 / 供应商详情两处复用）。
 * 声明后生成卡片的比例与时长档位、垫图上限按这里走；留空 = 用兜底。
 */
function ModelCapsFields({
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

/** 新增供应商表单页 */
function MediaAddProviderView({
  onDone,
  onCancel,
  onNotice,
}: {
  onDone: (providerId: string, message: string) => void
  onCancel: () => void
  onNotice: (message: string | null) => void
}) {
  const { mediaUserAddProvider, mediaAdapterKinds } = useSettings()
  const [npId, setNpId] = useState('')
  const [npLabel, setNpLabel] = useState('')
  const [npType, setNpType] = useState<MediaProviderType>('gateway-openai-compat')
  const [npBaseUrl, setNpBaseUrl] = useState('')
  const [npAuthStyle, setNpAuthStyle] = useState<'bearer' | 'x-api-key'>('bearer')
  const [npAuthEnv, setNpAuthEnv] = useState('')
  const [npModelId, setNpModelId] = useState('')
  const [npModelKind, setNpModelKind] = useState<MediaKind>('image')
  const [npCaps, setNpCaps] = useState<ModelCapabilities>({})
  const [npCostHint, setNpCostHint] = useState('')
  const [npCapsOpen, setNpCapsOpen] = useState(false)
  const adapterTypeOption = ADAPTER_TYPE_OPTIONS.find((t) => t.value === npType)
  // kind 选项 = 该接入类型路由得通的大类（主进程注册表事实来源）；矩阵没拉到就全放
  const kindOptions = mediaAdapterKinds[npType] ?? ALL_KINDS
  const effectiveModelKind = kindOptions.includes(npModelKind) ? npModelKind : kindOptions[0]

  const submit = async () => {
    const error = await mediaUserAddProvider({
      id: npId.trim(),
      type: npType,
      ...(npLabel.trim() ? { label: npLabel.trim() } : {}),
      ...(npType === 'gateway-openai-compat' && npBaseUrl.trim() ? { baseUrl: npBaseUrl.trim() } : {}),
      ...(npType === 'gateway-openai-compat' ? { authStyle: npAuthStyle } : {}),
      ...(npAuthEnv.trim() ? { authEnv: npAuthEnv.trim() } : {}),
      firstModel: { id: npModelId.trim(), kind: effectiveModelKind, ...capsPayload(effectiveModelKind, npCaps, npCostHint) }
    })
    if (error) {
      onNotice(`新增供应商失败：${error}`)
      return
    }
    onDone(npId.trim(), `已新增供应商：${npLabel.trim() || npId.trim()}（录入 API Key 后即可生成）`)
  }

  return (
    <div className="space-y-3" data-testid="media-add-provider">
      <div className="flex items-center justify-between">
        <div className="text-[15px] font-semibold text-(--on-surface)">新增自定义供应商</div>
        <button
          onClick={onCancel}
          className="flex h-7 w-7 items-center justify-center rounded-full text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
          title="取消"
        >
          <X size={14} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="供应商 id（小写英文/数字，不可与现有自定义重复）">
          <input value={npId} onChange={(e) => setNpId(e.target.value)} placeholder="siliconflow" className={inputCls} />
        </Field>
        <Field label="显示名（缺省 = id）">
          <input value={npLabel} onChange={(e) => setNpLabel(e.target.value)} placeholder="硅基流动" className={inputCls} />
        </Field>
        <Field label="接入类型">
          <Select
            value={npType}
            onChange={(v) => setNpType(v as MediaProviderType)}
            options={ADAPTER_TYPE_OPTIONS.map((t) => ({ value: t.value, label: t.label }))}
          />
        </Field>
        {npType === 'gateway-openai-compat' && (
          <>
            <Field label="Base URL（网关端点，留空 = 官方默认）">
              <input
                value={npBaseUrl}
                onChange={(e) => setNpBaseUrl(e.target.value)}
                placeholder={adapterTypeOption?.baseUrlHint ?? 'https://…'}
                className={inputCls}
              />
            </Field>
            <Field label="认证头风格">
              <Select
                value={npAuthStyle}
                onChange={(v) => setNpAuthStyle(v as 'bearer' | 'x-api-key')}
                options={[
                  { value: 'bearer', label: 'Authorization: Bearer（默认）' },
                  { value: 'x-api-key', label: 'x-api-key' },
                ]}
              />
            </Field>
          </>
        )}
        <Field label="凭据环境变量名（可选，录入 Key 后不需要）">
          <input value={npAuthEnv} onChange={(e) => setNpAuthEnv(e.target.value)} placeholder="SILICONFLOW_KEY" className={inputCls} />
        </Field>
        <Field label="首个模型 id（发给网关的标识）">
          <div className="flex gap-1.5">
            <input value={npModelId} onChange={(e) => setNpModelId(e.target.value)} placeholder="Kwai-Kolors/Kolors" className={inputCls} />
            <Select
              hug
              className="w-24 shrink-0"
              value={effectiveModelKind}
              onChange={(v) => setNpModelKind(v as MediaKind)}
              options={kindOptions.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
            />
          </div>
        </Field>
      </div>
      <button
        type="button"
        onClick={() => setNpCapsOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-medium text-(--on-surface-variant) transition-colors hover:text-(--on-surface)"
      >
        <SlidersHorizontal size={12} />
        能力参数（可选）
        <ChevronDown size={11} className={`transition-transform ${npCapsOpen ? 'rotate-180' : ''}`} />
      </button>
      {npCapsOpen && (
        <ModelCapsFields
          kind={effectiveModelKind}
          caps={npCaps}
          costHint={npCostHint}
          onChange={(next) => {
            setNpCaps(next.capabilities)
            setNpCostHint(next.costHint)
          }}
        />
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={!npId.trim() || !npModelId.trim()}
          className="rounded-lg bg-(--fab-bg) px-3.5 py-1.5 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90 disabled:opacity-30"
        >
          创建供应商
        </button>
        <span className="text-[11px] text-(--on-surface-muted)">
          创建后即可录入 API Key 并生成；稍后在模型清单里随时增删模型
        </span>
      </div>
    </div>
  )
}

/** 全量模型库浏览（数据源 = 随应用打包的只读目录，main/media/catalog/browse.ts） */
function MediaCatalogBrowser({
  providerId,
  onNotice,
}: {
  providerId: string
  onNotice: (message: string | null) => void
}) {
  const { mediaBrowseCatalog, mediaUserAddModel } = useSettings()
  const [items, setItems] = useState<MediaCatalogBrowseItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<MediaKind | 'all'>('all')

  useEffect(() => {
    let alive = true
    setItems(null)
    setQuery('')
    setKindFilter('all')
    void mediaBrowseCatalog(providerId).then((list) => {
      if (alive) setItems(list)
    })
    return () => {
      alive = false
    }
  }, [providerId, mediaBrowseCatalog])

  if (items === null) {
    return <div className="text-[11px] text-(--on-surface-muted)">模型库加载中…</div>
  }
  if (items.length === 0) return null

  const q = query.trim().toLowerCase()
  const filtered = items.filter(
    (it) =>
      (kindFilter === 'all' || it.kind === kindFilter) &&
      (!q || `${it.label} ${it.id} ${it.provider ?? ''}`.toLowerCase().includes(q))
  )
  const shown = filtered.slice(0, 120)
  const countOf = (k: MediaKind) => items.reduce((n, it) => n + (it.kind === k ? 1 : 0), 0)

  const add = async (item: MediaCatalogBrowseItem) => {
    const error = await mediaUserAddModel({
      providerId,
      id: item.id,
      kind: item.kind,
      label: item.label,
      ...(item.capabilities ? { capabilities: item.capabilities } : {})
    })
    if (error) {
      onNotice(`添加模型失败：${error}`)
      return
    }
    onNotice(`已添加模型：${item.label}`)
    setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, enabled: true } : i)) ?? prev)
  }

  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-(--on-surface-variant)">
        浏览完整模型库（{items.length} 个，点「添加」进入上方可生成清单）
      </div>
      <div className="rounded-xl bg-(--surface-input) p-2">
        <div className="mb-1 flex items-center gap-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型名 / id / 提供方…"
            className="min-w-0 flex-1 rounded-lg bg-(--surface-card) px-2.5 py-1 text-[12px] text-(--on-surface) outline-none transition focus:ring-2 focus:ring-(--accent) placeholder:text-(--on-surface-muted)"
          />
          {(['all', 'image', 'video', 'audio'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={`shrink-0 rounded-full px-2 py-1 text-[11px] transition-colors ${
                kindFilter === k
                  ? 'bg-(--surface-chip) font-medium text-(--on-surface)'
                  : 'text-(--on-surface-muted) hover:bg-(--outline-soft)'
              }`}
            >
              {k === 'all' ? `全部 ${items.length}` : `${KIND_LABEL[k]} ${countOf(k)}`}
            </button>
          ))}
        </div>
        <div data-scrollable="" className="max-h-56 divide-y divide-(--outline-soft) overflow-y-auto">
          {shown.map((item) => (
            <div key={item.id} className="flex items-center gap-2 py-1.5">
              <span className="w-8 shrink-0 text-[10px] text-(--on-surface-muted)">{KIND_LABEL[item.kind]}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-(--on-surface)">{item.label}</div>
                <div className="truncate font-mono text-[10px] text-(--on-surface-muted)">
                  {item.id}
                  {item.provider ? ` · ${item.provider}` : ''}
                </div>
              </div>
              {item.needsExtra && item.needsExtra.length > 0 && (
                <span
                  className="shrink-0 rounded-full bg-(--surface-chip) px-1.5 py-0.5 text-[9px] text-(--on-surface-variant)"
                  title={`除提示词外还需 ${item.needsExtra.join('、')} 等参数，当前版本只提交提示词/比例/时长/参考图，生成可能失败`}
                >
                  需参数
                </span>
              )}
              {item.enabled ? (
                <span className="w-12 shrink-0 text-center text-[10px] text-(--success-text)">已添加</span>
              ) : (
                <button
                  onClick={() => void add(item)}
                  className="w-12 shrink-0 rounded-full bg-(--fab-bg) py-0.5 text-[10px] font-medium text-(--fab-text) transition hover:opacity-90"
                >
                  添加
                </button>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="py-3 text-center text-[11px] text-(--on-surface-muted)">没有匹配的模型</div>
          )}
        </div>
        {filtered.length > shown.length && (
          <div className="pt-1 text-center text-[10px] text-(--on-surface-muted)">
            还有 {filtered.length - shown.length} 条，请用搜索缩小范围
          </div>
        )}
      </div>
    </div>
  )
}

/** 供应商详情页：凭据 + 可生成模型 + 全量模型库浏览 + 供应商管理 */
function MediaProviderDetail({
  providerId,
  onNotice,
}: {
  providerId: string
  onNotice: (message: string | null) => void
}) {
  const {
    mediaProviders,
    mediaStatus,
    mediaAdapterKinds,
    updateMediaConfig,
    setMediaKey,
    removeMediaKey,
    mediaUserRemoveProvider,
    mediaUserAddModel,
    mediaUserRemoveModel,
    mediaUserRestoreModel,
  } = useSettings()
  const provider = mediaProviders.find((p) => p.id === providerId)
  const [keyInput, setKeyInput] = useState('')
  const [nmId, setNmId] = useState('')
  const [nmKind, setNmKind] = useState<MediaKind>('image')
  const [nmCaps, setNmCaps] = useState<ModelCapabilities>({})
  const [nmCostHint, setNmCostHint] = useState('')
  const [nmCapsOpen, setNmCapsOpen] = useState(false)
  /* 删除供应商的两步确认（第二次点击才真正执行） */
  const [pendingRemove, setPendingRemove] = useState(false)

  useEffect(() => {
    setKeyInput('')
    setNmId('')
    setPendingRemove(false)
  }, [providerId])

  if (!provider) return null
  const keyUrl = MEDIA_API_KEY_URLS[provider.id]
  const agentProviderId = mediaStatus?.agentProvider ?? ''
  /** 该供应商接入类型路由得通的大类（kind 选项过滤；与新增供应商表单同一矩阵） */
  const kindOptions = mediaAdapterKinds[provider.type] ?? ALL_KINDS
  const effectiveNmKind = kindOptions.includes(nmKind) ? nmKind : kindOptions[0]
  /** 当前供应商名下被隐藏的内置模型（恢复入口用） */
  const hiddenModels = (mediaStatus?.hiddenBuiltin ?? []).filter((id) => id.startsWith(`${provider.id}/`))

  const submitKey = async () => {
    const key = keyInput.trim()
    if (!key) return
    const error = await setMediaKey(provider.id, key)
    onNotice(error ? `保存失败：${error}` : 'Key 已加密保存')
    if (!error) setKeyInput('')
  }

  const submitNewModel = async () => {
    if (!nmId.trim()) return
    const error = await mediaUserAddModel({
      providerId: provider.id,
      id: nmId.trim(),
      kind: effectiveNmKind,
      ...capsPayload(effectiveNmKind, nmCaps, nmCostHint)
    })
    if (error) {
      onNotice(`添加模型失败：${error}`)
      return
    }
    onNotice(`已添加模型：${nmId.trim()}`)
    setNmId('')
    setNmCaps({})
    setNmCostHint('')
    // 收起面板让 ModelCapsFields 卸载重挂：内部时长文本是本地草稿，不随 caps 重置而清
    setNmCapsOpen(false)
  }

  return (
    <div className="space-y-4" data-testid="media-provider-detail">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-(--on-surface)">{provider.label}</div>
          <div className="mt-0.5 text-[11px] text-(--on-surface-muted)">
            {provider.type} · {provider.models.length} 个模型 · {authHintLabel(provider.authHint)}
          </div>
        </div>
        {provider.id === agentProviderId && (
          <span className="shrink-0 rounded-full bg-(--success-bg) px-2 py-0.5 text-[10px] font-medium text-(--success-text)">
            Agent 默认
          </span>
        )}
      </div>

      <Field label={`API Key（${authHintLabel(provider.authHint)}）`}>
        <div className="flex gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitKey()
            }}
            placeholder={provider.configured ? '已配置 —— 输入新值可覆盖' : '粘贴 Key 后回车保存'}
            className={inputCls}
          />
          <button
            onClick={() => void submitKey()}
            disabled={!keyInput.trim()}
            className="shrink-0 rounded-lg bg-(--fab-bg) px-3.5 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90 disabled:opacity-30"
          >
            保存
          </button>
          {provider.authHint === 'workspace-store' && (
            <button
              onClick={async () => {
                const error = await removeMediaKey(provider.id)
                onNotice(error ? `删除失败：${error}` : '已删除已存 Key')
              }}
              className="shrink-0 rounded-lg px-2 text-[12px] text-(--danger) transition-colors hover:bg-(--outline-soft)"
              title="删除已存 Key"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </Field>
      {keyUrl && (
        <a
          href={keyUrl.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-(--accent) transition-colors hover:underline"
          title={`在系统浏览器打开 ${keyUrl.label} 的 API Key 页面`}
          data-testid={`media-apikey-link-${provider.id}`}
        >
          <ExternalLink size={10} />
          前往 {keyUrl.label} 创建 / 管理 API Key
        </a>
      )}

      <div>
        <div className="mb-1.5 text-[11px] font-medium text-(--on-surface-variant)">可生成模型</div>
        <div data-scrollable="" className="flex max-h-40 flex-wrap items-center gap-1.5 overflow-y-auto rounded-xl bg-(--surface-input) p-2">
          {provider.models.map((m) => (
            <span
              key={m.id}
              title={m.costHint ?? m.id}
              className="group/model flex items-center gap-1 rounded-full bg-(--surface-card) py-1 pl-2.5 pr-1 text-[12px] text-(--on-surface) ring-1 ring-(--outline-soft)"
            >
              <span className="text-(--on-surface-muted)">{KIND_LABEL[m.kind]}</span>
              {m.label ?? m.id}
              {provider.source && (
                <button
                  onClick={() => {
                    setPendingRemove(false)
                    void mediaUserRemoveModel(provider.id, m.id).then((error) => {
                      onNotice(error ? `移除失败：${error}` : `已移除模型：${m.label ?? m.id}`)
                    })
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-(--on-surface-muted) opacity-0 transition-opacity hover:bg-(--outline-soft) hover:text-(--danger) group-hover/model:opacity-100"
                  title={provider.source === 'user' ? '从清单移除该模型' : '隐藏该内置模型（可随时恢复）'}
                >
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
          <span className="flex items-center gap-1 rounded-full border border-dashed border-(--outline) py-1 pl-2 pr-1 text-[12px]">
            <input
              value={nmId}
              onChange={(e) => setNmId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNewModel()
              }}
              placeholder="模型 id，如 doubao-seedream-5-0"
              className="w-40 bg-transparent text-[12px] outline-none placeholder:text-(--on-surface-muted)"
            />
            <Select
              variant="ghost"
              value={effectiveNmKind}
              onChange={(v) => setNmKind(v as MediaKind)}
              options={kindOptions.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
            />
            <button
              onClick={() => setNmCapsOpen((v) => !v)}
              className={`flex h-4 w-4 items-center justify-center rounded-full transition ${
                nmCapsOpen ? 'bg-(--surface-chip) text-(--on-surface)' : 'text-(--on-surface-muted) hover:text-(--on-surface)'
              }`}
              title="能力参数（可选）"
            >
              <SlidersHorizontal size={10} />
            </button>
            <button
              onClick={() => void submitNewModel()}
              disabled={!nmId.trim()}
              className="flex h-4 w-4 items-center justify-center rounded-full bg-(--fab-bg) text-(--fab-text) transition hover:opacity-90 disabled:opacity-30"
              title="添加模型（发给网关的模型标识）"
            >
              <Plus size={10} />
            </button>
          </span>
        </div>
        {nmCapsOpen && (
          <div className="mt-1.5">
            <ModelCapsFields
              kind={effectiveNmKind}
              caps={nmCaps}
              costHint={nmCostHint}
              onChange={(next) => {
                setNmCaps(next.capabilities)
                setNmCostHint(next.costHint)
              }}
            />
          </div>
        )}
        {hiddenModels.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-(--on-surface-muted)">
            <span>已隐藏：</span>
            {hiddenModels.map((id) => (
              <button
                key={id}
                onClick={() =>
                  void mediaUserRestoreModel(provider.id, id).then((error) => {
                    onNotice(error ? `恢复失败：${error}` : `已恢复模型：${id}`)
                  })
                }
                className="flex items-center gap-0.5 rounded-full bg-(--surface-chip) px-2 py-0.5 transition-colors hover:bg-(--surface-hover)"
                title="恢复该内置模型"
              >
                {id.slice(provider.id.length + 1)}
                <RotateCcw size={9} />
              </button>
            ))}
          </div>
        )}
      </div>

      <MediaCatalogBrowser providerId={provider.id} onNotice={onNotice} />

      <div className="flex items-center gap-2 border-t border-(--outline-soft) pt-3">
        {provider.id !== agentProviderId && (
          <button
            onClick={async () => {
              const error = await updateMediaConfig({ agentProvider: provider.id })
              onNotice(error ? `切换失败：${error}` : `已设为 Agent 默认供应商：${provider.label}`)
            }}
            className="rounded-full bg-(--surface-chip) px-3.5 py-1.5 text-[12px] font-medium text-(--on-surface) transition-colors hover:bg-(--surface-hover)"
          >
            设为 Agent 默认
          </button>
        )}
        {provider.source === 'user' &&
          (pendingRemove ? (
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-(--danger)">删除供应商将移除它的全部模型配置（已存 Key 保留），确定？</span>
              <button
                onClick={() => {
                  setPendingRemove(false)
                  void mediaUserRemoveProvider(provider.id).then((error) => {
                    onNotice(error ? `删除失败：${error}` : `已删除供应商：${provider.label}`)
                  })
                }}
                className="rounded-lg bg-(--danger) px-2.5 py-1 text-[12px] font-medium text-white transition hover:opacity-90"
              >
                确认删除
              </button>
              <button
                onClick={() => setPendingRemove(false)}
                className="rounded-lg px-2.5 py-1 text-[12px] text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft)"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setPendingRemove(true)}
              className="flex items-center gap-1 text-[12px] text-(--danger) transition-colors hover:opacity-80"
            >
              <Trash2 size={12} />
              删除该自定义供应商
            </button>
          ))}
      </div>
    </div>
  )
}

export function MediaTab() {
  const { mediaProviders, mediaStatus, mediaLoaded, refreshMedia } = useSettings()
  const [view, setView] = useState<MediaView>('defaults')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!mediaLoaded) void refreshMedia()
  }, [mediaLoaded, refreshMedia])

  const agentProviderId = mediaStatus?.agentProvider ?? ''
  const selected = mediaProviders.find((p) => p.id === selectedId)
  // 供应商被删除后详情页失去目标，回落到默认值页
  const effectiveView: MediaView = view === 'provider' && !selected ? 'defaults' : view

  return (
    <div className="flex h-full gap-5" data-testid="media-tab">
      {/* 左栏：生成默认值 + 供应商清单 + 新增入口（对标「模型供应商」页的主从结构） */}
      <div data-scrollable="" className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto">
        <div
          onClick={() => {
            setNotice(null)
            setView('defaults')
          }}
          className={`flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 transition-colors ${
            effectiveView === 'defaults' ? 'bg-(--surface-chip)' : 'hover:bg-(--outline-soft)'
          }`}
        >
          <SlidersHorizontal size={13} className="shrink-0 text-(--on-surface-muted)" />
          <span className="truncate text-[13px] font-medium text-(--on-surface)">生成默认值</span>
        </div>
        <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold tracking-wider text-(--on-surface-muted)">
          供应商（{mediaProviders.length}）
        </div>
        {mediaProviders.map((p) => (
          <div
            key={p.id}
            onClick={() => {
              setNotice(null)
              setSelectedId(p.id)
              setView('provider')
            }}
            className={`flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 transition-colors ${
              effectiveView === 'provider' && p.id === selected?.id ? 'bg-(--surface-chip)' : 'hover:bg-(--outline-soft)'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.configured ? 'bg-(--success-dot)' : 'bg-(--on-surface-muted)'}`}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-(--on-surface)">{p.label}</span>
            {p.id === agentProviderId && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--accent)" title="Agent 默认供应商" />
            )}
            <span className="shrink-0 text-[10px] text-(--on-surface-muted)" title="模型数量">
              {p.models.length}
            </span>
          </div>
        ))}
        <button
          onClick={() => {
            setNotice(null)
            setView('add')
          }}
          className={`mt-1 flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors ${
            effectiveView === 'add'
              ? 'bg-(--surface-chip) text-(--on-surface)'
              : 'text-(--on-surface-variant) hover:bg-(--outline-soft)'
          }`}
        >
          <Plus size={13} />
          新增供应商
        </button>
        <div className="mt-auto px-2 pb-1 pt-2 text-[10px] leading-relaxed text-(--on-surface-muted)">
          媒体供应商与对话供应商是两套独立配置；这里的改动都写入当前工作区 workspace.json
        </div>
      </div>

      {/* 右栏：默认值编辑页 / 新增供应商表单 / 供应商详情 */}
      <div data-scrollable="" className="min-w-0 flex-1 overflow-y-auto border-l border-(--outline-soft) pl-5">
        {notice && (
          <div
            className={`mb-3 text-[12px] ${notice.includes('失败') ? 'text-(--danger)' : 'text-(--on-surface-muted)'}`}
            data-testid="media-notice"
          >
            {notice}
          </div>
        )}
        {effectiveView === 'defaults' ? (
          <MediaDefaultsView />
        ) : effectiveView === 'add' ? (
          <MediaAddProviderView
            onDone={(id, message) => {
              setNotice(message)
              setSelectedId(id)
              setView('provider')
            }}
            onCancel={() => setView(selected ? 'provider' : 'defaults')}
            onNotice={setNotice}
          />
        ) : selected ? (
          <MediaProviderDetail providerId={selected.id} onNotice={setNotice} />
        ) : (
          <div className="pt-10 text-center text-[12px] text-(--on-surface-muted)">加载中…</div>
        )}
      </div>
    </div>
  )
}
