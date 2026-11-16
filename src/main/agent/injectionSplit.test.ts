import { describe, expect, it } from 'vitest'
import { splitUserInjection } from './injectionSplit'
import {
  DIGEST_UNCHANGED_NOTE,
  LIBRARY_DIGEST_HEADER,
  PROJECT_DIGEST_HEADER,
  REFERENCE_PAYLOAD_HEADER_PREFIX,
  REFERENCE_PAYLOAD_HEADER_SUFFIX
} from '../../shared/injection'

/**
 * 注入段拆分是**两条运行时共用**的回放能力：Pi 侧读 JSONL、Mastra 侧读 thread，
 * 都要把「用户正文」与「逐轮拼上的上下文载荷」分开，否则每轮重复的清单会把对话
 * 读成用户反复粘贴同一段话。原先它只由 `pnpm session-history:check`（需要装着 pi）
 * 覆盖，这里把它钉进 `pnpm test`。
 */
describe('splitUserInjection（正文 / 本轮注入段）', () => {
  it('没有注入头时整段都是正文', () => {
    expect(splitUserInjection('帮我画一张夜行列车')).toEqual({ body: '帮我画一张夜行列车' })
    expect(splitUserInjection('')).toEqual({ body: '' })
  })

  it('空行 + 注入头 ⇒ 拆出 contextPayload，正文去掉尾部空行', () => {
    const text = `帮我画一张分镜\n\n${PROJECT_DIGEST_HEADER}（项目「夜行列车」）\n- 层级：剧集 → 镜头`
    const out = splitUserInjection(text)
    expect(out.body).toBe('帮我画一张分镜')
    expect(out.contextPayload).toBe(`${PROJECT_DIGEST_HEADER}（项目「夜行列车」）\n- 层级：剧集 → 镜头`)
  })

  it('注入头在开头（没有正文）⇒ 不拆', () => {
    const text = `${LIBRARY_DIGEST_HEADER}\n- 库 A`
    expect(splitUserInjection(text)).toEqual({ body: text })
  })

  it('前一行非空的注入头样式行视为正文的一部分 ⇒ 不拆', () => {
    // 用户在正文里手打了一行 [素材库清单]，前面紧挨着正文
    const text = `下面是模板\n${LIBRARY_DIGEST_HEADER} 这是我写的标题`
    expect(splitUserInjection(text)).toEqual({ body: text })
  })

  it('占位形态（头 + 未变化后缀）照常拆', () => {
    const text = `继续\n\n${PROJECT_DIGEST_HEADER}${DIGEST_UNCHANGED_NOTE}`
    const out = splitUserInjection(text)
    expect(out.body).toBe('继续')
    expect(out.contextPayload).toBe(`${PROJECT_DIGEST_HEADER}${DIGEST_UNCHANGED_NOTE}`)
  })

  it('引用素材头（带计数）同样认作注入段', () => {
    const header = `${REFERENCE_PAYLOAD_HEADER_PREFIX}2${REFERENCE_PAYLOAD_HEADER_SUFFIX}（仅传入绝对路径…）`
    const text = `按这两张图来\n\n${header}\n- [图片] E:/ws/a.png`
    const out = splitUserInjection(text)
    expect(out.body).toBe('按这两张图来')
    expect(out.contextPayload).toContain('E:/ws/a.png')
  })

  it('多个注入段：只切在最早的那个头上', () => {
    const text = `正文\n\n${PROJECT_DIGEST_HEADER}x\n\n${LIBRARY_DIGEST_HEADER}y`
    const out = splitUserInjection(text)
    expect(out.body).toBe('正文')
    expect(out.contextPayload).toBe(`${PROJECT_DIGEST_HEADER}x\n\n${LIBRARY_DIGEST_HEADER}y`)
  })
})
