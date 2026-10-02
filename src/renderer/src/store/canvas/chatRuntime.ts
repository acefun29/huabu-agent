import { ChatBridge } from '../../lib/agent'
import { ChatErrorCode, type ChatContextBreakdownInfo, type ChatEvent, type ChatHistoryMessage } from '@shared/ipc'
import { compactGate, createStreamState, draftToMessage, mergeStreamHistory, reduceChatEvent, type ChatDraft, type ChatStreamState } from '../../lib/chatStream'
import { isCommandInput, parseChatCommand } from '../../lib/chatCommands'
import { guessKind } from '../../lib/media'
import { buildReferencePayload } from '../../harness/prompt'
import type { AssetData, AssetKind, CanvasNode, ChatData, ChatMessage, SessionMeta } from '../../types'
import type { CanvasState } from '../canvasStore'
import { collectRoundContext } from './contextCollector'
import { BRIDGE_AVAILABLE, BRIDGE_UNAVAILABLE, newNodeId, settingsBridgeRef, spawnOffset, toolArgString, zCounter } from './shared'

/**
 * 会话域（T8 拆分）：会话 = 一段对话历史，呈现在底部对话坞；画布公用，
 * 会话操作不碰画布。这里持有渲染端与主进程的会话桥/流式状态（不可序列化的
 * 模块级 Map 群，旧 Provider 时代 ref 群的直系后代），以及：
 *
 * - 流式事件批处理（P0-3）：delta 缓冲 32ms 一次 fold，控制类事件即时；
 * - write 工具副作用：tool_end 成功后在画布钉产物卡片（pinWrittenFile）；
 * - 会话生命周期：新建/切换/fork/删除/改名（清单在 canvas.json meta.sessions，
 *   历史在 .huabu/sessions/*.jsonl，UI 只存引用）；
 * - 发送（路径引用契约）：collectRoundContext 采集 → buildReferencePayload
 *   拼进消息文本 → bridge.send。
 *
 * store 主体只消费本文件返回的 actions；`@internal` 标记的两个函数供
 * loadWorkspaceCanvas（回放历史）与 switchToWorkspace（切工作区清理）使用。
 */

/** 渲染端与主进程的会话桥/事件归约状态（不可序列化）。key = sessionId */
const bridges = new Map<string, ChatBridge>()
const streams = new Map<string, ChatStreamState>()
const baseLens = new Map<string, number>()
/** write 工具的 toolCallId → 目标路径。值带 sessionId：agent_end / 删会话时按会话
 * 清扫未配对条目（工具被 abort 时 tool_end 永不到达，否则 Map 单调增长） */
const writeToolPaths = new Map<string, { sessionId: string; path: string }>()
/** 历史已回放/已建过的会话（避免重复 replay 覆盖流式中的历史） */
const historyLoaded = new Set<string>()
/** 逐轮注入去重（token 经济）的上轮摘要全文（key = sessionId）：存 collectRoundContext
 * 返回的 digests **全量全文**（非占位），下轮采集时传入比较——一致则折叠为占位行 */
const lastRoundDigests = new Map<string, { library?: string; canvas?: string }>()
/** 逐轮注入去重的 genSummary 签名表（key = sessionId，卡片 id → 签名）：
 * 签名与上轮一致的生成卡片不再重复携带 genSummary 括注 */
const genSummarySeen = new Map<string, Record<string, string>>()

/* ---------------- 流式事件批处理（P0-3）---------------- */
/**
 * delta 事件逐个进 store 的成本（reduce 重建 + 全量 draftToMessage + setState）在
 * token 频率下是浪费：文本流不需要超过 ~30Hz 的提交频率。缓冲到 32ms 定时器一次 fold；
 * 控制类事件（轮起止 / 工具 / 桥错误）保持即时，pinWrittenFile 与 running 切换不延迟。
 */
const IMMEDIATE_CHAT_EVENTS = new Set([
  'agent_start',
  'agent_end',
  'host_error',
  'tool_start',
  'tool_end',
  'tool_update',
  'context_usage',
  'compaction_start',
  'compaction_end'
])
const pendingChatEvents = new Map<string, ChatEvent[]>()
let chatFlushTimer: ReturnType<typeof setTimeout> | null = null

/** draft → ChatMessage 的转换缓存（按 draft 对象身份）：settled 消息引用稳定，流式刷新只重渲染尾部 */
const draftMessageCache = new Map<string, Map<ChatDraft, ChatMessage>>()

/** zustand store 的 setState 窄化签名（域模块只用这两种形态） */
export type StoreSet = (partial: Partial<CanvasState> | ((state: CanvasState) => Partial<CanvasState>)) => void

export interface ChatRuntimeDeps {
  set: StoreSet
  get: () => CanvasState
  showToast: CanvasState['showToast']
  /** 节点集合的唯一修改口（write 工具钉产物卡片用） */
  applyNodes: (fn: (prev: CanvasNode[]) => CanvasNode[]) => void
  /** 会话清单的定向修改 */
  applySessions: (fn: (prev: SessionMeta[]) => SessionMeta[]) => void
  /** 对话历史的定向修改（重算 activeChat/isChatRunning 派生字段） */
  patchChat: (sessionId: string, fn: (d: ChatData) => ChatData) => void
  recomputeChatDerived: (
    chatsMap: Record<string, ChatData>,
    activeSessionId: string | null
  ) => Pick<CanvasState, 'activeChat' | 'isChatRunning'>
  /** 会话切换时的瞬时态清理（选中/注入/生成激活都是「这一轮」的，不跟会话走） */
  clearTransient: () => void
}

export function createChatRuntime(deps: ChatRuntimeDeps) {
  const { set, get, showToast, applyNodes, applySessions, patchChat, recomputeChatDerived, clearTransient } = deps

  const syncChatHistory = (sessionId: string) => {
    const stream = streams.get(sessionId)
    const baseLen = baseLens.get(sessionId) ?? 0
    let cache = draftMessageCache.get(sessionId)
    if (!cache) {
      cache = new Map()
      draftMessageCache.set(sessionId, cache)
    }
    const draftMessages: ChatMessage[] = (stream?.drafts ?? []).map((draft) => {
      const cached = cache!.get(draft)
      // draft 对象身份没变（本轮 flush 没有新事件落到它）→ 复用上次的 ChatMessage，
      // MessageBubble 的 memo 直接跳过；只有正在流式的那条 draft 每次换新对象。
      if (cached) return cached
      const message = draftToMessage(draft)
      message.streaming = !draft.settled
      cache!.set(draft, message)
      return message
    })
    patchChat(sessionId, (chat) => ({
      ...chat,
      running: stream?.running ?? false,
      // 压缩指示独立于 running（自动 threshold 压缩在 turn 之间、running=false 时也会来）
      compacting: stream?.compacting ?? false,
      // 水位留旧值不删除：stream 重置（新一轮发送）后仍显示上一次读数，等下一次推送刷新
      ...(stream?.contextUsage ? { contextUsage: stream.contextUsage } : {}),
      // 三段合并按 id 去重：tail 分隔条可能已被固化进前缀（baseLen 抬高越过它），不能重复追加
      history: mergeStreamHistory(chat.history.slice(0, baseLen), draftMessages, stream?.tail ?? [])
    }))
  }

  /** Agent 用 write 工具写了文件 → 在画布上钉一张产物文件卡片（落点按现有卡片错开） */
  const pinWrittenFile = (sessionId: string, rawPath: string) => {
    const wsRoot = get().workspace?.path
    if (!wsRoot) return
    // write 的 path 是相对工作区的；绝对路径则剥离工作区前缀，越界文件不钉
    let rel = rawPath.replace(/\\/g, '/')
    const rootPrefix = wsRoot.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    if (rel.startsWith(rootPrefix)) rel = rel.slice(rootPrefix.length)
    if (rel.startsWith('/') || rel.includes('..')) return
    const kind: AssetKind = guessKind(rel)
    if (kind !== 'doc' && kind !== 'code') return
    const exists = get().nodes.some((n) => n.data.path === rel && n.data.fromChatId === sessionId)
    if (exists) return
    zCounter.current += 1
    applyNodes((prev) => [
      ...prev,
      {
        id: newNodeId(),
        type: 'asset',
        x: 140 + spawnOffset(prev),
        y: 120 + spawnOffset(prev) + 40,
        width: 240,
        height: 210,
        zIndex: zCounter.current,
        data: {
          name: rel.split('/').pop() ?? rel,
          kind,
          storage: 'ws',
          path: rel,
          meta: 'Agent 写入',
          fromChatId: sessionId
        } satisfies AssetData
      } satisfies CanvasNode
    ])
    showToast(`产物已写入工作目录：${rel}`)
  }

  /** 把缓冲里的事件一次 fold 进流状态并同步一次渲染（write 工具副作用保持原时序语义） */
  const flushChatEvents = () => {
    chatFlushTimer = null
    if (pendingChatEvents.size === 0) return
    const batches = [...pendingChatEvents.entries()]
    pendingChatEvents.clear()
    for (const [sessionId, events] of batches) {
      let state = streams.get(sessionId) ?? createStreamState()
      let sawAgentStart = false
      for (const event of events) {
        if (event.type === 'agent_start') sawAgentStart = true
        state = reduceChatEvent(state, event)
        // write 工具：tool_start 记下目标路径（带 sessionId 供清扫），tool_end 成功后钉产物卡片
        if (event.type === 'tool_start' && event.toolName === 'write') {
          const path = toolArgString(event.args as Record<string, unknown>, 'path')
          if (path) writeToolPaths.set(event.toolCallId, { sessionId, path })
        }
        if (event.type === 'tool_end' && event.toolName === 'write' && !event.isError) {
          const entry = writeToolPaths.get(event.toolCallId)
          writeToolPaths.delete(event.toolCallId)
          if (entry) pinWrittenFile(sessionId, entry.path)
        }
        // 本轮收尾：agent_end 前还没被 tool_end 配对销掉的 write 条目必是 abort/中断遗留
        //（事件流里 tool_end 一定先于 agent_end），按会话清扫，防止 Map 单调增长
        if (event.type === 'agent_end') {
          for (const [callId, entry] of writeToolPaths) {
            if (entry.sessionId === sessionId) writeToolPaths.delete(callId)
          }
        }
      }
      if (sawAgentStart) {
        // 新一轮：旧的 draft→message 缓存整体作废（drafts 已重置）
        draftMessageCache.delete(sessionId)
      }
      streams.set(sessionId, state)
      syncChatHistory(sessionId)
    }
  }

  const handleChatEvent = (sessionId: string, event: ChatEvent) => {
    const buffer = pendingChatEvents.get(sessionId) ?? []
    buffer.push(event)
    pendingChatEvents.set(sessionId, buffer)
    if (IMMEDIATE_CHAT_EVENTS.has(event.type)) {
      if (chatFlushTimer) {
        clearTimeout(chatFlushTimer)
        chatFlushTimer = null
      }
      flushChatEvents()
      return
    }
    if (!chatFlushTimer) {
      chatFlushTimer = setTimeout(flushChatEvents, 32)
    }
  }

  const ensureBridge = (sessionId: string): ChatBridge => {
    let bridge = bridges.get(sessionId)
    if (!bridge) {
      bridge = new ChatBridge({
        nodeId: sessionId,
        onEvent: (event) => handleChatEvent(sessionId, event),
        // 会话创建成功：把 sessionFile/modelId 写回会话清单（canvas.json meta.sessions
        // 只存引用，恢复时按它重绑+回放）
        onBound: (info) => {
          applySessions((prev) =>
            prev.map((s) =>
              s.id === sessionId
                ? {
                    ...s,
                    ...(info.sessionFile ? { sessionFile: info.sessionFile } : {}),
                    modelId: info.modelId,
                    thinkingLevel: info.thinkingLevel
                  }
                : s
            )
          )
        },
        onFailure: (code: ChatErrorCode, message: string) => {
          showToast(`会话错误（${code}）：${message}`)
        }
      })
      bridges.set(sessionId, bridge)
    }
    return bridge
  }

  /**
   * 会话历史回放（T4 结构化）：按 sessionFile 读 JSONL 的结构化解析结果，
   * 映射为与流式同构的 ChatMessage（复用 MessageBubble，零新组件）：
   * blocks（text/thinking/toolCall）+ 图片缩略 + 压缩分隔条 + inContext 淡化标记
   * + 注入段拆分。幂等，每会话只回放一次。
   */
  const replayChatHistory = async (sessionId: string, sessionFile: string) => {
    if (!BRIDGE_AVAILABLE || historyLoaded.has(sessionId)) return
    historyLoaded.add(sessionId)
    const result = await window.huabu.chat.history({ nodeId: sessionId, sessionFile })
    if (!result.ok) {
      console.warn('[canvas] 回放会话历史失败：', result.error)
      return
    }
    const messages: ChatMessage[] = result.value.messages.map((m: ChatHistoryMessage, index) => ({
      id: `${sessionId}-replay-${index}`,
      role: m.role,
      content: m.text,
      ...(m.blocks && m.blocks.length > 0 ? { blocks: m.blocks } : {}),
      ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
      ...(m.entryKind === 'compaction' ? { compaction: m.compaction ?? { summary: m.text } } : {}),
      ...(m.inContext === false ? { inContext: false } : {}),
      ...(m.contextPayload ? { contextPayload: m.contextPayload } : {}),
      ...(m.stopReason === 'error' ? { errorMessage: '（历史消息此前生成失败）' } : {})
    }))
    patchChat(sessionId, (chat) => ({ ...chat, history: messages }))
  }

  /** 会话历史落定了才算 loaded（fork 复制历史、切换回放都依赖它） */
  const ensureHistoryLoaded = async (meta: SessionMeta) => {
    if (historyLoaded.has(meta.id)) return
    if (meta.sessionFile) await replayChatHistory(meta.id, meta.sessionFile)
    else historyLoaded.add(meta.id)
  }

  const disposeAllBridges = () => {
    for (const bridge of bridges.values()) bridge.dispose()
    bridges.clear()
    streams.clear()
    baseLens.clear()
    historyLoaded.clear()
    pendingChatEvents.clear()
    draftMessageCache.clear()
    // 切工作区：所有会话一并清空，逐轮注入去重状态也没有留存价值
    lastRoundDigests.clear()
    genSummarySeen.clear()
    // 切工作区：所有会话一并清空，write 路径条目（含旧 sessionId）没有留存价值
    writeToolPaths.clear()
  }

  const setActiveSessionId = (id: string | null) => {
    set((s) => ({ activeSessionId: id, ...recomputeChatDerived(s.chatsMap, id) }))
  }

  /* ---------------- 会话生命周期 ---------------- */

  /** 新建对话：只建一段空的对话历史，画布保持原样 */
  const createSession = (title?: string): string => {
    const id = newNodeId()
    const t = title?.trim().slice(0, 16) || '新会话'
    const meta: SessionMeta = { id, title: t, createdAt: new Date().toISOString() }
    historyLoaded.add(id)
    set((s) => {
      const chatsMap = { ...s.chatsMap, [id]: { title: t, history: [] } }
      return {
        sessions: [...s.sessions, meta],
        chatsMap,
        activeSessionId: id,
        ...recomputeChatDerived(chatsMap, id)
      }
    })
    clearTransient()
    return id
  }

  const switchSession = (id: string) => {
    if (id === get().activeSessionId) return
    const meta = get().sessions.find((s) => s.id === id)
    if (!meta) return
    setActiveSessionId(id)
    clearTransient()
    // 懒回放：还没载入过历史的老会话在第一次切到时回放
    void ensureHistoryLoaded(meta)
  }

  /**
   * fork（T5 原生文件级分叉）：源会话已有 JSONL → 主进程 SessionManager.forkFrom
   * 全量拷贝（多模态与工具上下文完整带走，水位与母会话同高），新 sessionFile 写进
   * 新 meta，历史在切到新会话时走 T4 结构化回放；
   * 源会话未发问过（无 sessionFile）→ 退回旧的「复制 UI 历史」行为（历史本就是空的）。
   */
  const forkSession = async (sourceId: string) => {
    const source = get().sessions.find((s) => s.id === sourceId)
    if (!source) return
    const id = newNodeId()
    const title = `${source.title} (Fork)`.slice(0, 24)
    const baseMeta: SessionMeta = {
      id,
      title,
      forkedFromId: source.id,
      forkedFromLabel: source.title,
      createdAt: new Date().toISOString()
    }

    if (source.sessionFile && BRIDGE_AVAILABLE) {
      const result = await window.huabu.chat.fork({ nodeId: source.id, sessionFile: source.sessionFile })
      if (!result.ok) {
        showToast(`分叉失败（${result.code}）：${result.error}`)
        return
      }
      const meta: SessionMeta = { ...baseMeta, sessionFile: result.value.sessionFile }
      set((s) => {
        const chatsMap = { ...s.chatsMap, [id]: { title, history: [] } }
        return { sessions: [...s.sessions, meta], chatsMap }
      })
      // 历史槽保持空且不置 historyLoaded：切换时按新 JSONL 结构化回放（工具卡/图全带）
      showToast('已分叉（含完整对话历史与素材上下文，上下文水位与母会话相同）')
      return
    }

    // 源会话尚未发问过：没有 JSONL 可拷，沿用复制 UI 历史的旧行为
    await ensureHistoryLoaded(source)
    const sourceChat = get().chatsMap[sourceId]
    historyLoaded.add(id)
    set((s) => {
      const chatsMap = {
        ...s.chatsMap,
        [id]: {
          title,
          history: (sourceChat?.history ?? []).map((m) => ({ ...m, streaming: false }))
        }
      }
      return { sessions: [...s.sessions, baseMeta], chatsMap }
    })
    showToast(`已从「${source.title}」分叉出新会话（源会话尚未开始对话，无历史可携带）`)
  }

  /** 执行删除会话：释放桥与主进程会话，清单与历史槽一并移除 */
  const performRemoveSession = (id: string) => {
    bridges.get(id)?.dispose()
    bridges.delete(id)
    streams.delete(id)
    baseLens.delete(id)
    historyLoaded.delete(id)
    // 这几个缓存都按会话键持有引用（流式缓冲/draft→message 转换/未配对的 write 路径/
    // 逐轮注入去重状态），会话删了不清理就是单调泄漏；缓冲里的残余事件会在下次 flush 时自然跳过
    pendingChatEvents.delete(id)
    draftMessageCache.delete(id)
    lastRoundDigests.delete(id)
    genSummarySeen.delete(id)
    for (const [callId, entry] of writeToolPaths) {
      if (entry.sessionId === id) writeToolPaths.delete(callId)
    }
    let wasActive = false
    set((s) => {
      const chatsMap = { ...s.chatsMap }
      delete chatsMap[id]
      const sessions = s.sessions.filter((ses) => ses.id !== id)
      wasActive = s.activeSessionId === id
      const nextActive = wasActive ? (sessions[0]?.id ?? null) : s.activeSessionId
      return { sessions, chatsMap, activeSessionId: nextActive, ...recomputeChatDerived(chatsMap, nextActive) }
    })
    if (wasActive) clearTransient()
    showToast('已删除会话（对话历史移除；画布与素材文件不受影响）')
  }

  /** 删除入口：有历史的会话先确认（JSONL 还在磁盘，但清单移除后 UI 上找不回） */
  const requestRemoveSession = (id: string) => {
    const meta = get().sessions.find((s) => s.id === id)
    if (!meta) return
    const chat = get().chatsMap[id]
    if (chat && chat.history.length > 0) {
      set({
        confirm: {
          title: `删除会话「${meta.title}」？`,
          body: '这段对话将从会话列表移除（Agent 写入工作目录的文件与画布卡片都不受影响）。',
          confirmLabel: '删除会话',
          danger: true,
          onConfirm: () => performRemoveSession(id)
        }
      })
      return
    }
    performRemoveSession(id)
  }

  const renameSession = (id: string, title: string) => {
    const t = title.trim().slice(0, 24)
    if (!t) return
    applySessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: t } : s)))
    patchChat(id, (chat) => ({ ...chat, title: t }))
  }

  /* ---------------- 对话发送（路径引用契约：buildReferencePayload 拼进消息文本） ---------------- */

  const sendMessage = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!BRIDGE_AVAILABLE) {
      showToast(BRIDGE_UNAVAILABLE)
      return
    }
    const ws = get().workspace
    if (!ws) {
      showToast('尚未打开工作区')
      return
    }
    let sid = get().activeSessionId
    if (!sid || !get().sessions.some((s) => s.id === sid)) {
      // 无当前会话 → 自动新建，标题取这句话的开头
      sid = createSession(trimmed)
    }
    const chat = get().chatsMap[sid]
    if (chat?.running) return
    const meta = get().sessions.find((s) => s.id === sid)

    // 本轮上下文 = 采集器唯一组装口：引用载荷（含 T11 生成卡回喂摘要）+ T9 素材库摘要
    // + T10 画布态势。全部逐轮动态注入（拼进消息文本），不进静态系统提示词；
    // @backend(payload)：只把路径与清单文本拼在消息后发给模型，文件内容不进上下文。
    const s = get()
    // 逐轮去重（token 经济）：传入上轮摘要全文与 genSummary 签名表，返回的新状态整表
    // 存回（digests 是全量全文、签名表只含本轮仍在附件集合里的卡片），供下一轮比较
    const {
      attachments,
      contextText,
      digests,
      genSummarySeen: carriedGenSigs
    } = collectRoundContext({
      selectedAssetIds: s.selectedAssetIds,
      injectedAssetIds: s.injectedAssetIds,
      nodes: s.nodes,
      tempAttachments: s.tempAttachments,
      workspaceDir: ws.path,
      libraries: s.libraries,
      previousDigests: lastRoundDigests.get(sid),
      genSummarySeen: genSummarySeen.get(sid)
    })
    lastRoundDigests.set(sid, digests)
    genSummarySeen.set(sid, carriedGenSigs)
    // 发送时把当前选中的资产固化为「已注入」，之后即使取消选中，chip 仍保留
    set((prev) => ({
      injectedAssetIds: Array.from(new Set([...prev.injectedAssetIds, ...prev.selectedAssetIds])),
      tempAttachments: []
    }))

    const bridge = ensureBridge(sid)
    const ready = await bridge.ensureCreated(
      // 重绑（有 sessionFile）也传 meta.modelId：恢复后用户切换过模型的话要在重绑时生效
      //（pi 对显式传入的 model 优先）；首次创建再兜底工作区默认模型，重绑无记录则不传（用会话内模型）
      meta?.modelId ?? (meta?.sessionFile ? undefined : settingsBridgeRef.current?.defaultModel ?? undefined),
      meta?.sessionFile,
      // 未建会话时暂存的档位随 create 生效（重绑旧会话也传，pi 会按模型 clamp）
      meta?.thinkingLevel
    )
    if (!ready) return

    // T5 之后 fork 出的会话带自己的 sessionFile（forkFrom 全量拷贝，首发即全量上下文），
    // 不再把母会话文本摘要拼进首条消息——那条 20 条 transcript 注入路径已删除
    // （旧版 fork 会话没有 sessionFile 的兜底注入也一并废弃：旧产物不救，用户裁决）。
    let outbound = trimmed
    const payload = buildReferencePayload(attachments)
    if (payload) outbound = `${outbound}\n\n${payload}`
    // T9/T10：素材库清单与画布态势逐轮注入（引用清单之后；两者皆空时不加任何文本）
    if (contextText) outbound = `${outbound}\n\n${contextText}`

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      ...(attachments.length > 0 ? { attachments } : {})
    }
    // 基准线必须在 await 之后再读：ensureCreated 期间可能有 flush 把分隔条等
    // 内容追加进实际历史（snapshot `chat` 是 await 之前的），用旧快照会把
    // 新发的这条 userMsg 切出 slice 范围
    const historyLen = get().chatsMap[sid]?.history.length ?? 0
    baseLens.set(sid, historyLen + 1)
    streams.set(sid, createStreamState())
    patchChat(sid, (c) => ({ ...c, history: [...c.history, userMsg], running: true }))
    const accepted = await bridge.send(outbound)
    if (!accepted) {
      streams.delete(sid)
      patchChat(sid, (c) => ({ ...c, running: false }))
    }
  }

  const stopChat = async (sessionId: string) => {
    const bridge = bridges.get(sessionId)
    if (bridge) await bridge.stop()
  }

  /**
   * 手动压缩当前会话（T2）。门控在 UI（compactGate）；这里只拦「会话从未建过」：
   * 没有桥说明一次对话都没发生，压缩无从谈起。
   */
  const compactSession = async (sessionId: string) => {
    if (!BRIDGE_AVAILABLE) {
      showToast(BRIDGE_UNAVAILABLE)
      return
    }
    const bridge = bridges.get(sessionId)
    if (!bridge) {
      showToast('会话尚未开始对话，无需压缩')
      return
    }
    await bridge.compact()
  }

  /**
   * 会话中途切换模型。已建会话（有 sessionFile 且本轮已建桥）走 chat:set-model
   * 即时生效并回填 clamp 结果；其余情况（未发问过 / 画布刚恢复还没发过言）只写
   * meta，等下次 ensureCreated 生效 —— 不在这里补建桥，避免为没说话的会话凭空建会话。
   */
  const setSessionModel = async (sessionId: string, modelId: string) => {
    const meta = get().sessions.find((s) => s.id === sessionId)
    if (!meta) return
    const bridge = meta.sessionFile ? bridges.get(sessionId) : undefined
    if (bridge) {
      const result = await bridge.setModel(modelId)
      if (!result) return
      applySessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, modelId: result.modelId, thinkingLevel: result.thinkingLevel } : s))
      )
      showToast(`已切换模型 ${result.modelId}`)
      return
    }
    applySessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, modelId } : s)))
    showToast(`已切换模型 ${modelId}（会话开始后生效）`)
  }

  /** 会话中途设置思考档位。同 setSessionModel：有桥即时生效（回填 clamp 后档位），否则只写 meta */
  const setSessionThinking = async (sessionId: string, level: string) => {
    const meta = get().sessions.find((s) => s.id === sessionId)
    if (!meta) return
    const bridge = meta.sessionFile ? bridges.get(sessionId) : undefined
    if (bridge) {
      const applied = await bridge.setThinking(level)
      if (!applied) return
      applySessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, thinkingLevel: applied } : s)))
      showToast(`已设置思考档位 ${applied}`)
      return
    }
    applySessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, thinkingLevel: level } : s)))
  }

  /** 上下文分布明细（T3）：按需拉取，水位条展开面板时调用；失败返回 null 静默收起 */
  const fetchContextBreakdown = async (sessionId: string): Promise<ChatContextBreakdownInfo | null> => {
    if (!BRIDGE_AVAILABLE) return null
    const result = await window.huabu.chat.contextBreakdown({ nodeId: sessionId })
    if (!result.ok) {
      console.warn('[canvas] 获取上下文分布失败：', result.error)
      return null
    }
    return result.value
  }

  /**
   * 斜杠命令分发（用户裁决：压缩 / fork 走输入框命令，不占对话坞头部按钮位）。
   *
   * 返回值约定：'not-command' = 调用方按普通消息发送；'ok' = 已执行（清空输入框）；
   * 'unknown' / 'rejected' = 拦截但未执行（toast 已说明原因，保留输入让用户修正）。
   */
  const runChatCommand = async (
    raw: string
  ): Promise<'not-command' | 'ok' | 'unknown' | 'rejected'> => {
    const trimmed = raw.trim()
    if (!isCommandInput(trimmed)) return 'not-command'
    const command = parseChatCommand(trimmed)
    if (!command) {
      showToast('未知命令。可用：/compact 压缩上下文 · /fork 分叉会话')
      return 'unknown'
    }
    if (command.type === 'compact') {
      const sid = get().activeSessionId
      const chat = sid ? get().chatsMap[sid] : undefined
      const gate = compactGate(chat?.running, chat?.compacting)
      if (gate.disabled) {
        showToast(gate.reason ?? '当前不可压缩')
        return 'rejected'
      }
      await compactSession(sid ?? '')
      return 'ok'
    }
    const sid = get().activeSessionId
    if (!sid || !get().sessions.some((s) => s.id === sid)) {
      showToast('没有可分叉的会话')
      return 'rejected'
    }
    await forkSession(sid)
    return 'ok'
  }

  return {
    /* ---- CanvasState actions ---- */
    createSession,
    switchSession,
    forkSession,
    requestRemoveSession,
    renameSession,
    sendMessage,
    stopChat,
    compactSession,
    setSessionModel,
    setSessionThinking,
    fetchContextBreakdown,
    runChatCommand,
    /* ---- @internal：store 主体（载入/切换工作区）专用 ---- */
    handleChatEvent,
    disposeAllBridges,
    replayChatHistory
  }
}

export type ChatRuntime = ReturnType<typeof createChatRuntime>
