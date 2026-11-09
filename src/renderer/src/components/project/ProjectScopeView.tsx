/**
 * 项目层级视图（严格对齐原型 index-projects.html 的视觉与交互）。
 *
 * - 标题区（scope-head）：kicker + 大标题 + 层级标签 + tagline + 统计行 + 结构来源说明
 * - 卡片（node-card）：16:7.4 封面 + 顶部层级/状态胶囊 + 底部渐变 scrim（标题 + 字段 + 进度）
 * - 列表（list-table）：与原型同构的表格
 * - 双视图与四态筛选（无「待审」）
 *
 * 层级完全由数据驱动（levels / cardFields），无写死的剧集/场景/镜头。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectNodeView, ProjectSnapshot } from '@shared/ipc'

type LevelDef = {
  label: string
  plural: string
  cardFields: string[]
  fields: { key: string; label: string }[]
}

/** 状态样式（对齐原型 .st.* 配色） */
const STATUS: Record<ProjectNodeView['status'], { label: string; cls: string }> = {
  todo: { label: '待生成', cls: 'bg-[#f1f3f4] text-[#6b7280]' },
  generating: { label: '生成中', cls: 'bg-[#e8f0fe] text-[#1a56b0]' },
  done: { label: '已生成', cls: 'bg-[#e6f4ea] text-[#137333]' },
  attention: { label: '需补上下文', cls: 'bg-[#fef7e0] text-[#a55a00]' },
}

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'todo', label: '待生成' },
  { key: 'generating', label: '生成中' },
  { key: 'done', label: '已生成' },
  { key: 'attention', label: '需补上下文' },
] as const
type FilterKey = (typeof FILTERS)[number]['key']

/** 是否在根看板（面包屑只有 rootLabel 一项） */
function isRootPath(snapshot: ProjectSnapshot | null): boolean {
  return (snapshot?.breadcrumb.length ?? 1) <= 1
}

type SnapshotResult = { ok: true; snapshot: ProjectSnapshot } | { ok: false; error: string }

async function fetchSnapshot(scopeId: string | null): Promise<SnapshotResult> {
  const api = window.huabu?.project
  if (!api) return { ok: false, error: '项目接口不可用（preload 未就绪）' }
  const res = (await api.snapshot({ scopeId })) as
    | { ok: true; value: ProjectSnapshot }
    | { ok: false; code: string; error: string }
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, snapshot: res.value }
}

export interface ProjectScopeViewProps {
  scopeId: string | null
  onScopeChange: (scopeId: string | null) => void
  selectedId: string | null
  onSelect: (nodeId: string | null) => void
  onAddToChat?: (node: ProjectNodeView) => void
  onOpenSchema?: () => void
  viewMode: 'canvas' | 'list'
  onViewModeChange: (mode: 'canvas' | 'list') => void
  /** 上报当前范围标题（供右栏「当前范围」chip 与 Agent 回执使用） */
  onScopeTitleChange?: (title: string) => void
}

export function ProjectScopeView(props: ProjectScopeViewProps) {
  const { scopeId, onScopeChange, selectedId, onSelect, onAddToChat, onOpenSchema, viewMode, onViewModeChange, onScopeTitleChange } = props
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)

  const load = useCallback(async (scope: string | null) => {
    setLoading(true)
    const result = await fetchSnapshot(scope)
    if (!alive.current) return
    setLoading(false)
    if (!result.ok) {
      setError(result.error)
      setSnapshot(null)
      return
    }
    setError(result.snapshot.error ?? null)
    setSnapshot(result.snapshot)
  }, [])

  useEffect(() => {
    alive.current = true
    void load(scopeId)
    return () => {
      alive.current = false
    }
  }, [scopeId, load])

  // 结构变更订阅（主进程 project:changed）
  useEffect(() => {
    const api = window.huabu?.project
    if (!api?.onChanged) return
    return api.onChanged(() => void load(scopeId))
  }, [scopeId, load])

  const project = snapshot?.project ?? null
  /** 当前层定义：由子节点 level 推断（根看板取 L1） */
  const levelDef: LevelDef | null = useMemo(() => {
    if (!project) return null
    const level = snapshot?.nodes[0]?.level ?? (snapshot?.breadcrumb.length || 1)
    return project.levels[level - 1] ?? null
  }, [project, snapshot])

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: snapshot?.nodes.length ?? 0 }
    for (const n of snapshot?.nodes ?? []) out[n.status] = (out[n.status] ?? 0) + 1
    return out
  }, [snapshot])

  const visible = useMemo(() => {
    const nodes = snapshot?.nodes ?? []
    return filter === 'all' ? nodes : nodes.filter((n) => n.status === filter)
  }, [snapshot, filter])

  /** 当前 scope 统计：本层节点数 + 子树叶子进度 + 需补上下文数 */
  const stats = useMemo(() => {
    const nodes = snapshot?.nodes ?? []
    const total = nodes.reduce((sum, n) => sum + (n.stats ? n.stats.total : 1), 0)
    const done = nodes.reduce((sum, n) => sum + (n.stats ? n.stats.done : n.status === 'done' ? 1 : 0), 0)
    const attention = nodes.filter((n) => n.status === 'attention').length
    return { nodes: nodes.length, total, done, attention }
  }, [snapshot])

  // 根看板标题是项目名（面包屑根项存的是 rootLabel，不是项目名）
  const currentTitle = isRootPath(snapshot) ? (project?.name ?? '') : (snapshot?.breadcrumb.at(-1)?.title ?? project?.name ?? '')
  // 上报范围标题（右栏 chip / Agent 回执用）
  useEffect(() => {
    if (currentTitle) onScopeTitleChange?.(currentTitle)
  }, [currentTitle, onScopeTitleChange])
  const isRoot = isRootPath(snapshot)

  if (!snapshot && loading) {
    return <div className="flex h-full items-center justify-center text-[12px] text-(--on-surface-muted)">加载项目结构…</div>
  }
  if (error && !snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-[13px] text-[#b3261e]">项目结构加载失败</div>
        <div className="max-w-[420px] text-[11.5px] leading-relaxed text-(--on-surface-muted)">{error}</div>
      </div>
    )
  }
  if (!snapshot) return null

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <div className="text-[13px] font-medium text-(--on-surface)">还没有项目结构</div>
        <div className="max-w-[420px] text-center text-[11.5px] leading-relaxed text-(--on-surface-muted)">
          项目结构是画布之上的层级骨架（如 短剧：剧集 → 场景 → 镜头）。素材库与文件路径不受影响。
        </div>
        <button
          type="button"
          className="rounded-full bg-(--accent) px-3.5 py-1.5 text-[12px] text-white"
          onClick={async () => {
            const api = window.huabu?.project
            if (!api) return
            await api.create({ name: '新项目', kind: '短剧' })
            onScopeChange(null)
            await load(null)
          }}
        >
          新建短剧项目
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-(--surface)">
      {/* 顶部工具条：面包屑 + 双视图 + 状态筛选 + 结构入口 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-(--outline-soft) px-5 py-2">
        {/* 项目 pill 切换（原型顶部下拉） */}
        <div className="relative shrink-0">
          <select
            className="appearance-none rounded-full border border-(--outline-soft) bg-(--surface-card) py-[3px] pl-2.5 pr-6 text-[11px] font-medium text-(--on-surface-variant) outline-none hover:border-(--outline)"
            value={snapshot.activeProjectId ?? ''}
            onChange={async (e) => {
              await window.huabu?.project.activate(e.target.value)
              onScopeChange(null)
              await load(null)
            }}
          >
            {snapshot.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.kind}）{p.summary ? ` · ${p.summary}` : ''}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[8px] text-(--on-surface-muted)">▼</span>
        </div>
        <nav className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px]">
          {snapshot.breadcrumb.map((crumb, i) => (
            <span key={crumb.id ?? 'root'} className="flex min-w-0 items-center gap-1.5">
              {i > 0 ? <span className="shrink-0 text-(--on-surface-muted)/50">›</span> : null}
              <button
                type="button"
                className={`truncate ${
                  i === snapshot.breadcrumb.length - 1
                    ? 'font-medium text-(--on-surface-variant)'
                    : 'text-(--on-surface-muted) hover:text-(--on-surface-variant)'
                }`}
                onClick={() => onScopeChange(crumb.id)}
              >
                {crumb.title}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-(--outline-soft) bg-(--surface-card) p-0.5">
          {(['canvas', 'list'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`rounded-full px-2.5 py-[3px] text-[10.5px] ${
                viewMode === mode ? 'bg-(--surface-chip) font-medium text-(--on-surface-variant)' : 'text-(--on-surface-muted)'
              }`}
              onClick={() => onViewModeChange(mode)}
            >
              {mode === 'canvas' ? '画布' : '列表'}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-(--outline-soft) bg-(--surface-card) px-2 py-[3px]">
          <span className="text-[10.5px] text-(--on-surface-muted)">状态</span>
          <select
            className="bg-transparent text-[10.5px] text-(--on-surface-variant) outline-none"
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterKey)}
          >
            {FILTERS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
                {counts[f.key] ? ` (${counts[f.key]})` : ''}
              </option>
            ))}
          </select>
        </div>
        {onOpenSchema ? (
          <button
            type="button"
            className="shrink-0 rounded-full border border-(--outline-soft) bg-(--surface-card) px-2.5 py-[3px] text-[10.5px] text-(--on-surface-muted) hover:text-(--on-surface-variant)"
            onClick={onOpenSchema}
          >
            结构
          </button>
        ) : null}
      </div>

      {/* 标题区（原型 scope-head） */}
      <div className="shrink-0 px-5 pt-4">
        <div className="mx-auto w-full max-w-[900px]">
          <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[.08em] text-(--on-surface-muted)">
            <span>{isRoot ? project.rootLabel : project.kind}</span>
            {!isRoot ? <span className="opacity-60">·</span> : null}
            {!isRoot ? <span>{project.kind}</span> : null}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-[22px] font-semibold leading-[1.22] tracking-[-.025em] text-(--on-surface)">{currentTitle}</h1>
            {levelDef?.label ? (
              <span className="rounded-full bg-(--surface-chip) px-1.5 py-0.5 text-[9.5px] text-(--on-surface-muted)">
                {levelDef.label}层
              </span>
            ) : null}
          </div>
          {isRoot && project.tagline ? (
            <p className="mt-1.5 max-w-[640px] text-[12px] leading-[1.62] text-(--on-surface-muted)">{project.tagline}</p>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-3.5">
            <span className="flex items-baseline gap-1 text-[10.5px] text-(--on-surface-muted)">
              <b className="text-[13px] font-semibold text-(--on-surface-variant)">{stats.nodes}</b>
              {levelDef?.plural ?? '项'}
            </span>
            <span className="flex items-baseline gap-1 text-[10.5px] text-(--on-surface-muted)">
              <b className="text-[13px] font-semibold text-(--on-surface-variant)">
                {stats.done}/{stats.total}
              </b>
              已生成
            </span>
            {stats.attention > 0 ? (
              <span className="flex items-baseline gap-1 text-[10.5px] text-[#a55a00]">
                <b className="text-[13px] font-semibold">{stats.attention}</b>
                需补上下文
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-(--outline-soft) bg-(--surface-card) px-2 py-[3px] text-[9.5px] text-(--on-surface-muted)">
              <span className="text-(--accent)">◈</span>
              结构由数据定义（{project.levels.length} 层），非前端硬编码
            </span>
            {loading ? <span className="text-[9.5px] text-(--on-surface-muted)">刷新中…</span> : null}
          </div>
        </div>
      </div>

      {/* 内容区：卡片看板 / 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16 pt-4">
        <div className="mx-auto w-full max-w-[900px]">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 py-16 text-center">
              <div className="text-[12.5px] font-medium text-(--on-surface-variant)">
                没有符合筛选的{levelDef?.label ?? '节点'}
              </div>
              <div className="text-[11px] text-(--on-surface-muted)">
                {(snapshot.nodes.length ?? 0) === 0
                  ? '当前层还没有节点——可以让 Agent 生成，或手动新增。'
                  : '清空状态筛选，或切换项目看另一套结构。'}
              </div>
            </div>
          ) : viewMode === 'canvas' ? (
            <div className="grid grid-cols-2 items-start gap-3.5">
              {visible.map((node) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  levelLabel={levelDef?.label ?? ''}
                  selected={selectedId === node.id}
                  onOpen={() => (node.stats ? onScopeChange(node.id) : onSelect(node.id))}
                  onSelect={() => onSelect(node.id)}
                  {...(onAddToChat ? { onAddToChat: () => onAddToChat(node) } : {})}
                />
              ))}
            </div>
          ) : (
            <ListView
              nodes={visible}
              levelDef={levelDef}
              selectedId={selectedId}
              onOpen={(n) => (n.stats ? onScopeChange(n.id) : onSelect(n.id))}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 卡片 */

function NodeCard({
  node,
  levelLabel,
  selected,
  onOpen,
  onSelect,
  onAddToChat,
}: {
  node: ProjectNodeView
  levelLabel: string
  selected: boolean
  onOpen: () => void
  onSelect: () => void
  onAddToChat?: () => void
}) {
  const st = STATUS[node.status]
  const isContainer = node.stats !== undefined
  const meta = Object.values(node.fields).filter(Boolean).slice(0, 2).join(' · ')
  const progress = isContainer ? `${node.stats!.done}/${node.stats!.total}` : node.status === 'done' ? '已完成' : '—'

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={node.title}
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-[14px] border bg-(--surface-card) text-left transition duration-150 ${
        selected
          ? 'border-(--accent) ring-2 ring-(--accent)/20'
          : 'border-(--outline-soft) hover:-translate-y-0.5 hover:border-(--outline) hover:shadow-[0_8px_24px_-10px_rgba(0,0,0,.18)]'
      }`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <div className="relative aspect-[16/7.4] overflow-hidden bg-[linear-gradient(135deg,var(--surface-chip),var(--surface-hover))]">
        {node.cover ? (
          <img
            src={node.cover}
            alt=""
            loading="lazy"
            className="block h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.025]"
          />
        ) : null}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,.2)_0%,transparent_42%)]" />
        <div className="absolute inset-x-2.5 top-2.5 z-[2] flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-white/85 px-1.5 py-0.5 text-[8.5px] font-semibold tracking-[.03em] text-(--on-surface-variant) shadow-sm backdrop-blur">
            {levelLabel}
          </span>
          <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[8.5px] font-medium ${st.cls}`}>
            <span className="h-1 w-1 rounded-full bg-current" />
            {st.label}
          </span>
        </div>
        <div className="pointer-events-none absolute right-2 top-9 z-[3] flex flex-col gap-1 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
          {onAddToChat ? (
            <button
              type="button"
              className="rounded-md bg-black/55 px-1.5 py-0.5 text-[9.5px] text-white backdrop-blur"
              onClick={(e) => {
                e.stopPropagation()
                onAddToChat()
              }}
            >
              加入对话
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md bg-black/55 px-1.5 py-0.5 text-[9.5px] text-white backdrop-blur"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
          >
            {isContainer ? '打开' : '详情'}
          </button>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,.62))] px-2.5 pb-2 pt-8">
          <div className="truncate text-[12.5px] font-semibold leading-tight text-white">{node.title}</div>
          <div className="mt-0.5 flex items-baseline gap-2 text-[10px] text-white/80">
            <span className="truncate">{meta}</span>
            <span className="ml-auto shrink-0 tabular-nums">{progress}</span>
          </div>
          {isContainer && node.stats!.total > 0 ? (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/30">
              <div className="h-full rounded-full bg-[#f4b942] transition-all duration-500" style={{ width: `${node.stats!.pct}%` }} />
            </div>
          ) : null}
        </div>
      </div>
    </article>
  )
}

/* ------------------------------------------------------------------ 列表 */

function ListView({
  nodes,
  levelDef,
  selectedId,
  onOpen,
}: {
  nodes: ProjectNodeView[]
  levelDef: LevelDef | null
  selectedId: string | null
  onOpen: (node: ProjectNodeView) => void
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-(--outline-soft) bg-(--surface-card)">
      <table className="w-full text-[11.5px]">
        <thead className="text-left text-[10px] uppercase tracking-[.06em] text-(--on-surface-muted)">
          <tr className="border-b border-(--outline-soft)">
            <th className="px-3 py-2 font-medium">{levelDef?.label ?? '节点'}</th>
            <th className="px-3 py-2 font-medium">状态</th>
            <th className="px-3 py-2 font-medium">字段</th>
            <th className="px-3 py-2 font-medium">进度</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => {
            const st = STATUS[node.status]
            const fields = (levelDef?.cardFields ?? [])
              .map((k) => `${levelDef?.fields.find((f) => f.key === k)?.label ?? k}：${node.fields[k] ?? '—'}`)
              .join('　')
            return (
              <tr
                key={node.id}
                className={`cursor-pointer border-b border-(--outline-soft) last:border-0 hover:bg-(--surface-chip)/60 ${
                  selectedId === node.id ? 'bg-(--surface-chip)' : ''
                }`}
                onClick={() => onOpen(node)}
              >
                <td className="px-3 py-2 font-medium text-(--on-surface)">{node.title}</td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[8.5px] ${st.cls}`}>
                    <span className="h-1 w-1 rounded-full bg-current" />
                    {st.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-(--on-surface-muted)">{fields || '—'}</td>
                <td className="px-3 py-2 tabular-nums text-(--on-surface-muted)">
                  {node.stats ? `${node.stats.done}/${node.stats.total} · ${node.stats.pct}%` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
