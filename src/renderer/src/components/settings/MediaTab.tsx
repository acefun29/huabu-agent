// 设置面板「媒体生成」tab：生成默认值、新增供应商、全量模型库浏览、供应商详情（内部组件不导出，仅导出 MediaTab）

import { useEffect, useState } from 'react'
import { ExternalLink, Plus, RotateCcw, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useSettings } from '../../store/settingsStore'
import { useCanvasStore } from '../../store/canvasStore'
import type { MediaCatalogBrowseItem, MediaProviderType } from '@shared/ipc'
import {
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_MEDIA_DURATION_S,
  DEFAULT_MEDIA_PROVIDER,
  DEFAULT_MEDIA_RATIO,
  MEDIA_RATIOS
} from '@shared/media'
import { matchBareModelId, shortModelLabel } from '@shared/mediaResolve'
import { MEDIA_ROOT_REL } from '../../harness/assetCategories'
import type { MediaKind } from '../../types'
import { KIND_LABEL } from '../../types'
import { Field, Select, Toggle, inputCls } from './ui'

/* -------------------------------------------------------------------------- */
/* 媒体生成（真实 IPC：workspace.json media 段 + 网关凭据）                     */
/* -------------------------------------------------------------------------- */

/** 新增供应商可用的适配器类型（与主进程注册表对应；新增类型时两处同步） */
const ADAPTER_TYPE_OPTIONS: { value: MediaProviderType; label: string; baseUrlHint?: string }[] = [
  { value: 'gateway-openai-compat', label: 'OpenAI 兼容（图片 / 语音合成）', baseUrlHint: 'https://api.openai.com/v1' },
  { value: 'gateway-dashscope', label: '阿里云百炼（异步任务）' },
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
  volcark: { url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', label: '火山方舟' },
  minimax: { url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', label: 'MiniMax 开放平台' },
  tencent: { url: 'https://console.cloud.tencent.com/cam/capi', label: '腾讯云（API 密钥管理）' },
}

type MediaView = 'defaults' | 'add' | 'provider'

/** 生成默认值编辑页：Agent 工具与画布生成卡片共用，写入当前工作区 workspace.json */
function MediaDefaultsView() {
  const { mediaProviders, mediaStatus, confirmVideo, updateMediaConfig, resolveMediaModel, mediaModelOptions } = useSettings()
  const libraries = useCanvasStore((s) => s.libraries)
  const [outputDirDraft, setOutputDirDraft] = useState<string | null>(null)
  const [saveHint, setSaveHint] = useState<string | null>(null)
  const agentProviderId = mediaStatus?.agentProvider ?? DEFAULT_MEDIA_PROVIDER
  const outputDir = mediaStatus?.outputDir ?? MEDIA_ROOT_REL
  const imageFallback = resolveMediaModel('image')
  /** 落库默认值：未配置 = 画布素材（按类型归类）；特殊值 builtin-assets / none 与主进程校验对齐 */
  const defaultLibraryId = mediaStatus?.defaultLibraryId ?? 'builtin-assets'

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[15px] font-semibold text-(--on-surface)">生成默认值</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-(--on-surface-muted)">
          Agent 工具与画布上的生成卡片共用这套默认值与回退链（卡片指定 → 各类默认模型 →
          供应商首个同类模型）；全部改动即时写入当前工作区
        </div>
      </div>

      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label="Agent 使用的供应商">
            <Select
              value={agentProviderId}
              onChange={(v) => void updateMediaConfig({ agentProvider: v })}
              options={mediaProviders.map((p) => ({ value: p.id, label: p.label }))}
            />
          </Field>
          {(['image', 'video', 'audio'] as MediaKind[]).map((kind) => {
            // 存储记法统一为 `provider:模型id` 复合串；旧工作区存的裸模型 id 在显示时兼容映射
            const stored = mediaStatus?.agentModels?.[kind] ?? ''
            const selectValue =
              !stored || stored.includes(':')
                ? stored
                : (matchBareModelId(mediaProviders, stored, kind, agentProviderId)?.ref ?? '')
            return (
              <Field key={kind} label={`${KIND_LABEL[kind]}默认模型`}>
                <Select
                  value={selectValue}
                  onChange={(v) =>
                    void updateMediaConfig({
                      agentModels: { ...mediaStatus?.agentModels, [kind]: v },
                    })
                  }
                  options={[
                    { value: '', label: '未指定（用供应商首个同类模型）' },
                    ...mediaModelOptions(kind).map((m) => ({ value: m.id, label: m.label })),
                  ]}
                />
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

      <div className="rounded-2xl bg-(--surface-card) px-4 py-3 text-[12px] leading-relaxed text-(--on-surface-muted) ring-1 ring-(--outline-soft)">
        <span className="text-(--on-surface)">当前图片回退</span> →{' '}
        {imageFallback
          ? `${imageFallback.provider} · ${shortModelLabel(imageFallback.provider, imageFallback.model)}`
          : '未配置（先在左侧选供应商录入 Key）'}
      </div>
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
  const { mediaUserAddProvider } = useSettings()
  const [npId, setNpId] = useState('')
  const [npLabel, setNpLabel] = useState('')
  const [npType, setNpType] = useState<MediaProviderType>('gateway-openai-compat')
  const [npBaseUrl, setNpBaseUrl] = useState('')
  const [npAuthEnv, setNpAuthEnv] = useState('')
  const [npModelId, setNpModelId] = useState('')
  const [npModelKind, setNpModelKind] = useState<MediaKind>('image')
  const adapterTypeOption = ADAPTER_TYPE_OPTIONS.find((t) => t.value === npType)

  const submit = async () => {
    const error = await mediaUserAddProvider({
      id: npId.trim(),
      type: npType,
      ...(npLabel.trim() ? { label: npLabel.trim() } : {}),
      ...(npType === 'gateway-openai-compat' && npBaseUrl.trim() ? { baseUrl: npBaseUrl.trim() } : {}),
      ...(npAuthEnv.trim() ? { authEnv: npAuthEnv.trim() } : {}),
      firstModel: { id: npModelId.trim(), kind: npModelKind }
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
        {npType === 'gateway-openai-compat' ? (
          <Field label="Base URL（网关端点，留空 = 官方默认）">
            <input
              value={npBaseUrl}
              onChange={(e) => setNpBaseUrl(e.target.value)}
              placeholder={adapterTypeOption?.baseUrlHint ?? 'https://…'}
              className={inputCls}
            />
          </Field>
        ) : (
          <Field label="凭据环境变量名（可选，录入 Key 后不需要）">
            <input value={npAuthEnv} onChange={(e) => setNpAuthEnv(e.target.value)} placeholder="SILICONFLOW_KEY" className={inputCls} />
          </Field>
        )}
        <Field label="首个模型 id（发给网关的标识）">
          <div className="flex gap-1.5">
            <input value={npModelId} onChange={(e) => setNpModelId(e.target.value)} placeholder="Kwai-Kolors/Kolors" className={inputCls} />
            <Select
              hug
              className="w-24 shrink-0"
              value={npModelKind}
              onChange={(v) => setNpModelKind(v as MediaKind)}
              options={[
                { value: 'image', label: '图片' },
                { value: 'video', label: '视频' },
                { value: 'audio', label: '音频' },
              ]}
            />
          </div>
        </Field>
      </div>
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
  /* 删除供应商的两步确认（第二次点击才真正执行） */
  const [pendingRemove, setPendingRemove] = useState(false)

  useEffect(() => {
    setKeyInput('')
    setNmId('')
    setPendingRemove(false)
  }, [providerId])

  if (!provider) return null
  const keyUrl = MEDIA_API_KEY_URLS[provider.id]
  const agentProviderId = mediaStatus?.agentProvider ?? DEFAULT_MEDIA_PROVIDER
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
    const error = await mediaUserAddModel({ providerId: provider.id, id: nmId.trim(), kind: nmKind })
    if (error) {
      onNotice(`添加模型失败：${error}`)
      return
    }
    onNotice(`已添加模型：${nmId.trim()}`)
    setNmId('')
  }

  return (
    <div className="space-y-4" data-testid="media-provider-detail">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-(--on-surface)">{provider.label}</div>
          <div className="mt-0.5 text-[11px] text-(--on-surface-muted)">
            {provider.type} · {provider.models.length} 个模型 · {provider.authHint ?? '无需凭据'}
          </div>
        </div>
        {provider.id === agentProviderId && (
          <span className="shrink-0 rounded-full bg-(--success-bg) px-2 py-0.5 text-[10px] font-medium text-(--success-text)">
            Agent 默认
          </span>
        )}
      </div>

      <Field label={`API Key（${provider.authHint === 'environment' ? '当前走环境变量' : '加密存储'}）`}>
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
              value={nmKind}
              onChange={(v) => setNmKind(v as MediaKind)}
              options={[
                { value: 'image', label: '图片' },
                { value: 'video', label: '视频' },
                { value: 'audio', label: '音频' },
              ]}
            />
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

  const agentProviderId = mediaStatus?.agentProvider ?? DEFAULT_MEDIA_PROVIDER
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
