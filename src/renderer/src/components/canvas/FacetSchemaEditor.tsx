/**
 * 分级结构编辑器（工作区级）。
 *
 * 产品不内置任何分级方案：一份结构 = 从粗到细的若干「层」（如 集 / 场 / 镜），
 * 由用户在这里现场定义，或由 Agent 按对话建出来。这个弹窗是用户的编辑入口，
 * 与 Agent 的 define_facet_schema 写的是同一份数据（workspace.json facets.schemas）。
 *
 * 为什么是弹窗而不是面板内的展开区：素材库面板在右侧栏里带独立滚动容器，
 * 嵌进去会被裁切；弹窗挂在 App 根部，层级列表再长也不受限。
 *
 * 与 Agent 的边界：这里只做「结构定义」；给某个素材盖位置仍然在卡片/批量选择器里。
 */

import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Layers, Plus, Trash2, X } from 'lucide-react'
import { MAX_FACET_DEPTH, sanitizeFacetSchema, type FacetSchema } from '@shared/facets'
import { useCanvasStore } from '../../store/canvasStore'
import { useEsc } from '../../lib/hooks'

/** 草稿行：label 必填，其余可空；key 只在更新已有结构时保留 */
interface LevelDraft {
  key?: string
  label: string
  title: string
  hint: string
}

const EMPTY_LEVEL: LevelDraft = { label: '', title: '', hint: '' }

export interface FacetSchemaEditorState {
  /** 要编辑的结构；null = 新建 */
  schema: FacetSchema | null
}

/**
 * 把草稿收成可提交的 schema。
 * 返回 null 表示还不能提交（没有名称或没有任何一层有名字）——调用方给提示即可。
 */
function buildSchema(
  id: string,
  label: string,
  description: string,
  levels: LevelDraft[]
): FacetSchema | null {
  return sanitizeFacetSchema({
    id,
    label,
    description,
    levels: levels
      // 空行（没填层名）直接丢掉，允许用户中途加一行又不填
      .filter((level) => level.label.trim())
      .map((level, index) => ({
        key: level.key ?? `level-${index + 1}`,
        label: level.label,
        ...(level.title.trim() ? { title: level.title } : {}),
        ...(level.hint.trim() ? { hint: level.hint } : {})
      }))
  })
}

export function FacetSchemaEditor({
  schema,
  onClose
}: {
  /** null = 新建 */
  schema: FacetSchema | null
  onClose: () => void
}) {
  const saveFacetSchema = useCanvasStore((s) => s.saveFacetSchema)
  const deleteFacetSchema = useCanvasStore((s) => s.deleteFacetSchema)
  const requestConfirm = useCanvasStore((s) => s.requestConfirm)
  const libraries = useCanvasStore((s) => s.libraries)
  const schemas = useCanvasStore((s) => s.facetSchemas)
  const [label, setLabel] = useState(schema?.label ?? '')
  const [description, setDescription] = useState(schema?.description ?? '')
  const [activate, setActivate] = useState(true)
  const [levels, setLevels] = useState<LevelDraft[]>(
    schema?.levels.map((l) => ({ key: l.key, label: l.label, title: l.title ?? '', hint: l.hint ?? '' })) ?? [
      { ...EMPTY_LEVEL }
    ]
  )
  const [saving, setSaving] = useState(false)
  const isNew = !schema

  useEsc(true, onClose, { capture: true, swallow: true })

  /** 这套结构当前挂着多少个文件的分级（删除前如实告知） */
  const affected = useMemo(() => {
    if (!schema) return 0
    let count = 0
    for (const lib of libraries) {
      for (const file of lib.files) if (file.facet?.schemaId === schema.id) count += 1
    }
    return count
  }, [libraries, schema])

  const patch = (index: number, next: Partial<LevelDraft>): void => {
    setLevels((prev) => prev.map((level, i) => (i === index ? { ...level, ...next } : level)))
  }

  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= levels.length) return
    setLevels((prev) => {
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const submit = async (): Promise<void> => {
    // id 由主进程侧的 newFacetSchemaId 语义决定；这里新建时先占位，保存后以返回值刷新列表
    const id = schema?.id ?? `facet-${Math.random().toString(36).slice(2, 8)}`
    const built = buildSchema(id, label, description, levels)
    if (!built) {
      useCanvasStore.getState().showToast('至少要有结构名称和一层有名字的层')
      return
    }
    setSaving(true)
    const ok = await saveFacetSchema(built, activate)
    setSaving(false)
    if (ok) onClose()
  }

  const remove = (): void => {
    if (!schema) return
    requestConfirm({
      title: `删除分级结构「${schema.label}」？`,
      body:
        affected > 0
          ? `有 ${affected} 个文件的分级指向这套结构。删除后这些值仍保留，但层名不再可解析（界面显示为「第N层」）。要重新解释需再建一套同名结构。`
          : '删除后不可恢复；这个工作区目前没有文件指向它。',
      confirmLabel: '删除结构',
      danger: true,
      onConfirm: () => {
        void deleteFacetSchema(schema.id)
        onClose()
      }
    })
  }

  const canSubmit = label.trim().length > 0 && levels.some((l) => l.label.trim().length > 0) && !saving

  return (
    <div
      data-testid="facet-schema-editor"
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/25 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="ctx-menu flex max-h-[min(760px,calc(100vh-48px))] w-full max-w-xl flex-col overflow-hidden rounded-[22px] bg-(--surface-card) shadow-2xl ring-1 ring-(--outline)"
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-(--on-surface-muted)">
              <Layers size={11} />
              分级结构 · 工作区自定义
            </div>
            <div className="mt-1.5 text-[18px] font-semibold tracking-tight text-(--on-surface)">
              {isNew ? '新建分级结构' : `编辑「${schema.label}」`}
            </div>
            <div className="mt-1 text-[11px] leading-relaxed text-(--on-surface-muted)">
              一条从粗到细的位置链，比如「集 → 场 → 镜」。层名由你定，Agent 也按这里的定义读写素材位置。
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-full p-1.5 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface)"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>

        {/* 表单主体 */}
        <div data-scrollable="" className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          <div className="flex flex-col gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-(--on-surface-variant)">结构名称</span>
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="如：短剧、分镜表、章节"
                maxLength={40}
                className="w-full rounded-lg bg-(--surface-input) px-3 py-1.5 text-[13px] text-(--on-surface) outline-none ring-1 ring-transparent transition focus:ring-2 focus:ring-(--accent)"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-(--on-surface-variant)">
                说明 <span className="font-normal text-(--on-surface-muted)">（可选，给 Agent 看的一句话）</span>
              </span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="如：按集-场-镜定位分镜素材"
                maxLength={200}
                className="w-full rounded-lg bg-(--surface-input) px-3 py-1.5 text-[13px] text-(--on-surface) outline-none ring-1 ring-transparent transition focus:ring-2 focus:ring-(--accent)"
              />
            </label>
          </div>

          {/* 层级行 */}
          <div className="mt-4 flex items-center justify-between">
            <span className="text-[11px] font-medium text-(--on-surface-variant)">
              层级 <span className="font-normal text-(--on-surface-muted)">（从粗到细，最多 {MAX_FACET_DEPTH} 层）</span>
            </span>
            <button
              onClick={() => setLevels((prev) => (prev.length >= MAX_FACET_DEPTH ? prev : [...prev, { ...EMPTY_LEVEL }]))}
              disabled={levels.length >= MAX_FACET_DEPTH}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-(--accent) transition-colors hover:bg-(--active-tint) disabled:cursor-default disabled:opacity-40"
            >
              <Plus size={11} />
              添加一层
            </button>
          </div>

          <div className="mt-2 flex flex-col gap-2">
            {levels.map((level, index) => (
              <div key={index} className="rounded-xl border border-(--outline-soft) bg-(--surface)">
                <div className="flex items-center gap-2 border-b border-(--outline-soft) px-2.5 py-1.5">
                  <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md bg-(--surface-card) font-mono text-[9px] text-(--on-surface-muted) ring-1 ring-(--outline-soft)">
                    L{index + 1}
                  </span>
                  <input
                    value={level.label}
                    onChange={(e) => patch(index, { label: e.target.value })}
                    placeholder="层名（如 集）"
                    maxLength={12}
                    className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-[12px] font-semibold text-(--on-surface) outline-none placeholder:font-normal placeholder:text-(--on-surface-muted) focus:bg-(--surface-input)"
                  />
                  <span className="flex shrink-0 items-center">
                    <button
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      title="上移（更粗）"
                      className="rounded-md p-1 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface) disabled:cursor-default disabled:opacity-30"
                    >
                      <ArrowUp size={11} />
                    </button>
                    <button
                      onClick={() => move(index, 1)}
                      disabled={index === levels.length - 1}
                      title="下移（更细）"
                      className="rounded-md p-1 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--on-surface) disabled:cursor-default disabled:opacity-30"
                    >
                      <ArrowDown size={11} />
                    </button>
                    <button
                      onClick={() => setLevels((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)))}
                      disabled={levels.length <= 1}
                      title="删除这一层"
                      className="rounded-md p-1 text-(--on-surface-muted) transition-colors hover:bg-(--danger)/10 hover:text-(--danger) disabled:cursor-default disabled:opacity-30"
                    >
                      <Trash2 size={11} />
                    </button>
                  </span>
                </div>
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <input
                    value={level.hint}
                    onChange={(e) => patch(index, { hint: e.target.value })}
                    placeholder="写法提示（如 第01集）"
                    maxLength={40}
                    title="帮人和 Agent 用统一写法；不填也可以"
                    className="min-w-0 flex-1 rounded-md bg-(--surface-card) px-2 py-1 text-[10.5px] text-(--on-surface-variant) outline-none placeholder:text-(--on-surface-muted) focus:ring-1 focus:ring-(--accent)/50"
                  />
                  <input
                    value={level.title}
                    onChange={(e) => patch(index, { title: e.target.value })}
                    placeholder="全名（可选）"
                    maxLength={40}
                    className="w-28 shrink-0 rounded-md bg-(--surface-card) px-2 py-1 text-[10.5px] text-(--on-surface-variant) outline-none placeholder:text-(--on-surface-muted) focus:ring-1 focus:ring-(--accent)/50"
                  />
                </div>
              </div>
            ))}
          </div>

          <label className="mt-3 flex cursor-pointer items-center gap-2 px-0.5 text-[11.5px] text-(--on-surface-variant)">
            <input
              type="checkbox"
              checked={activate}
              onChange={(e) => setActivate(e.target.checked)}
              className="h-3.5 w-3.5 accent-(--accent)"
            />
            保存后设为当前生效结构
            {schemas.length === 0 && <span className="text-(--on-surface-muted)">（第一套会自动生效）</span>}
          </label>
        </div>

        {/* 底部 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-(--outline-soft) px-5 py-3">
          {!isNew && (
            <button
              onClick={remove}
              className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] text-(--on-surface-muted) transition-colors hover:bg-(--danger)/10 hover:text-(--danger)"
            >
              <Trash2 size={12} />
              删除结构
            </button>
          )}
          <span className="ml-auto" />
          <button
            onClick={onClose}
            className="rounded-full bg-(--surface-chip) px-4 py-1.5 text-[12px] font-medium text-(--on-surface) transition-colors hover:bg-(--surface-hover)"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded-full bg-(--accent) px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
