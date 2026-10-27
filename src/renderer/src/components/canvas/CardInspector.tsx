import { useMemo } from 'react'
import { ArrowRight, FolderOpen, Sparkles, X } from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { useEsc } from '../../lib/hooks'
import { assetSrc } from '../../lib/media'
import { KIND_LABEL, type CanvasNode, type GenerateVersion } from '../../types'
import { activeVersionOf, deriveLineage, getReferenceUpdateState } from '../../lib/mediaReferenceGraph'
import type { LineageEntry } from '../../lib/mediaReferenceGraph'
import { REF_ROLE_LABEL } from '@shared/media'

/**
 * 卡片检视浮层：所有媒体卡统一的轻量检视入口（卡片悬停工具条的 分支 图标）。
 *
 * 内容三段，全部只读自生成事实（激活版本 inputs / 血脉派生）：
 * - 提示词详情：当前版本的生成输入（prompt/模型/参数）；
 * - 血脉图：生成链可视化（祖先在左、本卡在右，箭头方向与画布连线一致）；
 * - 版本切换与再生成（版本切换同步改卡片指向的文件；再生成打开生成面板预填）。
 *
 * 呈现刻意轻：紧凑面板、无重色块；导入素材无生成记录时如实说明。
 */

const PANEL_WIDTH = 328

/** 把来源卡片滚进视口中央并选中（点血脉节点定位） */
function locateSourceCard(sourceId: string): void {
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
  if (!s.selectedAssetIds.includes(sourceId)) s.toggleAssetSelected(sourceId)
}

/** 血脉图里的一个节点（缩略图 + 角色徽标；点击定位） */
function LineageNodeThumb({
  node,
  role,
  label,
  active = false,
}: {
  node: CanvasNode
  role?: string
  label?: string
  active?: boolean
}) {
  const thumb = node.data.kind === 'image' || node.data.kind === 'video' ? assetSrc(node.data, 96) : null
  return (
    <button
      data-testid="lineage-node"
      data-node-id={node.id}
      onClick={() => locateSourceCard(node.id)}
      className={`flex w-14 cursor-pointer flex-col items-center gap-0.5 rounded-lg p-1 transition-colors hover:bg-(--outline-soft) ${
        active ? 'ring-1 ring-(--accent)' : ''
      }`}
      title={`${node.data.name}${role ? ` · ${role}` : ''}（点击定位）`}
    >
      <span
        className={`flex h-9 w-9 items-center justify-center overflow-hidden rounded-md ${
          active ? 'bg-(--active-tint)' : 'bg-(--surface-input) ring-1 ring-(--outline-soft)'
        }`}
      >
        {thumb ? (
          <img src={thumb} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <span className="text-[9px] text-(--on-surface-muted)">{KIND_LABEL[node.data.kind].slice(0, 1)}</span>
        )}
      </span>
      <span className="w-full truncate text-center text-[9px] leading-tight text-(--on-surface-variant)">
        {node.data.name}
      </span>
      {role ? (
        <span className="rounded-full bg-(--active-tint) px-1 text-[8.5px] leading-4 text-(--accent)">{role}</span>
      ) : label ? (
        <span className="text-[8.5px] leading-4 text-(--on-surface-muted)">{label}</span>
      ) : null}
    </button>
  )
}

export function CardInspector() {
  const nodeId = useCanvasStore((s) => s.cardInspector)
  const closeCardInspector = useCanvasStore.getState().closeCardInspector
  const view = useCanvasStore((s) => s.view)
  const nodes = useCanvasStore((s) => s.nodes)

  const node = useMemo(() => (nodeId ? nodes.find((n) => n.id === nodeId) : undefined), [nodes, nodeId])
  const activeVersion = useMemo(() => (node ? activeVersionOf(node) : undefined), [node])
  const lineage = useMemo(
    () => (node ? deriveLineage(node.id, nodes, { maxDepth: 3, maxNodes: 8 }) : []),
    [node, nodes]
  )
  const updateState = useMemo(
    () => (node ? getReferenceUpdateState(node, nodes) : ('unknown' as const)),
    [node, nodes]
  )

  useEsc(nodeId !== null, closeCardInspector)

  if (!nodeId || !node) {
    if (nodeId) closeCardInspector()
    return null
  }

  // 世界坐标 → 屏幕坐标：锚在卡片右侧、垂直居中（与画布连线方向一致：来源在左）
  const rootRect = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect()
  const sx = (rootRect?.left ?? 0) + (node.x + node.width + 12) * view.scale + view.x
  const syCenter = (rootRect?.top ?? 0) + (node.y + node.height / 2) * view.scale + view.y
  const estHeight = 300
  const left = Math.min(Math.max(16, sx), Math.max(16, window.innerWidth - PANEL_WIDTH - 16))
  const top = Math.min(Math.max(16, syCenter - estHeight / 2), Math.max(16, window.innerHeight - estHeight - 16))

  const inputs = activeVersion?.inputs
  const versions = node.data.versions ?? []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // 血脉列：深度深（远祖）在左 → 直接参考在右，末列是本卡
  const depthGroups = new Map<number, LineageEntry[]>()
  for (const entry of lineage) {
    const group = depthGroups.get(entry.depth) ?? []
    group.push(entry)
    depthGroups.set(entry.depth, group)
  }
  const columns = [...depthGroups.entries()].sort((a, b) => b[0] - a[0])

  /** 切换版本：卡片同步指向该版本对应的文件（含 pathRoot 整体覆写，防旧根残留） */
  const switchVersion = (next: GenerateVersion) => {
    useCanvasStore.getState().updateNode(node.id, {
      data: {
        ...node.data,
        name: next.name,
        storage: next.storage,
        path: next.path,
        pathRoot: next.pathRoot,
        mime: next.mime,
        bytes: next.bytes,
        activeVersionId: next.id,
      },
    })
  }

  /** 再生成：打开生成面板，按当前版本输入预填（就地加新版本） */
  const openRegenerate = () => {
    closeCardInspector()
    useCanvasStore.getState().openGenComposer({
      at: { x: node.x + node.width + 24, y: node.y },
      targetNodeId: node.id,
      kind: node.data.kind as 'image' | 'video' | 'audio',
    })
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        data-testid="card-inspector-backdrop"
        onMouseDown={(e) => {
          e.stopPropagation()
          closeCardInspector()
        }}
      />
      <div
        data-testid="card-inspector"
        data-node-id={node.id}
        className="fixed z-50 flex flex-col gap-2 rounded-2xl bg-(--surface-card) p-3 shadow-xl ring-1 ring-(--outline-soft)"
        style={{ left, top: top + 6, width: PANEL_WIDTH }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* 头部：缩略 + 名称 */}
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-(--surface-input) ring-1 ring-(--outline-soft)">
            {node.data.kind === 'image' || node.data.kind === 'video' ? (
              <img src={assetSrc(node.data, 96) ?? ''} alt="" draggable={false} className="h-full w-full object-cover" />
            ) : (
              <span className="text-[9px] text-(--on-surface-muted)">{KIND_LABEL[node.data.kind].slice(0, 1)}</span>
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-(--on-surface)" title={node.data.name}>
            {node.data.name}
          </span>
          <button
            onClick={closeCardInspector}
            className="cursor-pointer rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft)"
            title="关闭（Esc）"
          >
            <X size={13} />
          </button>
        </div>

        {/* 提示词详情：当前版本（卡片"就是"激活版本）的生成输入 */}
        <div className="flex flex-col gap-1">
          <span className="text-[9.5px] font-semibold uppercase tracking-wider text-(--on-surface-muted)">提示词</span>
          {inputs?.prompt ? (
            <p className="line-clamp-4 whitespace-pre-wrap break-all text-[11.5px] leading-relaxed text-(--on-surface)" title={inputs.prompt}>
              {inputs.prompt}
            </p>
          ) : activeVersion ? (
            <p className="line-clamp-3 whitespace-pre-wrap break-all text-[11.5px] leading-relaxed text-(--on-surface)">
              {activeVersion.prompt || '（空）'}
            </p>
          ) : (
            <p className="text-[11px] leading-relaxed text-(--on-surface-muted)">导入/上传的素材，没有生成记录。</p>
          )}
          {inputs ? (
            <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-(--on-surface-variant)">
              {inputs.model && (
                <span className="font-mono">
                  {inputs.provider ? `${inputs.provider}:` : ''}
                  {inputs.model}
                </span>
              )}
              {inputs.params.ratio && <span>{inputs.params.ratio}</span>}
              {inputs.params.durationSeconds != null && <span>{inputs.params.durationSeconds}s</span>}
              {versions.length > 1 && <span>共 {versions.length} 版</span>}
            </div>
          ) : activeVersion ? (
            <span className="text-[10px] text-(--on-surface-muted)">该版本生成于输入快照功能之前，参数与参考未记录。</span>
          ) : null}
        </div>

        {/* 血脉图：祖先在左、本卡在右（与画布连线同方向）；点节点定位卡片 */}
        {activeVersion && (
          <div className="flex flex-col gap-1 border-t border-(--outline-soft) pt-1.5">
            <span className="text-[9.5px] font-semibold uppercase tracking-wider text-(--on-surface-muted)">血脉</span>
            {columns.length === 0 ? (
              <span className="text-[10.5px] text-(--on-surface-muted)">无参考，纯文生。</span>
            ) : (
              <div className="flex items-center gap-0.5 overflow-x-auto pb-0.5" data-testid="lineage-graph">
                {columns.map(([depth, entries], colIndex) => (
                  <div key={depth} className="flex items-center gap-0.5" data-lineage-depth={depth}>
                    {colIndex > 0 && <ArrowRight size={11} className="shrink-0 text-(--outline)" />}
                    <div className="flex flex-col gap-0.5">
                      {entries.map((entry) => {
                        const ancestor = byId.get(entry.nodeId)
                        if (!ancestor) return null
                        return (
                          <LineageNodeThumb
                            key={entry.nodeId}
                            node={ancestor}
                            role={entry.role ? REF_ROLE_LABEL[entry.role] : undefined}
                          />
                        )
                      })}
                    </div>
                  </div>
                ))}
                <ArrowRight size={11} className="shrink-0 text-(--outline)" />
                <LineageNodeThumb node={node} label="本卡" active />
              </div>
            )}
            {updateState === 'changed' && (
              <span className="text-[10px] text-(--accent)">上游卡片有更新，再次生成将使用新版本素材</span>
            )}
            {updateState === 'missing' && <span className="text-[10px] text-(--danger)">有来源卡片已被删除</span>}
          </div>
        )}

        {/* 版本切换 + 动作（轻量一行） */}
        {versions.length > 0 && (
          <div className="flex items-center gap-1 border-t border-(--outline-soft) pt-1.5">
            {versions.length > 1 ? (
              <span className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {versions.map((v, i) => (
                  <button
                    key={v.id}
                    data-testid="switch-version"
                    data-version-id={v.id}
                    onClick={() => switchVersion(v)}
                    className={`shrink-0 cursor-pointer rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                      v.id === activeVersion?.id
                        ? 'bg-(--active-tint) font-medium text-(--accent)'
                        : 'bg-(--surface-chip) text-(--on-surface-variant) hover:bg-(--surface-hover)'
                    }`}
                    title={v.prompt ? `v${i + 1}：${v.prompt.slice(0, 60)}` : `v${i + 1}`}
                  >
                    v{i + 1}
                  </button>
                ))}
              </span>
            ) : (
              <span className="text-[10px] text-(--on-surface-muted)">v1</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <button
                data-testid="regenerate-from"
                onClick={openRegenerate}
                className="flex cursor-pointer items-center gap-1 rounded-full bg-(--fab-bg) px-2.5 py-1 text-[10.5px] font-medium text-(--fab-text) transition hover:opacity-90"
                title="打开生成面板，按当前版本的输入再次生成（就地加新版本）"
              >
                <Sparkles size={11} />
                再生成
              </button>
              {node.data.path && (
                <button
                  onClick={() => {
                    if (window.huabu?.workspace && node.data.path) {
                      void window.huabu.workspace.reveal(node.data.path!)
                    }
                  }}
                  className="cursor-pointer rounded-full p-1 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft)"
                  title={`在文件管理器中打开：${node.data.path}`}
                >
                  <FolderOpen size={12} />
                </button>
              )}
            </span>
          </div>
        )}
      </div>
    </>
  )
}
