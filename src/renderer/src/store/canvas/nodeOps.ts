import { DEFAULT_MEDIA_DURATION_S, DEFAULT_MEDIA_RATIO } from '@shared/media'
import type { AssetData, CanvasNode, MediaKind, UndoEntry } from '../../types'
import type { CanvasState } from '../canvasStore'
import type { StoreSet } from './chatRuntime'
import { MEDIA_LABEL, jobCardIndex, newNodeId, settingsBridgeRef, spawnOffset, zCounter } from './shared'

/**
 * 画布节点域（T8 拆分）：卡片 = 图钉（引用而非副本），删除不动文件；
 * 生成卡片清理任务绑定与悬空引用；删除一律可撤销（undoEntry 单步）。
 * 选中/注入集合（selectedAssetIds / injectedAssetIds / tempAttachments）的
 * 增删也在这里 —— 它们是 contextCollector 的输入，语义是"这一轮递给助手的料"。
 */

export interface NodeOpsDeps {
  set: StoreSet
  get: () => CanvasState
  showToast: CanvasState['showToast']
  applyNodes: (fn: (prev: CanvasNode[]) => CanvasNode[]) => void
}

export function createNodeOps(deps: NodeOpsDeps) {
  const { set, get, showToast, applyNodes } = deps

  const updateNode = (id: string, updates: Partial<Pick<CanvasNode, 'x' | 'y' | 'width' | 'height' | 'data'>>) => {
    applyNodes((prev) => prev.map((n) => (n.id === id ? { ...n, ...updates } : n)))
  }

  const bringToFront = (id: string) => {
    zCounter.current += 1
    const z = zCounter.current
    applyNodes((prev) => prev.map((n) => (n.id === id ? { ...n, zIndex: z } : n)))
  }

  const setActiveGenerate = (id: string | null) => {
    set({ activeGenerateId: id ?? null })
  }

  const toggleAssetSelected = (id: string) => {
    set((s) => ({
      selectedAssetIds: s.selectedAssetIds.includes(id)
        ? s.selectedAssetIds.filter((x) => x !== id)
        : [...s.selectedAssetIds, id]
    }))
  }

  /** 框选/批量操作：整体替换当前选中集 */
  const setAssetSelection = (ids: string[]) => {
    set({ selectedAssetIds: ids })
  }

  /** 拖入底部输入框：加入上下文（chip 持久保留，既成事实） */
  const injectAsset = (id: string) => {
    set((s) => ({
      selectedAssetIds: s.selectedAssetIds.includes(id) ? s.selectedAssetIds : [...s.selectedAssetIds, id],
      injectedAssetIds: s.injectedAssetIds.includes(id) ? s.injectedAssetIds : [...s.injectedAssetIds, id]
    }))
  }

  const removeAssetChip = (id: string) => {
    set((s) => ({
      selectedAssetIds: s.selectedAssetIds.filter((x) => x !== id),
      injectedAssetIds: s.injectedAssetIds.filter((x) => x !== id)
    }))
  }

  const removeTempAttachment = (id: string) => {
    set((s) => ({ tempAttachments: s.tempAttachments.filter((a) => a.id !== id) }))
  }

  const createGenerateNode = (kind: MediaKind, at?: { x: number; y: number }, refs?: string[]) => {
    const id = newNodeId()
    zCounter.current += 1
    const offset = spawnOffset(get().nodes)
    applyNodes((prev) => [
      ...prev,
      {
        id,
        type: 'asset',
        x: at?.x ?? 280 + offset,
        y: at?.y ?? 200 + offset,
        width: 320,
        height: kind === 'image' ? 430 : 470,
        zIndex: zCounter.current,
        data: {
          name: `未命名${MEDIA_LABEL[kind]}`,
          kind,
          gen: {
            prompt: '',
            refs: refs ?? [],
            params: {
              ratio: settingsBridgeRef.current?.mediaStatus?.defaultRatio ?? DEFAULT_MEDIA_RATIO,
              durationSeconds: kind === 'image' ? undefined : settingsBridgeRef.current?.mediaStatus?.defaultDuration ?? DEFAULT_MEDIA_DURATION_S
            },
            status: 'idle',
            progress: 0,
            versions: []
          }
        } satisfies AssetData
      } satisfies CanvasNode
    ])
    set({ activeGenerateId: id })
    return id
  }

  /** 执行删除：卡片只是图钉，删除不动文件；生成卡片清理任务绑定与悬空引用 */
  const performRemove = (ids: string[]) => {
    const removed = get().nodes.filter((n) => ids.includes(n.id))
    if (removed.length === 0) return
    // 解除被删卡片持有的任务绑定：该任务后续事件重新建卡，而不是被误判为已有承接
    for (const [jobId, nodeId] of jobCardIndex) {
      if (ids.includes(nodeId)) jobCardIndex.delete(jobId)
    }
    applyNodes((prev) =>
      prev
        .filter((n) => !ids.includes(n.id))
        .map((n) => {
          // 清理生成卡片对已删参考的悬空引用
          const data = n.data
          if (!data.gen || data.gen.refs.every((r) => !ids.includes(r))) return n
          return { ...n, data: { ...data, gen: { ...data.gen, refs: data.gen.refs.filter((r) => !ids.includes(r)) } } }
        })
    )
    const activeGenerateId = get().activeGenerateId
    set((s) => ({
      activeGenerateId: activeGenerateId && ids.includes(activeGenerateId) ? null : activeGenerateId,
      selectedAssetIds: s.selectedAssetIds.filter((x) => !ids.includes(x)),
      injectedAssetIds: s.injectedAssetIds.filter((x) => !ids.includes(x)),
      undoEntry: {
        nodes: removed,
        label: removed[0]?.data.name ?? '卡片',
        wasActiveGenerate: Boolean(activeGenerateId && ids.includes(activeGenerateId))
      } satisfies UndoEntry,
      canUndo: true
    }))
  }

  const undo = () => {
    const entry = get().undoEntry
    if (!entry) return
    zCounter.current += entry.nodes.length
    let z = zCounter.current
    applyNodes((prev) => [...prev, ...entry.nodes.map((node) => ({ ...node, zIndex: (z += 1) }))])
    // 恢复被删卡片时同步恢复任务绑定（生成中的卡片要继续被事件定位）
    for (const node of entry.nodes) {
      const jobId = node.data.gen?.jobId
      if (jobId) jobCardIndex.set(jobId, node.id)
    }
    for (const node of entry.nodes) {
      if (entry.wasActiveGenerate) setActiveGenerate(node.id)
    }
    set({ undoEntry: null, canUndo: false })
    showToast('已撤销删除')
  }

  /** 删除入口：有版本的生成卡片先确认，其余直接删 + 可撤销 */
  const requestRemoveNode = (id: string) => {
    const node = get().nodes.find((n) => n.id === id)
    if (!node) return
    const data = node.data
    if (data.gen && data.gen.versions.length > 0) {
      set({
        confirm: {
          title: `删除生成卡片「${data.name}」？`,
          body: '提示词、参考与全部版本记录将一并消失，无法恢复；已生成的文件仍留在工作目录。',
          confirmLabel: '删除卡片',
          danger: true,
          onConfirm: () => performRemove([id])
        }
      })
      return
    }
    performRemove([id])
    showToast(`已删除「${data.name}」`, {
      label: '撤销',
      onAction: () => undo()
    })
  }

  /** 批量取消钉住（划选后的批量移除）：只删画布上的引用卡片，文件不动 */
  const removeNodes = (ids: string[]) => {
    performRemove(ids)
  }

  /** 一键清空画布：只清「画布上钉住的引用」，素材库/工作目录里的文件一个不动 */
  const clearCanvas = () => {
    const count = get().nodes.length
    if (count === 0) {
      showToast('画布已是空的')
      return
    }
    performRemove(get().nodes.map((n) => n.id))
    showToast(`已清空画布（移除 ${count} 张引用卡片，素材库文件不受影响）`, {
      label: '撤销',
      onAction: () => undo()
    })
  }

  return {
    updateNode,
    bringToFront,
    setActiveGenerate,
    toggleAssetSelected,
    setAssetSelection,
    injectAsset,
    removeAssetChip,
    removeTempAttachment,
    createGenerateNode,
    requestRemoveNode,
    removeNodes,
    clearCanvas,
    undo
  }
}

export type NodeOps = ReturnType<typeof createNodeOps>
