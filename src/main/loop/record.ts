/**
 * 把「工具真的产出了文件」这个事实写进 journal（施工计划 v4 §10 第 5 步缺的那一环）。
 *
 * 为什么需要这一层：任务要变成 `done`，前提是它名下有产物（§9 规则 2）。
 * 但生成/写入工具只知道自己写了个文件，不知道「这属于哪个任务」；而模型也不该
 * 靠再报一次路径来声明产物——那会退回到「模型自己抄路径」的老毛病（A02 修过的东西）。
 *
 * 所以由系统**观测**工具回执：工具说它产出了什么，系统就把这条事实记到正在做的任务上。
 * 这不是质量判断，是数据完整性（§12）——产物必须能追溯到哪个任务产出的。
 *
 * 产出必须由**产出工具自己显式报告**，两种来源：
 * - 生成类工具：`details.artifactPath` + `details.artifact`（mime/bytes 齐备）
 * - 文本产出类（`write` / `patch` / `create_note`）：`details.artifact = { path, bytes }`
 *
 * 只有真的写了东西的工具才声明 `artifact`。`read` / `ls` 这类只读工具的 details
 * 里也有 path/bytes（给模型与 UI 看），但它们不是产出——靠形状猜会把「读了一遍」
 * 记成「产出了一版」，任务就会在零产出时误判完成。
 *
 * 刻意不做的事：
 * - 不判断产物好不好（§12）
 * - 不在任务不存在 / 路径越界时"猜一个任务"——直接跳过，事实宁缺毋滥
 */

import type { ToolDefinition } from '../agent/contracts'
import type { WorkspaceJournal } from '../superagent/journal'
import { loadWorkState } from './run'
import { taskForSession } from './sessionTask'
import { isWithinLane } from '../core/task'
import { normalizeArtifactPath } from '../core/artifact'

export interface RecordArtifactDeps {
  journal: () => WorkspaceJournal
  /**
   * 这次工具调用属于哪个会话。产物记到**该会话正在做的任务**上：
   * 同一工作区多会话并行时，全局「最近开工」会把 A 的产物记给 B。
   * 缺省（没有会话上下文，如单测）按全局最近开工。
   */
  nodeId?: () => string | undefined
  /** 观测到候选产物时的旁路通知（测试与调试用；生产用它广播刷新） */
  onRecorded?: (info: { taskId: string; path: string }) => void
}

/** 从工具回执里抽出候选产物；抽不出返回 null（大多数工具都没有） */
export function artifactFromToolResult(details: unknown): {
  path: string
  kind: 'image' | 'video' | 'audio' | 'text'
  mime: string
  bytes: number
  params?: Record<string, unknown>
  /** 生成类工具（有 artifactPath）；文本产出类没有 */
  generated: boolean
} | null {
  if (!details || typeof details !== 'object') return null
  const record = details as Record<string, unknown>

  // 生成类：details.artifactPath 是 produce.ts 算好的工作区相对路径
  if (typeof record.artifactPath === 'string' && record.artifactPath.trim()) {
    const path = normalizeArtifactPath(record.artifactPath)
    if (!path) return null
    const media = (record.artifact ?? {}) as Record<string, unknown>
    const mime = typeof media.mime === 'string' ? media.mime : 'application/octet-stream'
    const bytes = typeof media.bytes === 'number' ? media.bytes : 0
    if (bytes <= 0) return null
    return {
      path,
      kind: kindOf(mime),
      mime,
      bytes,
      ...(record.params && typeof record.params === 'object'
        ? { params: record.params as Record<string, unknown> }
        : {}),
      generated: true
    }
  }

  // 文本产出类：产出工具在 details.artifact 里显式声明（fileTools.write / patch / noteTool.create_note）
  const produced = (record.artifact ?? null) as Record<string, unknown> | null
  if (produced) {
    const rawPath = typeof produced.path === 'string' ? produced.path.trim() : ''
    const bytes = typeof produced.bytes === 'number' ? produced.bytes : 0
    if (!rawPath || bytes <= 0) return null
    const path = normalizeArtifactPath(rawPath)
    if (!path) return null
    return { path, kind: 'text', mime: mimeOfText(path), bytes, generated: false }
  }

  return null
}

function kindOf(mime: string): 'image' | 'video' | 'audio' | 'text' {
  const value = mime.toLowerCase()
  if (value.startsWith('image/')) return 'image'
  if (value.startsWith('video/')) return 'video'
  if (value.startsWith('audio/')) return 'audio'
  return 'text'
}

function mimeOfText(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'text/markdown'
  if (ext === 'json') return 'application/json'
  return 'text/plain'
}

export type RecordOutcome =
  | { recorded: true; taskId: string; path: string }
  | { recorded: false; reason: string }

/**
 * 把一次工具回执记到活跃任务上。
 *
 * 跳过规则（都是「不该记」而不是「记了但不算」）：
 * - 回执里没有产物路径
 * - 当前没有正在做的任务
 * - 路径不在任务写区内
 * - 是文本产出但任务本身不是文本任务（避免把中间文件当交付物）
 */
export async function recordToolArtifact(
  deps: RecordArtifactDeps,
  details: unknown
): Promise<RecordOutcome> {
  const candidate = artifactFromToolResult(details)
  if (!candidate) return { recorded: false, reason: '回执里没有产物' }

  const journal = deps.journal()
  const state = await loadWorkState(journal)
  const task = taskForSession(state, deps.nodeId?.())
  if (!task) return { recorded: false, reason: '当前没有正在做的任务' }
  if (!isWithinLane(task.lane, candidate.path)) {
    return { recorded: false, reason: `产物不在任务写区 ${task.lane}/ 内` }
  }
  // 文本产出只记到文本任务上：图片任务里顺手写的提示词文件不是交付物
  if (!candidate.generated && task.kind !== 'text') {
    return { recorded: false, reason: '文本写入不记入非文本任务' }
  }

  await journal.append('artifact.recorded', task.id, 'main', {
    path: candidate.path,
    kind: candidate.kind,
    mime: candidate.mime,
    bytes: candidate.bytes,
    ...(candidate.params ? { params: candidate.params } : {})
  })
  deps.onRecorded?.({ taskId: task.id, path: candidate.path })
  return { recorded: true, taskId: task.id, path: candidate.path }
}

/**
 * 给工具列表套一层「产出即记账」。
 *
 * 只包裹 `execute`，不改参数与返回形状：工具的行为对模型完全不变，
 * 变化只发生在 journal 里——多了一条 `artifact.recorded`。
 */
export function withArtifactRecording(
  tools: ToolDefinition[],
  deps: RecordArtifactDeps
): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx)
      // 工具失败时不记账：没有产物可言（失败必须让产物不存在，§12 推论 3）
      if (!result.isError) {
        try {
          await recordToolArtifact(deps, result.details)
        } catch (error) {
          // 记账失败不能让工具调用看起来失败：文件已经落盘了，让模型重试生成只会浪费钱。
          // 记一条 warn，产物仍然可以被用户在磁盘上看到。
          console.warn(`[loop] 产物记账失败（文件已落盘，未记入任务）：${String(error)}`)
        }
      }
      return result
    }
  }))
}
