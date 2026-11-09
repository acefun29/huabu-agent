/**
 * 素材分级索引（.huabu/facets.json，随工作区走）。
 *
 * 为什么需要：短剧/漫画/套图这类生产流程里，一张图不是孤立的——它属于某个
 * 「镜头」，镜头属于「场景」，场景属于「剧集」。这种归属关系既不是文件路径
 * （素材库仍是平铺的，不因分级而搬目录），也不适合塞进标签（标签是扁平的、
 * 用来做交叉检索的，塞层级会把两者的语义搅在一起）。
 *
 * 设计要点（与 tagsIndex 同构，刻意保持简单）：
 * - 扁平键值：`{ version, facets: { <工作区相对路径>: Facet } }`
 * - 一个文件一条记录；多条记录描述同一文件时后者覆盖（不做列表）
 * - **不校验业务语义**：`chain` 只要求「从粗到细的字符串数组」，具体每层叫什么
 *   由 schema 决定（见 shared/facets.ts 的 FacetSchema）——这样短剧、
 *   漫画、产品套图、任意三维都共用同一套存储，不必改代码。
 * - 文件被移走/删除后残留键惰性忽略（索引是元数据不是账本）
 *
 * 与画布的关系：画布卡片只存引用，分级真相在这份索引里；渲染端启动时把
 * facets 合并进卡片 data.facets，与 tags 的同步方式完全一致。
 */

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { atomicWriteSync, recoverAtomicBackup } from '../fsutil/atomic'
import {
  coerceFacet,
  type Facet,
  type FacetSchema,
  normalizeFacetKey
} from '../../shared/facets'

interface FacetsIndexFile {
  version: 1
  facets: Record<string, Facet>
}

function facetsIndexPath(workspaceDir: string): string {
  return resolve(workspaceDir, '.huabu', 'facets.json')
}

/** 读索引（不存在/损坏时回退空索引；损坏只警告不抛——分级丢了不该挡住素材库） */
export function loadFacetsIndex(workspaceDir: string): Record<string, Facet> {
  const file = facetsIndexPath(workspaceDir)
  recoverAtomicBackup(file)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<FacetsIndexFile>
    if (!parsed || typeof parsed !== 'object' || typeof parsed.facets !== 'object') return {}
    const out: Record<string, Facet> = {}
    for (const [key, value] of Object.entries(parsed.facets)) {
      const facet = coerceFacet(value)
      // 空链条目视同未分级：不落键，避免索引里堆空对象
      if (facet) out[normalizeFacetKey(key)] = facet
    }
    return out
  } catch (error) {
    console.warn(`[facets-index] facets.json 解析失败，按空索引处理：${String(error)}`)
    return {}
  }
}

function saveFacetsIndex(workspaceDir: string, facets: Record<string, Facet>): void {
  const file = facetsIndexPath(workspaceDir)
  atomicWriteSync(
    file,
    JSON.stringify(
      { version: 1, savedAt: new Date().toISOString(), facets } satisfies FacetsIndexFile & {
        savedAt: string
      },
      null,
      2
    )
  )
}

/**
 * 设置单个文件的分级。`facet` 为 null / 空链 = 删除该条目。
 *
 * `schema` 只用来做**栅栏校正**（层数截断到 schema 深度）与键名规范化；
 * 传 null 表示不校正（用于迁移、批量导入等没有 schema 上下文的场景）。
 * 返回实际落盘的 facet（可能被截断），没有则返回 null。
 */
export function setFileFacet(
  workspaceDir: string,
  relPath: string,
  facet: Facet | null,
  schema?: FacetSchema | null
): Facet | null {
  const key = normalizeFacetKey(relPath)
  const coerced = coerceFacet(facet, schema)
  const facets = loadFacetsIndex(workspaceDir)
  if (!coerced) delete facets[key]
  else facets[key] = coerced
  saveFacetsIndex(workspaceDir, facets)
  return coerced
}

/**
 * 批量设置（Agent 一次标注整个场景时用）：避免 N 次读-改-写。
 * `entries` 里 facet 为 null 的项会删除对应条目。
 */
export function setFileFacetsBulk(
  workspaceDir: string,
  entries: Array<{ relPath: string; facet: Facet | null }>,
  schema?: FacetSchema | null
): { updated: number; removed: number } {
  const facets = loadFacetsIndex(workspaceDir)
  let updated = 0
  let removed = 0
  for (const entry of entries) {
    const key = normalizeFacetKey(entry.relPath)
    const coerced = coerceFacet(entry.facet, schema)
    if (!coerced) {
      if (key in facets) {
        delete facets[key]
        removed += 1
      }
      continue
    }
    facets[key] = coerced
    updated += 1
  }
  if (updated > 0 || removed > 0) saveFacetsIndex(workspaceDir, facets)
  return { updated, removed }
}

/**
 * 文件改名/移动后迁移键（与标签索引同一约定）。
 * 目标键已存在时以源值覆盖（用户刚改的名，沿用其分级）。
 */
export function migrateFacetKey(workspaceDir: string, fromRelPath: string, toRelPath: string): void {
  const from = normalizeFacetKey(fromRelPath)
  const to = normalizeFacetKey(toRelPath)
  if (from === to) return
  const facets = loadFacetsIndex(workspaceDir)
  const value = facets[from]
  if (!value) return
  delete facets[from]
  facets[to] = value
  saveFacetsIndex(workspaceDir, facets)
}

/** 删除文件后清理键（与标签索引同一约定：只清元数据，不碰文件） */
export function removeFacetKey(workspaceDir: string, relPath: string): void {
  const key = normalizeFacetKey(relPath)
  const facets = loadFacetsIndex(workspaceDir)
  if (!(key in facets)) return
  delete facets[key]
  saveFacetsIndex(workspaceDir, facets)
}
