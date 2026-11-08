/**
 * 工作区级 Mastra 存储生命周期（Mastra 迁移计划 v1.2 §7.6）。
 *
 * 每个工作区一个 LibSQL 文件库 `<workspace>/.huabu/mastra.db`：threads / messages /
 * memory 全在库里；canvas.json / workspace.json / sessions/*.jsonl 仍是各自真相，
 * 与 mastra.db 不双写。首次创建即 init() 建表；同工作区复用同一实例（LibSQL 连接池）。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LibSQLStore } from '@mastra/libsql'

const stores = new Map<string, Promise<LibSQLStore>>()

/** 工作区 .huabu 目录下的 mastra.db（会话/记忆唯一落点） */
export function mastraDbFile(workspaceDir: string): string {
  return join(workspaceDir, '.huabu', 'mastra.db')
}

export function mastraStorageFor(workspaceDir: string): Promise<LibSQLStore> {
  const cached = stores.get(workspaceDir)
  if (cached) return cached
  const creating = (async () => {
    mkdirSync(join(workspaceDir, '.huabu'), { recursive: true })
    const { LibSQLStore } = await import('@mastra/libsql')
    const store = new LibSQLStore({ id: 'huabu', url: pathToFileURL(mastraDbFile(workspaceDir)).href })
    await store.init()
    return store
  })()
  stores.set(workspaceDir, creating)
  creating.catch(() => stores.delete(workspaceDir))
  return creating
}

/** 会话的 resourceId：库按工作区隔离，资源名库内唯一即可 */
export const MEMORY_RESOURCE = 'workspace'
