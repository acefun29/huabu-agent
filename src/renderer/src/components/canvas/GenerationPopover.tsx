import { useMemo, useState } from 'react'
import {
  AudioLines,
  Check,
  Cpu,
  FolderOpen,
  Image as ImageIcon,
  Library as LibraryIcon,
  Plus,
  Sparkles,
  Timer,
  Video,
  X,
} from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { useSettings } from '../../store/settingsStore'
import { useEsc } from '../../lib/hooks'
import { assetSrc } from '../../lib/media'
import { KIND_LABEL, type AssetData, type CanvasNode, type GenerateParams, type MediaKind } from '../../types'
import { DEFAULT_MEDIA_DURATION_S, MEDIA_RATIOS, REF_ROLE_LABEL } from '@shared/media'
import { shortModelLabel } from '@shared/mediaResolve'
import { assignRefRoles } from '../../lib/mediaReferenceGraph'
import { activeVersionOf } from '../../lib/mediaReferenceGraph'
import { ChipSelect, MenuGroup, MenuItem, MenuNote } from '../Dropdown'

/**
 * 生成 Popover（直接生成入口，锚定触发卡/划选包围盒/画布光标）。
 * 用户只做三件事：选参考卡（角色由系统按当前模型能力派生）、写提示词、调参数；
 * 提交即冻结 GenerateInputSnapshot —— 引用链在产物落卡时由生成事实自动形成，
 * 这里没有任何建链控件。再次生成（targetNodeId）按激活版本输入预填，就地加版本。
 */

const FALLBACK_DURATIONS = [3, 5, 10, 15]
const PANEL_WIDTH = 372

/** 比例的图形符号：按真实宽高比画一个小方框，比纯文字更快辨认 */
function RatioGlyph({ ratio, size = 14 }: { ratio: string; size?: number }) {
  const [w, h] = ratio.split(':').map(Number)
  const long = Math.max(w, h)
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <span
        className="rounded-[2px] border-[1.5px] border-current"
        style={{ width: (size * w) / long, height: (size * h) / long }}
      />
    </span>
  )
}

/** 模型复合 id（provider:model）去掉供应商前缀（分组标题已经写了供应商） */
function shortModelId(composite: string) {
  const parts = composite.split(':')
  return parts.length > 1 ? parts.slice(1).join(':') : composite
}

const KIND_OPTIONS: MediaKind[] = ['image', 'video', 'audio']

/** 上次直接生成用过的模型（会话内记忆；画布工具栏的模型选择器也写这里） */
let lastModelByKind: Partial<Record<MediaKind, string>> = {}
export function setLastGenModel(kind: MediaKind, model: string | undefined): void {
  if (model) lastModelByKind[kind] = model
  else delete lastModelByKind[kind]
}

export function GenerationPopover() {
  const target = useCanvasStore((s) => s.genComposer)
  const closeGenComposer = useCanvasStore.getState().closeGenComposer
  const view = useCanvasStore((s) => s.view)
  const nodes = useCanvasStore((s) => s.nodes)
  const submitGeneration = useCanvasStore.getState().submitGeneration
  const resolveOutputLibrary = useCanvasStore.getState().resolveOutputLibrary
  const libraries = useCanvasStore((s) => s.libraries)
  const busy = useCanvasStore((s) => {
    const t = s.genComposer?.targetNodeId
    if (!t) return false
    const st = s.jobStates[t]
    return st?.status === 'queued' || st?.status === 'running'
  })
  const { mediaProviders, resolveMediaModel, mediaStatus } = useSettings()

  // 再次生成的目标卡（可能被删除 → 关面板）
  const targetNode = useMemo(
    () => (target?.targetNodeId ? nodes.find((n) => n.id === target.targetNodeId) : undefined),
    [nodes, target?.targetNodeId]
  )
  const regenInputs = targetNode ? activeVersionOf(targetNode)?.inputs : undefined

  const [kind, setKind] = useState<MediaKind>(target?.kind ?? targetNode?.data.kind as MediaKind ?? 'image')
  const [refIds, setRefIds] = useState<string[]>(() => {
    // 预选：打开目标给的参考卡；再次生成则回填当时用的来源卡
    if (target?.refs?.length) return [...new Set(target.refs)]
    if (regenInputs?.refs.length) {
      return [...new Set(regenInputs.refs.filter((r) => r.sourceNodeId).map((r) => r.sourceNodeId as string))]
    }
    return []
  })
  const [prompt, setPrompt] = useState(regenInputs?.prompt ?? '')
  const [params, setParams] = useState<GenerateParams>(() => ({
    ratio: regenInputs?.params.ratio,
    durationSeconds: regenInputs?.params.durationSeconds,
    model: regenInputs?.params.model ?? lastModelByKind[target?.kind ?? 'image'],
    libraryId: regenInputs?.params.libraryId,
  }))
  const [openMenu, setOpenMenu] = useState<null | 'kind' | 'ratio' | 'duration' | 'model' | 'library' | 'picker'>(null)
  const [submitting, setSubmitting] = useState(false)

  useEsc(target !== null, closeGenComposer)

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const refNodes = useMemo(
    () => refIds.map((id) => nodesById.get(id)).filter((n): n is CanvasNode => Boolean(n)),
    [refIds, nodesById]
  )
  const resolvedModel = resolveMediaModel(kind, params.model)
  const modelInfo = resolvedModel
    ? mediaProviders.find((p) => p.id === resolvedModel.provider)?.models.find((m) => m.id === resolvedModel.model)
    : undefined
  const capabilities = modelInfo?.capabilities
  const refCaps = useCanvasStore.getState().mediaCapsFor(kind, params.model)
  /** 参考角色由系统派生（同提交口径），chip 上展示 */
  const assignedRefs = useMemo(
    () => assignRefRoles(target?.targetNodeId ?? 'new', refNodes, kind, refCaps),
    [target?.targetNodeId, refNodes, kind, refCaps]
  )
  const ratioOptions = capabilities?.ratios?.length ? capabilities.ratios : MEDIA_RATIOS
  const durationOptions = capabilities?.durations?.length ? capabilities.durations : FALLBACK_DURATIONS
  const defaultLib = resolveOutputLibrary(kind, params.libraryId)

  /** ＋ 选择器的候选：画布上有文件的媒体卡、不在当前参考里、不是目标卡自己 */
  const pickerCandidates = useMemo(
    () =>
      nodes.filter((n) => {
        const d = n.data
        if (d.kind !== 'image' && d.kind !== 'video' && d.kind !== 'audio') return false
        if (!d.storage || !d.path) return false
        if (refIds.includes(n.id)) return false
        if (n.id === target?.targetNodeId) return false
        return true
      }),
    [nodes, refIds, target?.targetNodeId]
  )

  if (!target) return null
  if (target.targetNodeId && !targetNode) {
    // 目标卡已被删除：面板失去意义
    closeGenComposer()
    return null
  }

  /** 世界坐标 → 屏幕坐标：画布根 rect + 平移 + 缩放（与 CanvasWorkspace 的 transform 同一约定） */
  const rootRect = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect()
  const sx = (rootRect?.left ?? 0) + target.at.x * view.scale + view.x
  const sy = (rootRect?.top ?? 0) + target.at.y * view.scale + view.y
  const estHeight = 340
  const left = Math.min(Math.max(16, sx), Math.max(16, window.innerWidth - PANEL_WIDTH - 16))
  const top = Math.min(Math.max(16, sy), Math.max(16, window.innerHeight - estHeight - 16))

  const patchParams = (patch: Partial<GenerateParams>) => setParams((prev) => ({ ...prev, ...patch }))

  const submit = async () => {
    if (submitting || busy) return
    setSubmitting(true)
    setLastGenModel(kind, params.model)
    let result: { ok: boolean }
    if (target.targetNodeId) {
      // 再次生成目标卡存在且未在途：就地加版本
      result = await submitGeneration({
        kind,
        prompt,
        params,
        refs: refIds,
        targetNodeId: target.targetNodeId,
      })
    } else {
      result = await submitGeneration({ kind, prompt, params, refs: refIds, at: { x: target.at.x, y: target.at.y } })
    }
    setSubmitting(false)
    if (result.ok) closeGenComposer()
  }

  return (
    <>
      {/* 透明背板：点外部关闭（也拦住画布手势，面板打开期间画布静默） */}
      <div
        className="fixed inset-0 z-40"
        data-testid="gen-composer-backdrop"
        onMouseDown={(e) => {
          e.stopPropagation()
          closeGenComposer()
        }}
      />
      <div
        data-testid="gen-composer"
        data-target-node-id={target.targetNodeId ?? ''}
        className="fixed z-50 flex flex-col gap-2 rounded-2xl bg-(--surface-card) p-3 shadow-xl ring-1 ring-(--outline-soft)"
        style={{ left, top: top + 8, width: PANEL_WIDTH }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* 头部：生成类型（再次生成时锁定目标卡的类型） + 关闭 */}
        <div className="flex items-center gap-2">
          {target.targetNodeId ? (
            <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-(--on-surface)">
              再次生成 · {KIND_LABEL[kind]}
              <span className="rounded-full bg-(--surface-chip) px-1.5 py-0.5 text-[10px] font-normal text-(--on-surface-muted)">
                就地加版本
              </span>
            </span>
          ) : (
            <div className="flex items-center gap-0.5 rounded-full bg-(--surface-input) p-0.5">
              {KIND_OPTIONS.map((k) => (
                <button
                  key={k}
                  data-testid="gen-composer-kind"
                  data-kind={k}
                  onClick={() => setKind(k)}
                  className={`flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                    kind === k ? 'bg-(--surface-card) text-(--accent) shadow-sm' : 'text-(--on-surface-variant) hover:text-(--on-surface)'
                  }`}
                >
                  {k === 'image' ? <ImageIcon size={11} /> : k === 'video' ? <Video size={11} /> : <AudioLines size={11} />}
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={closeGenComposer}
            className="ml-auto cursor-pointer rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft)"
            title="关闭（Esc）"
          >
            <X size={13} />
          </button>
        </div>

        {/* 参考卡（角色由系统按当前模型派生；提交时以同口径校验） */}
        <div className="flex flex-wrap items-center gap-1">
          {assignedRefs.map((ref, i) => {
            const source = refNodes.find((n) => n.id === ref.sourceNodeId)
            const sd = source?.data as AssetData | undefined
            const thumb = sd && (sd.kind === 'image' || sd.kind === 'video') ? assetSrc(sd, 96) : null
            return (
              <span
                key={ref.id}
                data-testid="gen-composer-ref"
                data-source-node-id={ref.sourceNodeId}
                className="flex max-w-[190px] items-center gap-1 rounded-full bg-(--active-tint) py-0.5 pl-1 pr-1 text-[10.5px] text-(--accent)"
                title={`${REF_ROLE_LABEL[ref.role]}（角色由系统按当前模型派生）`}
              >
                {thumb ? (
                  <img src={thumb} alt="" draggable={false} className="h-4 w-4 shrink-0 rounded-full object-cover" />
                ) : (
                  sd?.kind === 'video' ? <Video size={11} /> : sd?.kind === 'audio' ? <AudioLines size={11} /> : <ImageIcon size={11} />
                )}
                <span className="min-w-0 shrink truncate">{sd?.name ?? source?.id}</span>
                <span className="shrink-0 rounded bg-(--surface-card)/70 px-1 text-[9.5px]">{REF_ROLE_LABEL[ref.role]}</span>
                <button
                  onClick={() => setRefIds((prev) => prev.filter((_, idx) => idx !== i))}
                  className="shrink-0 cursor-pointer rounded-full p-0.5 transition-colors hover:bg-(--accent) hover:text-white"
                  title="移除这条参考"
                >
                  <X size={10} />
                </button>
              </span>
            )
          })}
          <ChipSelect
            icon={<Plus size={11} />}
            label="参考"
            title="从画布上选择参考卡（角色由系统按当前模型能力派生）"
            open={openMenu === 'picker'}
            onOpenChange={(v) => setOpenMenu(v ? 'picker' : null)}
            minWidth={260}
          >
            {(close) => (
              <>
                <MenuGroup label="画布媒体卡" first />
                {pickerCandidates.length === 0 && <MenuNote>画布上暂时没有可作参考的媒体卡</MenuNote>}
                {pickerCandidates.map((n) => {
                  const thumb = n.data.kind !== 'audio' ? assetSrc(n.data, 96) : null
                  return (
                    <MenuItem
                      key={n.id}
                      icon={
                        thumb ? (
                          <img src={thumb} alt="" className="h-4 w-4 rounded object-cover" draggable={false} />
                        ) : n.data.kind === 'audio' ? (
                          <AudioLines size={12} />
                        ) : (
                          <ImageIcon size={12} />
                        )
                      }
                      label={n.data.name}
                      selected={false}
                      onClick={() => {
                        setRefIds((prev) => (prev.includes(n.id) ? prev : [...prev, n.id]))
                        close()
                      }}
                    />
                  )
                })}
              </>
            )}
          </ChipSelect>
        </div>

        {/* 提示词 */}
        <textarea
          data-testid="gen-composer-prompt"
          rows={3}
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={`描述要生成的${KIND_LABEL[kind]}…（Ctrl+Enter 生成）`}
          className="w-full resize-none rounded-xl bg-(--surface-input) px-2.5 py-2 text-[12px] leading-relaxed text-(--on-surface) outline-none ring-1 ring-(--outline-soft) transition-shadow placeholder:text-(--on-surface-muted) focus:ring-2 focus:ring-(--accent)/50"
        />

        {/* 参数条：比例/时长、模型、落库（复用 ChipSelect） */}
        <div className="flex flex-wrap items-center gap-1">
          {kind === 'image' ? (
            <ChipSelect
              icon={<RatioGlyph ratio={params.ratio ?? '1:1'} size={13} />}
              label={params.ratio ?? '自动'}
              title={params.ratio ? '图片比例' : '比例：自动（跟随参考图/模型默认）'}
              open={openMenu === 'ratio'}
              onOpenChange={(v) => setOpenMenu(v ? 'ratio' : null)}
            >
              {(close) => (
                <>
                  <MenuGroup label="比例" first />
                  <div className="grid grid-cols-2 gap-0.5">
                    {ratioOptions.map((r) => (
                      <MenuItem
                        key={r}
                        icon={<RatioGlyph ratio={r} size={15} />}
                        label={r}
                        selected={params.ratio === r}
                        onClick={() => {
                          patchParams({ ratio: r })
                          close()
                        }}
                      />
                    ))}
                  </div>
                  <MenuItem
                    label="自动（随参考图）"
                    hint="不向模型声明比例"
                    selected={!params.ratio}
                    onClick={() => {
                      patchParams({ ratio: undefined })
                      close()
                    }}
                  />
                </>
              )}
            </ChipSelect>
          ) : (
            <ChipSelect
              icon={<Timer size={11} />}
              label={`${params.durationSeconds ?? mediaStatus?.defaultDuration ?? DEFAULT_MEDIA_DURATION_S}s`}
              title="时长"
              open={openMenu === 'duration'}
              onOpenChange={(v) => setOpenMenu(v ? 'duration' : null)}
              minWidth={120}
            >
              {(close) => (
                <>
                  <MenuGroup label="时长" first />
                  {durationOptions.map((d) => (
                    <MenuItem
                      key={d}
                      label={`${d} 秒`}
                      hint={d >= 10 ? '较慢' : undefined}
                      selected={(params.durationSeconds ?? mediaStatus?.defaultDuration ?? DEFAULT_MEDIA_DURATION_S) === d}
                      onClick={() => {
                        patchParams({ durationSeconds: d })
                        close()
                      }}
                    />
                  ))}
                </>
              )}
            </ChipSelect>
          )}

          <ChipSelect
            icon={<Cpu size={11} />}
            label={params.model ?? `默认 · ${resolvedModel ? `${resolvedModel.provider} · ${shortModelLabel(resolvedModel.provider, resolvedModel.model)}` : '未选择'}`}
            title={`${params.model ? `已指定模型：${params.model}` : '使用设置里的默认模型（未选择时无法生成，去「设置 → 媒体生成」配置）'}${modelInfo?.costHint ? `\n成本：${modelInfo.costHint}` : ''}`}
            overridden={Boolean(params.model)}
            open={openMenu === 'model'}
            onOpenChange={(v) => setOpenMenu(v ? 'model' : null)}
            minWidth={248}
          >
            {(close) => (
              <>
                <MenuGroup label="模型" first />
                <MenuItem
                  icon={<Sparkles size={12} />}
                  label="跟随默认"
                  hint={resolvedModel ? `${resolvedModel.provider} · ${shortModelLabel(resolvedModel.provider, resolvedModel.model)}` : '默认模型未选择'}
                  selected={!params.model}
                  onClick={() => {
                    patchParams({ model: undefined })
                    close()
                  }}
                />
                {mediaProviders
                  .map((p) => ({
                    id: p.id,
                    name: p.label,
                    models: p.models
                      .filter((m) => m.kind === kind)
                      .map((m) => ({ composite: `${p.id}:${m.id}`, label: m.label ?? m.id, costHint: m.costHint })),
                  }))
                  .filter((g) => g.models.length > 0)
                  .map((g) => (
                    <div key={g.id}>
                      <MenuGroup label={g.name} />
                      {g.models.map((m) => (
                        <MenuItem
                          key={m.composite}
                          label={m.label}
                          hint={m.costHint ?? shortModelId(m.composite)}
                          selected={params.model === m.composite}
                          onClick={() => {
                            patchParams({ model: m.composite })
                            close()
                          }}
                        />
                      ))}
                    </div>
                  ))}
              </>
            )}
          </ChipSelect>

          <ChipSelect
            icon={<LibraryIcon size={11} />}
            label={params.libraryId ? (libraries.find((l) => l.id === params.libraryId)?.name ?? '未知库') : (defaultLib?.name ?? '未指定')}
            title={params.libraryId ? '已指定落库位置' : '跟随默认落库'}
            overridden={Boolean(params.libraryId)}
            open={openMenu === 'library'}
            onOpenChange={(v) => setOpenMenu(v ? 'library' : null)}
            minWidth={200}
          >
            {(close) => (
              <>
                <MenuGroup label="产物落库" first />
                <MenuItem
                  icon={<FolderOpen size={12} />}
                  label="跟随默认"
                  hint={defaultLib?.name}
                  selected={!params.libraryId}
                  onClick={() => {
                    patchParams({ libraryId: undefined })
                    close()
                  }}
                />
                {libraries.map((l) => (
                  <MenuItem
                    key={l.id}
                    icon={<LibraryIcon size={12} />}
                    label={l.name}
                    hint={l.builtin ? '按类型归类' : l.isPublic ? '公共' : undefined}
                    selected={params.libraryId === l.id}
                    onClick={() => {
                      patchParams({ libraryId: l.id })
                      close()
                    }}
                  />
                ))}
                <MenuNote>未指定时按「类型默认 → 全局默认 → 公共库 → 画布素材」依次兜底</MenuNote>
              </>
            )}
          </ChipSelect>
        </div>

        {/* 提交 */}
        <div className="flex items-center gap-2 border-t border-(--outline-soft) pt-2">
          <span className="min-w-0 flex-1 text-[10px] leading-snug text-(--on-surface-muted)">
            {refIds.length > 0
              ? `参考 ${refIds.length} 张 · 引用链将在生成完成时自动形成`
              : '无参考，纯文生'}
          </span>
          <button
            data-testid="gen-composer-submit"
            onClick={() => void submit()}
            disabled={submitting || busy || !prompt.trim()}
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-(--fab-bg) px-4 text-[12px] font-medium text-(--fab-text) shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            title={busy ? '该卡片正在生成中' : `生成${KIND_LABEL[kind]}（Ctrl+Enter）`}
          >
            {submitting ? <Check size={13} /> : <Sparkles size={13} />}
            {busy ? '生成中…' : `生成${KIND_LABEL[kind]}`}
          </button>
        </div>
      </div>
    </>
  )
}
