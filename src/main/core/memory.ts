/**
 * Memory —— 项目记忆（原子 3/3）。见施工计划 §5。
 *
 * **它就是工作区里的 Markdown 文件**，没有卡片、没有 revision、没有 source、
 * 没有 proposed/confirmed。模型用现成的 read/write 读写，用户用编辑器改。
 * 写错了打开就能看见，改回来即可 —— 和改代码一样。
 *
 * 本模块只做两件纯事：
 * 1. 目录与文件的**约定**（以及路径越界校验）；
 * 2. `studio.md` 的**注入格式**（含预算与截断标记）。
 *
 * 真正的读盘在调用侧（loop/context.ts）做，这里只接收字符串，保持可单测。
 */

/** 记忆目录（工作区相对路径） */
export const MEMORY_DIR_REL = '.huabu/memory'

/** 常驻记忆文件：每轮注入 system prompt */
export const STUDIO_FILE_REL = '.huabu/memory/studio.md'

/**
 * 常驻注入的字符预算（≈1.5k token）。
 *
 * 超出时**截断并显式标注**，不报错、不静默丢弃：这是读取侧的展示问题，
 * 不是写入门禁。完整内容仍在文件里，模型可以 read 打开。
 */
export const STUDIO_CHAR_LIMIT = 6000

/**
 * 校验并归一化一个记忆主题路径（如 `characters/r01.md`）。
 * 返回 null = 非法（绝对路径、盘符、`..`、空）。
 */
export function memoryFileRel(topic: string): string | null {
  const trimmed = (topic ?? '').trim()
  if (!trimmed) return null
  const posix = trimmed.replace(/\\/g, '/')
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null
  const segments = posix.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  return `${MEMORY_DIR_REL}/${segments.join('/')}`
}

/**
 * 渲染 `studio.md` 的注入块。
 *
 * 三种形态，都必须让模型一眼看出「我现在看到的是全部还是片段」：
 * - 空文件 / 不存在 → 明确说空，并给出该写什么的提示（不是假装没有这个功能）
 * - 未超预算 → 原文 + 用量
 * - 超预算 → 前 N 字符 + 截断说明 + 完整内容的读取方式
 */
export function renderStudioBlock(content: string): string {
  const text = (content ?? '').replace(/\r\n/g, '\n').trim()
  const header = '## 项目记忆（studio.md）'
  if (!text) {
    return [
      header,
      `<!-- 空。把稳定的项目约定写进 ${STUDIO_FILE_REL}：当前阶段、硬约束、长期偏好。 -->`
    ].join('\n')
  }
  const total = text.length
  if (total <= STUDIO_CHAR_LIMIT) {
    const percent = Math.round((total / STUDIO_CHAR_LIMIT) * 100)
    return [header, `<!-- ${total} / ${STUDIO_CHAR_LIMIT} 字符 · ${percent}% -->`, text].join('\n')
  }
  const head = text.slice(0, STUDIO_CHAR_LIMIT)
  return [
    header,
    `<!-- 已截断：原文 ${total} 字符，这里只注入前 ${STUDIO_CHAR_LIMIT} 字符。` +
      `需要完整内容请用 read 打开 ${STUDIO_FILE_REL} -->`,
    head
  ].join('\n')
}
