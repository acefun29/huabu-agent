import { describe, expect, it } from 'vitest'
import {
  MEMORY_DIR_REL,
  STUDIO_CHAR_LIMIT,
  STUDIO_FILE_REL,
  memoryFileRel,
  renderStudioBlock
} from './memory'

/**
 * 记忆就是 Markdown 文件。这里只测两件事：**路径不越界**、**注入必须诚实**
 * （是全文还是片段，模型要能一眼看出来）。
 */

describe('常量', () => {
  it('记忆目录与常驻文件在工作区的 .huabu 下', () => {
    expect(MEMORY_DIR_REL).toBe('.huabu/memory')
    expect(STUDIO_FILE_REL).toBe('.huabu/memory/studio.md')
  })
})

describe('memoryFileRel', () => {
  it('主题路径拼到记忆目录下', () => {
    expect(memoryFileRel('characters/r01.md')).toBe('.huabu/memory/characters/r01.md')
    expect(memoryFileRel('studio.md')).toBe('.huabu/memory/studio.md')
  })

  it('反斜杠归一、折叠多余分隔符', () => {
    expect(memoryFileRel('characters\\r01.md')).toBe('.huabu/memory/characters/r01.md')
    expect(memoryFileRel('./style.md/')).toBe('.huabu/memory/style.md')
  })

  it('拒绝越界与绝对路径', () => {
    expect(memoryFileRel('../outside.md')).toBeNull()
    expect(memoryFileRel('a/../../b.md')).toBeNull()
    expect(memoryFileRel('/abs.md')).toBeNull()
    expect(memoryFileRel('C:\\x.md')).toBeNull()
    expect(memoryFileRel('')).toBeNull()
  })
})

describe('renderStudioBlock', () => {
  it('空内容：明确说空，并说明该写什么（不假装没有这个功能）', () => {
    const block = renderStudioBlock('')
    expect(block).toContain('项目记忆')
    expect(block).toContain('空')
    expect(block).toContain(STUDIO_FILE_REL)
    expect(block.split('\n')).toHaveLength(2)
  })

  it('未超预算：原文全量 + 用量标注', () => {
    const content = '当前阶段：第 3 场分镜\n硬约束：16:9，不出现字幕'
    const block = renderStudioBlock(content)
    const lines = block.split('\n')
    expect(lines[0]).toBe('## 项目记忆（studio.md）')
    expect(lines[1]).toContain(`${content.length} / ${STUDIO_CHAR_LIMIT}`)
    // 多行内容原样保留，不被折叠或改写
    expect(lines.slice(2).join('\n')).toBe(content)
  })

  it('超预算：截到预算 + 明确标注被截断，并给出完整内容的读取方式', () => {
    const content = 'A'.repeat(STUDIO_CHAR_LIMIT + 1200)
    const block = renderStudioBlock(content)
    const lines = block.split('\n')
    expect(lines[1]).toContain('已截断')
    expect(lines[1]).toContain(String(content.length))
    expect(lines[1]).toContain(STUDIO_FILE_REL)
    expect(lines[2]).toHaveLength(STUDIO_CHAR_LIMIT)
  })

  it('恰好等于预算不算截断', () => {
    const content = 'B'.repeat(STUDIO_CHAR_LIMIT)
    const lines = renderStudioBlock(content).split('\n')
    expect(lines[1]).not.toContain('已截断')
    expect(lines[2]).toHaveLength(STUDIO_CHAR_LIMIT)
  })

  it('CRLF 归一，且首尾空白不占预算', () => {
    const block = renderStudioBlock('\r\n  hello  \r\n')
    expect(block.split('\n')[2]).toBe('hello')
  })
})
