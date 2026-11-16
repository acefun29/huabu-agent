/** 新增自定义供应商表单页。 */

import { useState } from 'react'
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react'
import { useMediaSettings } from '../../../store/settingsStore'
import type { MediaProviderType } from '@shared/ipc'
import type { ModelCapabilities } from '@shared/media'
import type { MediaKind } from '../../../types'
import { KIND_LABEL } from '../../../types'
import { Field, Select, inputCls } from '../ui'
import { ModelCapsFields } from './ModelCapsFields'
import { ADAPTER_TYPE_OPTIONS, ALL_KINDS, capsPayload } from './shared'

export function MediaAddProviderView({
  onDone,
  onCancel,
  onNotice,
}: {
  onDone: (providerId: string, message: string) => void
  onCancel: () => void
  onNotice: (message: string | null) => void
}) {
  const { mediaUserAddProvider, mediaAdapterKinds } = useMediaSettings()
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
