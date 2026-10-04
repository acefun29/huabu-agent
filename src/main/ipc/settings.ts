/**
 * settings 域 IPC（M9）。
 *
 * 覆盖通道（四段）：
 * - 凭据：settings:chat-providers / settings:set-api-key / settings:remove-api-key /
 *   settings:test-provider
 * - 自定义模型/供应商（T5 起写 chat 段）：settings:custom-add-provider /
 *   settings:custom-remove-provider / settings:custom-add-model
 * - 模型管理（内置+自定义）：settings:models-list / settings:model-edit /
 *   settings:model-remove / settings:model-restore
 * - MCP / Skills（真实接入）：settings:mcp-status / settings:mcp-set /
 *   settings:skills-list / settings:skills-set-disabled
 *
 * 域内局部（不进 IpcContext）：afterChatConfigChange（覆盖层写完后的统一收尾）。
 */
import { ipcMain } from 'electron'
import {
  IpcChannel,
  type ChatResult,
  type CustomModelInput,
  type CustomProviderInput,
  type ManagedModelInfo,
  type McpServerConfig,
  type ModelEditInput,
  type SettingsSetApiKeyRequest,
  type SettingsSkillsListResult
} from '../../shared/ipc'
import {
  addCustomModel,
  addCustomProvider,
  deleteModel,
  editCustomModel,
  removeCustomProvider,
  restoreBuiltinModel
} from '../models/overlay'
import { normalizeServerConfig, writeMcpServers } from '../mcp/store'
import type { IpcContext } from './shared'
import { describe, invalidPayload, isNonEmptyString, ok } from './shared'

export function registerSettingsIpc(ctx: IpcContext): void {
  const host = ctx.host
  const store = ctx.store
  const mcpManager = ctx.mcpManager
  const currentDir = ctx.currentDir

  // ---------------------------------------------------------------- settings 域（M9）

  ipcMain.handle(IpcChannel.SettingsChatProviders, () => {
    const dir = currentDir()
    if (!dir) {
      return {
        ok: true,
        value: { providers: [], credentialsHint: '' }
      } satisfies ChatResult<unknown>
    }
    return host.chatProviders(dir)
  })

  ipcMain.handle(IpcChannel.SettingsSetApiKey, (_event, payload: unknown) => {
    const request = payload as Partial<SettingsSetApiKeyRequest> | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('settings:set-api-key 需要 providerId')
    if (!isNonEmptyString(request.apiKey)) return invalidPayload('settings:set-api-key 需要 apiKey')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    return host.setApiKey(dir, request.providerId, request.apiKey)
  })

  ipcMain.handle(IpcChannel.SettingsRemoveApiKey, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('settings:remove-api-key 需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    return host.removeApiKey(dir, providerId)
  })

  ipcMain.handle(IpcChannel.SettingsTestProvider, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('settings:test-provider 需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    return host.testProvider(dir, providerId)
  })

  // ------------------------------------------------ settings 域：自定义模型/供应商（T5 起写 chat 段）

  /**
   * 覆盖层写完后的统一收尾：重注册 + 归一错误。
   * 忘记调用就等于"设置改了但不生效"，所以收成一个函数而不是各处手抄。
   */
  async function afterChatConfigChange(dir: string): Promise<ChatResult<undefined>> {
    const refreshed = await host.refreshModels(dir)
    return refreshed.ok ? ok() : refreshed
  }

  ipcMain.handle(IpcChannel.SettingsCustomAddProvider, async (_event, payload: unknown) => {
    const request = payload as Partial<CustomProviderInput> | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.baseUrl)) return invalidPayload('需要 baseUrl')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      addCustomProvider(dir, {
        providerId: request.providerId,
        ...(isNonEmptyString(request.name) ? { name: request.name } : {}),
        baseUrl: request.baseUrl,
        ...(isNonEmptyString(request.api) ? { api: request.api } : {})
      })
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsCustomRemoveProvider, async (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      removeCustomProvider(dir, providerId)
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsCustomAddModel, async (_event, payload: unknown) => {
    const request = payload as Partial<CustomModelInput> | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.id)) return invalidPayload('需要模型 id')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      // 供应商存在性由 addCustomModel 判定（覆盖层里有条目 或 在内置目录里），
      // 不再问 pi 的 getProvider——T5 之后内置目录才是"内置"的定义。
      addCustomModel(dir, {
        providerId: request.providerId,
        id: request.id,
        ...(isNonEmptyString(request.name) ? { name: request.name } : {}),
        ...(typeof request.contextWindow === 'number' ? { contextWindow: request.contextWindow } : {}),
        ...(typeof request.maxTokens === 'number' ? { maxTokens: request.maxTokens } : {}),
        ...(request.reasoning === true ? { reasoning: true } : {}),
        ...(Array.isArray(request.input_modalities) ? { input_modalities: request.input_modalities } : {})
      })
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  // ------------------------------------------------ settings 域：模型管理（内置+自定义）

  ipcMain.handle(
    IpcChannel.SettingsModelsList,
    async (_event, payload: unknown): Promise<ChatResult<ManagedModelInfo[]>> => {
      const providerId = (payload as { providerId?: unknown } | null)?.providerId
      if (!isNonEmptyString(providerId)) return invalidPayload('settings:models-list 需要 providerId')
      const dir = currentDir()
      if (!dir) return invalidPayload('尚未打开工作区')
      return host.managedModels(dir, providerId)
    }
  )

  ipcMain.handle(IpcChannel.SettingsModelEdit, async (_event, payload: unknown) => {
    const request = payload as Partial<ModelEditInput> | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.modelId)) return invalidPayload('需要 modelId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    const patch = {
      name: isNonEmptyString(request.name) ? request.name : undefined,
      ...(typeof request.contextWindow === 'number' ? { contextWindow: request.contextWindow } : {}),
      ...(typeof request.maxTokens === 'number' ? { maxTokens: request.maxTokens } : {}),
      ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {})
    }
    try {
      // 落点由覆盖层判定（自建条目直接改；内置条目 = 改名进 modelOverrides、
      // 能力字段进同 id 补丁），这里不再区分两套文件
      editCustomModel(dir, {
        providerId: request.providerId,
        modelId: request.modelId,
        ...patch
      })
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsModelRemove, async (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; modelId?: unknown } | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.modelId)) return invalidPayload('需要 modelId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      deleteModel(dir, request.providerId, request.modelId)
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsModelRestore, async (_event, payload: unknown) => {
    const request = payload as { providerId?: unknown; modelId?: unknown } | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('需要 providerId')
    if (!isNonEmptyString(request.modelId)) return invalidPayload('需要 modelId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      restoreBuiltinModel(dir, request.providerId, request.modelId)
      return await afterChatConfigChange(dir)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })

  // ------------------------------------------------- settings 域（MCP / Skills）

  /** MCP 配置是全局的（跨工作区），不要求打开工作区 */
  ipcMain.handle(IpcChannel.SettingsMcpStatus, () => {
    mcpManager.sync()
    return { ok: true, value: { servers: mcpManager.runtimeInfo() } }
  })

  ipcMain.handle(IpcChannel.SettingsMcpSet, (_event, payload: unknown) => {
    const request = payload as { servers?: unknown } | null
    if (!Array.isArray(request?.servers)) return invalidPayload('settings:mcp-set 需要 servers 数组')
    const cleaned: McpServerConfig[] = []
    for (const entry of request.servers) {
      const normalized = normalizeServerConfig(entry)
      if (typeof normalized === 'string') return invalidPayload(normalized)
      cleaned.push(normalized)
    }
    try {
      writeMcpServers(cleaned)
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
    mcpManager.sync()
    return { ok: true, value: { servers: mcpManager.runtimeInfo() } }
  })

  ipcMain.handle(IpcChannel.SettingsSkillsList, (): ChatResult<SettingsSkillsListResult> => {
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    const disabled = new Set(store.skillsDisabled())
    const { skills } = host.listSkills(dir)
    return {
      ok: true,
      value: { skills: skills.map((skill) => ({ ...skill, enabled: !disabled.has(skill.name) })) }
    }
  })

  ipcMain.handle(IpcChannel.SettingsSkillsSetDisabled, (_event, payload: unknown) => {
    const request = payload as { disabled?: unknown } | null
    if (!Array.isArray(request?.disabled)) return invalidPayload('settings:skills-set-disabled 需要 disabled 数组')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    try {
      store.setSkillsDisabled(request.disabled)
      return ok()
    } catch (error) {
      return { ok: false, code: 'unknown' as const, error: describe(error) }
    }
  })
}
