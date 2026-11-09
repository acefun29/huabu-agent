/**
 * 项目层级视图（原型 index-projects.html 的 renderScope 对应实现）。
 *
 * 与现有自由画布**并行**而非替换：
 * - 现有画布（CanvasWorkspace）继续承载素材卡自由摆放、血脉、生成；
 * - 本视图按 scope 渲染「当前层的容器卡/叶子卡」网格，进入容器即下钻，
 *   面包屑回退——这是原型的核心浏览语义。
 *
 * 层级完全由数据驱动：容器判定取 project.levels[level-1].container，
 * 卡片字段取 cardFields，没有任何写死的"剧集/场景/镜头"。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ProjectNodeView, ProjectSnapshot } from '@shared/ipc'

/** 状态展示（原型四态；色值对齐现有设计令牌语义） */
const STATUS_META: Record<ProjectNodeView['status'], { label: string; dot: string; className: string }> = {
  todo: { label: '待生成', dot: '#9aa0a6', className: 'text-(--on-surface-variant)' },
  generating: { label: '生成中', dot: '#c98b2f', className: 'text-[#c98b2f]' },
  done: { label: '已生成', dot: '#4f9d69', className: 'text-[#4f9d69]' },
  attention: { label: '需补上下文', dot: '#c2554f', className: 'text-[#c2554f]' },
}

const STATUS_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'todo', label: '待生成' },
  { key: 'generating', label: '生成中' },
  { key: 'done', label: '已生成' },
  { key: 'attention', label: '需补上下文' },
] as const

type StatusFilter = (typeof STATUS_FILTERS)[number]['key']

export interface ProjectScopeViewProps {
  /** 当前浏览的容器 id；null = 根看板 */
  scopeId: string | null
  onScopeChange: (scopeId: string | null) => void
  /** 选中节点（供详情抽屉/对话 chip） */
  selectedId: string | null
  onSelect: (nodeId: string | null) => void
  /** 卡片「加入对话」 */
  onAddToChat?: (node: ProjectNodeView) => void
  /** 结构弹窗 */
  onOpenSchema?: () => void
  /** 视图模式：画布（网格卡片）/ 列表 */
  viewMode: 'canvas' | 'list'
  onViewModeChange: (mode: 'canvas' | 'list') => void
}

type SnapshotResult = { ok: true; snapshot: ProjectSnapshot } | { ok: false; error: string }

async function fetchSnapshot(scopeId: string | null): Promise<SnapshotResult> {
  const api = window.huabu?.project
  if (!api) return { ok: false, error: '项目接口不可用（preload 未就绪）' }
  const result = (await api.snapshot({ scopeId })) as
    | { ok: true; value: ProjectSnapshot }
    | { ok: false; code: string; error: string }
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, snapshot: result.value }
}

export function ProjectScopeView({
  scopeId,
  onScopeChange,
  selectedId,
  onSelect,
  onAddToChat,
  onOpenSchema,
  viewMode,
  onViewModeChange,
}: ProjectScopeViewProps) {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [loading, setLoading] = useState(false)

  // scope 或结构变更时刷新（project:changed 订阅由上层挂载一次即可，这里按 scope 拉）
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchSnapshot(scopeId).then((result) => {
      if (cancelled) return
      setLoading(false)
      if (!result.ok) {
        setError(result.error)
        setSnapshot(null)
        return
      }
      // project.json 读取时的容错原因（损坏/版本不符）随快照带回，UI 提示但不阻塞
      setError(result.snapshot.error ?? null)
      setSnapshot(result.snapshot)
    })
    return () => {
      cancelled = true
    }
  }, [scopeId])

  const levelDef = useMemo(() => {
    if (!snapshot?.project) return null
    const first = snapshot.nodes[0]
    // 当前层的层级定义：根看板取 L1，容器内取子级
    const level = first?.level ?? (snapshot.breadcrumb.length || 1)
    return snapshot.project.levels[level - 1] ?? null
  }, [snapshot])

  const visible = useMemo(() => {
    if (!snapshot) return []
    if (filter === 'all') return snapshot.nodes
    return snapshot.nodes.filter((node) => node.status === filter)
  }, [snapshot, filter])

  const counts = useMemo(() => {
    const base: Record<string, number> = { all: snapshot?.nodes.length ?? 0 }
    for (const node of snapshot?.nodes ?? []) {
      base[node.status] = (base[node.status] ?? 0) + 1
    }
    return base
  }, [snapshot])

  if (!snapshot && !error) {
    return <div className="flex h-full items-center justify-center text-[12px] text-(--on-surface-variant)">加载项目结构…</div>
  }

  if (error && !snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-[13px] text-[#c2554f]">项目结构加载失败</div>
        <div className="max-w-[420px] text-[11.5px] leading-relaxed text-(--on-surface-variant)">{error}</div>
      </div>
    )
  }

  if (!snapshot) return null

  // 没有项目：引导新建（原型用 pill 切换，这里给最小入口）
  if (!snapshot.project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <div className="text-[13px] text-(--on-surface)">还没有项目结构</div>
        <div className="max-w-[420px] text-center text-[11.5px] leading-relaxed text-(--on-surface-variant)">
          项目结构是画布之上的层级骨架（如 短剧：剧集 → 场景 → 镜头）。素材库与文件路径不受影响。
        </div>
        <button
          type="button"
          className="rounded-lg bg-(--accent) px-3 py-1.5 text-[12px] text-white"
          onClick={async () => {
            const api = window.huabu?.project
            if (!api) return
            await api.create({ name: '新项目', kind: '短剧' })
            onScopeChange(null)
            const refreshed = await fetchSnapshot(null)
            setSnapshot(refreshed.ok ? refreshed.snapshot : null)
          }}
        >
          新建短剧项目
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* 头部：面包屑 + 视图切换 + 结构入口 */}
      <div className="flex items-center gap-2 border-b border-(--outline-variant) px-3 py-2">
        <nav className="flex min-w-0 items-center gap-1 text-[11.5px]">
          {snapshot.breadcrumb.map((crumb, index) => (
            <span key={crumb.id ?? 'root'} className="flex items-center gap-1">
              {index > 0 ? <span className="text-(--on-surface-variant)/50">/</span> : null}
              <button
                type="button"
                className={
                  index === snapshot.breadcrumb.length - 1
                    ? 'truncate font-medium text-(--on-surface)'
                    : 'truncate text-(--on-surface-variant) hover:text-(--on-surface)'
                }
                onClick={() => onScopeChange(crumb.id)}
              >
                {crumb.title}
              </button>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex rounded-lg border border-(--outline-variant) p-0.5">
            {(['canvas', 'list'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`rounded-md px-2 py-0.5 text-[11px] ${
                  viewMode === mode
                    ? 'bg-(--surface-container) text-(--on-surface)'
                    : 'text-(--on-surface-variant)'
                }`}
                onClick={() => onViewModeChange(mode)}
              >
                {mode === 'canvas' ? '画布' : '列表'}
              </button>
            ))}
          </div>
          {onOpenSchema ? (
            <button
              type="button"
              className="rounded-lg border border-(--outline-variant) px-2 py-0.5 text-[11px] text-(--on-surface-variant)"
              onClick={onOpenSchema}
            >
              结构
            </button>
          ) : null}
        </div>
      </div>

      {/* 状态筛选（四态，无"待审"） */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-(--outline-variant) px-3 py-1.5">
        {STATUS_FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
              filter === item.key
                ? 'bg-(--surface-container) text-(--on-surface)'
                : 'text-(--on-surface-variant) hover:text-(--on-surface)'
            }`}
            onClick={() => setFilter(item.key)}
          >
            {item.label}
            {counts[item.key] ? <span className="ml-1 opacity-60">{counts[item.key]}</span> : null}
          </button>
        ))}
        {loading ? <span className="ml-auto text-[10.5px] text-(--on-surface-variant)">刷新中…</span> : null}
      </div>

      {/* 内容：画布网格 / 列表 */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-(--on-surface-variant)">
            {snapshot.nodes.length === 0
              ? `尚无${levelDef?.label ?? '节点'}——可以让 Agent 生成，或手动新增`
              : '当前筛选下没有节点'}
          </div>
        ) : viewMode === 'canvas' ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {visible.map((node) => (
              <ScopeCard
                key={node.id}
                node={node}
                isContainer={node.stats !== undefined}
                selected={selectedId === node.id}
                onOpen={() => {
                  if (node.stats !== undefined) onScopeChange(node.id)
                  else onSelect(node.id)
                }}
                onSelect={() => onSelect(node.id)}
                {...(onAddToChat ? { onAddToChat: () => onAddToChat(node) } : {})}
              />
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-(--outline-variant)">
            <table className="w-full text-[11.5px]">
              <thead className="bg-(--surface-container) text-left text-(--on-surface-variant)">
                <tr>
                  <th className="px-2 py-1.5 font-normal">名称</th>
                  {levelDef?.cardFields?.map((key) => (
                    <th key={key} className="px-2 py-1.5 font-normal">
                      {levelDef.fields.find((f) => f.key === key)?.label ?? key}
                    </th>
                  ))}
                  <th className="px-2 py-1.5 font-normal">状态</th>
                  <th className="px-2 py-1.5 font-normal">进度</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((node) => {
                  const meta = STATUS_META[node.status]
                  return (
                    <tr
                      key={node.id}
                      className={`cursor-pointer border-t border-(--outline-variant) hover:bg-(--surface-container)/60 ${
                        selectedId === node.id ? 'bg-(--surface-container)' : ''
                      }`}
                      onClick={() => (node.stats !== undefined ? onScopeChange(node.id) : onSelect(node.id))}
                    >
                      <td className="px-2 py-1.5 text-(--on-surface)">{node.title}</td>
                      {levelDef?.cardFields?.map((key) => (
                        <td key={key} className="px-2 py-1.5 text-(--on-surface-variant)">
                          {node.fields[key] ?? '—'}
                        </td>
                      ))}
                      <td className={`px-2 py-1.5 ${meta.className}`}>
                        <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: meta.dot }} />
                        {meta.label}
                      </td>
                      <td className="px-2 py-1.5 text-(--on-surface-variant)">
                        {node.stats ? `${node.stats.done}/${node.stats.total} · ${node.stats.pct}%` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/** 画布卡片：16:9 封面 + 底部信息层（容器显示进度，叶子显示字段摘要） */
function ScopeCard({
  node,
  isContainer,
  selected,
  onOpen,
  onSelect,
  onAddToChat,
}: {
  node: ProjectNodeView
  isContainer: boolean
  selected: boolean
  onOpen: () => void
  onSelect: () => void
  onAddToChat?: () => void
}) {
  const meta = STATUS_META[node.status]
  const subtitle = Object.entries(node.fields)
    .slice(0, 2)
    .map(([, value]) => value)
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className={`group relative cursor-pointer overflow-hidden rounded-xl border bg-(--surface-container) transition ${
        selected ? 'border-(--accent) ring-2 ring-(--accent)/25' : 'border-(--outline-variant) hover:border-(--outline)'
      }`}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-(--surface-container-high, #e8e6e1)">
        {node.cover ? (
          <img src={node.cover} alt={node.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10.5px] text-(--on-surface-variant)/60">
            {isContainer ? node.title : node.status === 'todo' ? '待生成' : '无封面'}
          </div>
        )}
        {/* 悬浮工具条 */}
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
          {onAddToChat ? (
            <button
              type="button"
              className="rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] text-white backdrop-blur"
              onClick={(event) => {
                event.stopPropagation()
                onAddToChat()
              }}
            >
              加入对话
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] text-white backdrop-blur"
            onClick={(event) => {
              event.stopPropagation()
              onOpen()
            }}
          >
            {isContainer ? '打开' : '详情'}
          </button>
        </div>
      </div>
      <div className="space-y-0.5 px-2 py-1.5">
        <div className="truncate text-[11.5px] font-medium text-(--on-surface)">{node.title}</div>
        <div className="flex items-center gap-1.5 text-[10.5px]">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: meta.dot }} />
          <span className={meta.className}>{meta.label}</span>
          {node.stats ? (
            <span className="ml-auto text-(--on-surface-variant)">
              {node.stats.done}/{node.stats.total}
            </span>
          ) : subtitle ? (
            <span className="ml-auto truncate text-(--on-surface-variant)">{subtitle}</span>
          ) : null}
        </div>
        {node.stats && node.stats.total > 0 ? (
          <div className="h-1 overflow-hidden rounded-full bg-(--outline-variant)">
            <div
              className="h-full rounded-full bg-(--accent) transition-all"
              style={{ width: `${node.stats.pct}%` }}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
