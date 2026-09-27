import { useEffect, useState, type ReactNode } from 'react'
import { Bot, Boxes, Check, CirclePlay, Copy, Moon, Palette, Pencil, PlugZap, Plus, RotateCcw, SlidersHorizontal, Sparkles, Sun, Trash2, Wand2, X } from 'lucide-react'
import { useSettings, useSettingsUi, type McpServer } from '../store/settingsStore'
import { useCanvasStore } from '../store/canvasStore'
import type { ManagedModelInfo, MediaCatalogBrowseItem, MediaProviderType } from '@shared/ipc'
import {
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_MEDIA_DURATION_S,
  DEFAULT_MEDIA_PROVIDER,
  DEFAULT_MEDIA_RATIO,
  MEDIA_RATIOS
} from '@shared/media'
import { matchBareModelId, shortModelLabel } from '@shared/mediaResolve'
import { CHAT_API_LABEL, CHAT_MODEL_APIS, type ChatModelApi } from '@shared/chatApi'
import { MEDIA_ROOT_REL } from '../harness/assetCategories'
import type { MediaKind, MessageAttachment } from '../types'
import { KIND_LABEL } from '../types'
import { buildAgentSystemPrompt, buildReferencePayload } from '../harness/prompt'

type TabKey = 'guide' | 'providers' | 'media' | 'skills' | 'mcp' | 'agent' | 'appearance'

const TABS: { key: TabKey; label: string; icon: ReactNode }[] = [
  { key: 'guide', label: '使用引导', icon: <CirclePlay size={15} /> },
  { key: 'providers', label: '模型供应商', icon: <Boxes size={15} /> },
  { key: 'media', label: '媒体生成', icon: <Wand2 size={15} /> },
  { key: 'skills', label: 'Skills', icon: <Sparkles size={15} /> },
  { key: 'mcp', label: 'MCP', icon: <PlugZap size={15} /> },
  { key: 'agent', label: 'Agent 接入', icon: <Bot size={15} /> },
  { key: 'appearance', label: '外观', icon: <Palette size={15} /> },
]

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-(--accent)' : 'bg-(--toggle-off)'}`}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  )
}

function Row({ title, desc, control }: { title: string; desc?: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-(--on-surface)">{title}</div>
        {desc && <div className="mt-0.5 text-xs leading-relaxed text-(--on-surface-muted)">{desc}</div>}
      </div>
      {control}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--on-surface-variant)">{label}</span>
      {children}
    </label>
  )
}

const inputCls =
  'w-full rounded-lg bg-(--surface-input) px-3 py-1.5 text-[13px] text-(--on-surface) outline-none transition focus:ring-2 focus:ring-(--accent) placeholder:text-(--on-surface-muted)'

/* -------------------------------------------------------------------------- */
/* 使用引导（分步演示入口：面向使用者的操作讲解）                                */
/* -------------------------------------------------------------------------- */

const GESTURES: { gesture: string; desc: string }[] = [
  { gesture: '滚轮', desc: '以鼠标为中心缩放画布' },
  { gesture: '空格 + 拖动 / 中键拖动', desc: '平移画布' },
  { gesture: '左键拖动空白处', desc: '框选卡片（Shift 可追加选择）' },
  { gesture: '双击图片卡片', desc: '放大查看（视频 / 音频为播放）' },
  { gesture: '右键', desc: '看当前对象的全部操作：生成、引用、导入等' },
]

function GuideTab() {
  const openGuide = useCanvasStore.getState().openGuide
  const { closeSettings } = useSettingsUi()
  return (
    <div className="space-y-4" data-testid="guide-tab">
      <p className="text-xs leading-relaxed text-(--on-surface-muted)">
        分步演示会逐块高亮界面并讲解玩法：画布 → 素材卡片 → 批量操作 → 工作区 →
        会话 → 素材库 → 对话 → 设置。演示过程中不影响已有内容，随时按 Esc 退出；
        之后可随时回到这里重看。
      </p>

      <button
        data-testid="start-guide"
        onClick={() => {
          closeSettings()
          openGuide()
        }}
        className="flex items-center gap-2 rounded-full bg-(--fab-bg) px-5 py-2 text-[13px] font-medium text-(--fab-text) transition hover:opacity-90"
      >
        <CirclePlay size={15} />
        开始演示
      </button>

      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="mb-2 text-[13px] font-semibold text-(--on-surface)">画布快捷操作速查</div>
        <div className="divide-y divide-(--outline-soft)">
          {GESTURES.map((g) => (
            <div key={g.gesture} className="flex items-baseline gap-3 py-2">
              <span className="w-44 shrink-0 text-[12px] font-medium text-(--on-surface)">{g.gesture}</span>
              <span className="text-[12px] text-(--on-surface-muted)">{g.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 模型供应商（对话；真实 IPC：凭据加密存储，零密钥过 IPC）                      */
/* -------------------------------------------------------------------------- */

/**
 * 与主进程 chat 覆盖层的 ID 校验（main/models/catalog/merge.ts 的 PROVIDER_ID/MODEL_ID_PATTERN）
 * 大体一致，但这里刻意更宽：允许 `:` 与 `/`（自建模型常写 `网关/模型` 复合 id），大小写
 * 不敏感只为本输入框的容错；主进程侧仍是严格纯 id，最终以主进程校验为准。
 */
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._\-/:]*$/i

/** 上下文窗口紧凑显示：128000 → 128K，65536 → 64K（整除 1024 时按二进制），1000000 → 1M */
function compactTokens(value?: number): string | null {
  if (!value || value <= 0) return null
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`
  }
  if (value % 1024 === 0) return `${value / 1024}K`
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}

/**
 * 协议下拉。选项直接来自 shared/chatApi 的白名单 —— 不在这里再抄一份数组，
 * 否则主进程加第四种协议时这里会静默少一项（与 §2.5 那类"键名对、值不对"同一种错）。
 * allowFollow 时空串=不写模型级 api，跟随供应商。
 */
function ApiSelect({
  value,
  onChange,
  allowFollow = false,
  testId
}: {
  value: ChatModelApi | ''
  onChange: (next: ChatModelApi | '') => void
  allowFollow?: boolean
  testId?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ChatModelApi | '')}
      className={`${inputCls} cursor-pointer`}
      data-testid={testId}
    >
      {allowFollow && <option value="">跟随供应商（缺省）</option>}
      {CHAT_MODEL_APIS.map((api) => (
        <option key={api} value={api}>
          {api} · {CHAT_API_LABEL[api]}
        </option>
      ))}
    </select>
  )
}

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

  // Esc 只关本对话框：捕获阶段拦截，避免冒泡到设置面板把整个设置一起关掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

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

function ProvidersTab() {
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

/* -------------------------------------------------------------------------- */
/* 媒体生成（真实 IPC：workspace.json media 段 + 网关凭据）                     */
/* -------------------------------------------------------------------------- */

/** 新增供应商可用的适配器类型（与主进程注册表对应；新增类型时两处同步） */
const ADAPTER_TYPE_OPTIONS: { value: MediaProviderType; label: string; baseUrlHint?: string }[] = [
  { value: 'gateway-openai-compat', label: 'OpenAI 兼容（图片 / 语音合成）', baseUrlHint: 'https://api.openai.com/v1' },
  { value: 'gateway-fal', label: 'fal.ai 队列网关' },
  { value: 'gateway-dashscope', label: '阿里云百炼（异步任务）' },
  { value: 'gateway-volcark', label: '火山方舟' }
]

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
            <select
              value={agentProviderId}
              onChange={(e) => void updateMediaConfig({ agentProvider: e.target.value })}
              className={`${inputCls} cursor-pointer`}
            >
              {mediaProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
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
                <select
                  value={selectValue}
                  onChange={(e) =>
                    void updateMediaConfig({
                      agentModels: { ...mediaStatus?.agentModels, [kind]: e.target.value },
                    })
                  }
                  className={`${inputCls} cursor-pointer`}
                >
                  <option value="">未指定（用供应商首个同类模型）</option>
                  {mediaModelOptions(kind).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
            )
          })}
          <Field label="新建卡片默认比例">
            <select
              value={mediaStatus?.defaultRatio ?? DEFAULT_MEDIA_RATIO}
              onChange={(e) => void updateMediaConfig({ defaultRatio: e.target.value as (typeof MEDIA_RATIOS)[number] })}
              className={`${inputCls} cursor-pointer`}
            >
              {MEDIA_RATIOS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
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
            <select
              value={defaultLibraryId}
              onChange={(e) =>
                void updateMediaConfig({ defaultLibraryId: e.target.value }).then((error) =>
                  setSaveHint(error ? `保存失败：${error}` : '默认落库已更新，对新生成生效')
                )
              }
              className={`${inputCls} cursor-pointer`}
              data-testid="default-library-select"
            >
              <option value="builtin-assets">画布素材（按类型自动归类）</option>
              {libraries
                .filter((l) => !l.builtin)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.isPublic ? '（公共库）' : ''}
                  </option>
                ))}
              <option value="none">仅产物目录（不进素材库）</option>
            </select>
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
          <select
            value={npType}
            onChange={(e) => setNpType(e.target.value as MediaProviderType)}
            className={`${inputCls} cursor-pointer`}
          >
            {ADAPTER_TYPE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
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
            <select
              value={npModelKind}
              onChange={(e) => setNpModelKind(e.target.value as MediaKind)}
              className="w-24 shrink-0 cursor-pointer rounded-lg bg-(--surface-input) px-2 py-1.5 text-[13px] text-(--on-surface) outline-none transition focus:ring-2 focus:ring-(--accent)"
            >
              <option value="image">图片</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
            </select>
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
            <select
              value={nmKind}
              onChange={(e) => setNmKind(e.target.value as MediaKind)}
              className="cursor-pointer bg-transparent text-[11px] text-(--on-surface-muted) outline-none"
            >
              <option value="image">图片</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
            </select>
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

function MediaTab() {
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

/* -------------------------------------------------------------------------- */
/* Skills / MCP / 外观                                                         */
/* -------------------------------------------------------------------------- */

function SkillsTab() {
  const { skills, toggleSkill } = useSettings()
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-(--on-surface-muted)">
        Skills 为 Agent 提供可复用的工作流能力。工作区级 Skill 从{' '}
        <code className="rounded bg-(--surface-input) px-1">.huabu/skills/</code> 目录加载，仅对当前工作区生效。
        （此页为配置陈列，开关暂不影响运行行为。）
      </p>
      <div className="divide-y divide-(--outline-soft) rounded-2xl bg-(--surface-card) px-4 ring-1 ring-(--outline-soft)">
        {skills.map((s) => (
          <Row
            key={s.id}
            title={s.name}
            desc={s.description}
            control={
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    s.source === 'builtin'
                      ? 'bg-(--surface-chip) text-(--on-surface-variant)'
                      : 'bg-(--success-bg) text-(--success-text)'
                  }`}
                >
                  {s.source === 'builtin' ? '内置' : '工作区'}
                </span>
                <Toggle checked={s.enabled} onChange={() => toggleSkill(s.id)} />
              </div>
            }
          />
        ))}
      </div>
    </div>
  )
}

function McpTab() {
  const { mcpServers, toggleMcp, removeMcp, addMcp } = useSettings()
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')

  const submit = () => {
    if (!name.trim() || !command.trim()) return
    addMcp({ name: name.trim(), command: command.trim(), args: args.trim() } satisfies Omit<McpServer, 'id' | 'enabled'>)
    setName('')
    setCommand('')
    setArgs('')
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-(--on-surface-muted)">
        MCP 服务器经桥接层接入 Agent，工具名自动加前缀{' '}
        <code className="rounded bg-(--surface-input) px-1">mcp_&lt;server&gt;_</code>
        ，写操作默认需确认。配置格式对齐 Claude Desktop。（此页为配置陈列，开关暂不影响运行行为。）
      </p>
      <div className="space-y-2">
        {mcpServers.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-2xl bg-(--surface-card) px-4 py-3 ring-1 ring-(--outline-soft)"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-(--on-surface)">{s.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    s.enabled
                      ? 'bg-(--success-bg) text-(--success-text)'
                      : 'bg-(--surface-input) text-(--on-surface-muted)'
                  }`}
                >
                  {s.enabled ? '已启用' : '未启用'}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-(--on-surface-muted)">
                {s.command} {s.args}
              </div>
            </div>
            <button
              onClick={() => removeMcp(s.id)}
              className="rounded-full p-1.5 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--danger)"
              title="删除"
            >
              <Trash2 size={13} />
            </button>
            <Toggle checked={s.enabled} onChange={() => toggleMcp(s.id)} />
          </div>
        ))}
      </div>
      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="mb-2 text-[13px] font-medium text-(--on-surface)">添加 MCP 服务器</div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="名称">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" className={inputCls} />
          </Field>
          <Field label="命令">
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className={inputCls} />
          </Field>
          <Field label="参数">
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @scope/pkg ." className={inputCls} />
          </Field>
        </div>
        <button
          onClick={submit}
          disabled={!name.trim() || !command.trim()}
          className="mt-3 flex items-center gap-1 rounded-full bg-(--fab-bg) px-3.5 py-1.5 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90 disabled:opacity-30"
        >
          <Plus size={13} />
          添加
        </button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Agent 接入（给后端/Agent 看的契约预览：系统提示词 + 引用载荷）               */
/* -------------------------------------------------------------------------- */

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      data-testid="agent-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          /* 剪贴板不可用时忽略 */
        }
      }}
      className="flex shrink-0 items-center gap-1 rounded-full bg-(--surface-chip) px-2.5 py-1 text-[11px] font-medium text-(--on-surface-variant) transition-colors hover:bg-(--surface-hover)"
      title={`复制${label}`}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}

function AgentTab() {
  const workspace = useCanvasStore((s) => s.workspace)
  const workspaceDir = workspace?.path ?? '<工作区目录>'
  const systemPrompt = buildAgentSystemPrompt(workspaceDir)
  const payloadExample = buildReferencePayload([
    {
      id: 'example-1',
      name: '概念图.png',
      kind: 'image',
      absPath: `${workspaceDir.replace(/\/+$/, '')}/assets/images/概念图.png`,
      origin: 'workspace-asset',
    },
    {
      id: 'example-2',
      name: '需求说明.md',
      kind: 'doc',
      absPath: `${workspaceDir.replace(/\/+$/, '')}/docs/需求说明.md`,
      origin: 'workspace-asset',
    },
  ] satisfies MessageAttachment[])

  return (
    <div className="space-y-4" data-testid="agent-tab">
      <p className="text-xs leading-relaxed text-(--on-surface-muted)">
        这里展示的是渲染端与 Agent 运行时之间的真实契约（非陈列）：会话创建时主进程把下面的系统提示词经 Pi
        的 appendSystemPrompt 注入；引用素材只把绝对路径列表拼进用户消息，文件内容不进上下文，由 Agent
        按路径自行读取。
      </p>

      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-(--on-surface)">系统提示词（自动生成）</div>
            <div className="mt-0.5 text-[11px] text-(--on-surface-muted)">
              由素材分类表生成，随工作区目录注入；源码 src/shared/prompt.ts
            </div>
          </div>
          <CopyButton text={systemPrompt} label="系统提示词" />
        </div>
        <pre
          data-testid="agent-system-prompt"
          className="selectable max-h-72 overflow-auto rounded-xl bg-(--surface-input) p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-(--on-surface-variant)"
        >
          {systemPrompt}
        </pre>
      </div>

      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-(--on-surface)">引用载荷示例（拼在用户消息末尾）</div>
            <div className="mt-0.5 text-[11px] text-(--on-surface-muted)">
              每条一个绝对路径；工作区素材与临时上传（inbox）共用这一格式
            </div>
          </div>
          <CopyButton text={payloadExample} label="载荷示例" />
        </div>
        <pre
          data-testid="agent-payload-example"
          className="selectable max-h-56 overflow-auto rounded-xl bg-(--surface-input) p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-(--on-surface-variant)"
        >
          {payloadExample}
        </pre>
      </div>

      <div className="rounded-2xl bg-(--surface-card) p-4 text-[12px] leading-relaxed text-(--on-surface-muted) ring-1 ring-(--outline-soft)">
        <div className="mb-1 text-[13px] font-semibold text-(--on-surface)">接线对照</div>
        系统提示词注入：src/main/agent/host.ts（DefaultResourceLoader + appendSystemPrompt）·
        载荷拼接：canvasStore.sendMessage → buildReferencePayload ·
        素材分类单一事实来源：src/renderer/src/harness/assetCategories.ts
      </div>
    </div>
  )
}

function AppearanceTab() {
  const { appearance, setAppearance } = useSettings()
  const themes = [
    { key: 'light' as const, label: '浅色', icon: <Sun size={13} /> },
    { key: 'dark' as const, label: '深色', icon: <Moon size={13} /> },
  ]
  return (
    <div className="divide-y divide-(--outline-soft)">
      <div className="py-3">
        <div className="text-[13px] font-medium text-(--on-surface)">主题</div>
        <div className="mt-0.5 text-xs text-(--on-surface-muted)">切换浅色 / 深色界面外观，即时生效并记住选择</div>
        <div className="mt-3 inline-flex rounded-full bg-(--surface-input) p-1">
          {themes.map((t) => (
            <button
              key={t.key}
              onClick={() => setAppearance({ theme: t.key })}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-medium transition ${
                appearance.theme === t.key
                  ? 'bg-(--surface-card) text-(--on-surface) shadow-sm'
                  : 'text-(--on-surface-variant) hover:text-(--on-surface)'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <Row
        title="画布点阵网格"
        desc="在画布背景显示细点阵，关闭后为纯净底色"
        control={<Toggle checked={appearance.showGrid} onChange={(v) => setAppearance({ showGrid: v })} />}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export function SettingsPanel() {
  const { isOpen, closeSettings } = useSettingsUi()
  const [tab, setTab] = useState<TabKey>('providers')

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, closeSettings])

  return (
    <>
      {isOpen && (
        <div
          data-testid="settings-panel"
          onClick={closeSettings}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="ctx-menu flex h-[76vh] w-full max-w-4xl overflow-hidden rounded-[24px] bg-(--surface) shadow-2xl ring-1 ring-(--outline)"
          >
            <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-(--outline-soft) bg-(--glass) p-3 backdrop-blur">
              <div className="mb-2 px-2 text-[11px] font-semibold tracking-wider text-(--on-surface-muted) uppercase">
                设置
              </div>
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors ${
                    tab === t.key
                      ? 'bg-(--surface-chip) text-(--on-surface)'
                      : 'text-(--on-surface-variant) hover:bg-(--outline-soft)'
                  }`}
                >
                  <span className={tab === t.key ? 'text-(--accent)' : 'text-(--on-surface-muted)'}>{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between border-b border-(--outline-soft) px-6 py-4">
                <h2 className="text-[15px] font-semibold text-(--on-surface)">
                  {TABS.find((t) => t.key === tab)?.label}
                </h2>
                <button
                  onClick={closeSettings}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
                >
                  <X size={16} />
                </button>
              </div>
              <div data-scrollable="" className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                {tab === 'guide' && <GuideTab />}
                {tab === 'providers' && <ProvidersTab />}
                {tab === 'media' && <MediaTab />}
                {tab === 'skills' && <SkillsTab />}
                {tab === 'mcp' && <McpTab />}
                {tab === 'agent' && <AgentTab />}
                {tab === 'appearance' && <AppearanceTab />}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
