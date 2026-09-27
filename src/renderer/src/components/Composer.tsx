import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, FolderOpen, MessageSquare, Paperclip, ShieldAlert, SlashSquare, X } from 'lucide-react'
import { ASSET_IDS_MIME, useCanvasStore } from '../store/canvasStore'
import { hasBridge, useSettings } from '../store/settingsStore'
import { THINKING_LEVEL_LABEL, type ChatModelOption, type MediaAccessMode, type ThinkingLevelName } from '@shared/ipc'
import { KIND_LABEL, type AssetData, type CanvasNode } from '../types'
import { filterCommands, isCommandInput } from '../lib/chatCommands'
import { kindIcon } from './AssetNode'

function Chip({
  icon,
  label,
  title,
  onRemove,
  temporary,
  testid,
}: {
  icon: ReactNode
  label: string
  title?: string
  onRemove?: () => void
  /** 临时上传的文件（不进素材库，仅传绝对路径）：虚线边框区分 */
  temporary?: boolean
  testid?: string
}) {
  return (
    <span
      data-testid={testid}
      title={title}
      className={`flex max-w-[180px] items-center gap-1 rounded-full bg-(--surface-chip) py-1 pl-2 pr-1 text-[11px] font-medium text-(--on-surface) transition-colors hover:bg-(--surface-hover) ${
        temporary ? 'border border-dashed border-(--accent)' : ''
      }`}
    >
      <span className="shrink-0 text-(--on-surface-variant)">{icon}</span>
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          onClick={onRemove}
          className="shrink-0 rounded-full p-0.5 text-(--on-surface-variant) transition-colors hover:bg-(--outline)"
          title={temporary ? '移除临时文件（文件仍留在 inbox 目录）' : '移出上下文'}
        >
          <X size={10} />
        </button>
      )}
    </span>
  )
}

/** 档位 → 中文标签（THINKING_LEVELS 之外的值原样显示） */
const levelLabel = (level: string) => THINKING_LEVEL_LABEL[level as ThinkingLevelName] ?? level

/**
 * 底部居中的全局对话输入框（唯一身份：和当前会话对话）。
 * 生成提示词不在此处输入——直接在画布上的生成卡片里写。
 * 选中/拖入文件卡片即作为本轮上下文递给助手（只传绝对路径）；
 * 拖入电脑文件 = 临时引用（存工作区外的 inbox，不进素材库）。
 */
export function Composer() {
  // 精确订阅：chips 用字符串 key 派生（引用稳定，选中集没变不重渲染）；actions 恒定引用
  const workspaceName = useCanvasStore((s) => s.workspace?.name ?? '未选择')
  const activeSession = useCanvasStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null)
  const isChatRunning = useCanvasStore((s) => s.isChatRunning)
  const libraries = useCanvasStore((s) => s.libraries)
  const tempAttachments = useCanvasStore((s) => s.tempAttachments)
  const pendingApprovals = useCanvasStore((s) => s.pendingApprovals)
  // 访问模式锚定在 workspace.json，切工作区后需重拉（settingsStore 的 mediaStatus 只含 config 段，不含 accessMode）
  const workspacePath = useCanvasStore((s) => s.workspace?.path ?? '')
  const chipsKey = useCanvasStore((s) =>
    Array.from(new Set([...s.selectedAssetIds, ...s.injectedAssetIds]))
      .map((id) => {
        const n = s.nodes.find((x) => x.id === id)
        return n ? [id, n.data.name, n.data.kind, n.data.path ?? ''].join('\u0001') : ''
      })
      .join('\u0002')
  )
  const {
    removeTempAttachment,
    removeAssetChip,
    injectAsset,
    dropFilesToComposer,
    importFromLibrary,
    resolveApproval,
    sendMessage,
    runChatCommand,
    setSessionModel,
    setSessionThinking
  } = useCanvasStore.getState()
  const { defaultModel, chatProviders, chatModels } = useSettings()
  const [text, setText] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState<null | 'model' | 'thinking' | 'access'>(null)
  // Agent 媒体访问模式（初始假定完全访问，挂载/切工作区后按主进程实际值回显）
  const [accessMode, setAccessMode] = useState<MediaAccessMode>('full')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const attachRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!attachOpen) return
    const onDown = (e: MouseEvent) => {
      if (attachRef.current && !attachRef.current.contains(e.target as Node)) setAttachOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAttachOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [attachOpen])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // 访问模式当前值：挂载/切工作区时拉一次（切换成功后由 pickAccess 重拉回显）
  useEffect(() => {
    if (!hasBridge()) return
    void window.huabu.settings.mediaStatus().then((r) => {
      if (r.ok) setAccessMode(r.value.accessMode)
    })
  }, [workspacePath])

  // 当前生效模型：会话绑定 → 工作区默认 → 空（发送时主进程按凭据自动选择）
  const currentModel = activeSession?.modelId ?? defaultModel ?? ''
  const currentModelEntry = currentModel ? chatModels.find((m) => m.id === currentModel) : undefined
  const currentLevels = currentModelEntry?.thinkingLevels ?? []
  const currentModelShort = currentModel ? currentModel.split('/').pop() || '自动选择' : '自动选择'
  // 模型菜单按 provider 分组（chatModels 已按认证状态排好，组内保持原顺序）
  const modelGroups = new Map<string, ChatModelOption[]>()
  for (const m of chatModels) {
    const group = modelGroups.get(m.provider)
    if (group) group.push(m)
    else modelGroups.set(m.provider, [m])
  }
  const providerName = (id: string) => chatProviders.find((p) => p.id === id)?.name ?? id

  const chipAssetNodes = chipsKey
    ? chipsKey
        .split('\u0002')
        .filter(Boolean)
        .map((entry) => {
          const [id, name, kind, path] = entry.split('\u0001')
          return { id, data: { name, kind, path } as CanvasNode['data'] } as CanvasNode
        })
    : []

  const autoResize = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }

  const resetHeight = () => {
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto'
    })
  }

  // 斜杠命令：点击建议直接执行；unknown/rejected 保留输入（原因已 toast）
  const executeCommand = (raw: string) => {
    void runChatCommand(raw).then((outcome) => {
      if (outcome === 'ok') {
        setText('')
        resetHeight()
      }
    })
  }

  const submit = () => {
    const t = text.trim()
    if (!t || isChatRunning) return
    // 以 / 开头的一律不发给模型：命中则执行，未命中 toast 提示（防误发字面斜杠文本）
    if (isCommandInput(t)) {
      executeCommand(t)
      return
    }
    void sendMessage(t)
    setText('')
    resetHeight()
  }

  const commandInput = isCommandInput(text)
  const commandMatches = commandInput ? filterCommands(text) : []

  // 菜单条目点击：关菜单后落到 store action（按钮打开时已保证有活动会话）
  const pickModel = (modelId: string) => {
    setMenuOpen(null)
    if (!activeSession) return
    void setSessionModel(activeSession.id, modelId)
  }

  const pickThinking = (level: string) => {
    setMenuOpen(null)
    if (!activeSession) return
    void setSessionThinking(activeSession.id, level)
  }

  // 访问模式切换：以主进程落盘结果回显（成功重拉当前值），失败 toast 原因
  const pickAccess = (mode: MediaAccessMode) => {
    setMenuOpen(null)
    if (!hasBridge()) return
    void window.huabu.media.setAccessMode(mode).then((r) => {
      if (r.ok) {
        void window.huabu.settings.mediaStatus().then((s) => {
          if (s.ok) setAccessMode(s.value.accessMode)
        })
        useCanvasStore
          .getState()
          .showToast(mode === 'confirm' ? '已切换为变更前确认：生成前会弹卡确认' : '已切换为完全访问：生成直接执行')
      } else {
        useCanvasStore.getState().showToast(r.error)
      }
    })
  }

  return (
    <div
      data-testid="composer"
      data-tour="composer"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        // 通道二：OS 文件直接拖进输入框 = 临时引用（asset:import-temp，存工作区外 inbox）
        if (e.dataTransfer.files.length > 0) {
          void dropFilesToComposer(Array.from(e.dataTransfer.files))
          return
        }
        // 画布卡片整批拖入（划选后从任一选中卡片的把手拖出）
        const batch = e.dataTransfer.getData(ASSET_IDS_MIME)
        if (batch) {
          try {
            ;(JSON.parse(batch) as string[]).forEach((id) => injectAsset(id))
          } catch {
            /* 非法载荷忽略 */
          }
          return
        }
        const id = e.dataTransfer.getData('application/x-huabu-asset')
        if (!id) return
        // 拖文件卡片进来 = 递给助手当本轮上下文
        injectAsset(id)
      }}
      className={`pointer-events-auto w-full max-w-3xl rounded-[28px] bg-(--surface-card) p-3 shadow-[0_8px_30px_rgba(0,0,0,0.08)] transition ${
        dragOver ? 'ring-2 ring-(--accent)' : 'ring-1 ring-(--outline)'
      }`}
    >
      {/* 变更前确认（media.accessMode='confirm'）：Agent 生成工具提交前的确认卡 */}
      {pendingApprovals.length > 0 && (
        <div className="mb-2 flex flex-col gap-1.5">
          {pendingApprovals.map((p) => (
            <div
              key={p.requestId}
              data-testid="media-approval"
              className="rounded-2xl border border-(--accent)/40 bg-(--active-tint)/40 px-3 py-2.5"
            >
              <div className="flex items-center gap-2 text-[11px] font-semibold text-(--accent)">
                <ShieldAlert size={13} />
                变更前确认 · {KIND_LABEL[p.kind]}生成
              </div>
              <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-(--on-surface)" title={p.prompt}>
                {p.prompt}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-(--on-surface-muted)">
                {p.model && (
                  <span className="font-mono">
                    {p.provider ?? ''}/{p.model}
                  </span>
                )}
                {p.ratio && <span>比例 {p.ratio}</span>}
                {p.durationSeconds && <span>时长 {p.durationSeconds}s</span>}
                {p.refCount ? <span>参考图 {p.refCount} 张</span> : null}
              </div>
              <div className="mt-2 flex items-center justify-end gap-1.5">
                <button
                  onClick={() => resolveApproval(p.requestId, false)}
                  className="rounded-full border border-(--outline) px-3 py-1 text-[11.5px] transition-colors hover:bg-(--outline-soft)"
                >
                  拒绝
                </button>
                <button
                  data-testid="media-approval-accept"
                  onClick={() => resolveApproval(p.requestId, true)}
                  className="rounded-full bg-(--accent) px-3 py-1 text-[11.5px] font-medium text-white transition hover:brightness-110"
                >
                  接受
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(activeSession || chipAssetNodes.length > 0 || tempAttachments.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
          {activeSession && (
            <Chip icon={<MessageSquare size={11} />} label={activeSession.title} testid="active-chat-chip" />
          )}
          {chipAssetNodes.map((n) => (
            <Chip
              key={n.id}
              icon={kindIcon((n.data as AssetData).kind, 11)}
              label={(n.data as AssetData).name}
              onRemove={() => removeAssetChip(n.id)}
              testid="context-chip"
            />
          ))}
          {tempAttachments.map((a) => (
            <Chip
              key={a.id}
              icon={kindIcon(a.kind, 11)}
              label={`${a.name} · 临时`}
              title={`临时上传（不进素材库）\n${a.absPath}`}
              temporary
              onRemove={() => removeTempAttachment(a.id)}
              testid="temp-chip"
            />
          ))}
        </div>
      )}

      {/* 斜杠命令建议：输入以 / 开头时浮在输入框上方（与素材库菜单同一样式语言） */}
      {commandInput && commandMatches.length > 0 && (
        <div className="relative">
          <div
            data-testid="chat-commands"
            data-scrollable=""
            className="ctx-menu absolute bottom-full left-2 z-30 mb-1 w-[380px] rounded-2xl bg-(--surface-card) p-1.5 shadow-lg ring-1 ring-(--outline)"
          >
            <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--on-surface-muted)">
              <SlashSquare size={11} />
              命令
            </div>
            {commandMatches.map((command) => (
              <button
                key={command.name}
                onClick={() => executeCommand(command.name)}
                className="flex w-full flex-col items-start gap-0.5 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-(--outline-soft)"
              >
                <span className="font-mono text-[12px] font-medium text-(--on-surface)">
                  {command.name}
                  {command.aliases && (
                    <span className="ml-1.5 font-sans text-[10px] font-normal text-(--on-surface-muted)">
                      {command.aliases.join(' ')}
                    </span>
                  )}
                </span>
                <span className="text-[10.5px] leading-relaxed text-(--on-surface-muted)">{command.description}</span>
              </button>
            ))}
            <div className="px-2.5 pb-1 pt-1.5 text-[10px] text-(--on-surface-muted)">
              点击执行，或完整输入后按 Enter
            </div>
          </div>
        </div>
      )}

      <div className="flex items-end gap-1.5">
        <div ref={attachRef} className="relative">
          <button
            onClick={() => setAttachOpen((v) => !v)}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-(--outline-soft) ${
              attachOpen ? 'bg-(--surface-chip) text-(--on-surface)' : 'text-(--on-surface-variant)'
            }`}
            title="从素材库钉入文件引用"
          >
            <Paperclip size={16} />
          </button>
          {attachOpen && (
            <div data-scrollable="" className="ctx-menu absolute bottom-full left-0 z-30 mb-2 max-h-80 w-80 overflow-y-auto rounded-2xl bg-(--surface-card) p-1.5 shadow-lg ring-1 ring-(--outline)">
              <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-(--on-surface-muted)">
                <FolderOpen size={11} />
                素材库 · 工作区内文件
              </div>
              {libraries.map((lib) => (
                <div key={lib.id}>
                  <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-medium text-(--on-surface-variant)">
                    {lib.name}
                    {lib.isPublic && (
                      <span className="rounded-full bg-(--surface-chip) px-1.5 py-0.5 text-[9px] font-medium text-(--accent)">公共</span>
                    )}
                    <span className="ml-auto truncate font-mono text-[9.5px] font-normal text-(--on-surface-muted)">{lib.path}</span>
                  </div>
                  {lib.files.length === 0 && (
                    <div className="px-2.5 py-1 text-[10.5px] text-(--on-surface-muted)">暂无文件</div>
                  )}
                  {lib.files.map((f) => (
                    <button
                      key={f.relPath}
                      onClick={() => {
                        importFromLibrary(lib.id, f)
                        setAttachOpen(false)
                      }}
                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-(--outline-soft)"
                    >
                      <span className="shrink-0 text-(--on-surface-variant)">{kindIcon(f.kind, 12)}</span>
                      <span className="truncate text-[12px] text-(--on-surface)">{f.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-(--on-surface-muted)">{f.relPath}</span>
                    </button>
                  ))}
                </div>
              ))}
              <div className="px-2.5 pb-1 pt-1.5 text-[10px] text-(--on-surface-muted)">
                钉引用 = 在画布上放一个指向真实文件的引用卡片，不复制文件
              </div>
            </div>
          )}
        </div>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            autoResize()
          }}
          onKeyDown={(e) => {
            // 输入法组词过程中的回车不触发发送
            const sendByEnter = e.key === 'Enter' && !e.shiftKey
            if (sendByEnter && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="向 Agent 描述你的需求；选中画布资源、拖入文件（临时引用）即作为上下文…"
          className="max-h-36 flex-1 resize-none bg-transparent py-1.5 text-[13px] leading-relaxed outline-none placeholder:text-(--on-surface-muted)"
        />
        <button
          data-testid="composer-submit"
          onClick={submit}
          disabled={!text.trim() || isChatRunning}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--fab-bg) text-(--fab-text) shadow-sm transition hover:opacity-90 disabled:opacity-30"
          title={isChatRunning ? '生成中…' : '发送'}
        >
          <ArrowUp size={15} strokeWidth={2.5} />
        </button>
      </div>

      <div className="flex items-center justify-between px-1 pt-1.5 text-[10.5px] text-(--on-surface-muted)">
        <div className="flex min-w-0 items-center gap-1">
          <span data-testid="composer-status" className="min-w-0 truncate" title={`工作区: ${workspaceName}`}>
            会话: {activeSession ? activeSession.title : '（发送时自动新建）'} · 工作区: {workspaceName}
          </span>
          <div ref={menuRef} className="relative flex shrink-0 items-center">
            <button
              onClick={() => {
                if (!activeSession) {
                  useCanvasStore.getState().showToast('发送后自动新建会话，届时可再切换')
                  return
                }
                setMenuOpen((v) => (v === 'model' ? null : 'model'))
              }}
              className={`flex items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 transition-colors hover:bg-(--outline-soft) ${
                menuOpen === 'model' ? 'bg-(--surface-chip) text-(--on-surface)' : ''
              }`}
              title="切换会话模型（已建会话即时生效）"
            >
              模型: {currentModelShort}
              <ChevronDown size={10} />
            </button>
            {currentModelEntry && (
              <button
                onClick={() => {
                  if (!activeSession) {
                    useCanvasStore.getState().showToast('发送后自动新建会话，届时可再切换')
                    return
                  }
                  setMenuOpen((v) => (v === 'thinking' ? null : 'thinking'))
                }}
                disabled={currentLevels.length === 0}
                className={`flex items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 transition-colors hover:bg-(--outline-soft) disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:opacity-40 ${
                  menuOpen === 'thinking' ? 'bg-(--surface-chip) text-(--on-surface)' : ''
                }`}
                title={currentLevels.length === 0 ? '该模型不支持思考档位' : '设置思考档位'}
              >
                思考: {activeSession?.thinkingLevel ? levelLabel(activeSession.thinkingLevel) : '默认'}
                <ChevronDown size={10} />
              </button>
            )}
            <button
              onClick={() => setMenuOpen((v) => (v === 'access' ? null : 'access'))}
              className={`flex items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 transition-colors hover:bg-(--outline-soft) ${
                menuOpen === 'access' ? 'bg-(--surface-chip) text-(--on-surface)' : ''
              }`}
              title="Agent 媒体访问模式：完全访问 = 生成直接执行；变更前确认 = 每次生成前弹卡，接受后才执行"
            >
              访问: {accessMode === 'confirm' ? '变更前确认' : '完全访问'}
              <ChevronDown size={10} />
            </button>
            {menuOpen === 'model' && (
              <div
                data-scrollable=""
                className="ctx-menu absolute bottom-full left-0 z-30 mb-1 max-h-80 w-72 overflow-y-auto rounded-2xl bg-(--surface-card) p-1.5 shadow-lg ring-1 ring-(--outline)"
              >
                {Array.from(modelGroups.entries()).map(([provider, models]) => (
                  <div key={provider}>
                    <div className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-medium text-(--on-surface-variant)">
                      {providerName(provider)}
                    </div>
                    {models.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => pickModel(m.id)}
                        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-(--outline-soft)"
                      >
                        <span
                          className={`truncate text-[12px] ${
                            m.authConfigured ? 'text-(--on-surface)' : 'text-(--on-surface-muted)'
                          }`}
                        >
                          {m.model}
                        </span>
                        {!m.authConfigured && (
                          <span className="ml-auto shrink-0 text-[9.5px] text-(--on-surface-muted)">未配置 Key</span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
                {modelGroups.size === 0 && (
                  <div className="px-2.5 py-1.5 text-[10.5px]">暂无可用模型（先在设置里配置对话供应商）</div>
                )}
              </div>
            )}
            {menuOpen === 'thinking' && (
              <div className="ctx-menu absolute bottom-full left-0 z-30 mb-1 w-40 rounded-2xl bg-(--surface-card) p-1.5 shadow-lg ring-1 ring-(--outline)">
                {currentLevels.map((level) => (
                  <button
                    key={level}
                    onClick={() => pickThinking(level)}
                    className={`flex w-full items-center rounded-xl px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-(--outline-soft) ${
                      level === activeSession?.thinkingLevel
                        ? 'bg-(--surface-chip) text-(--on-surface)'
                        : 'text-(--on-surface)'
                    }`}
                  >
                    {levelLabel(level)}
                  </button>
                ))}
              </div>
            )}
            {menuOpen === 'access' && (
              <div className="ctx-menu absolute bottom-full left-0 z-30 mb-1 w-52 rounded-2xl bg-(--surface-card) p-1.5 shadow-lg ring-1 ring-(--outline)">
                <button
                  onClick={() => pickAccess('full')}
                  className={`flex w-full items-center rounded-xl px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-(--outline-soft) ${
                    accessMode === 'full' ? 'bg-(--surface-chip) text-(--on-surface)' : 'text-(--on-surface)'
                  }`}
                >
                  完全访问 · 生成直接执行
                </button>
                <button
                  onClick={() => pickAccess('confirm')}
                  className={`flex w-full items-center rounded-xl px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-(--outline-soft) ${
                    accessMode === 'confirm' ? 'bg-(--surface-chip) text-(--on-surface)' : 'text-(--on-surface)'
                  }`}
                >
                  变更前确认 · 生成前需确认
                </button>
              </div>
            )}
          </div>
        </div>
        <span className="shrink-0">Enter 发送 · Shift+Enter 换行 · / 命令 · 引用只传绝对路径</span>
      </div>
    </div>
  )
}
