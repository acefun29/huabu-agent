import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assembleFacetTools } from './facetTools'
import { loadFacetsIndex, setFileFacet } from '../assets/facetsIndex'
import { FACET_SCHEMA_DRAMA } from '../../shared/facets'

/**
 * Agent 分级工具的行为（临时工作区，不碰真实数据）。
 * 重点：路径守卫、空 chain 清除、schema 截断、坏条目跳过而不整单失败。
 */
let dir = ''
let tools: ReturnType<typeof assembleFacetTools>

/** 直接调工具 execute（Pi 的 ToolDefinition.execute 是 5 参：id / params / signal / onUpdate / ctx） */
const run = async (name: string, params: unknown) => {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`工具不存在：${name}`)
  return (await tool.execute('call-1', params, undefined, undefined, {} as never)) as {
    content: Array<{ type: string; text?: string }>
    details: Record<string, unknown>
  }
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((c) => c.text ?? '').join('\n')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'huabu-facet-tools-'))
  mkdirSync(join(dir, '.huabu'), { recursive: true })
  tools = assembleFacetTools({ currentDir: () => dir, schemaId: () => null, notifyChanged: () => {} })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('set_facets', () => {
  it('给多个文件设同一位置，并盖章 schemaId', async () => {
    const result = await run('set_facets', {
      entries: [
        { relPath: 'assets/images/a.png', chain: ['第02集', '第1场'] },
        { relPath: 'assets/images/b.png', chain: ['第02集', '第1场'] }
      ]
    })
    expect(result.details).toMatchObject({ ok: true, updated: 2, removed: 0, schemaId: 'drama' })
    const facets = loadFacetsIndex(dir)
    expect(facets['assets/images/a.png']).toEqual({ chain: ['第02集', '第1场'], schemaId: 'drama' })
    expect(facets['assets/images/b.png']).toEqual({ chain: ['第02集', '第1场'], schemaId: 'drama' })
  })

  it('chain: null 清除分级', async () => {
    setFileFacet(dir, 'assets/images/a.png', { chain: ['第01集'] }, FACET_SCHEMA_DRAMA)
    const result = await run('set_facets', { entries: [{ relPath: 'assets/images/a.png', chain: null }] })
    expect(result.details).toMatchObject({ ok: true, updated: 0, removed: 1 })
    expect(loadFacetsIndex(dir)['assets/images/a.png']).toBeUndefined()
  })

  it('超出 schema 深度的层被截断', async () => {
    await run('set_facets', {
      entries: [{ relPath: 'a.png', chain: ['第01集', '第2场', '第12镜', '溢出层'] }]
    })
    expect(loadFacetsIndex(dir)['a.png'].chain).toEqual(['第01集', '第2场', '第12镜'])
  })

  it('越界路径被跳过并在结果里报告，合法条目照常写入', async () => {
    const result = await run('set_facets', {
      entries: [
        { relPath: '../outside.png', chain: ['第01集'] },
        { relPath: 'assets/images/good.png', chain: ['第01集'] }
      ]
    })
    expect(result.details).toMatchObject({ ok: true, updated: 1 })
    expect((result.details.rejected as string[]).join('')).toContain('越出工作区')
    expect(Object.keys(loadFacetsIndex(dir))).toEqual(['assets/images/good.png'])
  })

  it('全部条目不合法时返回指引文本而不是抛错', async () => {
    const result = await run('set_facets', { entries: [{ relPath: '../../escape.png', chain: ['第01集'] }] })
    expect(result.details.ok).toBe(false)
    expect(textOf(result)).toContain('没有可写入的条目')
  })

  it('空 entries 返回指引', async () => {
    const result = await run('set_facets', { entries: [] })
    expect(result.details.ok).toBe(false)
    expect(textOf(result)).toContain('entries 不能为空')
  })

  it('相对路径里的反斜杠被规范成正斜杠', async () => {
    // 注意不能以 \ 开头：那在 Windows 上是「从盘符根开始」的绝对路径，会被路径守卫正确拒绝
    await run('set_facets', { entries: [{ relPath: 'assets\\images\\a.png', chain: ['第01集'] }] })
    expect(Object.keys(loadFacetsIndex(dir))).toEqual(['assets/images/a.png'])
  })

  it('以分隔符开头的路径按绝对路径拒绝（不许借它越出工作区）', async () => {
    const result = await run('set_facets', { entries: [{ relPath: '\\assets\\images\\a.png', chain: ['第01集'] }] })
    expect(result.details.ok).toBe(false)
    expect(Object.keys(loadFacetsIndex(dir))).toEqual([])
  })
})

describe('list_facets', () => {
  it('返回 schema 层定义与已分级条目', async () => {
    setFileFacet(dir, 'a.png', { chain: ['第01集', '第2场'] }, FACET_SCHEMA_DRAMA)
    const result = await run('list_facets', {})
    const text = textOf(result)
    expect(text).toContain('第01集 / 第2场')
    expect(text).toContain('短剧')
    expect(result.details).toMatchObject({ ok: true, graded: 1 })
  })

  it('prefix 只列出该位置下的文件', async () => {
    setFileFacet(dir, 'ep1.png', { chain: ['第01集', '第2场'] }, FACET_SCHEMA_DRAMA)
    setFileFacet(dir, 'ep2.png', { chain: ['第02集', '第1场'] }, FACET_SCHEMA_DRAMA)
    const result = await run('list_facets', { prefix: ['第02集'] })
    expect(result.details).toMatchObject({ ok: true, graded: 1 })
    expect(textOf(result)).toContain('ep2.png')
    expect(textOf(result)).not.toContain('ep1.png')
  })

  it('没有分级时提示如何写入', async () => {
    const result = await run('list_facets', {})
    expect(textOf(result)).toContain('还没有文件分级')
  })
})

describe('未打开工作区', () => {
  it('两个工具都返回指引文本而不是抛错', async () => {
    const noWorkspace = assembleFacetTools({ currentDir: () => null, schemaId: () => null, notifyChanged: () => {} })
    for (const name of ['list_facets', 'set_facets']) {
      const tool = noWorkspace.find((t) => t.name === name)!
      const result = (await tool.execute(
        'c',
        { entries: [{ relPath: 'a.png', chain: ['x'] }] },
        undefined,
        undefined,
        {} as never
      )) as {
        content: Array<{ text?: string }>
        details: Record<string, unknown>
      }
      expect(result.details.ok).toBe(false)
      expect(result.content[0]?.text).toContain('尚未打开工作区')
    }
  })
})

describe('工作区 schema 切换', () => {
  it('用工作区选定的 schema 盖章（漫画 → 话/页/格，两层深度不受限）', async () => {
    const mangaTools = assembleFacetTools({ currentDir: () => dir, schemaId: () => 'manga', notifyChanged: () => {} })
    const tool = mangaTools.find((t) => t.name === 'set_facets')!
    await tool.execute('c', { entries: [{ relPath: 'a.png', chain: ['第05话', '第3页'] }] }, undefined, undefined, {} as never)
    const saved = loadFacetsIndex(dir)['a.png']
    expect(saved).toEqual({ chain: ['第05话', '第3页'], schemaId: 'manga' })
  })
})
