import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assembleFacetTools } from './facetTools'
import { loadFacetsIndex, setFileFacet } from '../assets/facetsIndex'
import type { FacetSchema } from '../../shared/facets'

/**
 * Agent 分级工具的行为（临时工作区，不碰真实数据）。
 *
 * 重点：产品不内置分级方案——工具必须能「先按用户说的层名定义结构，再写位置」，
 * 以及没结构时给出指引而不是瞎猜层名。其余：路径守卫、空 chain 清除、
 * 结构深度截断、坏条目跳过而不整单失败。
 */
let dir = ''
let tools: ReturnType<typeof assembleFacetTools>

/** 内存里的工作区结构表（模拟 store 的 facets 段） */
let schemas: FacetSchema[]
let activeId: string | null
/** 每次 notifyChanged 计数（验证写入后确实通知了渲染端） */
let notified: number

const DRAMA: FacetSchema = {
  id: 'test-drama',
  label: '短剧',
  levels: [
    { key: 'episode', label: '集', title: '剧集', hint: '第01集' },
    { key: 'scene', label: '场', title: '场景', hint: '第2场' },
    { key: 'shot', label: '镜', title: '镜头', hint: '第12镜' }
  ]
}

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

const buildTools = () =>
  assembleFacetTools({
    currentDir: () => dir,
    schemas: () => schemas,
    activeSchemaId: () => activeId,
    saveSchema: (schema, activate) => {
      const index = schemas.findIndex((s) => s.id === schema.id)
      if (index >= 0) schemas[index] = schema
      else schemas.push(schema)
      if (activate || schemas.length === 1) activeId = schema.id
    },
    deleteSchema: (id) => {
      const before = schemas.length
      schemas = schemas.filter((s) => s.id !== id)
      if (activeId === id) activeId = schemas[0]?.id ?? null
      return schemas.length !== before
    },
    notifyChanged: () => {
      notified += 1
    }
  })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'huabu-facet-tools-'))
  mkdirSync(join(dir, '.huabu'), { recursive: true })
  schemas = [DRAMA]
  activeId = DRAMA.id
  notified = 0
  tools = buildTools()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('set_facets', () => {
  it('给多个文件设同一位置，并盖章当前结构 id', async () => {
    const result = await run('set_facets', {
      entries: [
        { relPath: 'assets/images/a.png', chain: ['第02集', '第1场'] },
        { relPath: 'assets/images/b.png', chain: ['第02集', '第1场'] }
      ]
    })
    expect(result.details).toMatchObject({ ok: true, updated: 2, removed: 0, schemaId: 'test-drama' })
    const facets = loadFacetsIndex(dir)
    expect(facets['assets/images/a.png']).toEqual({ chain: ['第02集', '第1场'], schemaId: 'test-drama' })
    expect(facets['assets/images/b.png']).toEqual({ chain: ['第02集', '第1场'], schemaId: 'test-drama' })
    expect(notified).toBe(1)
  })

  it('chain: null 清除分级', async () => {
    setFileFacet(dir, 'assets/images/a.png', { chain: ['第01集'] }, DRAMA)
    const result = await run('set_facets', { entries: [{ relPath: 'assets/images/a.png', chain: null }] })
    expect(result.details).toMatchObject({ ok: true, updated: 0, removed: 1 })
    expect(loadFacetsIndex(dir)['assets/images/a.png']).toBeUndefined()
  })

  it('超出结构深度的层被截断', async () => {
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

  it('可以用 schemaId 指定按哪套结构写（并盖那套的 id）', async () => {
    schemas.push({
      id: 'test-manga',
      label: '漫画',
      levels: [
        { key: 'chapter', label: '话' },
        { key: 'page', label: '页' }
      ]
    })
    const result = await run('set_facets', {
      schemaId: 'test-manga',
      entries: [{ relPath: 'a.png', chain: ['第05话', '第3页'] }]
    })
    expect(result.details).toMatchObject({ ok: true, schemaId: 'test-manga' })
    expect(loadFacetsIndex(dir)['a.png']).toEqual({ chain: ['第05话', '第3页'], schemaId: 'test-manga' })
  })

  it('schemaId 不存在时返回指引，不写入', async () => {
    const result = await run('set_facets', {
      schemaId: 'ghost',
      entries: [{ relPath: 'a.png', chain: ['x'] }]
    })
    expect(result.details.ok).toBe(false)
    expect(textOf(result)).toContain('没有这个分级结构')
    expect(loadFacetsIndex(dir)).toEqual({})
  })
})

describe('list_facets', () => {
  it('返回结构定义与已分级条目', async () => {
    setFileFacet(dir, 'a.png', { chain: ['第01集', '第2场'] }, DRAMA)
    const result = await run('list_facets', {})
    const text = textOf(result)
    expect(text).toContain('第01集 / 第2场')
    expect(text).toContain('短剧')
    expect(text).toContain('当前生效')
    expect(result.details).toMatchObject({ ok: true, graded: 1, schemaId: 'test-drama' })
  })

  it('prefix 只列出该位置下的文件', async () => {
    setFileFacet(dir, 'ep1.png', { chain: ['第01集', '第2场'] }, DRAMA)
    setFileFacet(dir, 'ep2.png', { chain: ['第02集', '第1场'] }, DRAMA)
    const result = await run('list_facets', { prefix: ['第02集'] })
    expect(result.details).toMatchObject({ ok: true, graded: 1 })
    expect(textOf(result)).toContain('ep2.png')
    expect(textOf(result)).not.toContain('ep1.png')
  })

  it('没有分级时提示如何写入', async () => {
    const result = await run('list_facets', {})
    expect(textOf(result)).toContain('还没有文件分级')
  })

  it('工作区没有结构时明确提示先建结构，不假设层名', async () => {
    schemas = []
    activeId = null
    tools = buildTools()
    const result = await run('list_facets', {})
    const text = textOf(result)
    expect(result.details).toMatchObject({ ok: true, schemaId: null, schemas: [] })
    expect(text).toContain('还没有任何分级结构')
    expect(text).toContain('define_facet_schema')
  })
})

describe('define_facet_schema', () => {
  it('新建一套结构并置为生效', async () => {
    const result = await run('define_facet_schema', {
      label: '章节',
      levels: [{ label: '卷' }, { label: '章' }]
    })
    expect(result.details).toMatchObject({ ok: true, created: true, active: true })
    expect(schemas).toHaveLength(2)
    const created = schemas[1]
    expect(created.label).toBe('章节')
    expect(created.levels.map((l) => l.label)).toEqual(['卷', '章'])
    expect(activeId).toBe(created.id)
    expect(notified).toBeGreaterThan(0)
  })

  it('传 id 时更新已有结构而不是新建', async () => {
    const result = await run('define_facet_schema', {
      id: DRAMA.id,
      label: '短剧（改）',
      levels: [{ label: '集' }, { label: '场' }]
    })
    expect(result.details).toMatchObject({ ok: true, created: false })
    expect(schemas).toHaveLength(1)
    expect(schemas[0].label).toBe('短剧（改）')
    expect(schemas[0].levels).toHaveLength(2)
  })

  it('activate: false 时不改当前生效结构', async () => {
    await run('define_facet_schema', {
      label: '备用',
      levels: [{ label: '组' }],
      activate: false
    })
    expect(schemas).toHaveLength(2)
    expect(activeId).toBe(DRAMA.id)
  })

  it('缺少层名时拒绝并给出原因', async () => {
    const result = await run('define_facet_schema', { label: '空的', levels: [{ label: '' }] })
    expect(result.details.ok).toBe(false)
    expect(textOf(result)).toContain('不合法')
    expect(schemas).toHaveLength(1)
  })

  it('定义后 set_facets 按新层名工作（端到端：用户口述 → Agent 建结构 → 写位置）', async () => {
    await run('define_facet_schema', {
      label: '章节',
      levels: [{ label: '卷', hint: '第1卷' }, { label: '章', hint: '第3章' }]
    })
    await run('set_facets', { entries: [{ relPath: 'a.png', chain: ['第1卷', '第3章'] }] })
    const saved = loadFacetsIndex(dir)['a.png']
    expect(saved.chain).toEqual(['第1卷', '第3章'])
    expect(saved.schemaId).toBe(schemas[1].id)
  })
})

describe('delete_facet_schema', () => {
  it('删除结构并报告受影响文件数', async () => {
    setFileFacet(dir, 'a.png', { chain: ['第01集'] }, DRAMA)
    setFileFacet(dir, 'b.png', { chain: ['第02集'] }, DRAMA)
    const result = await run('delete_facet_schema', { id: DRAMA.id })
    expect(result.details).toMatchObject({ ok: true, affected: 2, schemaIdAfter: null })
    expect(schemas).toHaveLength(0)
    expect(activeId).toBeNull()
    // 分级数据保留（层名不再可解析，但值还在）
    expect(loadFacetsIndex(dir)['a.png'].chain).toEqual(['第01集'])
  })

  it('删掉生效结构后回落到下一套', async () => {
    schemas.push({
      id: 'test-manga',
      label: '漫画',
      levels: [{ key: 'chapter', label: '话' }]
    })
    const result = await run('delete_facet_schema', { id: DRAMA.id })
    expect(result.details).toMatchObject({ ok: true, schemaIdAfter: 'test-manga' })
    expect(activeId).toBe('test-manga')
  })

  it('id 不存在时返回指引，不误删', async () => {
    const result = await run('delete_facet_schema', { id: 'ghost' })
    expect(result.details.ok).toBe(false)
    expect(schemas).toHaveLength(1)
  })
})

describe('未打开工作区', () => {
  it('四个工具都返回指引文本而不是抛错', async () => {
    const noWorkspace = assembleFacetTools({
      currentDir: () => null,
      schemas: () => [],
      activeSchemaId: () => null,
      saveSchema: () => {},
      deleteSchema: () => false,
      notifyChanged: () => {}
    })
    for (const name of ['list_facets', 'set_facets', 'define_facet_schema', 'delete_facet_schema']) {
      const tool = noWorkspace.find((t) => t.name === name)!
      const result = (await tool.execute(
        'c',
        { entries: [{ relPath: 'a.png', chain: ['x'] }], id: 'x', label: 'x', levels: [{ label: 'x' }] },
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
