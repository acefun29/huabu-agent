import { useCallback, useMemo, useRef, useState } from 'react'
import type { ChatModelOption, CustomModelInput, ProviderAuthInfo, ModelEditInput } from '@shared/ipc'
import type { ChatModelApi } from '@shared/chatApi'
import { hasBridge } from './bridge'

function errorText(result: { ok: false; error: string } | { ok: true }): string | null {
  return result.ok ? null : result.error
}

/** 聊天模型目录、凭据和工作区默认模型。 */
export function useChatSettingsState() {
  const [chatProviders, setChatProviders] = useState<ProviderAuthInfo[]>([])
  const [chatModels, setChatModels] = useState<ChatModelOption[]>([])
  const [credentialsHint, setCredentialsHint] = useState('')
  const [chatLoaded, setChatLoaded] = useState(false)
  const [defaultModel, setDefaultModelState] = useState<string | null>(null)
  const [chatWorkspacePath, setChatWorkspacePath] = useState<string | null>(null)

  const refreshSequence = useRef(0)

  const resetChatWorkspace = useCallback(() => {
    refreshSequence.current += 1
    setChatProviders([])
    setChatModels([])
    setCredentialsHint('')
    setDefaultModelState(null)
    setChatLoaded(false)
    setChatWorkspacePath(null)
  }, [])

  const refreshChat = useCallback(async (expectedWorkspace?: string) => {
    if (!hasBridge()) return
    const requestId = ++refreshSequence.current
    const before = await window.huabu.workspace.state()
    const workspacePath = before.workspace?.path
    if (!workspacePath || (expectedWorkspace && expectedWorkspace !== workspacePath)) return
    const [providersResult, stateResult, runtimeResult] = await Promise.all([
      window.huabu.settings.chatProviders(),
      window.huabu.workspace.state(),
      window.huabu.chat.runtime()
    ])
    const after = await window.huabu.workspace.state()
    if (requestId !== refreshSequence.current || stateResult.workspace?.path !== workspacePath || after.workspace?.path !== workspacePath) return
    if (providersResult.ok) {
      setChatProviders(providersResult.value.providers)
      setCredentialsHint(providersResult.value.credentialsHint)
    }
    if (stateResult.workspace) {
      setDefaultModelState(stateResult.workspace.defaultModel ?? null)
    }
    // 模型清单只供对话框的模型/档位菜单消费，失败静默保持空
    if (runtimeResult.ok) setChatModels(runtimeResult.value.models)
    setChatWorkspacePath(workspacePath)
    setChatLoaded(true)
  }, [])

  /**
   * chat 配置变更成功后同步清单：设置页头部的认证徽章与「N 个模型」来自 chatProviders
   * IPC（statuses），只在 refreshChat 时重算；没有这一步，存 Key / 加模型后详情区是新的、
   * 头部永远停在面板首次打开时的旧快照。
   */
  const refreshChatAfter = useCallback(
    async (error: string | null) => {
      if (!error) await refreshChat()
      return error
    },
    [refreshChat]
  )

  const setApiKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return refreshChatAfter(errorText(await window.huabu.settings.setApiKey(providerId, apiKey)))
  }, [refreshChatAfter])

  const removeApiKey = useCallback(async (providerId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return refreshChatAfter(errorText(await window.huabu.settings.removeApiKey(providerId)))
  }, [refreshChatAfter])

  const testProvider = useCallback(async (providerId: string) => {
    if (!hasBridge()) return null
    const result = await window.huabu.settings.testProvider(providerId)
    return result.ok ? result.value : null
  }, [])

  const setDefaultModel = useCallback(async (modelId: string | null) => {
    setDefaultModelState(modelId)
    if (!hasBridge()) return
    await window.huabu.workspace.setDefaultModel(modelId)
  }, [])

  const modelsList = useCallback(async (providerId: string) => {
    if (!hasBridge()) return []
    const result = await window.huabu.settings.modelsList(providerId)
    return result.ok ? result.value : []
  }, [])

  const customAddProvider = useCallback(
    async (providerId: string, name: string, baseUrl: string, api: ChatModelApi = 'openai-completions') => {
      if (!hasBridge()) return '当前环境没有可用的设置服务'
      return refreshChatAfter(errorText(await window.huabu.settings.customAddProvider({ providerId, name, baseUrl, api })))
    },
    [refreshChatAfter]
  )

  const customRemoveProvider = useCallback(async (providerId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return refreshChatAfter(errorText(await window.huabu.settings.customRemoveProvider(providerId)))
  }, [refreshChatAfter])

  const customAddModel = useCallback(async (input: CustomModelInput) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return refreshChatAfter(errorText(await window.huabu.settings.customAddModel(input)))
  }, [refreshChatAfter])

  const modelRemove = useCallback(async (providerId: string, modelId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return refreshChatAfter(errorText(await window.huabu.settings.modelRemove(providerId, modelId)))
  }, [refreshChatAfter])

  const modelEdit = useCallback(async (input: ModelEditInput) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return refreshChatAfter(errorText(await window.huabu.settings.modelEdit(input)))
  }, [refreshChatAfter])

  const modelRestore = useCallback(async (providerId: string, modelId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    return refreshChatAfter(errorText(await window.huabu.settings.modelRestore(providerId, modelId)))
  }, [refreshChatAfter])

  return useMemo(() => ({
    chatProviders, chatModels, credentialsHint, chatLoaded, defaultModel, chatWorkspacePath,
    refreshChat, resetChatWorkspace, setApiKey, removeApiKey, testProvider, setDefaultModel, modelsList,
    customAddProvider, customRemoveProvider, customAddModel, modelRemove, modelEdit, modelRestore
  }), [
    chatProviders, chatModels, credentialsHint, chatLoaded, defaultModel, chatWorkspacePath,
    refreshChat, resetChatWorkspace, setApiKey, removeApiKey, testProvider, setDefaultModel, modelsList,
    customAddProvider, customRemoveProvider, customAddModel, modelRemove, modelEdit, modelRestore
  ])
}

export type ChatSettingsState = ReturnType<typeof useChatSettingsState>
