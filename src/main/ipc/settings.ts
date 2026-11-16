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
 * - Skills：settings:skills-list / settings:skills-set-disabled
 *
 * 域内局部（不进 IpcContext）：afterChatConfigChange（覆盖层写完后的统一收尾）。
 */
import { ipcMain } from './ipcMainBridge'
import {
  IpcChannel,
  type ChatResult,
  type CustomModelInput,
  type CustomProviderInput,
  type ManagedModelInfo,
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
import { scanSkills } from '../agent/skills'
import { resolveBuiltinSkillsRoots } from '../agent/blockoutTools'
import type { IpcContext } from './shared'
import { describe, invalidPayload, isNonEmptyString, ok } from './shared'

export function registerSettingsIpc(ctx: IpcContext): void {
  const store = ctx.store
  const currentDir = ctx.currentDir
  // 模型目录/凭据走 WorkspaceModels（与 pi 解耦）：Key 录入、供应商清单、模型管理
  // 不再要求 pi 加载成功。testProvider 仍留在 host（要做真实请求 + 读 pi 的认证快照）。
  const models = ctx.models

  // ---------------------------------------------------------------- settings 域（M9）

  ipcMain.handle(IpcChannel.SettingsChatProviders, () => {
    const dir = currentDir()
    if (!dir) {
      return {
        ok: true,
        value: { providers: [], credentialsHint: '' }
      } satisfies ChatResult<unknown>
    }
    return models.providersInfo(dir)
  })

  ipcMain.handle(IpcChannel.SettingsSetApiKey, (_event, payload: unknown) => {
    const request = payload as Partial<SettingsSetApiKeyRequest> | null
    if (!isNonEmptyString(request?.providerId)) return invalidPayload('settings:set-api-key 需要 providerId')
    if (!isNonEmptyString(request.apiKey)) return invalidPayload('settings:set-api-key 需要 apiKey')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    return models.setApiKey(dir, request.providerId, request.apiKey)
  })

  ipcMain.handle(IpcChannel.SettingsRemoveApiKey, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('settings:remove-api-key 需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    return models.removeApiKey(dir, providerId)
  })

  ipcMain.handle(IpcChannel.SettingsTestProvider, (_event, payload: unknown) => {
    const providerId = (payload as { providerId?: unknown } | null)?.providerId
    if (!isNonEmptyString(providerId)) return invalidPayload('settings:test-provider 需要 providerId')
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    return models.testProvider(dir, providerId)
  })

  // ------------------------------------------------ settings 域：自定义模型/供应商（T5 起写 chat 段）

  /**
   * 覆盖层写完后的统一收尾（归一错误）。
   *
   * 此前这里要调 `host.refreshModels()` 把清单重新注进 pi 的 ModelRuntime——pi 的清单
   * 在运行时里有一份副本，不重注就不生效。pi 移除后这一步不再需要：管理器每次现算
   * （目录唯一来源），改写即刻生效。保留这个函数是为了统一错误出口。
   */
  async function afterChatConfigChange(_dir: string): Promise<ChatResult<undefined>> {
    return ok()
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
        ...(Array.isArray(request.input_modalities) ? { input_modalities: request.input_modalities } : {}),
        ...(Array.isArray(request.thinkingLevels) ? { thinkingLevels: request.thinkingLevels } : {})
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
      return models.managedModels(dir, providerId)
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
      ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
      ...(Array.isArray(request.thinkingLevels) ? { thinkingLevels: request.thinkingLevels } : {})
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

  // ------------------------------------------------------- settings 域（Skills）

  ipcMain.handle(IpcChannel.SettingsSkillsList, (): ChatResult<SettingsSkillsListResult> => {
    const dir = currentDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    const disabled = new Set(store.skillsDisabled())
    // 自建扫描（agent/skills.ts）：原先走 host.listSkills → pi 的 loadSkillsFromDir，
    // 设置页因此在 pi 未就绪时永远是「暂无技能」。现在与会话注入同源，且内置技能
    // （resources/skills，如 blockout-shot）也如实列出，用户可停用。
    const { skills } = scanSkills({ workspaceDir: dir, builtinRoots: resolveBuiltinSkillsRoots() })
    return {
      ok: true,
      value: {
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          dir: skill.dir,
          source: skill.source,
          enabled: !disabled.has(skill.name),
          ...(skill.invalid ? { invalid: skill.invalid } : {})
        }))
      }
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
