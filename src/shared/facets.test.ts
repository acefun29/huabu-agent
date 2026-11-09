import { describe, expect, it } from 'vitest'
import {
  BUILTIN_FACET_SCHEMAS,
  FACET_SCHEMA_DRAMA,
  FACET_SCHEMA_PROMO,
  coerceFacet,
  collectFacetValues,
  facetGroupKey,
  facetMatchesPrefix,
  facetPath,
  findFacetSchema,
  normalizeFacetKey
} from './facets'

describe('coerceFacet', () => {
  it('保留合法链条并按 schema 深度截断', () => {
    const result = coerceFacet({ chain: ['第01集', '第2场', '第12镜', '多余层'] }, FACET_SCHEMA_DRAMA)
    expect(result).toEqual({ chain: ['第01集', '第2场', '第12镜'] })
  })

  it('遇到空值即截断，不允许中间空洞', () => {
    expect(coerceFacet({ chain: ['第01集', '', '第12镜'] }, FACET_SCHEMA_DRAMA)).toEqual({
      chain: ['第01集']
    })
  })

  it('清洗空白与换行，并限长', () => {
    const long = 'x'.repeat(200)
    const result = coerceFacet({ chain: ['  第01集\n', long] }, FACET_SCHEMA_DRAMA)
    expect(result?.chain[0]).toBe('第01集')
    expect(result?.chain[1].length).toBe(60)
  })

  it('空链返回 null（= 清除分级）', () => {
    expect(coerceFacet({ chain: [] })).toBeNull()
    expect(coerceFacet({ chain: ['', '  '] })).toBeNull()
    expect(coerceFacet(null)).toBeNull()
    expect(coerceFacet({ chain: 'not-an-array' })).toBeNull()
  })

  it('保留合法 schemaId 与 order，丢弃非法值', () => {
    expect(coerceFacet({ chain: ['a'], schemaId: 'drama', order: 3 })).toEqual({
      chain: ['a'],
      schemaId: 'drama',
      order: 3
    })
    expect(coerceFacet({ chain: ['a'], schemaId: 'has space' })).toEqual({ chain: ['a'] })
    expect(coerceFacet({ chain: ['a'], order: Number.NaN })).toEqual({ chain: ['a'] })
  })

  it('没有 schema 时用 MAX_FACET_DEPTH 兜底', () => {
    const many = Array.from({ length: 20 }, (_, i) => `L${i}`)
    expect(coerceFacet({ chain: many })?.chain.length).toBe(6)
  })
})

describe('findFacetSchema', () => {
  it('无 id 时返回默认（短剧）', () => {
    expect(findFacetSchema(BUILTIN_FACET_SCHEMAS, null)?.id).toBe('drama')
  })

  it('按 id 精确匹配', () => {
    expect(findFacetSchema(BUILTIN_FACET_SCHEMAS, 'promo')?.id).toBe('promo')
  })

  it('未知 id 返回 null', () => {
    expect(findFacetSchema(BUILTIN_FACET_SCHEMAS, 'nope')).toBeNull()
  })
})

describe('facetMatchesPrefix', () => {
  const facet = { chain: ['第01集', '第2场', '第12镜'] }

  it('空前缀恒匹配（含未分级）', () => {
    expect(facetMatchesPrefix(facet, [])).toBe(true)
    expect(facetMatchesPrefix(null, [])).toBe(true)
  })

  it('逐层精确匹配', () => {
    expect(facetMatchesPrefix(facet, ['第01集'])).toBe(true)
    expect(facetMatchesPrefix(facet, ['第01集', '第2场'])).toBe(true)
    expect(facetMatchesPrefix(facet, ['第02集'])).toBe(false)
  })

  it('未分级不匹配任何非空前缀；前缀比链长也不匹配', () => {
    expect(facetMatchesPrefix(null, ['第01集'])).toBe(false)
    expect(facetMatchesPrefix(facet, ['第01集', '第2场', '第12镜', '更深'])).toBe(false)
  })
})

describe('collectFacetValues', () => {
  it('按首次出现顺序收集某一层取值并去重', () => {
    const facets = [
      { chain: ['第02集', '第1场'] },
      { chain: ['第01集', '第2场'] },
      null,
      { chain: ['第02集', '第3场'] },
      { chain: ['第01集'] }
    ]
    expect(collectFacetValues(facets, 0)).toEqual(['第02集', '第01集'])
    expect(collectFacetValues(facets, 1)).toEqual(['第1场', '第2场', '第3场'])
  })
})

describe('facetPath / facetGroupKey', () => {
  it('facetPath 用 / 连接；超出 schema 深度加 + 前缀', () => {
    expect(facetPath({ chain: ['第01集', '第2场'] }, FACET_SCHEMA_DRAMA)).toBe('第01集 / 第2场')
    expect(facetPath({ chain: ['a', 'b', 'c', 'd'] }, FACET_SCHEMA_DRAMA)).toBe('a / b / c / +d')
    expect(facetPath(null, FACET_SCHEMA_DRAMA)).toBe('')
  })

  it('facetGroupKey 截到指定层，不足则返回全长', () => {
    const facet = { chain: ['第01集', '第2场', '第12镜'] }
    expect(facetGroupKey(facet, 1)).toBe('第01集')
    expect(facetGroupKey(facet, 9)).toBe('第01集\u0000第2场\u0000第12镜')
    expect(facetGroupKey(null, 1)).toBe('')
  })
})

describe('normalizeFacetKey', () => {
  it('反斜杠转正斜杠并去前导斜杠', () => {
    expect(normalizeFacetKey('\\assets\\images\\a.png')).toBe('assets/images/a.png')
    expect(normalizeFacetKey('/assets/a.png')).toBe('assets/a.png')
  })
})

describe('schema 自身的形状约束', () => {
  it('每套内置 schema 的层 key 唯一、层级非空', () => {
    for (const schema of BUILTIN_FACET_SCHEMAS) {
      expect(schema.levels.length).toBeGreaterThan(0)
      const keys = schema.levels.map((l) => l.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('套图是两层、短剧是三层（用于文档与 UI 预期）', () => {
    expect(FACET_SCHEMA_PROMO.levels.length).toBe(2)
    expect(FACET_SCHEMA_DRAMA.levels.length).toBe(3)
  })
})
