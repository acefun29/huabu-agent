/**
 * chat 域 IPC（M3 + M9 扩展）。
 *
 * 覆盖通道：chat:runtime / chat:create / chat:prompt / chat:steer / chat:abort /
 * chat:dispose / chat:history / chat:context-usage / chat:context-breakdown /
 * chat:compact / chat:fork / chat:set-model / chat:set-thinking。
 * 流式增量经 shared.ts 的 broadcastChatEvent（AgentHost onUpdate）以 chat:event 推送。
 * chat:create 装配媒体生成工具（mediaManager/mediaContext/requestMediaApproval 取自 ctx）；
 * chat:dispose 成功后经 media.ts 的 settleApprovalsForNode 把该节点的挂起确认按拒绝 settle。
 */
import { ipcMain } from 'electron'
import { resolveSessionFile } from '../agent/workspace'
import { assembleMediaTools } from '../agent/mediaToolAssembly'
import { inboxRoot } from '../assets/manager'
import {
  IpcChannel,
  type ChatCreateRequest,
  type ChatPromptRequest,
  type ChatResult,
  type ChatSteerRequest
} from '../../shared/ipc'
import type { IpcContext } from './shared'
import { asNodeRequest, invalidPayload, isNonEmptyString } from './shared'
import { settleApprovalsForNode } from './media'

export function registerChatIpc(ctx: IpcContext): void {
  const store = ctx.store
  const host = ctx.host
  const currentDir = ctx.currentDir
  const mediaManager = ctx.mediaManager
  const mediaContext = ctx.mediaContext
  const requestMediaApproval = ctx.requestMediaApproval

  ipcMain.handle(IpcChannel.ChatRuntime, () => {
    const dir = currentDir()
    if (!dir) {
      return {
        ok: true,
        value: { ready: false, error: '尚未打开工作区', models: [], configuredProviders: [] }
      } satisfies ChatResult<unknown>
    }
    return host.runtime(dir)
  })

  ipcMain.handle(IpcChannel.ChatCreate, (_event, payload: unknown) => {
    const request = payload as Partial<ChatCreateRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:create 需要 nodeId')
    const createRequest: ChatCreateRequest = { nodeId: request.nodeId }
    if (isNonEmptyString(request.cwd)) createRequest.cwd = request.cwd
    if (isNonEmptyString(request.modelId)) createRequest.modelId = request.modelId
    if (isNonEmptyString(request.sessionFile)) createRequest.sessionFile = request.sessionFile
    const current = store.currentWorkspace

    // M13 + T7：会话注入媒体生成工具与 read_media（装配见 agent/mediaToolAssembly.ts）。
    // submit = 提交 + 等待终态：工具 execute 阻塞到成功/失败/取消，期间经 onUpdate 推进度，
    // 失败信息原样进工具结果（Agent 据此引导用户配置），不再有"提交即成功"的假反馈
    const { mediaTools, readMediaTool } = assembleMediaTools(createRequest.nodeId, {
      store,
      mediaManager,
      requestApproval: requestMediaApproval,
      sessionModelSupportsImages: (nid) => host.sessionModelSupportsImages(nid),
      currentDir,
      mediaContext,
      inboxRoot
    })

    return host.create(createRequest, {
      currentDir: current?.path ?? null,
      defaultModel: current?.defaultModel,
      customTools: [...mediaTools, readMediaTool]
    })
  })

  ipcMain.handle(IpcChannel.ChatPrompt, (_event, payload: unknown) => {
    const request = payload as Partial<ChatPromptRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:prompt 需要 nodeId')
    if (!isNonEmptyString(request.text)) return invalidPayload('chat:prompt 需要 text')

    const promptRequest: ChatPromptRequest = { nodeId: request.nodeId, text: request.text }
    return host.prompt(promptRequest)
  })

  ipcMain.handle(IpcChannel.ChatSteer, (_event, payload: unknown) => {
    const request = payload as Partial<ChatSteerRequest> | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:steer 需要 nodeId')
    if (!isNonEmptyString(request.text)) return invalidPayload('chat:steer 需要 text')
    return host.steer({ nodeId: request.nodeId, text: request.text })
  })

  ipcMain.handle(IpcChannel.ChatAbort, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:abort 需要 nodeId')
    return host.abort(request)
  })

  ipcMain.handle(IpcChannel.ChatDispose, async (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:dispose 需要 nodeId')
    const result = await host.dispose(request)
    // dispose 成功后该会话不会再有回执：挂起的确认请求按拒绝 settle，防孤儿挂起
    if (result.ok) {
      settleApprovalsForNode(request.nodeId)
    }
    return result
  })

  ipcMain.handle(IpcChannel.ChatHistory, (_event, payload: unknown) => {
    // 画布恢复时按文件回放历史；节点可能尚未 create，所以直接按路径读
    const request = payload as { nodeId?: unknown; sessionFile?: unknown } | null
    if (!isNonEmptyString(request?.sessionFile)) return invalidPayload('chat:history 需要 sessionFile')
    const nodeId = isNonEmptyString(request.nodeId) ? request.nodeId : ''
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    // 路径合法性校验：必须位于当前工作区 .huabu/sessions/ 内
    const resolved = resolveSessionFile(request.sessionFile, dir)
    if (!resolved.ok) return { ok: false, code: 'cwd_rejected' as const, error: resolved.error }
    return host.readSessionHistory(resolved.sessionFile, nodeId)
  })

  ipcMain.handle(IpcChannel.ChatContextUsage, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:context-usage 需要 nodeId')
    return host.contextUsage(request.nodeId)
  })

  ipcMain.handle(IpcChannel.ChatContextBreakdown, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:context-breakdown 需要 nodeId')
    return host.contextBreakdown(request.nodeId)
  })

  ipcMain.handle(IpcChannel.ChatCompact, (_event, payload: unknown) => {
    const request = asNodeRequest(payload)
    if (!request) return invalidPayload('chat:compact 需要 nodeId')
    return host.compact(request)
  })

  ipcMain.handle(IpcChannel.ChatFork, (_event, payload: unknown) => {
    const request = payload as { nodeId?: unknown; sessionFile?: unknown } | null
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('chat:fork 需要 nodeId')
    if (!isNonEmptyString(request.sessionFile)) return invalidPayload('chat:fork 需要 sessionFile')
    return host.forkSession({ nodeId: request.nodeId, sessionFile: request.sessionFile }, currentDir())
  })

  ipcMain.handle(IpcChannel.ChatSetModel, async (_event, payload: unknown) => {
    const request = payload as { nodeId?: unknown; modelId?: unknown } | null
    if (!isNonEmptyString(request?.nodeId) || !isNonEmptyString(request?.modelId)) {
      return invalidPayload('chat:set-model 需要 nodeId 与 modelId')
    }
    return host.setModel({ nodeId: request.nodeId, modelId: request.modelId })
  })

  ipcMain.handle(IpcChannel.ChatSetThinking, (_event, payload: unknown) => {
    const request = payload as { nodeId?: unknown; thinkingLevel?: unknown } | null
    if (!isNonEmptyString(request?.nodeId) || !isNonEmptyString(request?.thinkingLevel)) {
      return invalidPayload('chat:set-thinking 需要 nodeId 与 thinkingLevel')
    }
    return host.setThinking({ nodeId: request.nodeId, thinkingLevel: request.thinkingLevel })
  })
}
