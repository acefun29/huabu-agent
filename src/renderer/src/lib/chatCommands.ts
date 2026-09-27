/**
 * 会话输入框的斜杠命令（用户裁决 2026-09-26：压缩 / fork 这类行为动作走 / 命令，
 * 不占对话坞头部按钮位；头部只保留「+ 新建对话」这类轻量入口）。
 *
 * 纯函数：解析与建议过滤都不碰 store，可在 Node 自检直接断言
 * （scripts/chat-events-check.mjs）。
 */

export interface ChatCommandInfo {
  name: string
  /** 中文别名（与命令名等价触发） */
  aliases?: string[]
  description: string
}

export const CHAT_COMMANDS: readonly ChatCommandInfo[] = [
  {
    name: '/compact',
    aliases: ['/压缩'],
    description: '压缩当前会话的上下文（保留产物路径、提示词、版本决策与审美取向）'
  },
  {
    name: '/fork',
    aliases: ['/分叉'],
    description: '从当前会话分叉出新会话（带走完整对话历史与素材上下文，水位与母会话相同）'
  }
]

export type ChatCommand = { type: 'compact' } | { type: 'fork' }

/** 严格整条匹配（trim 后）；命令带参数的形态本期不引入，宁可少见不过度设计 */
export function parseChatCommand(input: string): ChatCommand | null {
  const t = input.trim()
  if (t === '/compact' || t === '/压缩') return { type: 'compact' }
  if (t === '/fork' || t === '/分叉') return { type: 'fork' }
  return null
}

/** 输入是否进入命令模式（以 / 开头即拦截发送，防误发字面斜杠文本给模型） */
export function isCommandInput(input: string): boolean {
  return input.trimStart().startsWith('/')
}

/** 按当前输入前缀过滤命令建议（名与别名都参与匹配） */
export function filterCommands(input: string): ChatCommandInfo[] {
  const t = input.trim()
  if (!t.startsWith('/')) return []
  return CHAT_COMMANDS.filter(
    (command) => command.name.startsWith(t) || command.aliases?.some((alias) => alias.startsWith(t))
  )
}
