// 设置面板「模型供应商」tab：供应商清单与详情、添加/编辑模型对话框（内部组件不导出，仅导出 ProvidersTab）

import { useEffect, useState } from 'react'
import { Check, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useSettings } from '../../store/settingsStore'
import { compactTokens } from '../../lib/format'
import { useEsc } from '../../lib/hooks'
import type { ManagedModelInfo } from '@shared/ipc'
import { CHAT_API_LABEL, type ChatModelApi } from '@shared/chatApi'
import { ApiSelect, Field, Row, Toggle, inputCls } from './ui'

/* -------------------------------------------------------------------------- */
/* 模型供应商（对话；真实 IPC：凭据加密存储，零密钥过 IPC）                      */
/* -------------------------------------------------------------------------- */

/**
 * 与主进程 chat 覆盖层的 ID 校验（main/models/catalog/merge.ts 的 PROVIDER_ID/MODEL_ID_PATTERN）
 * 大体一致，但这里刻意更宽：允许 `:` 与 `/`（自建模型常写 `网关/模型` 复合 id），大小写
 * 不敏感只为本输入框的容错；主进程侧仍是严格纯 id，最终以主进程校验为准。
 */
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._\-/:]*$/i

/**
 * 「添加模型」对话框：模型 ID + 显示名 + 上下文/最大输出 + 输入类型（图片）+ 推理开关。
 * 字段语义与主进程 CustomModelInput 一一对应；错误就地显示，成功后回调刷新清单。
 */
function AddModelDialog({
  providerId,
  onClose,
  onAdded,
}: {
  providerId: string
  onClose: () => void
  onAdded: () => void
}) {
  const { customAddModel } = useSettings()
  const [modelId, setModelId] = useState('')
  const [name, setName] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [supportsImage, setSupportsImage] = useState(false)
  const [reasoning, setReasoning] = useState(false)
  const [api, setApi] = useState<ChatModelApi | ''>('')
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
    (maxTokens.trim() === '' || (Number.isFinite(maxNum) && maxNum > 0))

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
      input_modalities: supportsImage ? ['text', 'image'] : ['text']
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

/**
 * 「编辑模型」对话框：改名 + 上下文/最大输出 + 推理开关。
 *
 * 内置与自定义走同一个口（`settings:model-edit`），分流在主进程 applyEditModel：自定义改条目本身，
 * 内置改名进 modelOverrides、改能力进同 id 补丁条目 —— 所以这里不判来源，只管把用户填的送过去。
 * 两条语义要留意：`name` 一律带上（清空 = 主动恢复目录默认名），能力字段留空 = 不动这一栏。
 */
function EditModelDialog({
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
  const { modelEdit } = useSettings()
  const [name, setName] = useState(model.name)
  const [contextWindow, setContextWindow] = useState(model.contextWindow ? String(model.contextWindow) : '')
  const [maxTokens, setMaxTokens] = useState(model.maxTokens ? String(model.maxTokens) : '')
  const [reasoning, setReasoning] = useState(model.reasoning)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Esc 只关本对话框：捕获阶段拦截并吞掉，避免冒泡到设置面板把整个设置一起关掉
  useEsc(true, onClose, { capture: true, swallow: true })

  const ctxNum = Number(contextWindow)
  const maxNum = Number(maxTokens)
  const canSubmit =
    !submitting &&
    (contextWindow.trim() === '' || (Number.isFinite(ctxNum) && ctxNum > 0)) &&
    (maxTokens.trim() === '' || (Number.isFinite(maxNum) && maxNum > 0))

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
      reasoning
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

function ProviderDetail({ providerId }: { providerId: string }) {
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
  } = useSettings()
  const provider = chatProviders.find((p) => p.id === providerId)
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
                    <button
                      onClick={() => void removeModel(m)}
                      className="flex h-4 w-4 items-center justify-center rounded-full text-(--on-surface-muted) opacity-0 transition-opacity hover:bg-(--outline-soft) hover:text-(--danger) group-hover/model:opacity-100"
                      title="删除该自定义模型"
                    >
                      <X size={10} />
                    </button>
                  )}
                  {m.source === 'builtin' && (
                    <>
                      <button
                        onClick={() => setEditingModel(m)}
                        className="flex h-4 w-4 items-center justify-center rounded-full text-(--on-surface-muted) opacity-0 transition-opacity hover:bg-(--outline-soft) hover:text-(--on-surface) group-hover/model:opacity-100"
                        title="编辑（改名 / 上下文 / 最大输出 / 推理）"
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
              ? '自定义模型悬停可删除；内置模型悬停可编辑或隐藏（隐藏后可在下面恢复）'
              : '点「添加模型」录入自定义模型（ID / 上下文 / 图片支持等）；内置模型悬停可编辑或隐藏'}
          </span>
        </div>
      </div>

      <Field label="默认对话模型（新建会话继承；工作区级设置）">
        <select
          value={defaultModel && defaultModel.startsWith(`${providerId}/`) ? defaultModel : ''}
          onChange={(e) => void setDefaultModel(e.target.value || null)}
          className={`${inputCls} cursor-pointer`}
        >
          <option value="">自动（首个有凭据的可用模型）</option>
          {models
            .filter((m) => !m.hidden)
            .map((m) => (
              <option key={m.id} value={`${providerId}/${m.id}`}>
                {m.name}
              </option>
            ))}
        </select>
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

export function ProvidersTab() {
  const { chatProviders, credentialsHint, chatLoaded, defaultModel, refreshChat, customAddProvider } = useSettings()
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
    await refreshChat()
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
