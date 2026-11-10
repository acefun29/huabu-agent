import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FacetSchema } from '../../shared/facets'

/** 测试结构（产品不内置方案，这里按测试需要自建两套） */
const DRAMA: FacetSchema = {
  id: 'test-drama',
  label: '短剧',
  levels: [
    { key: 'episode', label: '集' },
    { key: 'scene', label: '场' },
    { key: 'shot', label: '镜' }
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
import {
  loadFacetsIndex,
  migrateFacetKey,
  removeFacetKey,
  setFileFacet,
  setFileFacetsBulk
} from './facetsIndex'

/**
 * facetsIndex 的落盘行为（临时工作区目录，不碰真实数据）。
 * 关注四件事：写入盖章 schemaId、schema 深度栅栏、批量统计、键随文件迁移/清理。
 */
let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'huabu-facets-'))
  mkdirSync(join(dir, '.huabu'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const readRaw = (): { facets: Record<string, { chain: string[]; schemaId?: string }> } =>
  JSON.parse(readFileSync(join(dir, '.huabu', 'facets.json'), 'utf8'))

describe('setFileFacet', () => {
  it('写入时盖上 schemaId', () => {
    const saved = setFileFacet(dir, 'assets/images/a.png', { chain: ['第01集', '第2场'] }, DRAMA)
    expect(saved).toEqual({ chain: ['第01集', '第2场'], schemaId: 'test-drama' })
    expect(readRaw().facets['assets/images/a.png']).toEqual(saved)
  })

  it('按 schema 深度截断多余层', () => {
    const saved = setFileFacet(
      dir,
      'assets/images/a.png',
      { chain: ['第01集', '第2场', '第12镜', '第4层'] },
      DRAMA
    )
    expect(saved?.chain).toEqual(['第01集', '第2场', '第12镜'])
  })

  it('切换 schema 后写入的新条目盖新 schemaId，旧条目保持原语义', () => {
    setFileFacet(dir, 'a.png', { chain: ['第01集'] }, DRAMA)
    setFileFacet(dir, 'b.png', { chain: ['第01话'] }, MANGA)
    const facets = readRaw().facets
    expect(facets['a.png'].schemaId).toBe('test-drama')
    expect(facets['b.png'].schemaId).toBe('test-manga')
  })

  it('空链 = 删除条目', () => {
    setFileFacet(dir, 'a.png', { chain: ['第01集'] }, DRAMA)
    expect(setFileFacet(dir, 'a.png', { chain: [] }, DRAMA)).toBeNull()
    expect(loadFacetsIndex(dir)['a.png']).toBeUndefined()
  })

  it('路径键规范化：反斜杠与前导斜杠都收敛成正斜杠', () => {
    setFileFacet(dir, '\\assets\\images\\a.png', { chain: ['第01集'] }, DRAMA)
    expect(Object.keys(readRaw().facets)).toEqual(['assets/images/a.png'])
  })
})

describe('setFileFacetsBulk', () => {
  it('统计 updated / removed，并盖章 schemaId', () => {
    setFileFacet(dir, 'old.png', { chain: ['第01集'] }, DRAMA)
    const result = setFileFacetsBulk(
      dir,
      [
        { relPath: 'a.png', facet: { chain: ['第02集', '第1场'] } },
        { relPath: 'b.png', facet: { chain: ['第02集'] } },
        { relPath: 'old.png', facet: null }
      ],
      DRAMA
    )
    expect(result).toEqual({ updated: 2, removed: 1 })
    const facets = readRaw().facets
    expect(facets['a.png']).toEqual({ chain: ['第02集', '第1场'], schemaId: 'test-drama' })
    expect(facets['old.png']).toBeUndefined()
  })

  it('删除不存在的条目不计入 removed', () => {
    const result = setFileFacetsBulk(dir, [{ relPath: 'ghost.png', facet: null }], DRAMA)
    expect(result).toEqual({ updated: 0, removed: 0 })
  })

  it('批量里被 schema 截断的条目同样落盘截断后的值', () => {
    setFileFacetsBulk(
      dir,
      [{ relPath: 'a.png', facet: { chain: ['第01集', '第2场', '第12镜', '溢出'] } }],
      DRAMA
    )
    expect(readRaw().facets['a.png'].chain).toEqual(['第01集', '第2场', '第12镜'])
  })
})

describe('键随文件迁移 / 清理', () => {
  it('migrateFacetKey 把分级带到新键', () => {
    setFileFacet(dir, 'assets/images/a.png', { chain: ['第01集'] }, DRAMA)
    migrateFacetKey(dir, 'assets/images/a.png', 'assets/images/b.png')
    const facets = readRaw().facets
    expect(facets['assets/images/a.png']).toBeUndefined()
    expect(facets['assets/images/b.png']).toEqual({ chain: ['第01集'], schemaId: 'test-drama' })
  })

  it('migrateFacetKey 对没有分级的文件是无害空操作', () => {
    migrateFacetKey(dir, 'nope.png', 'other.png')
    expect(loadFacetsIndex(dir)).toEqual({})
  })

  it('removeFacetKey 清理单条', () => {
    setFileFacet(dir, 'a.png', { chain: ['第01集'] }, DRAMA)
    setFileFacet(dir, 'b.png', { chain: ['第02集'] }, DRAMA)
    removeFacetKey(dir, 'a.png')
    expect(Object.keys(readRaw().facets)).toEqual(['b.png'])
  })
})

describe('损坏文件容错', () => {
  it('facets.json 不是合法 JSON 时按空索引处理，不抛错', () => {
    writeFileSync(join(dir, '.huabu', 'facets.json'), '{ 坏掉的内容', 'utf8')
    expect(loadFacetsIndex(dir)).toEqual({})
  })

  it('空链条目读入时被丢弃（不保留空对象）', () => {
    writeFileSync(
      join(dir, '.huabu', 'facets.json'),
      JSON.stringify({ version: 1, facets: { 'a.png': { chain: [] }, 'b.png': { chain: ['第01集'] } } }),
      'utf8'
    )
    expect(Object.keys(loadFacetsIndex(dir))).toEqual(['b.png'])
  })
})
