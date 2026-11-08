/**
 * 工作区级 Mastra Memory 工厂（Phase 2：working memory + 上下文预算）。
 *
 * - working memory：结构化模板（计划 §8.1/§8.2），关键字段 pin 在模板里由模型维护，
 *   经 system message 注入、update_working_memory 工具自主更新；scope=thread（会话内）。
 * - 上下文预算：TokenLimiterProcessor 挂在 Agent inputProcessors（runtime.ts，按会话
 *   contextWindow 派生），历史超预算时按 memory-only 修剪。
 * - observational memory（旧对话压缩成 observation）与 compaction 事件桥接：后台引擎
 *   的 model 绑定与「memory 按工作区单例、model 按会话」存在结构矛盾，单独攻坚，
 *   见 Phase0 记录 §5.6。
 */

import type { Memory } from '@mastra/memory'
import { mastraStorageFor } from './storage'

const memories = new Map<string, Promise<Memory>>()

/** working memory 模板：pin 字段固定（模型只填值），防裁剪丢失关键状态（计划 §8.2） */
const WORKING_MEMORY_TEMPLATE = `# 工作记忆

## 当前范围
- （当前讨论的画布节点/场景，未知则写"未指定"）

## 进行中的任务
- （用户最近交办的事项与状态）

## 用户偏好
- （表达过的稳定偏好：风格、语言、称呼等）

## 当前引用
- （本轮上下文里活跃的资产引用摘要：id + 角色，不写文件内容）
`

export function mastraMemoryFor(workspaceDir: string): Promise<Memory> {
  const cached = memories.get(workspaceDir)
  if (cached) return cached
  const creating = (async () => {
    const { Memory } = await import('@mastra/memory')
    return new Memory({
      storage: await mastraStorageFor(workspaceDir),
      options: {
        lastMessages: 50,
        // Phase 2：working memory 开启（thread 级；system 注入 + 工具更新，见计划 §8.1）
        workingMemory: {
          enabled: true,
          template: WORKING_MEMORY_TEMPLATE,
          scope: 'thread',
        },
        // 线程标题自动生成默认关闭：渲染端会话列表仍走 sessionFile 语义（Phase 5 接管）
        generateTitle: false,
      },
    })
  })()
  memories.set(workspaceDir, creating)
  creating.catch(() => memories.delete(workspaceDir))
  return creating
}
