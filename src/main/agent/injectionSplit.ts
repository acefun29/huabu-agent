import { isInjectionHeaderLine } from '../../shared/injection'

/**
 * 用户消息的「正文 / 逐轮注入段」拆分。
 *
 * 注入段由渲染端 `sendMessage` 逐轮拼在正文后（`\n\n` + 载荷），头部来自
 * `shared/injection.ts` 的自产文本头。拆分是纯文本操作：找到最早的行首注入头，
 * 之前是正文、之后整段折叠。载荷总以 `\n\n` 拼在正文后，注入头前必有空行——
 * 因此只有「前一行是空行」的注入头才认作切分点，用户正文里恰好有一行以
 * `[素材库清单]` 开头的文本（前一行非空）不会被误拆；折叠占位形态
 * （头 + 「（与上轮一致，未变化）」单行）同样按头前缀命中，无需特殊处理。
 * 正文为空（理论不该发生）时不拆，整条按正文展示。
 *
 * 独立成模块的原因：这是**两条运行时都要用**的能力——Pi 侧的 JSONL 回放
 * （`agent/history.ts`）与 Mastra 侧的 thread 回放（`mastra/runtime.ts`）。
 * 原先长在 `history.ts` 里，而那个文件在全量去 pi 时整体删除；放在这里，
 * 删 Pi 不会顺手把 Mastra 的回放拆段一起删掉。
 */
export function splitUserInjection(text: string): { body: string; contextPayload?: string } {
  if (!text) return { body: text }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!isInjectionHeaderLine(lines[i])) continue
    // 切分点收紧：注入头前必有空行（载荷以 `\n\n` 拼在正文后）；前一行非空的
    // 注入头样式的行视为用户正文的一部分，不拆
    if (i === 0 || lines[i - 1].trim() !== '') continue
    const body = lines
      .slice(0, i)
      .join('\n')
      .replace(/\n+$/, '')
    if (!body.trim()) return { body: text }
    return { body, contextPayload: lines.slice(i).join('\n') }
  }
  return { body: text }
}
