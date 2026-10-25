import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  AudioLines,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Image as ImageIcon,
  Loader2,
  Video,
  X,
} from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { LEGACY_ASSET_MIME } from '../../store/canvas/shared'
import { parseLegacyAssetPayload } from '../../lib/dragPayload'
import { assetSrc } from '../../lib/media'
import {
  MEDIA_REF_ROLES,
  MEDIA_ROLE_KIND,
  REF_ROLE_LABEL,
} from '@shared/media'
import type { MediaRefRole, ResolvedRefCaps } from '@shared/media'
import type {
  AssetData,
  AssetGen,
  AssetKind,
  CanvasNode,
  GenerateReference,
  GenerateVersion,
  MediaKind,
} from '../../types'
import { getGenerateReferences, getReferenceUpdateState } from '../../lib/mediaReferenceGraph'
import { ChipSelect, MenuGroup, MenuNote } from '../Dropdown'
import { MEDIA_REFERENCE_MIME } from './MediaConnectionHandle'

/**
 * 参考素材输入区（生成卡控制台内）：能力驱动的命名角色槽位 + 引用条目管理 +
 * 引用新鲜度提示 + 生成链控件 + 版本详情回放。
 * 读写走 store 的 addGenerateRef / setGenerateRefRole / moveGenerateRef /
 * removeGenerateRef / runGenerationChain / cancelGeneration；
 * 单值槽占用后新拖入 = store 替换 + Toast 撤销，UI 只负责投递，不做自己的替换逻辑。
 */

/** 参考连接通道 drop 载荷解析（新 MIME 优先，旧 LEGACY 通道兜底）；未命中返回 null */
export function parseReferencePayload(dt: DataTransfer): string | null {
  const raw = dt.getData(MEDIA_REFERENCE_MIME) || parseLegacyAssetPayload(dt)
  return raw && raw.trim() ? raw : null
}

/** dragover 阶段只读 types 判通道（HTML5 此刻 getData 恒为空串） */
export function hasReferenceDrag(types: readonly string[]): boolean {
  return types.includes(MEDIA_REFERENCE_MIME) || types.includes(LEGACY_ASSET_MIME)
}

/** 把来源卡片滚进视口中央并激活：生成卡走 activeGenerate，普通卡确保选中 */
export function locateSourceCard(sourceId: string): void {
  const s = useCanvasStore.getState()
  const target = s.nodesById.get(sourceId)
  if (!target) return
  const root = document.querySelector('[data-testid="canvas"]')
  const rect = root?.getBoundingClientRect()
  const scale = s.view.scale
  s.setView({
    x: (rect ? rect.width : window.innerWidth) / 2 - (target.x + target.width / 2) * scale,
    y: (rect ? rect.height : window.innerHeight) / 2 - (target.y + target.height / 2) * scale,
  })
  if (target.data.gen) s.setActiveGenerate(sourceId)
  else if (!s.selectedAssetIds.includes(sourceId)) s.toggleAssetSelected(sourceId)
}

function sourceIcon(kind: AssetKind, size = 11) {
  if (kind === 'image') return <ImageIcon size={size} />
  if (kind === 'video') return <Video size={size} />
  if (kind === 'audio') return <AudioLines size={size} />
  return <FileText size={size} />
}

/** 某素材大类在该模型配额里能担当的角色（保持官方枚举顺序） */
function rolesForAssetKind(assetKind: MediaKind, refCaps: ResolvedRefCaps): MediaRefRole[] {
  return MEDIA_REF_ROLES.filter(
    (role) => MEDIA_ROLE_KIND[role] === assetKind && (refCaps.quota[role] ?? 0) > 0
  )
}

/** 模型不支持时的原因文案（角色选择器禁用项与失效区共用） */
function roleUnavailableReason(role: MediaRefRole, refCaps: ResolvedRefCaps): string | undefined {
  return (refCaps.quota[role] ?? 0) > 0 ? undefined : '当前生成模型不支持该角色'
}

/**
 * 单条引用 chip：缩略图/名称 + 显式角色选择（替代旧的循环点击）+ 移除 + 上下移。
 * key 用 referenceId 而不是 sourceId：同一来源可以以不同角色各挂一条，互不覆盖。
 */
function ReferenceChip({
  nodeId,
  ref: reference,
  source,
  total,
  refCaps,
}: {
  nodeId: string
  ref: GenerateReference
  source: CanvasNode | null
  total: number
  refCaps: ResolvedRefCaps
}) {
  const { setGenerateRefRole, removeGenerateRef, moveGenerateRef } = useCanvasStore.getState()
  const [roleMenuOpen, setRoleMenuOpen] = useState(false)
  const sourceData = source?.data as AssetData | undefined
  const sourceKind = sourceData?.kind
  const thumb =
    sourceData && (sourceData.kind === 'image' || sourceData.kind === 'video')
      ? assetSrc(sourceData, 96)
      : null
  const supported = (refCaps.quota[reference.role] ?? 0) > 0
  /** 角色候选 = 该来源素材大类在官方枚举里的全部角色；当前模型不支持的项禁用并给原因 */
  const candidates: MediaRefRole[] = sourceKind
    ? MEDIA_REF_ROLES.filter((role) => MEDIA_ROLE_KIND[role] === sourceKind)
    : []

  return (
    <span
      data-testid="reference-item"
      data-reference-id={reference.id}
      data-source-node-id={reference.sourceNodeId}
      className={`flex max-w-[190px] items-center gap-1 rounded-full py-0.5 pl-1 pr-1 text-[10.5px] ${
        supported
          ? 'bg-(--active-tint) text-(--accent)'
          : 'bg-(--surface-input) text-(--danger) ring-1 ring-(--danger)/30'
      }`}
      title={
        supported
          ? `${REF_ROLE_LABEL[reference.role]} · 点击名称定位来源卡片`
          : `${REF_ROLE_LABEL[reference.role]}：${roleUnavailableReason(reference.role, refCaps) ?? '不可用'}（换模型后旧角色保留并标红，不会进请求）`
      }
    >
      {source && thumb ? (
        <img src={thumb} alt="" draggable={false} className="h-4 w-4 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="flex shrink-0 items-center opacity-80">
          {source ? sourceIcon(sourceData!.kind) : <AlertTriangle size={11} />}
        </span>
      )}
      {source ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            locateSourceCard(reference.sourceNodeId)
          }}
          className="min-w-0 shrink cursor-pointer truncate transition-colors hover:underline"
          title="定位并选中来源卡片"
        >
          {sourceData?.name ?? source.id}
        </button>
      ) : (
        <span className="min-w-0 shrink truncate">来源已删除</span>
      )}
      <span data-testid="reference-role-select" data-reference-id={reference.id} className="flex shrink-0 items-center">
        <ChipSelect
          label={REF_ROLE_LABEL[reference.role]}
          title={supported ? '选择这条参考的角色' : roleUnavailableReason(reference.role, refCaps)}
          open={roleMenuOpen}
          onOpenChange={setRoleMenuOpen}
          minWidth={150}
          disabled={!source}
        >
          {(close) => (
            <>
              <MenuGroup label="参考角色" first />
              {candidates.map((role) => {
                const reason = roleUnavailableReason(role, refCaps)
                return (
                  <button
                    key={role}
                    type="button"
                    data-testid="reference-role-option"
                    data-role={role}
                    disabled={Boolean(reason)}
                    onClick={() => {
                      setGenerateRefRole(nodeId, reference.id, role)
                      close()
                    }}
                    title={reason}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      role === reference.role
                        ? 'bg-(--active-tint) font-medium text-(--accent)'
                        : 'text-(--on-surface) hover:bg-(--outline-soft)'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{REF_ROLE_LABEL[role]}</span>
                    {reason && <span className="shrink-0 text-[10px] text-(--on-surface-muted)">不支持</span>}
                    {role === reference.role && <Check size={12} strokeWidth={3} className="shrink-0 text-(--accent)" />}
                  </button>
                )
              })}
              <MenuNote>角色按当前生成模型的能力给出；不支持的项会标灰并说明原因</MenuNote>
            </>
          )}
        </ChipSelect>
      </span>
      {total > 1 && (
        <span className="flex shrink-0 flex-col leading-none">
          <button
            data-testid="reference-move-up"
            onClick={(e) => {
              e.stopPropagation()
              moveGenerateRef(nodeId, reference.id, -1)
            }}
            className="rounded-sm p-px transition-colors hover:bg-(--accent) hover:text-white"
            title="上移（影响角色派生顺序）"
          >
            <ChevronUp size={9} />
          </button>
          <button
            data-testid="reference-move-down"
            onClick={(e) => {
              e.stopPropagation()
              moveGenerateRef(nodeId, reference.id, 1)
            }}
            className="rounded-sm p-px transition-colors hover:bg-(--accent) hover:text-white"
            title="下移"
          >
            <ChevronDown size={9} />
          </button>
        </span>
      )}
      <button
        data-testid="reference-remove"
        onClick={(e) => {
          e.stopPropagation()
          removeGenerateRef(nodeId, reference.id)
        }}
        className="shrink-0 cursor-pointer rounded-full p-0.5 transition-colors hover:bg-(--accent) hover:text-white"
        title="移除参考"
      >
        <X size={10} />
      </button>
    </span>
  )
}

/**
 * 生成链控件：「运行到此」+ 本卡在链中的状态 + 取消。
 * runGenerationChain 内部自带范围确认，这里不再弹二次确认；链活跃时禁用入口防误触重跑。
 * 链终态（succeeded/failed/cancelled）后不再显示「等待/运行」——等待下游与被中断的
 * 当前卡回归安静，只有真正完成的卡保留「链已完成」（失败/取消的详情由 Toast 与卡片自身状态呈现）。
 */
export function ChainControls({ nodeId, prompt, busy }: { nodeId: string; prompt: string; busy: boolean }) {
  const chainState = useCanvasStore((s) => {
    const c = s.chainRun
    if (!c || !c.nodeIds.includes(nodeId)) return 'idle' as const
    if (c.status !== 'running') {
      return c.completedNodeIds.includes(nodeId) ? ('done' as const) : ('idle' as const)
    }
    if (c.completedNodeIds.includes(nodeId)) return 'done' as const
    if (c.currentNodeId === nodeId) return 'running' as const
    return 'waiting' as const
  })
  const chainActive = useCanvasStore((s) => s.chainRun?.status === 'running')
  const { runGenerationChain, cancelGeneration } = useCanvasStore.getState()
  /** 本卡在活跃链上（正在跑或等待轮到）：取消按钮取消的是整条链 */
  const chainHoldsMe = chainState === 'running' || chainState === 'waiting'

  const stateLabel =
    chainState === 'waiting'
      ? '链等待中'
      : chainState === 'running'
        ? '链运行中'
        : '链已完成'
  const stateCls =
    chainState === 'running'
      ? 'bg-(--active-tint) text-(--accent)'
      : chainState === 'done'
        ? 'bg-(--success-bg) text-(--success-text)'
        : 'bg-(--surface-chip) text-(--on-surface-variant)'

  return (
    <span className="flex items-center gap-1">
      {chainState !== 'idle' && (
        <span data-testid="chain-status" data-state={chainState} className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${stateCls}`}>
          {chainState === 'running' && <Loader2 size={10} className="animate-spin" />}
          {stateLabel}
        </span>
      )}
      <button
        data-testid="run-chain"
        onClick={(e) => {
          e.stopPropagation()
          void runGenerationChain(nodeId, prompt.trim() || undefined)
        }}
        disabled={busy || chainActive}
        title="按依赖顺序先运行本卡参考所指的上游生成卡，最后生成本卡（运行前列出涉及卡片；链运行期间此入口停用）"
        className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-(--surface-chip) px-1.5 text-[10.5px] text-(--on-surface-variant) transition-colors hover:bg-(--surface-hover) disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronDown size={11} />
        运行到此
      </button>
      {(busy || chainHoldsMe) && (
        <button
          data-testid="cancel-generation"
          onClick={(e) => {
            e.stopPropagation()
            void cancelGeneration(nodeId)
          }}
          title={chainHoldsMe ? '取消本卡所在的生成链（已完成的产物保留，后续卡不再执行）' : '取消本卡的生成任务'}
          className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-(--surface-chip) px-1.5 text-[10.5px] text-(--danger) transition-colors hover:bg-(--surface-hover)"
        >
          <X size={11} />
          取消
        </button>
      )}
    </span>
  )
}

/** 版本详情：回放该版本生成时的真实输入（prompt/model/params/引用来源）；老版本如实说明缺什么 */
export function VersionDetailPanel({ version }: { version: GenerateVersion }) {
  const inputs = version.inputs
  if (!inputs) {
    // 老版本：版本自身仍存了当时的 prompt/model，如实展示；参数与参考快照确实没记录
    return (
      <div
        data-testid="version-detail-panel"
        className="flex flex-col gap-1 px-3 py-1.5 text-[10.5px] leading-relaxed"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-(--on-surface-muted)">提示词（该版本实际使用）</div>
        <div className="line-clamp-3 whitespace-pre-wrap break-all text-(--on-surface)">{version.prompt || '（空）'}</div>
        <div className="text-(--on-surface-variant)">
          模型：
          <span className="font-mono">{version.model ?? '默认回退链'}</span>
        </div>
        <div className="text-(--on-surface-muted)">
          该版本生成于输入快照功能之前：当时已保存提示词与模型（见上），但参数与参考素材快照未记录，无法回放完整输入，也无法比对引用是否变化。
        </div>
      </div>
    )
  }
  return (
    <div
      data-testid="version-detail-panel"
      className="flex flex-col gap-1 px-3 py-1.5 text-[10.5px] leading-relaxed"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="text-(--on-surface-muted)">提示词（该版本实际使用）</div>
      <div className="line-clamp-3 whitespace-pre-wrap break-all text-(--on-surface)">{inputs.prompt || '（空）'}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-(--on-surface-variant)">
        <span>
          模型：
          <span className="font-mono">
            {inputs.model ? `${inputs.provider ? `${inputs.provider}:` : ''}${inputs.model}` : '默认回退链'}
          </span>
        </span>
        {inputs.params?.ratio && <span>比例 {inputs.params.ratio}</span>}
        {inputs.params?.durationSeconds != null && <span>时长 {inputs.params.durationSeconds}s</span>}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-(--on-surface-muted)">参考素材（{inputs.refs.length}）</span>
        {inputs.refs.length === 0 && <span className="text-(--on-surface-muted)">无参考，纯文生</span>}
        {inputs.refs.map((r, i) => (
          <span key={`${r.referenceId}-${i}`} className="flex min-w-0 items-center gap-1 text-(--on-surface-variant)">
            <span className="shrink-0 rounded bg-(--active-tint) px-1 text-[9.5px] text-(--accent)">{REF_ROLE_LABEL[r.role]}</span>
            <span className="min-w-0 truncate" title={r.path}>
              {r.sourceName}
            </span>
            {r.sourceVersionId && <span className="shrink-0 text-[9.5px] text-(--on-surface-muted)">（指定来源产物版本）</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * 角色槽位 + 引用条目 + 新鲜度提示 + 整卡 drop 的多角色选择菜单。
 * 每个槽位是独立 drop 目标（data-reference-role 供连线锚点与 GUI 测试定位）；
 * 槽内 drop 直接以该角色添加，即使单值槽已被占用（替换与撤销由 store 运行时处理）。
 */
export function MediaReferenceInputs({
  node,
  gen,
  refCaps,
  pendingSourceId,
  onClearPending,
}: {
  node: CanvasNode
  gen: AssetGen
  refCaps: ResolvedRefCaps
  /** 整卡 drop 命中多合法角色时挂起待选的来源 id（角色选择菜单展示用） */
  pendingSourceId: string | null
  onClearPending: () => void
}) {
  const nodes = useCanvasStore((s) => s.nodes)
  const addGenerateRef = useCanvasStore.getState().addGenerateRef
  const [dropRole, setDropRole] = useState<MediaRefRole | null>(null)

  /** 权威引用列表（references 优先，旧 refs/refRoles 兼容；角色派生吃同一份 caps） */
  const refs = useMemo(() => getGenerateReferences(node, nodes, refCaps), [node, nodes, refCaps])
  /** 引用新鲜度：与最近一次已记录输入对比（unknown = 旧历史未记录） */
  const updateState = useMemo(() => getReferenceUpdateState(node, nodes), [node, nodes])
  /** 「上次生成未记录」只在确有生成历史（存在版本）但缺输入快照时提示；新空卡不打扰 */
  const hasGenHistory = (node.data.gen?.versions.length ?? 0) > 0
  const showUpdateHint =
    updateState === 'missing' || updateState === 'changed' || (updateState === 'unknown' && hasGenHistory)
  const sourceById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const validRefs = refs.filter((r) => (refCaps.quota[r.role] ?? 0) > 0)
  const unsupportedRefs = refs.filter((r) => (refCaps.quota[r.role] ?? 0) <= 0)
  /** 官方枚举顺序里、当前模型声明了配额的角色 → 槽位 */
  const slots = MEDIA_REF_ROLES.filter((role) => (refCaps.quota[role] ?? 0) > 0)

  const dropToRole = (role: MediaRefRole) => (e: React.DragEvent) => {
    if (!hasReferenceDrag(e.dataTransfer.types)) return
    e.preventDefault()
    e.stopPropagation()
    setDropRole(null)
    const src = parseReferencePayload(e.dataTransfer)
    if (src && src !== node.id) addGenerateRef(node.id, src, role)
  }
  const overRole = (role: MediaRefRole) => (e: React.DragEvent) => {
    if (!hasReferenceDrag(e.dataTransfer.types)) return
    e.preventDefault()
    e.stopPropagation()
    setDropRole(role)
  }

  /** 整卡 drop 挂起的多角色选择：候选 = 来源素材大类 × 当前模型配额 */
  const pendingSource = pendingSourceId ? sourceById.get(pendingSourceId) : undefined
  const pendingKind = pendingSource ? (pendingSource.data.kind as MediaKind) : undefined
  const pendingRoles = pendingKind ? rolesForAssetKind(pendingKind, refCaps) : []

  return (
    <div className="mb-1.5 flex flex-col gap-1" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      {pendingSource && pendingRoles.length > 0 && (
        <div
          data-testid="reference-role-menu"
          className="flex flex-wrap items-center gap-1 rounded-lg bg-(--active-tint) px-2 py-1.5 ring-1 ring-(--accent)/30"
        >
          <span className="text-[10.5px] text-(--on-surface-variant)">「{(pendingSource.data as AssetData).name}」可作为：</span>
          {pendingRoles.map((role) => (
            <button
              key={role}
              data-testid="reference-role-option"
              data-role={role}
              onClick={() => {
                addGenerateRef(node.id, pendingSourceId!, role)
                onClearPending()
              }}
              className="cursor-pointer rounded-full bg-(--surface-card) px-2 py-0.5 text-[10.5px] ring-1 ring-(--accent)/30 transition-colors hover:bg-(--accent) hover:text-white"
            >
              {REF_ROLE_LABEL[role]}
            </button>
          ))}
          <button
            data-testid="reference-role-dismiss"
            onClick={onClearPending}
            className="ml-auto cursor-pointer rounded-full p-0.5 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft)"
            title="取消本次添加"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {showUpdateHint && (
        <div
          data-testid="reference-update-hint"
          data-state={updateState}
          className={`flex items-center gap-1 text-[10.5px] leading-snug ${
            updateState === 'missing' ? 'text-(--danger)' : 'text-(--accent)'
          }`}
          title={
            updateState === 'changed'
              ? '引用素材在生成后有更新，结果可能已过时；点击下方来源名可查看，是否重跑由你决定（不会自动重跑）'
              : updateState === 'missing'
                ? '有引用来源卡片已被删除；下方保留占位，可移除或重新拖入修复'
                : '最近一次生成未记录引用输入（旧版本产物），无法比对引用是否变化'
          }
        >
          <AlertTriangle size={11} className="shrink-0" />
          {updateState === 'changed'
            ? '引用素材有更新，结果可能已过时'
            : updateState === 'missing'
              ? '引用失效：有来源卡片已被删除'
              : '上次生成未记录引用输入，无法比对变化'}
        </div>
      )}

      {slots.map((role) => {
        const groupRefs = validRefs.filter((r) => r.role === role)
        const max = refCaps.quota[role] ?? 0
        return (
          <div
            key={role}
            data-testid="reference-slot"
            data-reference-role={role}
            data-slot-count={max}
            onDragOver={overRole(role)}
            onDragLeave={() => setDropRole((cur) => (cur === role ? null : cur))}
            onDrop={dropToRole(role)}
            className={`flex flex-wrap items-center gap-1 rounded-lg px-1.5 py-1 transition-shadow ${
              dropRole === role
                ? 'bg-(--active-tint) ring-2 ring-(--accent)'
                : 'bg-(--surface-input) ring-1 ring-(--outline-soft)'
            }`}
          >
            <span className="shrink-0 text-[10px] font-medium text-(--on-surface-muted)" title={`该模型最多 ${max} 条${REF_ROLE_LABEL[role]}参考`}>
              {REF_ROLE_LABEL[role]}
            </span>
            {groupRefs.map((r) => (
              <ReferenceChip
                key={r.id}
                nodeId={node.id}
                ref={r}
                source={sourceById.get(r.sourceNodeId) ?? null}
                total={refs.length}
                refCaps={refCaps}
              />
            ))}
            {groupRefs.length < max && (
              <span className="rounded-full border border-dashed border-(--outline) px-1.5 py-0.5 text-[10px] text-(--on-surface-muted)" title={`把素材卡片拖到这里，作为${REF_ROLE_LABEL[role]}`}>
                {groupRefs.length === 0 ? '空 · 拖入素材' : `还可加 ${max - groupRefs.length}`}
              </span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-(--on-surface-muted)">
              {groupRefs.length}/{max}
            </span>
          </div>
        )
      })}

      {unsupportedRefs.length > 0 && (
        <div
          data-testid="reference-slot"
          data-reference-role={unsupportedRefs[0].role}
          data-slot-state="unsupported"
          className="flex flex-wrap items-center gap-1 rounded-lg bg-(--surface-input) px-1.5 py-1 ring-1 ring-(--danger)/30"
        >
          <span
            className="shrink-0 text-[10px] font-medium text-(--danger)"
            title="这些参考的角色当前模型不接受（可能来自换模型前的配置）；保留在此便于换回模型或手动改角色"
          >
            用不到
          </span>
          {unsupportedRefs.map((r) => (
            <ReferenceChip
              key={r.id}
              nodeId={node.id}
              ref={r}
              source={sourceById.get(r.sourceNodeId) ?? null}
              total={refs.length}
              refCaps={refCaps}
            />
          ))}
          {refCaps.total === 0 && (
            <span className="text-[10px] text-(--on-surface-muted)">当前模型不支持任何参考输入</span>
          )}
        </div>
      )}

      {/* 处置留痕（主进程编排逐条判定后随任务带回） */}
      {gen.notes && gen.notes.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {gen.notes.map((n) => (
            <div key={n} className="line-clamp-2 text-[10.5px] leading-snug text-(--danger)" title={n}>
              · {n}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
