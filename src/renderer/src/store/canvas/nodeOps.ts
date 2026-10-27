import type { CanvasNode } from '../../types'
import type { CanvasState } from '../canvasStore'
import type { StoreSet } from './chatRuntime'
import { jobCardIndex, zCounter } from './shared'

/**
 * 画布节点域（T8 拆分）：卡片 = 图钉（引用而非副本），删除不动文件、也不清理
 * 其他卡片对它的参考引用（保留失效占位，撤销恢复后自动复活）；删除一律可撤销
 * （undoEntry 单步）。
 * 选中/注入集合（selectedAssetIds / injectedAssetIds / tempAttachments）的
 * 增删也在这里 —— 它们是 contextCollector 的输入，语义是"这一轮递给助手的料"。
 * 生成产物卡由 jobRuntime 直接 spawn（贴参考来源落位），本域不再提供建卡入口。
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

  /**
   * 执行删除：卡片只是图钉，删除不动文件；也不清理其他卡片对被删卡片的参考 ——
   * 引用保留为失效占位（getCardReferences 照常读出，校验报缺失），撤销恢复
   * 后引用自动复活。删除同时清掉内存运行态（jobStates），在途任务的后续事件
   * 会重新建卡承接。
   */
  const performRemove = (ids: string[]) => {
    const removed = get().nodes.filter((n) => ids.includes(n.id))
    if (removed.length === 0) return
    // 解除被删卡片持有的任务绑定：该任务后续事件重新建卡，而不是被误判为已有承接
    for (const [jobId, nodeId] of jobCardIndex) {
      if (ids.includes(nodeId)) jobCardIndex.delete(jobId)
    }
    applyNodes((prev) => prev.filter((n) => !ids.includes(n.id)))
    set((s) => {
      let jobStates = s.jobStates
      for (const id of ids) {
        if (id in jobStates) {
          const next = { ...jobStates }
          delete next[id]
          jobStates = next
        }
      }
      return {
        jobStates,
        selectedAssetIds: s.selectedAssetIds.filter((x) => !ids.includes(x)),
        injectedAssetIds: s.injectedAssetIds.filter((x) => !ids.includes(x)),
        undoEntry: {
          nodes: removed,
          label: removed[0]?.data.name ?? '卡片'
        },
        canUndo: true
      }
    })
  }

  const undo = () => {
    const entry = get().undoEntry
    if (!entry) return
    zCounter.current += entry.nodes.length
    let z = zCounter.current
    applyNodes((prev) => [...prev, ...entry.nodes.map((node) => ({ ...node, zIndex: (z += 1) }))])
    // 恢复被删卡片时同步恢复任务绑定（生成中的卡片要继续被事件定位与进度显示）
    for (const node of entry.nodes) {
      const jobId = node.data.pendingJob?.jobId
      if (jobId) jobCardIndex.set(jobId, node.id)
    }
    set({ undoEntry: null, canUndo: false })
    showToast('已撤销删除')
  }

  /** 删除入口：带生成历史的卡片先确认，其余直接删 + 可撤销 */
  const requestRemoveNode = (id: string) => {
    const node = get().nodes.find((n) => n.id === id)
    if (!node) return
    const data = node.data
    if ((data.versions?.length ?? 0) > 0) {
      set({
        confirm: {
          title: `删除卡片「${data.name}」？`,
          body: '全部版本记录与引用链将一并消失，无法恢复；已生成的文件仍留在工作目录。',
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
    toggleAssetSelected,
    setAssetSelection,
    injectAsset,
    removeAssetChip,
    removeTempAttachment,
    requestRemoveNode,
    removeNodes,
    clearCanvas,
    undo
  }
}
