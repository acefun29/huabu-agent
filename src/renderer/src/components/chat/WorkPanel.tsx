import { useMemo } from 'react'
import { FileText } from 'lucide-react'
import { useCanvasStore } from '../../store/canvasStore'
import { buildWorkGroups, textArtifacts, visualArtifacts, type WorkItem } from '../../lib/workModel'
import { assetSrc } from '../../lib/media'
import { nodeRelPath } from '../../lib/workspacePath'
import { StatusWord } from './StatusWord'

/**
 * 工作项面板：按任务看现在在做的事。
 *
 * 画布按空间摆产物，面板按任务归拢——同一个产物两边都能看到，不是重复。
 * 已完成的交付不进面板：面板回答的是「现在在做什么」。
 */
export function WorkPanel({ onClose }: { onClose: () => void }) {
  const state = useCanvasStore((s) => s.workState)
  const nodes = useCanvasStore((s) => s.nodes)
  const dropWorkItem = useCanvasStore((s) => s.dropWorkItem)
  const openViewer = useCanvasStore((s) => s.openViewer)

  const groups = useMemo(() => buildWorkGroups(state), [state])

  /** 产物路径 → 画布节点 id：有卡片就放大看，没有就交给系统打开 */
  const nodeByPath = useMemo(() => {
    const map = new Map<string, string>()
    for (const node of nodes) {
      const rel = nodeRelPath(node.data)
      if (rel) map.set(rel, node.id)
    }
    return map
  }, [nodes])

  const reveal = (path: string): void => {
    const nodeId = nodeByPath.get(path)
    if (nodeId) {
      openViewer(nodeId)
      onClose()
      return
    }
    void window.huabu.workspace.reveal(path)
  }

  const renderArtifacts = (item: WorkItem) => {
    const visual = visualArtifacts(item)
    const texts = textArtifacts(item)
    if (visual.length === 0 && texts.length === 0) {
      return <div className="mt-1.5 text-[10.5px] text-(--on-surface-muted) opacity-80">还没有产出</div>
    }
    return (
      <>
        {visual.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {visual.map((artifact, index) => {
              const src = assetSrc({ storage: 'ws', path: artifact.path }, 512)
              return (
                <button
                  key={artifact.id}
                  type="button"
                  onClick={() => reveal(artifact.path)}
                  title={`${artifact.path} · 第 ${index + 1} 版`}
                  className="relative h-[38px] w-[56px] shrink-0 overflow-hidden rounded-md bg-(--surface-chip) ring-1 ring-(--outline-soft) transition-transform hover:scale-[1.03]"
                >
                  {src ? (
                    <img src={src} alt="" className="size-full object-cover" draggable={false} />
                  ) : null}
                  <span className="absolute bottom-0.5 right-0.5 rounded bg-black/55 px-1 text-[8.5px] font-semibold text-white">
                    第 {index + 1} 版
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {texts.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            onClick={() => reveal(artifact.path)}
            title={artifact.path}
            className="mt-1.5 flex w-full items-center gap-1.5 rounded-lg bg-(--surface-chip) px-2 py-1.5 text-left text-[10.5px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
          >
            <FileText size={11} className="shrink-0" />
            <span className="min-w-0 truncate">{artifact.path}</span>
          </button>
        ))}
      </>
    )
  }

  const empty = groups.doing.length === 0 && groups.todo.length === 0

  return (
    <div
      role="dialog"
      aria-label="工作项"
      data-testid="work-panel"
      className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[min(420px,60vh)] overflow-y-auto rounded-2xl bg-(--surface-card) p-1.5 shadow-[0_16px_40px_rgba(0,0,0,.16)] ring-1 ring-(--outline-soft)"
      data-scrollable=""
    >
      <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">
          工作项
        </span>
        <span className="text-[10px] text-(--on-surface-muted)">
          {groups.doing.length} 个进行中 · {groups.todo.length} 个待办
        </span>
      </div>

      {empty ? (
        <div className="px-3 py-6 text-center text-[12px] leading-relaxed text-(--on-surface-muted)">
          现在没有在做的事。
          <br />
          在输入框说一句，就会开一个任务。
        </div>
      ) : (
        <>
          {groups.doing.map((item) => (
            <div key={item.id} className="rounded-xl bg-(--accent)/6 px-2 py-1.5 ring-1 ring-(--outline-soft)">
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 rounded bg-(--surface-chip) px-1 py-px text-[9.5px] font-semibold text-(--on-surface-variant)">
                  {item.id}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-(--on-surface)">
                  {item.title}
                </span>
                <StatusWord status={item.status} />
              </div>
              <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-[1.45] text-(--on-surface-muted)">
                {item.brief}
              </div>
              <div className="mt-0.5 text-[9.5px] text-(--on-surface-muted) opacity-85">
                写区 {item.lane}/
              </div>
              {renderArtifacts(item)}
            </div>
          ))}

          {groups.todo.length > 0 && (
            <>
              <div className="mx-2 mt-2 border-t border-(--outline-soft) pt-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-(--on-surface-muted)">
                待办
              </div>
              {groups.todo.map((item) => (
                <div key={item.id} className="rounded-xl px-2 py-1.5 transition-colors hover:bg-(--surface-chip)">
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0 rounded bg-(--surface-chip) px-1 py-px text-[9.5px] font-semibold text-(--on-surface-variant)">
                      {item.id}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-(--on-surface)">
                      {item.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => void dropWorkItem(item.id)}
                      title="放弃这个任务（产物保留）"
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] text-(--on-surface-muted) ring-1 ring-(--outline) transition-colors hover:bg-(--surface-chip) hover:text-(--on-surface)"
                    >
                      放弃
                    </button>
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-[1.45] text-(--on-surface-muted)">
                    {item.brief}
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      <div className="px-2 pb-1 pt-1.5 text-[9.5px] leading-[1.5] text-(--on-surface-muted)">
        画布放产物，这里放正在做的事。
      </div>
    </div>
  )
}
