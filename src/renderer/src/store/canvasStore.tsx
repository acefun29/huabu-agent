import { useEffect, type ReactNode } from 'react'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  AssetLibraryFile,
  ChatContextBreakdownInfo,
  MediaConfirmPayload,
  MediaJobStatus,
  WorkspaceInfo
} from '@shared/ipc'
import { useSettings } from './settingsStore'
import type {
  AssetData,
  AssetGen,
  CanvasNode,
  ChatData,
  ChatMessage,
  DirEntry,
  MaterialLibrary,
  MediaKind,
  MessageAttachment,
  SessionMeta,
  UndoEntry,
  ViewState,
  Workspace
} from '../types'
import { createChatRuntime } from './canvas/chatRuntime'
import { createJobRuntime } from './canvas/jobRuntime'
import { createNodeOps } from './canvas/nodeOps'
import { createLibraryOps } from './canvas/libraryOps'
import {
  BRIDGE_AVAILABLE,
  buildJobCardIndex,
  jobCardIndex,
  settingsBridgeRef,
  zCounter
} from './canvas/shared'

/* 对外契约（T8 拆分前就有的导出符号，消费者按此引用；实现已移入 store/canvas/*） */
export { MEDIA_EXT, MEDIA_LABEL, LIBRARY_ASSET_MIME, ASSET_IDS_MIME, toolArgString } from './canvas/shared'

/**
 * 画布状态（huabuai-proto-v2 最新版数据模型的真实数据层）—— T8 起为装配层。
 *
 * 领域模型（原型 docs/backend-interface.md 第一节）：
 * - 工作区 = 目录 + 素材库 + 一块公用画布 + N 个会话；
 * - 画布上只有文件卡片（引用而非副本），会话不再上画布 —— 会话 = 一段对话历史，
 *   呈现在底部对话坞；新建/切换/删除会话都不动画布；
 * - 会话持久化 = .huabu/sessions/*.jsonl（历史）+ canvas.json v3 meta.sessions（清单）；
 * - 会话里引用素材只传绝对路径（buildReferencePayload 拼进消息文本），文件内容不进上下文；
 * - 生成不是卡片而是一种状态：产物写成新版本挂在原卡片上，产物即素材。
 *
 * 模块布局（T8 四域拆分，本文件只留对外契约 + 装配 + 工作区载入 + 探针）：
 * - canvas/shared.ts        跨域常量、纯函数与模块级可变状态（jobCardIndex/zCounter/settingsBridgeRef）
 * - canvas/chatRuntime.ts   会话域：桥与流式管道、会话生命周期、sendMessage
 * - canvas/jobRuntime.ts    生成任务域：job 事件状态机、任务对账、submitGeneration
 * - canvas/nodeOps.ts       画布节点域：增删/撤销/选中与注入集合
 * - canvas/libraryOps.ts    素材库域：清单、建删库、导入双通道、落库优先级链
 * - canvas/contextCollector.ts  上下文采集（T9/T10 的注入点）
 *
 * 性能契约（性能优化方案 P0-2）：单 zustand store + slice + selector。
 * state 按变化频率分片组织；组件用 selector 精确订阅（如每张卡只订自己的 node 对象），
 * 任一字段变化不再波及无关组件 —— 这是替代旧「巨型 Context」的核心。
 * 全部组件已经 `useCanvasStore(s => ...)` 细粒度订阅。
 */

const CANVAS_SAVE_DEBOUNCE_MS = 800

/** nodes → id 索引的统一重建口：所有写 nodes 的 set 点都必须带上一份（见 nodesById 注释） */
const buildNodeIndex = (nodes: CanvasNode[]): Map<string, CanvasNode> => new Map(nodes.map((n) => [n.id, n]))

interface ConfirmRequest {
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
}

interface ToastState {
  message: string
  actionLabel?: string
  onAction?: () => void
}

interface ViewerTarget {
  nodeId: string
}

/** v1/v2 画布上的会话节点数据（迁移用；v3 起会话进 meta.sessions，画布只有文件卡片） */
interface LegacyChatData {
  title?: string
  sessionFile?: string
  modelId?: string
  forkedFromId?: string
  forkedFromLabel?: string
}

export interface CanvasState {
  /* 启动与工作区 */
  booted: boolean
  bridgeAvailable: boolean
  workspace: Workspace | null
  recents: Array<{ path: string; name: string }>
  openDirDialog: () => Promise<void>
  openWorkspace: (path: string) => Promise<void>
  createWorkspace: (name: string) => Promise<void>

  /* 画布内容（工作区公用，只有文件卡片）—— 低频：拖动/缩放结束才变 */
  nodes: CanvasNode[]
  /**
   * id → 节点索引（随 nodes 同步重建，见 buildNodeIndex）。selector 里 O(1) 查节点，
   * 替代 s.nodes.find 的 O(k×n)：zustand v5 每次任何 set 都会执行 selector，
   * 30Hz 流式 flush 下 find 扫描是纯浪费。Map 引用每次新建没关系——消费方
   * selector 都返回 string key，靠字符串相等防重渲。
   */
  nodesById: Map<string, CanvasNode>
  view: ViewState
  setView: (patch: Partial<ViewState> | ((prev: ViewState) => ViewState)) => void
  selectedAssetIds: string[]
  toggleAssetSelected: (id: string) => void
  /** 框选等场景：整体替换当前选中集 */
  setAssetSelection: (ids: string[]) => void
  injectedAssetIds: string[]
  injectAsset: (id: string) => void
  removeAssetChip: (id: string) => void
  /** 直接拖入会话输入框的临时文件（工作区之外，只传绝对路径给 Agent） */
  tempAttachments: MessageAttachment[]
  removeTempAttachment: (id: string) => void
  activeGenerateId: string | null
  setActiveGenerate: (id: string | null) => void

  /* 节点操作 */
  updateNode: (id: string, updates: Partial<Pick<CanvasNode, 'x' | 'y' | 'width' | 'height' | 'data'>>) => void
  bringToFront: (id: string) => void
  createGenerateNode: (kind: MediaKind, at?: { x: number; y: number }, refs?: string[]) => string
  requestRemoveNode: (id: string) => void
  /** 批量取消钉住（划选后的批量移除）：只删画布上的引用卡片，文件不动 */
  removeNodes: (ids: string[]) => void
  /** 一键清空当前工作区画布（两步确认由调用方做；只移除引用卡片，素材库文件不动） */
  clearCanvas: () => void
  undo: () => void
  canUndo: boolean
  /** @internal 供自动保存订阅与探针使用 */
  undoEntry: UndoEntry | null

  /* 生成卡片 */
  updateGenerate: (nodeId: string, patch: Partial<AssetGen>) => void
  addGenerateRef: (nodeId: string, refId: string) => void
  removeGenerateRef: (nodeId: string, refId: string) => void
  clearGenerateVersions: (nodeId: string) => void
  requestClearGenerateVersions: (nodeId: string) => void
  submitGeneration: (nodeId: string, prompt: string) => Promise<void>

  /* 素材库（工作区级共享；清单由主进程现算） */
  libraries: MaterialLibrary[]
  /** 临时收件箱绝对路径（素材库清单顺带返回；临时附件预览/ reveal 用） */
  inboxDir: string | null
  refreshLibraries: () => Promise<void>
  createLibrary: (name: string) => Promise<void>
  removeLibrary: (id: string) => Promise<void>
  importFromLibrary: (libraryId: string, entry: AssetLibraryFile, at?: { x: number; y: number }) => void
  /** 落库优先级链：卡片手动指定 > 类型默认 > 全局默认 > 公共库 */
  resolveOutputLibrary: (kind: MediaKind, overrideId?: string) => MaterialLibrary | undefined

  /* 导入 */
  dirFiles: DirEntry[]
  refreshDirFiles: () => Promise<void>
  importFromDirectory: (entry: DirEntry) => void
  /** 拖到画布上的 OS 文件：归档进 assets/<分类>/ 并钉卡片（asset:import-canvas） */
  dropFilesToCanvas: (files: File[], at?: { x: number; y: number }) => Promise<void>
  /** 拖进会话输入框的 OS 文件：复制到 inbox（asset:import-temp），只传绝对路径 */
  dropFilesToComposer: (files: File[]) => Promise<void>

  /* 拖拽归档（asset:transfer）：目标 = 素材库条目 */
  /** 画布卡片（回形针手柄）拖到素材库条目：移动文件，卡片引用改指新位置 */
  moveAssetsToLibrary: (nodeIds: string[], libraryId: string) => Promise<void>
  /** 素材库文件条目拖到另一个库：移动（同库拦截） */
  moveLibraryFile: (fromLibraryId: string, entry: AssetLibraryFile, toLibraryId: string) => Promise<void>
  /** OS 外部文件拖到素材库条目：复制进该库目录 */
  dropFilesToLibrary: (files: File[], libraryId: string) => Promise<void>

  /* 标签与笔记 */
  /** 设置卡片标签（写 .huabu/tags.json，同一文件的多张卡同步） */
  setNodeTags: (nodeId: string, tags: string[]) => Promise<void>
  /** 新建 md 笔记：落公共素材库并钉到画布（返回卡片 id；失败 null） */
  createNote: (title?: string) => Promise<string | null>

  /* 素材删除 / 重命名（破坏性操作在调用方走 requestConfirm 二次确认） */
  /** 删除素材文件：真删 + 引用它的画布卡片与选中/注入项一并清理 */
  deleteAsset: (entry: { name: string; relPath: string }) => Promise<void>
  /** 重命名素材：磁盘改名（重名加序号）+ 画布卡片引用同步改指新路径 */
  renameAsset: (entry: { name: string; relPath: string }, newName: string) => Promise<void>

  /* 会话（= 一段对话历史，呈现在底部对话坞；画布公用，会话操作不碰画布）—— 高频（流式） */
  sessions: SessionMeta[]
  /** 全部会话的对话历史（key = sessionId）。@internal：组件请订阅 activeChat */
  chatsMap: Record<string, ChatData>
  activeSessionId: string | null
  /** 当前会话的对话历史（底部对话坞的数据源） */
  activeChat: ChatData | null
  switchSession: (id: string) => void
  createSession: (title?: string) => string
  forkSession: (sourceId: string) => Promise<void>
  requestRemoveSession: (id: string) => void
  /** 批量删除：任一所选带历史则统一确认一次；onDone 在移除完成后回调（确认取消则不触发） */
  requestRemoveSessions: (ids: string[], onDone?: () => void) => void
  renameSession: (id: string, title: string) => void
  /** 会话中途切换模型（已建会话即时生效；未建会话暂存到创建时） */
  setSessionModel: (sessionId: string, modelId: string) => Promise<void>
  /** 会话中途设置思考档位 */
  setSessionThinking: (sessionId: string, level: string) => Promise<void>
  sendMessage: (text: string) => Promise<void>
  stopChat: (sessionId: string) => Promise<void>
  /** 手动压缩会话上下文（T2；门控在 runChatCommand/compactGate：running/compacting 时拦截） */
  compactSession: (sessionId: string) => Promise<void>
  /** 上下文分布明细（T3；水位条展开面板时按需拉取） */
  fetchContextBreakdown: (sessionId: string) => Promise<ChatContextBreakdownInfo | null>
  /**
   * 斜杠命令分发（/compact、/fork）。'not-command' = 调用方按普通消息发送；
   * 'ok' 已执行；'unknown'/'rejected' 已拦截（toast 说明，输入保留）。
   */
  runChatCommand: (raw: string) => Promise<'not-command' | 'ok' | 'unknown' | 'rejected'>
  /** 当前会话是否正在流式生成（Composer 发送按钮的禁用态） */
  isChatRunning: boolean

  /* 轻提示 / 确认 / 查看器 */
  toast: ToastState | null
  showToast: (message: string, action?: { label: string; onAction: () => void }) => void
  confirm: ConfirmRequest | null
  requestConfirm: (request: ConfirmRequest) => void
  dismissConfirm: () => void
  viewer: ViewerTarget | null
  openViewer: (nodeId: string) => void
  closeViewer: () => void

  /* 变更前确认（media.accessMode='confirm'：Agent 生成工具提交前弹确认卡，Composer 渲染） */
  /** 变更前确认：挂起中的确认卡（Agent 生成工具提交前） */
  pendingApprovals: MediaConfirmPayload[]
  /** 确认卡回执：接受/拒绝（调 IPC 后由 onConfirmResolved 撤卡，这里只发回执） */
  resolveApproval: (requestId: string, accepted: boolean) => void

  /* 分步演示（操作引导浮层） */
  guideOpen: boolean
  openGuide: () => void
  closeGuide: () => void

  /* @internal：Provider 引导 / 自动保存 / 探针用，业务组件不要订阅 */
  refreshWorkspaceState: () => Promise<void>
  handleJobEvent: (job: MediaJobStatus) => void
  saveCanvasNow: () => Promise<void>
}

/** 画布载入期间不触发自动保存（避免把「恢复中」的中间态写回去） */
let hydrated = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let toastTimer: number | null = null
/** 性能基准（pnpm bench）用的流式模拟定时器 */
let benchStreamTimer: number | null = null

export const useCanvasStore = create<CanvasState>()(
  subscribeWithSelector((set, get) => {
    /* ---------------- 内部工具（跨域注入） ---------------- */

    const showToast = (message: string, action?: { label: string; onAction: () => void }) => {
      set({ toast: { message, ...(action ?? {}) } })
      if (toastTimer) window.clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => set({ toast: null }), action ? 6000 : 2400)
    }

    /** 节点集合的唯一修改口 */
    const applyNodes = (fn: (prev: CanvasNode[]) => CanvasNode[]) => {
      set((s) => {
        const nodes = fn(s.nodes)
        return { nodes, nodesById: buildNodeIndex(nodes) }
      })
    }

    const mutateNodeData = (id: string, fn: (data: AssetData) => AssetData) => {
      applyNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: fn(n.data) } : n)))
    }

    /** 会话清单的定向修改 */
    const applySessions = (fn: (prev: SessionMeta[]) => SessionMeta[]) => {
      set((s) => ({ sessions: fn(s.sessions) }))
    }

    /** chatsMap / activeSessionId 的唯一写入口：一并重算 activeChat / isChatRunning 派生字段 */
    const recomputeChatDerived = (chatsMap: Record<string, ChatData>, activeSessionId: string | null) => {
      const active = activeSessionId ? chatsMap[activeSessionId] : undefined
      return {
        activeChat: activeSessionId ? (chatsMap[activeSessionId] ?? null) : null,
        isChatRunning: Boolean(active?.running)
      }
    }

    /** 对话历史的定向修改：流式回填等异步流必须带 sessionId，避免切会话错写 */
    const patchChat = (sessionId: string, fn: (d: ChatData) => ChatData) => {
      set((s) => {
        const chat = s.chatsMap[sessionId]
        if (!chat) return s
        const chatsMap = { ...s.chatsMap, [sessionId]: fn(chat) }
        return { chatsMap, ...recomputeChatDerived(chatsMap, s.activeSessionId) }
      })
    }

    /** 会话切换时的瞬时态清理（选中/注入/生成激活都是「这一轮」的，不跟会话走） */
    const clearTransient = () => {
      set({ activeGenerateId: null, selectedAssetIds: [], injectedAssetIds: [], tempAttachments: [] })
    }

    /* ---------------- 画布快照（canvas.json v3） ---------------- */

    const toSnapshot = () => {
      const s = get()
      return {
        version: 3 as const,
        savedAt: new Date().toISOString(),
        meta: {
          activeSessionId: s.activeSessionId,
          view: s.view,
          sessions: s.sessions
        },
        nodes: s.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          zIndex: node.zIndex,
          data: node.data as unknown
        }))
      }
    }

    const saveCanvasNow = async () => {
      if (!get().workspace || !BRIDGE_AVAILABLE) return
      const result = await window.huabu.workspace.saveCanvas(toSnapshot())
      if (!result.ok) console.warn('[canvas] 保存画布失败：', result.error)
    }

    /* ---------------- 四域装配（显式 deps 注入，无循环 import） ---------------- */

    const chat = createChatRuntime({
      set,
      get,
      showToast,
      applyNodes,
      applySessions,
      patchChat,
      recomputeChatDerived,
      clearTransient
    })

    const job = createJobRuntime({ set, get, showToast, applyNodes, mutateNodeData })

    const node = createNodeOps({ set, get, showToast, applyNodes })

    const library = createLibraryOps({ set, get, showToast, applyNodes })

    /* ---------------- 工作区：打开 / 切换 / 载入画布 ---------------- */

    const loadWorkspaceCanvas = async () => {
      hydrated = false
      const result = await window.huabu.workspace.loadCanvas()
      const restored: CanvasNode[] = []
      let restoredSessions: SessionMeta[] = []
      let metaActiveSession: string | null = null
      let metaView: ViewState | null = null
      if (result.ok && result.value) {
        const snapshot = result.value
        metaView = snapshot.meta?.view ?? null
        for (const raw of snapshot.nodes) {
          if (!raw || typeof raw !== 'object') continue
          if (typeof raw.id !== 'string' || !raw.data || typeof raw.data !== 'object') continue
          if (raw.type === 'asset') {
            restored.push({
              id: raw.id,
              type: 'asset',
              x: typeof raw.x === 'number' ? raw.x : 80,
              y: typeof raw.y === 'number' ? raw.y : 80,
              width: typeof raw.width === 'number' ? raw.width : 240,
              height: typeof raw.height === 'number' ? raw.height : 230,
              zIndex: typeof raw.zIndex === 'number' ? raw.zIndex : 1,
              data: raw.data as AssetData
            })
          } else if (raw.type === 'chat') {
            // v1/v2 迁移：画布会话节点 → 会话清单条目（卡片本身丢弃）
            const legacy = raw.data as LegacyChatData
            restoredSessions.push({
              id: raw.id,
              title: legacy.title ?? '会话',
              ...(legacy.sessionFile ? { sessionFile: legacy.sessionFile } : {}),
              ...(legacy.modelId ? { modelId: legacy.modelId } : {}),
              ...(legacy.forkedFromId ? { forkedFromId: legacy.forkedFromId } : {}),
              ...(legacy.forkedFromLabel ? { forkedFromLabel: legacy.forkedFromLabel } : {}),
              createdAt: snapshot.savedAt
            })
          }
        }
        if (snapshot.version === 3 && Array.isArray(snapshot.meta?.sessions)) {
          // v3：会话清单在 meta.sessions（权威来源，覆盖 v1/v2 迁移路径的结果）
          restoredSessions = snapshot.meta.sessions
            .filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string')
            .map((s) => ({
              id: s.id,
              title: s.title,
              ...(s.sessionFile ? { sessionFile: s.sessionFile } : {}),
              ...(s.modelId ? { modelId: s.modelId } : {}),
              ...(s.thinkingLevel ? { thinkingLevel: s.thinkingLevel } : {}),
              ...(s.forkedFromId ? { forkedFromId: s.forkedFromId } : {}),
              ...(s.forkedFromLabel ? { forkedFromLabel: s.forkedFromLabel } : {}),
              createdAt: typeof s.createdAt === 'string' ? s.createdAt : snapshot.savedAt
            }))
          metaActiveSession = snapshot.meta?.activeSessionId ?? null
        } else {
          metaActiveSession = snapshot.meta?.activeChatId ?? null
        }
      } else if (!result.ok) {
        console.warn('[canvas] 载入画布失败：', result.error)
      }
      const maxZ = restored.reduce((max, node) => Math.max(max, node.zIndex), 10)
      zCounter.current = maxZ + 1
      // 重建任务绑定索引：重载后同一任务的后续事件依然只由既有卡片承接
      jobCardIndex.clear()
      for (const [k, v] of buildJobCardIndex(restored)) jobCardIndex.set(k, v)
      // 会话清单 + 空的对话历史槽（历史随后按 sessionFile 回放）
      const chats: Record<string, ChatData> = {}
      for (const s of restoredSessions) chats[s.id] = { title: s.title, history: [] }
      const restoredActive =
        metaActiveSession && restoredSessions.some((s) => s.id === metaActiveSession)
          ? metaActiveSession
          : (restoredSessions[0]?.id ?? null)
      hydrated = true
      set({
        nodes: restored,
        nodesById: buildNodeIndex(restored),
        view: metaView ?? { x: 0, y: 0, scale: 1 },
        sessions: restoredSessions,
        chatsMap: chats,
        selectedAssetIds: [],
        injectedAssetIds: [],
        tempAttachments: [],
        activeGenerateId: null,
        activeSessionId: restoredActive,
        ...recomputeChatDerived(chats, restoredActive)
      })
      // 回放会话历史（按 sessionFile）+ 任务对账（都在节点/会话就位之后）
      for (const s of restoredSessions) {
        if (s.sessionFile) void chat.replayChatHistory(s.id, s.sessionFile)
      }
      await job.reconcileJobs()
    }

    const switchToWorkspace = async (info: WorkspaceInfo) => {
      // 注意：此刻主进程的当前工作区已经切换（openDialog/openPath/create 都在 IPC 里先切换
      // 再返回），所以「切走前落盘」必须发生在发起这些 IPC 之前 —— 由各调用方负责。
      chat.disposeAllBridges()
      const next: Workspace = { path: info.path, name: info.name }
      set((s) => ({
        workspace: next,
        recents: [{ path: info.path, name: info.name }, ...s.recents.filter((r) => r.path !== info.path)]
      }))
      await loadWorkspaceCanvas()
      settingsBridgeRef.current?.refreshAll()
      void library.refreshLibraries()
    }

    const refreshWorkspaceState = async () => {
      if (!BRIDGE_AVAILABLE) {
        set({ booted: true })
        return
      }
      const state = await window.huabu.workspace.state()
      set({ recents: state.recents.map((r) => ({ path: r.path, name: r.name })) })
      if (state.workspace) {
        await switchToWorkspace(state.workspace)
      }
      set({ booted: true })
    }

    /* ---------------- 视口与工作区入口 ---------------- */

    const setView = (patch: Partial<ViewState> | ((prev: ViewState) => ViewState)) => {
      set((s) => {
        const next = typeof patch === 'function' ? patch(s.view) : { ...s.view, ...patch }
        return { view: next }
      })
    }

    const openDirDialog = async () => {
      if (!BRIDGE_AVAILABLE) return
      // 打开系统对话框前先落盘：对话框/切换 IPC 都会改变主进程的当前工作区
      await saveCanvasNow()
      const result = await window.huabu.workspace.openDialog()
      if (result.cancelled || !result.workspace) return
      await switchToWorkspace(result.workspace)
    }

    const openWorkspace = async (path: string) => {
      if (!BRIDGE_AVAILABLE) return
      // 切换 IPC 会先改主进程当前目录再返回，旧画布必须先落盘
      await saveCanvasNow()
      const result = await window.huabu.workspace.openPath(path)
      if (!result.ok) {
        showToast(`打开工作区失败：${result.error}`)
        return
      }
      await switchToWorkspace(result.value.workspace)
    }

    const createWorkspace = async (name: string) => {
      if (!BRIDGE_AVAILABLE) return
      // 新建即切换：切换 IPC 会改主进程当前目录，旧画布必须先落盘
      await saveCanvasNow()
      const result = await window.huabu.workspace.create(name)
      if (!result.ok) {
        showToast(`新建工作区失败：${result.error}`)
        return
      }
      await switchToWorkspace(result.value.workspace)
      showToast(`已创建工作区 ${result.value.workspace.name}`)
    }

    return {
      /* ---- state ---- */
      booted: false,
      bridgeAvailable: BRIDGE_AVAILABLE,
      workspace: null,
      recents: [],
      nodes: [],
      nodesById: buildNodeIndex([]),
      view: { x: 0, y: 0, scale: 1 },
      selectedAssetIds: [],
      injectedAssetIds: [],
      tempAttachments: [],
      activeGenerateId: null,
      libraries: [],
      inboxDir: null,
      dirFiles: [],
      sessions: [],
      chatsMap: {},
      activeSessionId: null,
      activeChat: null,
      isChatRunning: false,
      toast: null,
      confirm: null,
      viewer: null,
      pendingApprovals: [],
      undoEntry: null,
      canUndo: false,
      guideOpen: false,

      /* ---- actions ---- */
      openDirDialog,
      openWorkspace,
      createWorkspace,
      setView,
      ...node,
      ...job,
      ...library,
      ...chat,
      showToast,
      requestConfirm: (request: ConfirmRequest) => set({ confirm: request }),
      dismissConfirm: () => set({ confirm: null }),
      // 本地不先移除：等主进程 onConfirmResolved 广播统一撤卡，保证多窗口一致
      resolveApproval: (requestId, accepted) => {
        void window.huabu.media.resolveConfirm(requestId, accepted)
      },
      openViewer: (nodeId: string) => set({ viewer: { nodeId } }),
      closeViewer: () => set({ viewer: null }),
      openGuide: () => set({ guideOpen: true }),
      closeGuide: () => set({ guideOpen: false }),
      refreshWorkspaceState,
      handleJobEvent: job.handleJobEvent,
      saveCanvasNow
    }
  })
)

/* ------------------------------------------------------------------ */
/* 自动保存：任何画布/会话变化（节点/视口/会话清单/活动会话）都防抖落盘          */
/* ------------------------------------------------------------------ */

function shallowEqualArray<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

useCanvasStore.subscribe(
  (s) => [s.nodes, s.view, s.sessions, s.activeSessionId, s.workspace] as const,
  () => {
    if (!useCanvasStore.getState().workspace || !hydrated) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void useCanvasStore.getState().saveCanvasNow()
    }, CANVAS_SAVE_DEBOUNCE_MS)
  },
  { equalityFn: shallowEqualArray }
)

/* ------------------------------------------------------------------ */
/* Provider：引导（IPC 事件订阅 + 启动恢复）+ settings 桥 + dev 探针         */
/* ------------------------------------------------------------------ */

/**
 * E2E 探针钩子（仅 dev 构建）：让 CDP 探针驱动与 UI 按钮完全相同的 store action，
 * 而不是绕过 UI 直接打 IPC —— 后者验不到「用户实际看到的东西」。
 * 生产构建下这个分支被 Vite 静态消除，不暴露任何内部状态。
 */
function installCanvasProbe() {
  if (!import.meta.env.DEV) return
  ;(window as unknown as Record<string, unknown>)['__huabuCanvas'] = {
    state: () => {
      const s = useCanvasStore.getState()
      return {
        nodes: s.nodes,
        view: s.view,
        workspace: s.workspace,
        sessions: s.sessions,
        chats: s.chatsMap,
        activeSessionId: s.activeSessionId,
        activeGenerateId: s.activeGenerateId,
        selectedAssetIds: s.selectedAssetIds,
        injectedAssetIds: s.injectedAssetIds,
        tempAttachments: s.tempAttachments,
        dirFiles: s.dirFiles,
        libraries: s.libraries,
        booted: s.booted
      }
    },
    actions: {
      createSession: useCanvasStore.getState().createSession,
      forkSession: useCanvasStore.getState().forkSession,
      requestRemoveSession: useCanvasStore.getState().requestRemoveSession,
      switchSession: useCanvasStore.getState().switchSession,
      createGenerateNode: useCanvasStore.getState().createGenerateNode,
      requestRemoveNode: useCanvasStore.getState().requestRemoveNode,
      removeNodes: useCanvasStore.getState().removeNodes,
      clearCanvas: useCanvasStore.getState().clearCanvas,
      requestClearGenerateVersions: useCanvasStore.getState().requestClearGenerateVersions,
      undo: useCanvasStore.getState().undo,
      setActiveGenerate: useCanvasStore.getState().setActiveGenerate,
      setAssetSelection: useCanvasStore.getState().setAssetSelection,
      injectAsset: useCanvasStore.getState().injectAsset,
      importFromDirectory: useCanvasStore.getState().importFromDirectory,
      importFromLibrary: useCanvasStore.getState().importFromLibrary,
      dropFilesToCanvas: useCanvasStore.getState().dropFilesToCanvas,
      dropFilesToComposer: useCanvasStore.getState().dropFilesToComposer,
      submitGeneration: useCanvasStore.getState().submitGeneration,
      updateGenerate: useCanvasStore.getState().updateGenerate,
      sendMessage: useCanvasStore.getState().sendMessage,
      stopChat: useCanvasStore.getState().stopChat,
      compactSession: useCanvasStore.getState().compactSession,
      fetchContextBreakdown: useCanvasStore.getState().fetchContextBreakdown,
      runChatCommand: useCanvasStore.getState().runChatCommand,
      openViewer: useCanvasStore.getState().openViewer,
      closeViewer: useCanvasStore.getState().closeViewer,
      openWorkspace: useCanvasStore.getState().openWorkspace,
      createWorkspace: useCanvasStore.getState().createWorkspace,
      refreshDirFiles: useCanvasStore.getState().refreshDirFiles,
      refreshLibraries: useCanvasStore.getState().refreshLibraries,
      refreshSettings: () => {
        void settingsBridgeRef.current?.refreshAll()
      },
      updateNode: useCanvasStore.getState().updateNode,
      setView: useCanvasStore.getState().setView
    },
    /** 性能基准专用（scripts/perf-bench.mjs）：合成节点与模拟流式，不耗模型额度 */
    bench: {
      /** 在画布上铺合成卡片：images（工作区相对路径，bench 脚本先写好真实位图）× perImage + gens 张生成卡；返回全部 id */
      plant: (opts: { images: string[]; perImage: number; gens: number }): string[] => {
        const created: CanvasNode[] = []
        const ids: string[] = []
        const push = (node: CanvasNode) => {
          ids.push(node.id)
          created.push(node)
        }
        const total = opts.images.length * opts.perImage
        const cols = Math.max(1, Math.ceil(Math.sqrt(total)))
        for (let fi = 0; fi < opts.images.length; fi += 1) {
          for (let i = 0; i < opts.perImage; i += 1) {
            const idx = created.length
            zCounter.current += 1
            push({
              id: crypto.randomUUID(),
              type: 'asset',
              x: (idx % cols) * 300,
              y: Math.floor(idx / cols) * 290,
              width: 240,
              height: 230,
              zIndex: zCounter.current,
              data: {
                name: `bench-img-${fi}-${i}`,
                kind: 'image',
                storage: 'ws',
                path: opts.images[fi],
                bytes: 2_300_000,
                meta: 'bench'
              } satisfies AssetData
            })
          }
        }
        for (let i = 0; i < opts.gens; i += 1) {
          const idx = created.length
          zCounter.current += 1
          push({
            id: crypto.randomUUID(),
            type: 'asset',
            x: (idx % cols) * 340,
            y: Math.floor(idx / cols) * 450,
            width: 320,
            height: 430,
            zIndex: zCounter.current,
            data: {
              name: `bench-gen-${i}`,
              kind: 'image',
              gen: {
                prompt: 'bench 基准卡片提示词',
                refs: [],
                params: { ratio: '1:1' },
                status: 'idle',
                progress: 0,
                versions: []
              }
            } satisfies AssetData
          })
        }
        // bench 直写 state 也要同步重建节点索引（与 applyNodes 同一契约）
        useCanvasStore.setState((prev) => {
          const nodes = [...prev.nodes, ...created]
          return { nodes, nodesById: buildNodeIndex(nodes) }
        })
        return ids
      },
      /** 以给定频率模拟一路流式输出（走真实渲染路径：blocks → markdown） */
      streamStart: (hz = 20): boolean => {
        const s = useCanvasStore.getState()
        const sid = s.activeSessionId && s.sessions.some((x) => x.id === s.activeSessionId) ? s.activeSessionId : s.createSession('bench')
        const sessionId = sid as string
        const modelId = 'bench-stream-model'
        const appended: ChatMessage[] = [
          { id: 'bench-stream-user', role: 'user', content: 'bench' },
          { id: modelId, role: 'model', content: '', streaming: true, blocks: [] }
        ]
        useCanvasStore.setState((prev) => {
          const chat = prev.chatsMap[sessionId]
          const chatsMap = {
            ...prev.chatsMap,
            [sessionId]: {
              ...(chat ?? { title: 'bench', history: [] }),
              running: true,
              history: [...(chat?.history ?? []), ...appended]
            }
          }
          const active = prev.activeSessionId ? chatsMap[prev.activeSessionId] : undefined
          return { chatsMap, activeChat: prev.activeSessionId ? (chatsMap[prev.activeSessionId] ?? null) : null, isChatRunning: Boolean(active?.running) }
        })
        const chunk = '性能基准流式输出模拟：这是一段用于渲染压力测试的中文文本，带少量 markdown 如 **加粗** 与 `code`。'
        benchStreamTimer = window.setInterval(() => {
          useCanvasStore.setState((prev) => {
            const chat = prev.chatsMap[sessionId]
            if (!chat) return prev
            const history = chat.history.slice()
            const last = history[history.length - 1]
            if (!last || last.id !== modelId) return prev
            const prevText = last.blocks && last.blocks[0]?.kind === 'text' ? last.blocks[0].text : ''
            const text = prevText + chunk
            history[history.length - 1] = { ...last, content: text, blocks: [{ kind: 'text', text }] }
            const chatsMap = { ...prev.chatsMap, [sessionId]: { ...chat, history } }
            const active = prev.activeSessionId ? chatsMap[prev.activeSessionId] : undefined
            return { chatsMap, activeChat: prev.activeSessionId ? (chatsMap[prev.activeSessionId] ?? null) : null, isChatRunning: Boolean(active?.running) }
          })
        }, Math.max(16, Math.round(1000 / hz)))
        return true
      },
      streamStop: () => {
        if (benchStreamTimer) window.clearInterval(benchStreamTimer)
        benchStreamTimer = null
        const sid = useCanvasStore.getState().activeSessionId
        if (!sid) return
        useCanvasStore.setState((prev) => {
          const chat = prev.chatsMap[sid]
          if (!chat) return prev
          const history = chat.history.slice()
          const last = history[history.length - 1]
          if (last && last.streaming) history[history.length - 1] = { ...last, streaming: false }
          const chatsMap = { ...prev.chatsMap, [sid]: { ...chat, history, running: false } }
          const active = prev.activeSessionId ? chatsMap[prev.activeSessionId] : undefined
          return { chatsMap, activeChat: prev.activeSessionId ? (chatsMap[prev.activeSessionId] ?? null) : null, isChatRunning: Boolean(active?.running) }
        })
      }
    }
  }
}

/** Provider 引导：settings 桥 + 启动恢复 + IPC 事件订阅（挂载一次） */
function useCanvasBootstrap() {
  useEffect(() => {
    installCanvasProbe()
    void useCanvasStore.getState().refreshWorkspaceState()
    if (!BRIDGE_AVAILABLE) return
    const unsubJob = window.huabu.media.onJobEvent((job) => useCanvasStore.getState().handleJobEvent(job))
    const unsubAsset = window.huabu.asset.onChanged(() => {
      void useCanvasStore.getState().refreshLibraries()
    })
    const unsubConfirm = window.huabu.media.onConfirmRequest((payload) =>
      useCanvasStore.setState((s) =>
        s.pendingApprovals.some((p) => p.requestId === payload.requestId)
          ? s
          : { pendingApprovals: [...s.pendingApprovals, payload] }
      )
    )
    const unsubConfirmResolved = window.huabu.media.onConfirmResolved(({ requestId }) =>
      useCanvasStore.setState((s) => ({ pendingApprovals: s.pendingApprovals.filter((p) => p.requestId !== requestId) }))
    )
    return () => {
      unsubJob()
      unsubAsset()
      unsubConfirm()
      unsubConfirmResolved()
    }
    // 仅启动时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

export function CanvasProvider({ children }: { children: ReactNode }) {
  // settings 仍是 Context：把最新实例交给 store action 跨域调用（resolveMediaModel / refreshAll 等）
  const settings = useSettings()
  // 渲染体里直接写 ref 是渲染期副作用（StrictMode 双渲染会双写），移到提交后同步；
  // 不写依赖数组 = 每次渲染后都刷新为最新实例。卸载时刻意不清空：bridge 语义是
  // 「最近一次挂载的实例」，清空反而让卸载瞬间在途的跨域调用读不到 settings。
  useEffect(() => {
    settingsBridgeRef.current = settings
  })
  useCanvasBootstrap()
  return <>{children}</>
}
