/**
 * 设置面板「模型供应商」页：左侧是对话供应商清单与新增入口，
 * 右侧渲染供应商详情或新增表单。
 */

import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useChatSettings } from '../../store/settingsStore'
import type { ChatModelApi } from '@shared/chatApi'
import { ApiSelect, Field, inputCls } from './ui'
import { ProviderDetail } from './providers/ProviderDetail'

export function ProvidersTab() {
  const { chatProviders, credentialsHint, chatLoaded, defaultModel, refreshChat, customAddProvider } = useChatSettings()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [newBaseUrl, setNewBaseUrl] = useState('')
  const [newApi, setNewApi] = useState<ChatModelApi>('openai-completions')
  const [addError, setAddError] = useState<string | null>(null)

  const selected = chatProviders.find((p) => p.id === selectedId) ?? chatProviders[0]

  useEffect(() => {
    if (!chatLoaded) void refreshChat()
  }, [chatLoaded, refreshChat])

  const submitAdd = async () => {
    const id = newId.trim()
    const url = newBaseUrl.trim()
    if (!id || !url) return
    const error = await customAddProvider(id, newName.trim() || id, url, newApi)
    if (error) {
      setAddError(error)
      return
    }
    setAddError(null)
    setNewId('')
    setNewName('')
    setNewBaseUrl('')
    setNewApi('openai-completions')
    setAdding(false)
    setSelectedId(id)
  }

  return (
    <div className="flex h-full gap-5">
      <div data-scrollable="" className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto">
        {chatProviders.map((p) => (
          <div
            key={p.id}
            onClick={() => setSelectedId(p.id)}
            className={`flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 transition-colors ${
              p.id === selected?.id ? 'bg-(--surface-chip)' : 'hover:bg-(--outline-soft)'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.authConfigured ? 'bg-(--success-dot)' : 'bg-(--on-surface-muted)'}`}
            />
            <span className="truncate text-[13px] font-medium text-(--on-surface)">{p.name}</span>
            {defaultModel?.startsWith(`${p.id}/`) && (
              <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-(--accent)" title="默认供应商" />
            )}
          </div>
        ))}
        <button
          onClick={() => setAdding(true)}
          data-testid="add-provider-toggle"
          className="mt-1 flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
        >
          <Plus size={13} />
          添加自定义供应商
        </button>
        <div className="mt-auto px-2 pb-1 pt-2 text-[10px] leading-relaxed text-(--on-surface-muted)">
          凭据文件：{credentialsHint || '（未打开工作区）'}
        </div>
      </div>
      <div data-scrollable="" className="min-w-0 flex-1 overflow-y-auto border-l border-(--outline-soft) pl-5">
        {adding ? (
          <div className="max-w-md space-y-3">
            <div className="text-[15px] font-semibold text-(--on-surface)">添加自定义供应商</div>
            <Field label="供应商 ID（英文标识）">
              <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="my-gateway" className={inputCls} />
            </Field>
            <Field label="显示名（可选）">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="我的网关" className={inputCls} />
            </Field>
            <Field label="Base URL">
              <input
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className={inputCls}
              />
            </Field>
            <Field label="协议">
              <ApiSelect value={newApi} onChange={(v) => setNewApi(v as ChatModelApi)} testId="add-provider-api" />
              <span className="mt-1 block text-[10px] leading-relaxed text-(--on-surface-muted)">
                选错不会报错，只会连不上：走 OpenAI 兼容端点的网关选第一项，Anthropic/Claude
                兼容端点（如 open.bigmodel.cn/api/anthropic）选最后一项。建好后改协议要删掉重建。
                自建供应商按「通用兼容形态」发请求（system 角色 + max_tokens，不带 OpenAI
                专有参数），不会把兼容网关当成 OpenAI 官方来对待；真 OpenAI 请用内置供应商。
              </span>
            </Field>
            {addError && <div className="text-[12px] text-(--danger)">{addError}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => void submitAdd()}
                disabled={!newId.trim() || !newBaseUrl.trim()}
                className="rounded-full bg-(--fab-bg) px-4 py-1.5 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90 disabled:opacity-30"
              >
                创建
              </button>
              <button
                onClick={() => setAdding(false)}
                className="rounded-full bg-(--surface-chip) px-4 py-1.5 text-[12px] font-medium text-(--on-surface) transition-colors hover:bg-(--surface-hover)"
              >
                取消
              </button>
            </div>
          </div>
        ) : selected ? (
          <ProviderDetail key={selected.id} providerId={selected.id} />
        ) : (
          <div className="pt-10 text-center text-[12px] text-(--on-surface-muted)">
            {chatLoaded ? '当前工作区没有可用的模型供应商' : '加载中…'}
          </div>
        )}
      </div>
    </div>
  )
}
