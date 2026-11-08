/**
 * 工作区级 Mastra Memory 工厂（Phase 1：基础对话记忆）。
 *
 * Phase 2 在这里升级：workingMemory 模板 + processors（预算/pin/trim）+ observational
 * memory（压缩可观测，compaction_* 事件）；Phase 1 只开 lastMessages 窗口，
 * 保证 thread 连续性与 history 回放先等价。
 */

import type { Memory } from '@mastra/memory'
import { mastraStorageFor } from './storage'

const memories = new Map<string, Promise<Memory>>()

export function mastraMemoryFor(workspaceDir: string): Promise<Memory> {
  const cached = memories.get(workspaceDir)
  if (cached) return cached
  const creating = (async () => {
    const { Memory } = await import('@mastra/memory')
    return new Memory({
      storage: await mastraStorageFor(workspaceDir),
      options: {
        lastMessages: 50,
        // 线程标题自动生成默认关闭：渲染端会话列表仍走 sessionFile 语义（Phase 5 接管）
        generateTitle: false,
      },
    })
  })()
  memories.set(workspaceDir, creating)
  creating.catch(() => memories.delete(workspaceDir))
  return creating
}
