import { describe, expect, it } from 'vitest'
import {
  activeFacetSchema,
  coerceFacet,
  collectFacetValues,
  facetGroupKey,
  facetMatchesPrefix,
  facetPath,
  findFacetSchema,
  MAX_FACET_DEPTH,
  newFacetSchemaId,
  normalizeFacetKey,
  sanitizeFacetSchema,
  sanitizeFacetSchemas,
  schemaForFacet,
  stampFacetSchema,
  type FacetSchema
} from './facets'

/**
 * 测试用的两套结构（刻意在测试里定义，而不是从产品代码 import）：
 * 产品不内置任何方案，所以「有一套 集/场/镜 的结构」这件事本身就是测试数据。
 */
const DRAMA: FacetSchema = {
  id: 'test-drama',
  label: '短剧',
  levels: [
    { key: 'episode', label: '集', title: '剧集', hint: '第01集' },
    { key: 'scene', label: '场', title: '场景', hint: '第2场' },
    { key: 'shot', label: '镜', title: '镜头', hint: '第12镜' }
  ]
}

const MANGA: FacetSchema = {
  id: 'test-manga',
  label: '漫画',
  levels: [
    { key: 'chapter', label: '话' },
    { key: 'page', label: '页' }
  ]
}

describe('coerceFacet', () => {
  it('保留合法链条并按 schema 深度截断', () => {
    const result = coerceFacet({ chain: ['第01集', '第2场', '第12镜', '多余层'] }, DRAMA)
    expect(result).toEqual({ chain: ['第01集', '第2场', '第12镜'] })
  })

  it('遇到空值即截断，不允许中间空洞', () => {
    expect(coerceFacet({ chain: ['第01集', '', '第12镜'] }, DRAMA)).toEqual({
      chain: ['第01集']
    })
  })

  it('清洗空白与换行，并限长', () => {
    const long = 'x'.repeat(200)
    const result = coerceFacet({ chain: ['  第01集\n', long] }, DRAMA)
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
    expect(coerceFacet({ chain: ['a'], schemaId: 'facet-abc123', order: 3 })).toEqual({
      chain: ['a'],
      schemaId: 'facet-abc123',
      order: 3
    })
    expect(coerceFacet({ chain: ['a'], schemaId: 'has space' })).toEqual({ chain: ['a'] })
    expect(coerceFacet({ chain: ['a'], order: Number.NaN })).toEqual({ chain: ['a'] })
  })

  it('没有 schema 时用 MAX_FACET_DEPTH 兜底', () => {
    const many = Array.from({ length: 20 }, (_, i) => `L${i}`)
    expect(coerceFacet({ chain: many })?.chain.length).toBe(MAX_FACET_DEPTH)
  })
})

describe('sanitizeFacetSchema', () => {
  it('收下合法定义并补默认 key', () => {
    const schema = sanitizeFacetSchema({
      id: 'facet-1',
      label: '  分镜  ',
      levels: [{ label: '集' }, { label: '场', hint: '第2场' }]
    })
    expect(schema).toEqual({
      id: 'facet-1',
      label: '分镜',
      levels: [
        { key: 'level-1', label: '集' },
        { key: 'level-2', label: '场', hint: '第2场' }
      ]
    })
  })

  it('id 非法或缺失 → null（id 是落盘键，必须有）', () => {
    expect(sanitizeFacetSchema({ label: 'x', levels: [{ label: 'a' }] })).toBeNull()
    expect(sanitizeFacetSchema({ id: 'has space', label: 'x', levels: [{ label: 'a' }] })).toBeNull()
  })

  it('名称缺失 → null；层级为空 → null', () => {
    expect(sanitizeFacetSchema({ id: 'facet-1', label: '  ', levels: [{ label: 'a' }] })).toBeNull()
    expect(sanitizeFacetSchema({ id: 'facet-1', label: 'x', levels: [] })).toBeNull()
    // 全是无名层：同样不成立
    expect(sanitizeFacetSchema({ id: 'facet-1', label: 'x', levels: [{ label: '' }] })).toBeNull()
  })

  it('丢弃无名层，保留其余', () => {
    const schema = sanitizeFacetSchema({
      id: 'facet-1',
      label: 'x',
      levels: [{ label: '集' }, { label: '   ' }, { label: '镜' }]
    })
    expect(schema?.levels.map((l) => l.label)).toEqual(['集', '镜'])
  })

  it('层数超上限时截断', () => {
    const levels = Array.from({ length: MAX_FACET_DEPTH + 4 }, (_, i) => ({ label: `L${i}` }))
    expect(sanitizeFacetSchema({ id: 'facet-1', label: 'x', levels })?.levels.length).toBe(MAX_FACET_DEPTH)
  })

  it('层 key 重复时自动去重（React key / datalist id 不能撞）', () => {
    const schema = sanitizeFacetSchema({
      id: 'facet-1',
      label: 'x',
      levels: [
        { key: 'a', label: '集' },
        { key: 'a', label: '场' },
        { key: 'a', label: '镜' }
      ]
    })
    const keys = schema?.levels.map((l) => l.key) ?? []
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['a', 'a-2', 'a-3'])
  })

  it('保留 description 并限长；空白的 description 不落', () => {
    const withDesc = sanitizeFacetSchema({ id: 'facet-1', label: 'x', description: ' 说明 ', levels: [{ label: 'a' }] })
    expect(withDesc?.description).toBe('说明')
    const blank = sanitizeFacetSchema({ id: 'facet-1', label: 'x', description: '   ', levels: [{ label: 'a' }] })
    expect(blank && 'description' in blank).toBe(false)
  })
})

describe('sanitizeFacetSchemas', () => {
  it('丢弃坏条目，按 id 去重（后者覆盖）', () => {
    const list = sanitizeFacetSchemas([
      DRAMA,
      null,
      { id: 'bad id', label: 'x', levels: [{ label: 'a' }] },
      { ...DRAMA, label: '短剧v2' }
    ])
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe('短剧v2')
  })

  it('非数组输入返回空列表', () => {
    expect(sanitizeFacetSchemas(null)).toEqual([])
    expect(sanitizeFacetSchemas({})).toEqual([])
  })
})

describe('newFacetSchemaId', () => {
  it('生成合法 id 且不与已有冲突', () => {
    const existing = Array.from({ length: 40 }, (_, i) => `facet-x${i}`)
    for (let i = 0; i < 20; i += 1) {
      const id = newFacetSchemaId(existing)
      expect(id).toMatch(/^facet-[a-z0-9]{1,6}$/)
      expect(existing).not.toContain(id)
    }
  })
})

describe('findFacetSchema', () => {
  it('按 id 精确匹配', () => {
    expect(findFacetSchema([DRAMA, MANGA], 'test-manga')?.label).toBe('漫画')
  })

  it('未知 id / 空 id 返回 null（不再有内置默认回落）', () => {
    expect(findFacetSchema([DRAMA, MANGA], 'nope')).toBeNull()
    expect(findFacetSchema([DRAMA, MANGA], null)).toBeNull()
  })
})

describe('activeFacetSchema', () => {
  it('命中生效 id 时返回该套', () => {
    expect(activeFacetSchema([DRAMA, MANGA], 'test-manga')?.id).toBe('test-manga')
  })

  it('id 缺失或失效时回落第一套', () => {
    expect(activeFacetSchema([DRAMA, MANGA], null)?.id).toBe('test-drama')
    expect(activeFacetSchema([DRAMA, MANGA], 'ghost')?.id).toBe('test-drama')
  })

  it('没有任何结构时返回 null（UI 据此隐藏分级入口）', () => {
    expect(activeFacetSchema([], 'test-drama')).toBeNull()
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
    expect(facetPath({ chain: ['第01集', '第2场'] }, DRAMA)).toBe('第01集 / 第2场')
    expect(facetPath({ chain: ['a', 'b', 'c', 'd'] }, DRAMA)).toBe('a / b / c / +d')
    expect(facetPath(null, DRAMA)).toBe('')
  })

  it('没有 schema 时也能拼出路径（结构被删后仍可读）', () => {
    expect(facetPath({ chain: ['a', 'b'] }, null)).toBe('+a / +b')
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

describe('schemaForFacet（切换结构后按写入时语义显示）', () => {
  it('优先用 facet 自己的 schemaId', () => {
    const facet = { chain: ['第01集', '第2场'], schemaId: 'test-drama' }
    // 工作区已切成漫画，但这条分级仍应按短剧解释
    expect(schemaForFacet(facet, [DRAMA, MANGA], MANGA)?.id).toBe('test-drama')
  })

  it('没有 schemaId 时用当前生效结构', () => {
    expect(schemaForFacet({ chain: ['a'] }, [DRAMA, MANGA], MANGA)?.id).toBe('test-manga')
  })

  it('schemaId 指向已删除的结构时用当前生效结构', () => {
    expect(schemaForFacet({ chain: ['a'], schemaId: 'ghost' }, [DRAMA, MANGA], MANGA)?.id).toBe('test-manga')
  })

  it('没有任何可用结构时返回 null（层名未知，显示为「第N层」）', () => {
    expect(schemaForFacet(null, [], null)).toBeNull()
    expect(schemaForFacet({ chain: ['a'] }, [], null)).toBeNull()
  })
})

describe('stampFacetSchema（写入盖章）', () => {
  it('没有 schemaId 时补上写入用的结构', () => {
    expect(stampFacetSchema({ chain: ['a'] }, MANGA)).toEqual({
      chain: ['a'],
      schemaId: 'test-manga'
    })
  })

  it('已有同一 id 时原样返回（对象身份不变）', () => {
    const facet = { chain: ['a'], schemaId: 'test-manga' }
    expect(stampFacetSchema(facet, MANGA)).toBe(facet)
  })

  it('schemaId 与写入结构不同时以写入结构为准', () => {
    expect(stampFacetSchema({ chain: ['a'], schemaId: 'test-drama' }, MANGA)).toEqual({
      chain: ['a'],
      schemaId: 'test-manga'
    })
  })

  it('facet 为 null 或没有结构时原样返回', () => {
    expect(stampFacetSchema(null, DRAMA)).toBeNull()
    expect(stampFacetSchema({ chain: ['a'] }, null)).toEqual({ chain: ['a'] })
  })
})
