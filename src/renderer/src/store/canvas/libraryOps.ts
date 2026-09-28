import type { AssetLibraryFile } from '@shared/ipc'
import { assetDirForKind, MEDIA_ROOT_REL } from '@shared/assets'
import { KIND_LABEL, type AssetData, type CanvasNode, type DirEntry, type MaterialLibrary, type MediaKind, type MessageAttachment } from '../../types'
import type { CanvasState } from '../canvasStore'
import type { StoreSet } from './chatRuntime'
import { BUILTIN_LIBRARY, BRIDGE_AVAILABLE, newNodeId, settingsBridgeRef, spawnOffset, zCounter } from './shared'

/**
 * 素材库域（T8 拆分）：工作区级共享，清单由主进程现算（asset:libraries），
 * 渲染端只存清单与 inboxDir。三条通道：
 *
 * - 库管理：建库/删库（删库只删映射，文件退回「未归类」，画布引用清 libraryId）；
 * - 钉卡片：从素材库/工作目录文件钉引用卡片（storage:'ws'，引用而非副本）；
 * - OS 文件双通道导入：拖上画布 = 归档进 assets/<分类>/ 并钉卡（@backend(import-canvas)），
 *   拖进输入框 = 复制到 inbox 只传绝对路径（@backend(import-temp)）。
 *
 * 落库优先级链（resolveOutputLibrary）是生成产物的落库裁决口，画布卡片提交
 * 与主进程 Agent 工具路径共用同一语义（'builtin-assets' = 画布素材，'none' = 不落库）。
 */

export interface LibraryOpsDeps {
  set: StoreSet
  get: () => CanvasState
  showToast: CanvasState['showToast']
  applyNodes: (fn: (prev: CanvasNode[]) => CanvasNode[]) => void
}

export function createLibraryOps(deps: LibraryOpsDeps) {
  const { set, get, showToast, applyNodes } = deps

  const refreshLibraries = async () => {
    if (!BRIDGE_AVAILABLE || !get().workspace) return
    const result = await window.huabu.asset.libraries()
    if (!result.ok) return
    set({ libraries: result.value.libraries, inboxDir: result.value.inboxDir })
  }

  const refreshDirFiles = async () => {
    if (!BRIDGE_AVAILABLE || !get().workspace) return
    const result = await window.huabu.workspace.files()
    if (!result.ok) return
    set({
      dirFiles: result.value.map((f) => ({ name: f.name, kind: f.kind, path: f.relPath, bytes: f.bytes }))
    })
  }

  const createLibrary = async (name: string) => {
    if (!BRIDGE_AVAILABLE) return
    const result = await window.huabu.asset.createLibrary(name)
    if (!result.ok) {
      showToast(`创建素材库失败：${result.error}`)
      return
    }
    showToast(`已创建素材库「${result.value.name}」（映射 ${result.value.path}/）`)
    await refreshLibraries()
  }

  /** 删库 = 只删映射：库内文件退回「未归类」，画布引用与磁盘文件都不动 */
  const removeLibrary = async (id: string) => {
    if (!BRIDGE_AVAILABLE) return
    const lib = get().libraries.find((l) => l.id === id)
    if (!lib || lib.isPublic || lib.builtin) return
    const result = await window.huabu.asset.removeLibrary(id)
    if (!result.ok) {
      showToast(`移除素材库失败：${result.error}`)
      return
    }
    // 画布卡片上的 libraryId 引用退回未归类
    applyNodes((prev) =>
      prev.map((n) => {
        if (n.data.libraryId !== id) return n
        const { libraryId: _drop, ...rest } = n.data
        void _drop
        return { ...n, data: rest }
      })
    )
    showToast(`已移除素材库「${lib.name}」（文件仍在工作目录，引用退回未归类）`)
    await refreshLibraries()
  }

  /** 从素材库钉引用卡片到公用画布：只存引用，不复制文件 */
  const importFromLibrary = (libraryId: string, entry: AssetLibraryFile, at?: { x: number; y: number }) => {
    const lib = get().libraries.find((l) => l.id === libraryId)
    if (!lib) return
    const nodeId = newNodeId()
    zCounter.current += 1
    const offset = spawnOffset(get().nodes)
    applyNodes((prev) => [
      ...prev,
      {
        id: nodeId,
        type: 'asset',
        x: at?.x ?? 80 + offset,
        y: at?.y ?? 100 + offset,
        width: 240,
        height: 230,
        zIndex: zCounter.current,
        data: {
          name: entry.name,
          kind: entry.kind,
          storage: 'ws',
          path: entry.relPath,
          libraryId: lib.id,
          bytes: entry.bytes,
          meta: KIND_LABEL[entry.kind]
        } satisfies AssetData
      } satisfies CanvasNode
    ])
    // 新钉的卡片自动选中 = 立刻递给助手
    set((s) => ({
      selectedAssetIds: s.selectedAssetIds.includes(nodeId) ? s.selectedAssetIds : [...s.selectedAssetIds, nodeId]
    }))
    showToast(`已钉入引用：${lib.name} / ${entry.name}`)
  }

  const importFromDirectory = (entry: DirEntry) => {
    const id = newNodeId()
    zCounter.current += 1
    const offset = spawnOffset(get().nodes)
    applyNodes((prev) => [
      ...prev,
      {
        id,
        type: 'asset',
        x: 200 + offset,
        y: 160 + offset,
        width: 240,
        height: 230,
        zIndex: zCounter.current,
        data: {
          name: entry.name,
          kind: entry.kind,
          storage: 'ws',
          path: entry.path,
          meta: KIND_LABEL[entry.kind]
        } satisfies AssetData
      } satisfies CanvasNode
    ])
    // 新钉的卡片自动选中 = 立刻递给助手
    set((s) => ({
      selectedAssetIds: s.selectedAssetIds.includes(id) ? s.selectedAssetIds : [...s.selectedAssetIds, id]
    }))
    showToast(`已导入 ${entry.path}`)
  }

  /**
   * @backend(import-canvas)：OS 文件拖上画布 → 归档进 <工作区>/assets/<分类>/ 并钉卡片。
   * 卡片 = 归档后工作区文件的引用（storage: 'ws'）。
   */
  const dropFilesToCanvas = async (files: File[], at?: { x: number; y: number }) => {
    if (!BRIDGE_AVAILABLE || files.length === 0) return
    const items: Array<{ sourcePath: string; name: string; mime?: string }> = []
    for (const file of files) {
      const sourcePath = window.huabu.media.pathForFile(file)
      if (!sourcePath) {
        showToast(`无法导入 ${file.name}（没有磁盘路径）`)
        continue
      }
      items.push({ sourcePath, name: file.name, ...(file.type ? { mime: file.type } : {}) })
    }
    if (items.length === 0) return
    const result = await window.huabu.asset.importCanvas({ files: items })
    if (!result.ok) {
      showToast(`导入失败：${result.error}`)
      return
    }
    for (const f of result.value.failed) showToast(`导入失败：${f.name}（${f.error}）`)
    const base = at ?? { x: 160, y: 140 }
    const createdIds: string[] = []
    const created: CanvasNode[] = []
    // 循环内只构建节点攒进 created，循环外一次 applyNodes 提交：
    // 逐文件 set 会造成 N 轮渲染风暴 + N 次 autosave 防抖重置
    result.value.imported.forEach((asset, index) => {
      const id = newNodeId()
      createdIds.push(id)
      zCounter.current += 1
      created.push({
        id,
        type: 'asset',
        x: base.x + index * 28,
        y: base.y + index * 28,
        width: 240,
        height: 230,
        zIndex: zCounter.current,
        data: {
          name: asset.name,
          kind: asset.kind,
          storage: 'ws',
          path: asset.relPath,
          mime: asset.mime,
          bytes: asset.bytes,
          meta: KIND_LABEL[asset.kind]
        } satisfies AssetData
      } satisfies CanvasNode)
    })
    // 空列表跳过：与旧行为一致（imported 为空时不动 nodes，nodesById 由 applyNodes 内部重建）
    if (created.length > 0) applyNodes((prev) => [...prev, ...created])
    set({ selectedAssetIds: createdIds })
    if (createdIds.length > 0) {
      showToast(`已把 ${createdIds.length} 个文件归档进素材库（assets/<分类>/）并钉到画布`)
    }
  }

  /**
   * @backend(import-temp)：OS 文件拖进会话输入框 → 复制到工作区之外的 inbox，
   * 只把绝对路径作为临时引用（不进素材库）。
   */
  const dropFilesToComposer = async (files: File[]) => {
    if (!BRIDGE_AVAILABLE || files.length === 0) return
    const items: Array<{ sourcePath: string; name: string; mime?: string }> = []
    for (const file of files) {
      const sourcePath = window.huabu.media.pathForFile(file)
      if (!sourcePath) {
        showToast(`无法附加 ${file.name}（没有磁盘路径）`)
        continue
      }
      items.push({ sourcePath, name: file.name, ...(file.type ? { mime: file.type } : {}) })
    }
    if (items.length === 0) return
    const result = await window.huabu.asset.importTemp({ files: items })
    if (!result.ok) {
      showToast(`附加失败：${result.error}`)
      return
    }
    for (const f of result.value.failed) showToast(`附加失败：${f.name}（${f.error}）`)
    const staged: MessageAttachment[] = result.value.imported.map((asset) => ({
      id: crypto.randomUUID(),
      name: asset.name,
      kind: asset.kind,
      absPath: asset.absPath,
      origin: 'temp-upload' as const
    }))
    if (staged.length > 0) {
      set((s) => ({ tempAttachments: [...s.tempAttachments, ...staged] }))
      showToast(`已附加 ${staged.length} 个临时文件（存放于工作区外的 inbox，只把路径传给 Agent）`)
    }
  }

  /**
   * 落库优先级链：卡片手动指定 > 类型默认 > 全局默认 > 公共库 > 画布素材（按 kind 归类）。
   * 特殊值：'builtin-assets' = 画布素材（映射到分类子目录，面板可见的前提）；
   * 'none' = 仅产物目录（不进素材库）；未配置任何默认时同样兜底画布素材——
   * 生成物"本地有文件但素材库看不到"的体验缺口由此封死。
   */
  const resolveOutputLibrary = (kind: MediaKind, overrideId?: string): MaterialLibrary | undefined => {
    const libraries = get().libraries
    const media = settingsBridgeRef.current?.mediaStatus
    const byId = (id?: string): MaterialLibrary | undefined => {
      if (!id) return undefined
      if (id === BUILTIN_LIBRARY) {
        // 虚拟条目：path 按媒体大类映射到分类子目录（assets/images 等）
        return { id: BUILTIN_LIBRARY, name: '画布素材', path: assetDirForKind(kind), files: [] }
      }
      return libraries.find((l) => l.id === id)
    }
    if (overrideId === 'none' || media?.defaultLibraryId === 'none') return undefined
    return (
      byId(overrideId) ??
      byId(media?.kindLibraryDefaults?.[kind]) ??
      byId(media?.defaultLibraryId) ??
      libraries.find((l) => l.isPublic) ??
      byId(BUILTIN_LIBRARY)
    )
  }

  /* ---------------- 拖拽归档（asset:transfer）：画布卡/库条目移动，OS 文件复制 ---------------- */

  /** 卡片（或其历史版本）的工作区相对路径：media 形态 = pathRoot/path，ws 形态 = path */
  const nodeRelPath = (ref: { storage?: 'media' | 'ws'; path?: string; pathRoot?: string }): string | null => {
    if (!ref.path) return null
    return ref.storage === 'media' ? `${(ref.pathRoot ?? MEDIA_ROOT_REL).replace(/\/+$/, '')}/${ref.path}` : ref.path
  }

  const libraryName = (id: string): string =>
    get().libraries.find((l) => l.id === id)?.name ?? (id === BUILTIN_LIBRARY ? '画布素材' : id)

  /**
   * 移动结果回写画布：引用该文件的卡片（含生成卡片的当前版本与历史版本）改指新位置。
   * 移动后文件一定在工作区内（库目录都在工作区根下），storage 统一成 ws、pathRoot 作废。
   */
  const applyMovedToNodes = (moved: Array<{ from: string; to: string; name: string }>, libraryId: string) => {
    if (moved.length === 0) return
    const byFrom = new Map(moved.map((m) => [m.from, m]))
    applyNodes((prev) =>
      prev.map((node) => {
        const data = node.data
        if (!data) return node
        const hit = byFrom.get(nodeRelPath(data) ?? '')
        let nextData: AssetData | undefined
        if (hit) {
          const { pathRoot: _drop, ...rest } = data
          void _drop
          nextData = { ...rest, name: hit.name, storage: 'ws', path: hit.to, libraryId }
        } else if (data.gen) {
          // 生成卡片：历史版本里引用同一文件的条目也要跟上（它们是独立的旧版本文件，
          // 只有路径恰好等于本次被移动文件的那条才会命中）
          let touched = false
          const versions = data.gen.versions.map((v) => {
            const vHit = byFrom.get(nodeRelPath(v) ?? '')
            if (!vHit) return v
            touched = true
            const { pathRoot: _vDrop, ...rest } = v
            void _vDrop
            return { ...rest, name: vHit.name, storage: 'ws' as const, path: vHit.to }
          })
          if (!touched) return node
          nextData = { ...data, gen: { ...data.gen, versions } }
        }
        return nextData ? { ...node, data: nextData } : node
      })
    )
  }

  /** 画布卡片（回形针手柄拖到素材库条目）→ 移动文件到目标库；卡片引用改指新位置 */
  const moveAssetsToLibrary = async (nodeIds: string[], libraryId: string) => {
    if (!BRIDGE_AVAILABLE || nodeIds.length === 0) return
    const nodes = get().nodes
    const movePaths: string[] = []
    for (const id of nodeIds) {
      const rel = nodeRelPath(nodes.find((n) => n.id === id)?.data ?? {})
      if (rel) movePaths.push(rel)
    }
    if (movePaths.length === 0) {
      showToast('这些卡片没有落盘文件，无法归档')
      return
    }
    const result = await window.huabu.asset.transfer({ libraryId, movePaths })
    if (!result.ok) {
      showToast(`移动失败：${result.error}`)
      return
    }
    for (const f of result.value.failed) showToast(`移动失败：${f.name}（${f.error}）`)
    applyMovedToNodes(result.value.moved, libraryId)
    if (result.value.moved.length > 0) {
      showToast(`已移动 ${result.value.moved.length} 个素材到「${libraryName(libraryId)}」`)
    }
    await refreshLibraries()
  }

  /** 素材库文件条目 → 拖到另一个库 = 移动（同一面板内跨库归档） */
  const moveLibraryFile = async (fromLibraryId: string, entry: AssetLibraryFile, toLibraryId: string) => {
    if (!BRIDGE_AVAILABLE) return
    if (fromLibraryId === toLibraryId) {
      showToast('该文件已在此库中')
      return
    }
    const result = await window.huabu.asset.transfer({ libraryId: toLibraryId, movePaths: [entry.relPath] })
    if (!result.ok) {
      showToast(`移动失败：${result.error}`)
      return
    }
    for (const f of result.value.failed) showToast(`移动失败：${f.name}（${f.error}）`)
    applyMovedToNodes(result.value.moved, toLibraryId)
    if (result.value.moved.length > 0) {
      showToast(`已把「${entry.name}」移动到「${libraryName(toLibraryId)}」`)
    }
    await refreshLibraries()
  }

  /** OS 外部文件 → 拖到素材库条目 = 复制进该库目录（画布卡/库条目是移动，外部文件是复制） */
  const dropFilesToLibrary = async (files: File[], libraryId: string) => {
    if (!BRIDGE_AVAILABLE || files.length === 0) return
    const copyFiles: Array<{ sourcePath: string; name: string; mime?: string }> = []
    for (const file of files) {
      const sourcePath = window.huabu.media.pathForFile(file)
      if (!sourcePath) {
        showToast(`无法导入 ${file.name}（没有磁盘路径）`)
        continue
      }
      copyFiles.push({ sourcePath, name: file.name, ...(file.type ? { mime: file.type } : {}) })
    }
    if (copyFiles.length === 0) return
    const result = await window.huabu.asset.transfer({ libraryId, copyFiles })
    if (!result.ok) {
      showToast(`导入失败：${result.error}`)
      return
    }
    for (const f of result.value.failed) showToast(`导入失败：${f.name}（${f.error}）`)
    if (result.value.copied.length > 0) {
      showToast(`已复制 ${result.value.copied.length} 个文件进「${libraryName(libraryId)}」`)
    }
    await refreshLibraries()
  }

  /* ---------------- 标签与笔记（文件级元数据 + md 文档） ---------------- */

  /**
   * 设置卡片标签：写主进程 .huabu/tags.json（清洗后的标签为准），卡片与素材库条目同源刷新。
   * media 形态产物同样可打标签（key = 工作区相对路径）。
   */
  const setNodeTags = async (nodeId: string, tags: string[]) => {
    if (!BRIDGE_AVAILABLE) return
    const data = get().nodes.find((n) => n.id === nodeId)?.data
    const relPath = data ? nodeRelPath(data) : null
    if (!data || !relPath) {
      showToast('该卡片没有落盘文件，无法打标签')
      return
    }
    const result = await window.huabu.asset.setTags(relPath, tags)
    if (!result.ok) {
      showToast(`设置标签失败：${result.error}`)
      return
    }
    const cleaned = result.value.tags
    applyNodes((prev) =>
      prev.map((n) => {
        // 同一文件的多张卡同步（标签是文件级的）
        const d = n.data
        if (!d || nodeRelPath(d) !== relPath) return n
        return { ...n, data: { ...d, ...(cleaned.length > 0 ? { tags: cleaned } : { tags: undefined }) } }
      })
    )
    await refreshLibraries()
  }

  /**
   * 删除素材：真删磁盘文件（UI 层负责二次确认），引用它的画布卡片一并移除
   * （卡片只是引用，文件没了卡片就是死链；生成卡的历史版本是独立文件，不受影响）。
   */
  const deleteAsset = async (entry: { name: string; relPath: string }) => {
    if (!BRIDGE_AVAILABLE) return
    const result = await window.huabu.asset.deleteAsset(entry.relPath)
    if (!result.ok) {
      showToast(`删除失败：${result.error}`)
      return
    }
    // 先快照将被移除的卡片 id（选中/注入集清理用），再移除节点
    const doomed = new Set(
      get()
        .nodes.filter((n) => nodeRelPath(n.data) === entry.relPath)
        .map((n) => n.id)
    )
    applyNodes((prev) => prev.filter((n) => nodeRelPath(n.data) !== entry.relPath))
    if (doomed.size > 0) {
      set((s) => ({
        selectedAssetIds: s.selectedAssetIds.filter((id) => !doomed.has(id)),
        injectedAssetIds: s.injectedAssetIds.filter((id) => !doomed.has(id))
      }))
    }
    showToast(`已删除 ${entry.name}（文件与画布引用卡片）`)
    await refreshLibraries()
  }

  /**
   * 重命名素材：磁盘同目录改名（主进程净化 + 重名加序号），引用该文件的画布卡片
   * （含生成卡历史版本里的同路径条目）同步改指新路径。media 形态产物改名后统一转 ws 引用。
   */
  const renameAsset = async (entry: { name: string; relPath: string }, newName: string) => {
    if (!BRIDGE_AVAILABLE) return
    const result = await window.huabu.asset.renameAsset(entry.relPath, newName)
    if (!result.ok) {
      showToast(`重命名失败：${result.error}`)
      return
    }
    const { relPath: newRel, name: finalName } = result.value
    applyNodes((prev) =>
      prev.map((n) => {
        const d = n.data
        if (!d) return n
        if (nodeRelPath(d) === entry.relPath) {
          const { pathRoot: _drop, ...rest } = d
          void _drop
          return { ...n, data: { ...rest, name: finalName, storage: 'ws' as const, path: newRel } }
        }
        if (d.gen) {
          let touched = false
          const versions = d.gen.versions.map((v) => {
            if (nodeRelPath(v) !== entry.relPath) return v
            touched = true
            const { pathRoot: _vDrop, ...rest } = v
            void _vDrop
            return { ...rest, name: finalName, storage: 'ws' as const, path: newRel }
          })
          if (!touched) return n
          return { ...n, data: { ...d, gen: { ...d.gen, versions } } }
        }
        return n
      })
    )
    showToast(finalName === newName ? `已重命名为 ${finalName}` : `已重命名为 ${finalName}（原名被占用，自动加序号）`)
    await refreshLibraries()
  }

  /**
   * 新建 md 笔记：落公共素材库（兜底第一个库/文档分类目录）并钉卡选中。
   * 文件写入走 workspace:write-file（白名单 .md，原子写）。
   */
  const createNote = async (title?: string): Promise<string | null> => {
    if (!BRIDGE_AVAILABLE) return null
    const t = (title?.trim() || '新笔记').replace(/[\\/:*?"<>|]/g, '').slice(0, 16)
    const stamp = new Date().toISOString().slice(11, 16).replace(':', '')
    const name = `${t}-${stamp}.md`
    const libs = get().libraries
    const lib = libs.find((l) => l.isPublic && !l.builtin) ?? libs.find((l) => !l.builtin) ?? null
    const relPath = lib ? `${lib.path.replace(/\/+$/, '')}/${name}` : `assets/documents/${name}`
    const write = await window.huabu.workspace.writeFile(relPath, `# ${t}\n\n`)
    if (!write.ok) {
      showToast(`创建笔记失败：${write.error}`)
      return null
    }
    const nodeId = newNodeId()
    zCounter.current += 1
    const offset = spawnOffset(get().nodes)
    applyNodes((prev) => [
      ...prev,
      {
        id: nodeId,
        type: 'asset',
        x: 160 + offset,
        y: 130 + offset,
        width: 260,
        height: 300,
        zIndex: zCounter.current,
        data: {
          name,
          kind: 'doc',
          storage: 'ws',
          path: relPath,
          ...(lib ? { libraryId: lib.id } : {}),
          tags: [],
          meta: '2 行'
        } satisfies AssetData
      } satisfies CanvasNode
    ])
    set((s) => ({ selectedAssetIds: [...s.selectedAssetIds, nodeId] }))
    showToast(`已创建笔记 ${name}（md，落在「${lib?.name ?? '画布素材'}」）`)
    await refreshLibraries()
    return nodeId
  }

  return {
    refreshLibraries,
    refreshDirFiles,
    createLibrary,
    removeLibrary,
    importFromLibrary,
    importFromDirectory,
    dropFilesToCanvas,
    dropFilesToComposer,
    resolveOutputLibrary,
    moveAssetsToLibrary,
    moveLibraryFile,
    dropFilesToLibrary,
    setNodeTags,
    createNote,
    deleteAsset,
    renameAsset
  }
}

export type LibraryOps = ReturnType<typeof createLibraryOps>
