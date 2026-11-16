/** 供应商详情页：凭据、模型清单、默认对话模型与连通性检测。 */

import { useEffect, useState } from 'react'
import { ExternalLink, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useChatSettings } from '../../../store/settingsStore'
import { compactTokens } from '../../../lib/format'
import type { ManagedModelInfo } from '@shared/ipc'
import { CHAT_API_LABEL, type ChatModelApi } from '@shared/chatApi'
import { Field, Select, inputCls } from '../ui'
import { AddModelDialog } from './AddModelDialog'
import { EditModelDialog } from './EditModelDialog'
import { API_KEY_URLS } from './shared'

export function ProviderDetail({ providerId }: { providerId: string }) {
  const {
    chatProviders,
    setApiKey,
    removeApiKey,
    testProvider,
    defaultModel,
    setDefaultModel,
    modelsList,
    modelRemove,
    modelRestore,
  } = useChatSettings()
  const provider = chatProviders.find((p) => p.id === providerId)
  const keyUrl = API_KEY_URLS[providerId]
  const [keyInput, setKeyInput] = useState('')
  const [testMessage, setTestMessage] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [models, setModels] = useState<ManagedModelInfo[]>([])
  const [addingModel, setAddingModel] = useState(false)
  const [editingModel, setEditingModel] = useState<ManagedModelInfo | null>(null)

  const refreshModels = async () => {
    setModels(await modelsList(providerId))
  }

  useEffect(() => {
    setTestMessage(null)
    setKeyInput('')
    setAddingModel(false)
    setEditingModel(null)
    void modelsList(providerId).then(setModels)
  }, [providerId, modelsList])

  if (!provider) return null
  // 被隐藏的内置模型不消失，只是从这里挪到下面的「已隐藏」行 —— 没有这一步，旧工作区迁移来的
  // hiddenBuiltin 条目在 UI 上就是永不可见的黑洞
  const hiddenModels = models.filter((m) => m.hidden)

  const runTest = async () => {
    setTesting(true)
    setTestMessage(null)
    const result = await testProvider(providerId)
    setTestMessage(result ? result.message : '测试请求失败')
    setTesting(false)
  }

  const submitKey = async () => {
    const key = keyInput.trim()
    if (!key) return
    const error = await setApiKey(providerId, key)
    if (error) setTestMessage(`保存失败：${error}`)
    else {
      setKeyInput('')
      setTestMessage('Key 已加密保存，即刻生效')
    }
  }

  const removeModel = async (m: ManagedModelInfo) => {
    const error = await modelRemove(providerId, m.id)
    // 同一个按钮两种语义（主进程按 source 分派），文案必须跟着分派，否则用户以为内置模型被删了
    setTestMessage(error ? `移除失败：${error}` : m.source === 'builtin' ? `已隐藏模型：${m.name}（下方可恢复）` : `已删除模型：${m.name}`)
    if (!error) void refreshModels()
  }

  return (
    <div className="space-y-4" data-testid="provider-detail">
      {addingModel && (
        <AddModelDialog
          providerId={providerId}
          onClose={() => setAddingModel(false)}
          onAdded={() => {
            setAddingModel(false)
            void refreshModels()
          }}
        />
      )}
      {editingModel && (
        <EditModelDialog
          providerId={providerId}
          model={editingModel}
          onClose={() => setEditingModel(null)}
          onSaved={() => {
            setEditingModel(null)
            setTestMessage('已保存，即刻重注册生效')
            void refreshModels()
          }}
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-(--on-surface)">{provider.name}</div>
          <div className="mt-0.5 font-mono text-[11px] text-(--on-surface-muted)">
            {provider.id} · {provider.modelCount} 个模型
            {/* 生效协议要显示出来：选错协议不会报错，只会连不上，用户得能看见自己选了哪一路 */}
            {provider.api && <span title={CHAT_API_LABEL[provider.api as ChatModelApi] ?? provider.api}> · {provider.api}</span>}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${
            provider.authConfigured
              ? 'bg-(--success-bg) text-(--success-text)'
              : 'bg-(--surface-chip) text-(--on-surface-muted)'
          }`}
          title={provider.authLabel ? `凭据来源：${provider.authLabel}` : '尚未配置凭据'}
        >
          {provider.authConfigured ? `已配置（${provider.authSource}）` : '未配置凭据'}
        </span>
      </div>

      <div>
        <Field label="API Key（safeStorage 加密存储，仅存环境变量名不存密钥）">
          <div className="flex gap-2">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitKey()
              }}
              placeholder={provider.authConfigured ? '已配置 —— 输入新值可覆盖' : '粘贴 Key 后回车保存'}
              className={inputCls}
            />
            <button
              onClick={() => void submitKey()}
              disabled={!keyInput.trim()}
              className="shrink-0 rounded-lg bg-(--fab-bg) px-3.5 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90 disabled:opacity-30"
            >
              保存
            </button>
            {provider.authConfigured && provider.authSource === 'workspace-store' && (
              <button
                onClick={async () => {
                  const error = await removeApiKey(providerId)
                  setTestMessage(error ? `删除失败：${error}` : '已删除已存凭据')
                }}
                className="shrink-0 rounded-lg px-2 text-[12px] text-(--danger) transition-colors hover:bg-(--outline-soft)"
                title="删除已存凭据"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </Field>
        {provider.authLabel && (
          <div className="mt-1 text-[11px] text-(--on-surface-muted)">环境变量：{provider.authLabel}</div>
        )}
        {keyUrl && (
          <a
            href={keyUrl.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-(--accent) transition-colors hover:underline"
            title={`在系统浏览器打开 ${keyUrl.label} 的 API Key 页面`}
            data-testid={`provider-apikey-link-${providerId}`}
          >
            <ExternalLink size={10} />
            前往 {keyUrl.label} 创建 / 管理 API Key
          </a>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-(--on-surface-variant)">
          <span>模型（内置 + 自定义；自定义可追加）</span>
          <button
            onClick={() => setAddingModel(true)}
            className="flex items-center gap-1 rounded-full bg-(--surface-chip) px-2.5 py-1 text-[11px] font-medium text-(--on-surface) transition-colors hover:bg-(--surface-hover)"
            data-testid={`provider-add-model-${providerId}`}
            title="新增自定义模型（名称 / ID / 上下文 / 图片输入 / 推理）"
          >
            <Plus size={11} />
            添加模型
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-(--surface-input) p-2">
          {models
            .filter((m) => !m.hidden)
            .map((m) => {
              const ctx = compactTokens(m.contextWindow)
              const vision = m.input?.includes('image') ?? false
              return (
                <span
                  key={m.id}
                  className="group/model flex items-center gap-1 rounded-full bg-(--surface-card) py-1 pl-2.5 pr-1 text-[12px] text-(--on-surface) ring-1 ring-(--outline-soft)"
                  title={`${m.id}${ctx ? ` · 上下文 ${m.contextWindow}` : ''}`}
                >
                  {m.name}
                  {m.reasoning && <span className="text-[9px] text-(--accent)">思考</span>}
                  {vision && (
                    <span className="rounded-full bg-(--surface-chip) px-1.5 text-[9px] text-(--on-surface-variant)">视觉</span>
                  )}
                  {ctx && <span className="text-[9px] text-(--on-surface-muted)">{ctx}</span>}
                  {defaultModel === `${providerId}/${m.id}` && (
                    <span className="rounded-full bg-(--accent) px-1.5 text-[9px] text-white">默认</span>
                  )}
                  {m.source === 'custom' && (
                    <>
                      <button
                        onClick={() => setEditingModel(m)}
                        className="flex h-4 w-4 items-center justify-center rounded-full text-(--on-surface-muted) opacity-0 transition-opacity hover:bg-(--outline-soft) hover:text-(--on-surface) group-hover/model:opacity-100"
                        title="编辑（改名 / 上下文 / 最大输出 / 推理与思考档位）"
                        data-testid={`model-edit-${m.id}`}
                      >
                        <Pencil size={9} />
                      </button>
                      <button
                        onClick={() => void removeModel(m)}
                        className="flex h-4 w-4 items-center justify-center rounded-full text-(--on-surface-muted) opacity-0 transition-opacity hover:bg-(--outline-soft) hover:text-(--danger) group-hover/model:opacity-100"
                        title="删除该自定义模型"
                      >
                        <X size={10} />
                      </button>
                    </>
                  )}
                  {m.source === 'builtin' && (
                    <>
                      <button
                        onClick={() => setEditingModel(m)}
                        className="flex h-4 w-4 items-center justify-center rounded-full text-(--on-surface-muted) opacity-0 transition-opacity hover:bg-(--outline-soft) hover:text-(--on-surface) group-hover/model:opacity-100"
                        title="编辑（改名 / 上下文 / 最大输出 / 推理与思考档位）"
                        data-testid={`model-edit-${m.id}`}
                      >
                        <Pencil size={9} />
                      </button>
                      <button
                        onClick={() => void removeModel(m)}
                        className="flex h-4 w-4 items-center justify-center rounded-full text-(--on-surface-muted) opacity-0 transition-opacity hover:bg-(--outline-soft) hover:text-(--danger) group-hover/model:opacity-100"
                        title="隐藏该内置模型（不再生成清单里出现，可随时恢复）"
                      >
                        <X size={10} />
                      </button>
                    </>
                  )}
                </span>
              )
            })}
          {hiddenModels.length > 0 && (
            <span className="flex w-full items-center gap-1.5 px-1.5 pt-1 text-[11px] text-(--on-surface-muted)">
              已隐藏：
              {hiddenModels.map((m) => (
                <button
                  key={m.id}
                  onClick={async () => {
                    const error = await modelRestore(providerId, m.id)
                    setTestMessage(error ? `恢复失败：${error}` : `已恢复模型：${m.name}`)
                    if (!error) void refreshModels()
                  }}
                  className="flex items-center gap-1 rounded-full bg-(--surface-chip) px-2 py-0.5 transition-colors hover:bg-(--surface-hover)"
                  title="恢复该内置模型"
                  data-testid={`model-restore-${m.id}`}
                >
                  {m.name}
                  <RotateCcw size={9} />
                </button>
              ))}
            </span>
          )}
          <span className="px-1.5 text-[11px] text-(--on-surface-muted)">
            {models.some((m) => m.source === 'custom')
              ? '模型悬停可编辑（名称 / 上下文 / 推理与思考档位）；自定义模型悬停可删除，内置模型可隐藏（隐藏后可在下面恢复）'
              : '点「添加模型」录入自定义模型（ID / 上下文 / 图片支持等）；内置模型悬停可编辑或隐藏'}
          </span>
        </div>
      </div>

      <Field label="默认对话模型（新建会话继承；工作区级设置）">
        <Select
          value={defaultModel && defaultModel.startsWith(`${providerId}/`) ? defaultModel : ''}
          onChange={(v) => void setDefaultModel(v || null)}
          options={[
            { value: '', label: '自动（首个有凭据的可用模型）' },
            ...models
              .filter((m) => !m.hidden)
              .map((m) => ({ value: `${providerId}/${m.id}`, label: m.name })),
          ]}
        />
      </Field>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => void runTest()}
          disabled={testing}
          className="rounded-full bg-(--surface-chip) px-3.5 py-1.5 text-[12px] font-medium text-(--on-surface) transition-colors hover:bg-(--surface-hover) disabled:opacity-50"
        >
          {testing ? '检测中…' : '测试连接'}
        </button>
        {testMessage && (
          <span
            className={`text-[12px] ${testMessage.includes('失败') ? 'text-(--danger)' : 'text-(--success-text)'}`}
            data-testid="provider-test-result"
          >
            {testMessage}
          </span>
        )}
      </div>
    </div>
  )
}
