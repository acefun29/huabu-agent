/**
 * Context 装配（施工计划 §7 Loop 的「装配」一步）。
 *
 * 每轮模型看到的东西就这几块：
 *   常驻记忆（studio.md） + 当前任务说明
 *
 * 刻意不在这里拼：会话历史（Mastra 的 memory 负责）、其它记忆文件（模型自己 read/ls）、
 * 产物内容（模型自己 read 或看附带的图）。
 *
 * 为什么只拼这两块：装配得越多，越容易变成"第二事实源"。模型的上下文应该始终是
 * 「一小块常驻记忆 + 一份任务说明 + 它自己查到的」，而不是一份系统替它总结过的摘要。
 *
 * 本模块是纯的：接收字符串，返回字符串。读盘在调用侧做。
 */

import { renderStudioBlock } from '../core/memory'
import type { Task } from '../core/task'

export interface TurnContextInput {
  /** 本轮要推进的任务；纯对话回合没有 */
  task?: Task
  /** `.huabu/memory/studio.md` 的内容（不存在时传空串） */
  studioContent: string
  /** 任务当前版本的产物路径，让模型知道"上一版在哪" */
  currentArtifactPath?: string
}

/** 任务说明块。字段克制：只留模型真的会用到的。 */
function renderTask(task: Task, currentArtifactPath: string | undefined): string {
  const versions = task.artifacts.length
  const lines = [
    '## 当前任务',
    `- 编号：${task.id}`,
    `- 标题：${task.title}`,
    `- 要做什么：${task.brief}`,
    `- 写区：${task.lane}/（写到范围外的文件不会成为本任务的产物）`,
    `- 类型：${task.kind}`
  ]
  if (versions > 0) {
    lines.push(`- 已产出：${versions} 个版本${currentArtifactPath ? `，当前版本 ${currentArtifactPath}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * 装配本轮上下文。
 *
 * 顺序有讲究：常驻记忆在前（稳定前缀，利于 prompt 缓存命中），任务说明在后
 * （每轮都变）。这样同一个任务的多轮之间前缀一致，只有尾部在变。
 */
export function buildTurnContext(input: TurnContextInput): string {
  const blocks: string[] = [renderStudioBlock(input.studioContent)]
  if (input.task) {
    blocks.push(renderTask(input.task, input.currentArtifactPath))
  }
  return blocks.join('\n\n')
}
