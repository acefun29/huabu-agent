/**
 * 供应商详情页：凭据 + 可生成模型 + 全量模型库浏览 + 供应商管理。
 */

import { useEffect, useState } from 'react'
import { ExternalLink, Plus, RotateCcw, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useMediaSettings } from '../../../store/settingsStore'
import type { ModelCapabilities } from '@shared/media'
import type { MediaKind } from '../../../types'
import { KIND_LABEL } from '../../../types'
import { Field, Select, inputCls } from '../ui'
import { MediaCatalogBrowser } from './CatalogBrowser'
import { ModelCapsFields } from './ModelCapsFields'
import { ALL_KINDS, MEDIA_API_KEY_URLS, authHintLabel, capsPayload } from './shared'

export function MediaProviderDetail({
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
  } = useMediaSettings()
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
