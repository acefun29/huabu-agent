import type { CustomModelInput, CustomProviderInput, ModelEditInput } from '../../shared/ipc'
import type { ChatUserProviderConfig, WorkspaceChatConfig } from './types'
import {
  applyAddModel,
  applyAddProvider,
  applyDeleteModel,
  applyRemoveProvider,
  applyRestoreModel,
  applyEditModel,
  pruneChatConfig
} from './overlayConfig'
import { readChatConfig, writeChatSegment } from '../workspace/store'

/**
 * `chat` 覆盖层的落盘胶水：读磁盘 → 交给 overlayConfig 的纯规则改 → 写回 → 通知 host 重注册。
 *
 * 规则本身在 `overlayConfig.ts`（那份不依赖 electron，能被 `pnpm chat-catalog:check` 直接跑）。
 * 这里只保留"必须碰磁盘"的两件事，因此本文件每个函数都短到不值得单独出错——
 * 出错的地方在规则里，而规则是有断言的。
 *
 * 取代旧的 `agent/customModels.ts`：那份写 `.huabu/models.json`（Pi 原生格式），清单由三方
 * 合成，既不可审计也没法表达 pi 没有的概念。现在目录是代码、覆盖层是配置，写这里就是写清单本身。
 */

function mutate(dir: string, apply: (chat: WorkspaceChatConfig) => void): WorkspaceChatConfig {
  if (!dir) throw new Error('尚未打开工作区')
  const chat = structuredClone(readChatConfig(dir))
  apply(chat)
  writeChatSegment(dir, pruneChatConfig(chat))
  return readChatConfig(dir)
}

/** 设置页的「自定义供应商」清单（覆盖层原样，含还没挂模型的条目） */
export function listUserProviders(dir: string): ChatUserProviderConfig[] {
  if (!dir) return []
  return [...(readChatConfig(dir).userProviders ?? [])]
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
