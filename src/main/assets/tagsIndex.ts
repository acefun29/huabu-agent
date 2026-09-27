import { readFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { atomicWriteSync, recoverAtomicBackup } from '../fsutil/atomic'

/**
 * 文件标签索引（.huabu/tags.json，随工作区走）。
 *
 * 标签是文件级元数据：同一文件钉多张卡、出现在素材库面板与搜索里，都读这一份。
 * 结构刻意扁平：`{ version, tags: { <工作区相对路径>: string[] } }`；条目只在
 * 非空时存在（清空标签即删键），文件被移走/删除后残留键由下一次 set 时惰性忽略——
 * 索引是元数据不是账本，宁可残留也不碰用户文件。
 *
 * 写入与 jobs.json 同一手法：走 fsutil/atomic 的 tmp + rename 原子落盘，强杀不留半截
 * JSON，也绝不先删旧文件再改名（rm 与 rename 之间崩溃会把原文件彻底丢掉）。
 */

interface TagsIndexFile {
  version: 1
  tags: Record<string, string[]>
}

function tagsIndexPath(workspaceDir: string): string {
  return resolve(workspaceDir, '.huabu', 'tags.json')
}

function emptyIndex(): TagsIndexFile {
  return { version: 1, tags: {} }
}

/** 读索引（不存在/损坏时回退空索引；损坏只警告不抛——标签丢了不该挡住素材库） */
export function loadTagsIndex(workspaceDir: string): Record<string, string[]> {
  const file = tagsIndexPath(workspaceDir)
  // 读前先做崩溃恢复：上次若停在「旧文件挪成 .bak、新文件未落位」之间，索引在此还原
  recoverAtomicBackup(file)
  if (!existsSync(file)) return emptyIndex().tags
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TagsIndexFile>
    if (!parsed || typeof parsed !== 'object' || typeof parsed.tags !== 'object') return emptyIndex().tags
    const out: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(parsed.tags)) {
      if (Array.isArray(value)) {
        const cleaned = value.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        if (cleaned.length > 0) out[key.replace(/\\/g, '/')] = cleaned
      }
    }
    return out
  } catch (error) {
    console.warn(`[tags-index] tags.json 解析失败，按空索引处理：${String(error)}`)
    return emptyIndex().tags
  }
}

function saveTagsIndex(workspaceDir: string, tags: Record<string, string[]>): void {
  const file = tagsIndexPath(workspaceDir)
  mkdirSync(dirname(file), { recursive: true })
  atomicWriteSync(file, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tags } satisfies TagsIndexFile & { savedAt: string }, null, 2))
}

/** 标签清洗：去 #、去首尾空白、去重、单条限 12 字、最多 8 条（与渲染端约定一致） */
export function cleanTags(raw: string[]): string[] {
  return Array.from(new Set(raw.map((t) => t.trim().replace(/^#/, '').slice(0, 12)).filter(Boolean))).slice(0, 8)
}

/**
 * 设置单个文件的标签并落盘（tags 为空数组 = 删除该条目）。
 * 返回清洗后的标签（调用方广播与回传都以它为准）。
 */
export function setFileTags(workspaceDir: string, relPath: string, rawTags: string[]): string[] {
  const key = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const cleaned = cleanTags(rawTags)
  const tags = loadTagsIndex(workspaceDir)
  if (cleaned.length === 0) delete tags[key]
  else tags[key] = cleaned
  saveTagsIndex(workspaceDir, tags)
  return cleaned
}
