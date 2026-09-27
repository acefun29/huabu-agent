import type { ChatProviderDef } from '../types'
import deepseek from './providers/deepseek'
import kimi from './providers/kimi'
import glm from './providers/glm'
import qwen from './providers/qwen'
import anthropic from './providers/anthropic'
import openai from './providers/openai'

/**
 * 内置聊天模型目录（架构计划 §3 目录层）。
 *
 * 一家供应商一个文件放 providers/ 下，在此汇入 BUILTIN_CHAT_PROVIDERS；运行时由 merge.ts
 * 与 workspace.json 的 `chat` 覆盖层（userProviders/hiddenBuiltin/modelOverrides）
 * 合并出生效清单，manager 再产出注册载荷喂给 pi。**这是清单的唯一事实来源**——
 * 取代此前"pi 内置 data/*.json + builtinModelUpdates 修订层 + 工作区 models.json 三方合成"
 * 的分裂状态（那套的产物就是一个落盘的合成 models.json，且我们无法表达 pi 没有的概念）。
 *
 * 为什么故意缺 doubao：它是六家里唯一 pi 上游**没有** data 文件的一家，官方 pricing 页
 * 我们也没复核过。一期模型 id 还必须是带日期的全名或 ep-xxx Endpoint ID（`doubao-seed-2.0`
 * 只是系列代称、不可调用），contextWindow/maxTokens 全无出处——写进目录就只能编数字。
 * 豆包一期**不做**（用户裁决 2026-09-24），想用豆包走设置页的「自定义供应商」入口。
 *
 * 为什么收 anthropic / openai（2026-09-24 决策 3 定为「要支持」）：设置页此前直接遍历
 * `pi runtime.getProviders()`，pi 自带的 40 个内置供应商全在列表里。改成"管理器是唯一
 * 枚举源"后，不写进目录就等于**连用户已经录好的 Key 一起从 UI 消失**。这两家按最新一代
 * 模型收进来（各取当族旗舰/主力/便宜档）；它们的官方文档页在本机网络不可达（region 307 /
 * 403），数值出处与缺口逐条写在各自文件头。
 *
 * 维护约定：模型 `id` 合入后不得改名；`compat` 一律显式写、不靠 pi 的域名自动探测
 * （moonshot/zai 域名会静默关掉 `supportsReasoningEffort`，见 §2.5 推论1）。
 */
export const BUILTIN_CHAT_PROVIDERS: ChatProviderDef[] = [deepseek, kimi, glm, qwen, anthropic, openai]

export { defineProvider } from './define'
export type {
  ChatCompatFor,
  ChatModelApi,
  ChatModelDef,
  ChatModelOverride,
  ChatProviderAuth,
  ChatProviderDef,
  ChatUserModelConfig,
  ChatUserProviderConfig,
  EffectiveChatModel,
  EffectiveChatProvider,
  RegistrationModelInput,
  RegistrationPayload,
  WorkspaceChatConfig
} from '../types'
export { CHAT_MODEL_APIS, isChatModelApi } from '../types'
export {
  mergeChatCatalog,
  validateBuiltinCatalog,
  sanitizeUserProviders,
  sanitizeUserProvider,
  sanitizeHiddenBuiltin,
  sanitizeModelOverrides,
  PROVIDER_ID_PATTERN,
  MODEL_ID_PATTERN
} from './merge'
export type { ChatCatalogUserConfig } from './merge'
