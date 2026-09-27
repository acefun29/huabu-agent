/**
 * 允许的对话协议白名单（单一事实来源）。
 *
 * 放 shared 而不是 main/models/types.ts，是因为渲染端要枚举它做「协议」下拉：
 * types.ts 依赖 pi-ai 的类型，UI 不能引。main/models/types.ts 从这里再导出，
 * 目录与合并层的 import 路径不变。
 *
 * 不用 pi 的 `Api` 类型：它是 `KnownApi | (string & {})`，等于无约束；
 * `api` 字段来自用户输入，必须在收录进覆盖层之前收紧成这三项。
 */
export const CHAT_MODEL_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

export type ChatModelApi = (typeof CHAT_MODEL_APIS)[number]

export function isChatModelApi(value: unknown): value is ChatModelApi {
  return typeof value === 'string' && (CHAT_MODEL_APIS as readonly string[]).includes(value)
}

/** 下拉与详情页的展示名（点明"这路协议是谁家的什么端点"，避免用户凭字面猜） */
export const CHAT_API_LABEL: Record<ChatModelApi, string> = {
  'openai-completions': 'OpenAI 兼容 /chat/completions',
  'openai-responses': 'OpenAI Responses /responses',
  'anthropic-messages': 'Anthropic 兼容 /messages'
}
