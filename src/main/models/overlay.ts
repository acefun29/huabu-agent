import type { CustomModelInput, CustomProviderInput, ModelEditInput } from '../../shared/ipc'
import type { WorkspaceChatConfig } from './types'
import {
  applyAddModel,
  applyAddProvider,
  applyDeleteModel,
  applyRemoveProvider,
  applyRestoreModel,
  applyEditModel,
  pruneChatConfig
} from './overlayConfig'
import { readChatConfig, writeChatSegment } from '../workspace/metadata'

/**
 * 读取工作区的聊天模型覆盖层，应用 overlayConfig 的规则并写回。
 * 内置目录保持只读，用户更改仅保存在 workspace.json 的 chat 段。
 */

function mutate(dir: string, apply: (chat: WorkspaceChatConfig) => void): WorkspaceChatConfig {
  if (!dir) throw new Error('尚未打开工作区')
  const chat = structuredClone(readChatConfig(dir))
  apply(chat)
  writeChatSegment(dir, pruneChatConfig(chat))
  return readChatConfig(dir)
}

export function addCustomProvider(dir: string, input: CustomProviderInput): WorkspaceChatConfig {
  return mutate(dir, (chat) => applyAddProvider(chat, input))
}

export function removeCustomProvider(dir: string, providerId: string): WorkspaceChatConfig {
  return mutate(dir, (chat) => applyRemoveProvider(chat, providerId))
}

export function addCustomModel(dir: string, input: CustomModelInput): WorkspaceChatConfig {
  return mutate(dir, (chat) => applyAddModel(chat, input))
}

/** 删除（含来源判定）：用户自建条目真删，内置条目转隐藏 */
export function deleteModel(dir: string, providerId: string, modelId: string): WorkspaceChatConfig {
  return mutate(dir, (chat) => applyDeleteModel(chat, providerId, modelId))
}

export function restoreBuiltinModel(dir: string, providerId: string, modelId: string): WorkspaceChatConfig {
  return mutate(dir, (chat) => applyRestoreModel(chat, providerId, modelId))
}

export function editCustomModel(dir: string, input: ModelEditInput): WorkspaceChatConfig {
  return mutate(dir, (chat) => applyEditModel(chat, input))
}
