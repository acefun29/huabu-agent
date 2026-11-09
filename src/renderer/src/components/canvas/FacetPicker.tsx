/**
 * 批量分级选择器：给划选的多张卡片一次盖上同一个位置（如「第02集 / 第1场」）。
 *
 * 为什么批量入口单独做：单卡的 FacetRow 在卡片浮层里够用，但"把这 20 张镜图
 * 归到第3集"是真实生产里的高频操作，逐张点开太慢。`asset:set-facets` 批量通道
 * 本来就存在（主进程一次读-改-写），这里只是给它一个 UI。
 *
 * 层级名与深度来自工作区 schema，代码不写死 集/场/镜。
 * 值输入带 datalist 建议：只列出「画布上已经出现过的值」，避免同一场被写成
 * 「第2场」和「第02场」两种形态。
 */

import { useMemo, useState } from 'react'
import { Layers } from 'lucide-react'
import { ChipSelect } from '../Dropdown'
import { collectFacetValues } from '@shared/facets'
import { useCanvasStore } from '../../store/canvasStore'

export function FacetPicker({ nodeIds }: { nodeIds: string[] }) {
  const schema = useCanvasStore((s) => s.facetSchema)
  const nodes = useCanvasStore((s) => s.nodes)
  const setNodesFacet = useCanvasStore((s) => s.setNodesFacet)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])

  /** 每层的建议值：取自画布上同类前置前缀的现有分级（与筛选条同源） */
  const suggestions = useMemo(() => {
    if (!schema) return [] as string[][]
    const facets = nodes.map((n) => n.data.facet).filter(Boolean)
    const out: string[][] = []
    const prefix: string[] = []
    for (let i = 0; i < schema.levels.length; i += 1) {
      const pool = facets.filter((f) => {
        for (let k = 0; k < prefix.length; k += 1) if (f?.chain[k] !== prefix[k]) return false
        return true
      })
      out.push(collectFacetValues(pool, i))
      const picked = draft[i]?.trim()
      if (!picked) break
      prefix.push(picked)
    }
    return out
  }, [nodes, schema, draft])

  if (!schema) return null

  /** 空值截断到第一个空洞之前（与 FacetRow 同一规则：不允许中间留空） */
  const chainOf = (values: string[]): string[] | null => {
    const chain: string[] = []
    for (const value of values) {
      const trimmed = (value ?? '').trim()
      if (!trimmed) break
      chain.push(trimmed)
    }
    return chain.length > 0 ? chain : null
  }

  const openPanel = (): void => {
    // 预填：若选中的卡片已有一致分级，带出来方便微调
    const firstFacet = nodeIds
      .map((id) => nodes.find((n) => n.id === id)?.data.facet)
      .find((f) => f?.chain.length)
    const next = schema.levels.map((_, i) => firstFacet?.chain[i] ?? '')
    setDraft(next)
    setOpen(true)
  }

  const apply = (values: string[]): void => {
    setOpen(false)
    void setNodesFacet(nodeIds, chainOf(values))
  }

  return (
    <ChipSelect
      icon={<Layers size={13} />}
      label="设置分级"
      title={`为选中的 ${nodeIds.length} 张卡片设置分级（${schema.label}）`}
      open={open}
      onOpenChange={(next) => (next ? openPanel() : setOpen(false))}
      minWidth={280}
    >
      {(close) => (
        <div className="flex flex-col gap-1.5 p-1">
          <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-(--on-surface-muted)">
            {schema.label} · {schema.levels.map((l) => l.label).join(' / ')}
          </div>
          {schema.levels.map((level, index) => (
            <label key={level.key} className="flex items-center gap-2 px-2">
              <span className="w-8 shrink-0 text-[11px] text-(--on-surface-muted)" title={level.title ?? level.label}>
                {level.label}
              </span>
              <input
                autoFocus={index === 0}
                value={draft[index] ?? ''}
                list={`huabu-facet-level-${level.key}`}
                onChange={(e) => {
                  const next = [...draft]
                  next[index] = e.target.value
                  setDraft(next)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    apply(draft)
                  }
                  if (e.key === 'Escape') close()
                }}
                placeholder={level.hint ?? level.title ?? level.label}
                className="min-w-0 flex-1 rounded-lg bg-(--surface-input) px-2 py-1 text-[12px] text-(--on-surface) outline-none ring-1 ring-(--outline-soft) placeholder:text-(--on-surface-muted) focus:ring-(--accent)/60"
              />
              <datalist id={`huabu-facet-level-${level.key}`}>
                {(suggestions[index] ?? []).map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </label>
          ))}
          <div className="mt-0.5 flex items-center gap-1 border-t border-(--outline-soft) px-2 pt-1.5">
            <button
              type="button"
              onClick={() => apply(draft)}
              className="flex-1 rounded-lg bg-(--accent) px-2 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90"
            >
              应用到 {nodeIds.length} 张
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                void setNodesFacet(nodeIds, null)
              }}
              className="rounded-lg px-2 py-1 text-[11.5px] text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--danger)"
              title="清除这些卡片的分级"
            >
              清除
            </button>
          </div>
          <div className="px-2 pb-0.5 text-[10px] leading-relaxed text-(--on-surface-muted)">
            只填到某一层也可以（如只填「集」）；留空的层及其后不再写入。
          </div>
        </div>
      )}
    </ChipSelect>
  )
}
