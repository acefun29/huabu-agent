/**
 * 派单工具（`list_tasks` / `delegate_tasks` / `cancel_task`）——主 Agent 指挥专家团的入口。
 *
 * 背景：专家池、任务板、journal 都已在主进程落地，但主 Agent 之前完全不知道它们存在。
 * 这三个工具把「看板 / 派单 / 取消」暴露给模型，且与 IPC 的 superagent 域共用同一条
 * 编排链（`SuperAgentRunner`）——不存在「Agent 走一套、UI 走另一套」的分叉。
 *
 * 设计约束（与项目其它工具一致）：
 * - 不可修复的错误（未打开工作区 / 没有可用模型）返回指引文本而不是抛错，避免打断整轮；
 * - 派单等待终态（对齐 Mastra 原生 subagent 工具）：工具阻塞到专家任务结束再返回最终状态，
 *   不是「受理即返回、让模型自己轮询」；进度仍经 task:event 实时推给任务板；
 * - 一次派单有上限（批量镜头是主要场景，但一次几十个会挤占生成配额）。
 */

import { Type } from 'typebox'
import type { ToolDefinitionLike } from './mediaTools'
import type { SuperAgentRunner } from '../superagent/runner'
import type { TaskIntent } from '../superagent/dispatch'
import type { SuperAgentAssetRef } from '../../shared/ipc'

export interface SuperAgentToolDeps {
  /** 当前工作区根目录（无工作区时工具返回指引文本） */
  currentDir: () => string | null
  /** 编排入口（与 IPC 共用） */
  runner: SuperAgentRunner
}

/** 单次派单上限：一次 20 个镜头已是批量上限 */
const MAX_DELEGATE = 20

const NO_WORKSPACE_TEXT =
  '尚未打开工作区：任务板存在工作区的 .huabu/journal.jsonl 里，请先让用户打开工作区。'

const STATUS_LABEL: Record<string, string> = {
  todo: '待开工',
  active: '执行中',
  validating: '验收中',
  blocked: '受阻',
  done: '已完成',
  attention: '待重派'
}

/** 工具参数里的引用（与 IPC 载荷同形，字段可省略处都是可选的） */
function toIntentRefs(raw: unknown): SuperAgentAssetRef[] {
  if (!Array.isArray(raw)) return []
  const refs: SuperAgentAssetRef[] = []
  for (const item of raw.slice(0, 16)) {
    const ref = item as Partial<SuperAgentAssetRef> | null
    if (!ref || typeof ref.assetId !== 'string' || typeof ref.path !== 'string' || !ref.path.trim()) continue
    const kind = ['image', 'video', 'audio', 'text'].includes(String(ref.kind)) ? ref.kind! : 'image'
    const role = ['character', 'location', 'prop', 'style', 'previous_take', 'reference'].includes(String(ref.role))
      ? ref.role!
      : 'reference'
    refs.push({
      assetId: ref.assetId,
      path: ref.path,
      version: typeof ref.version === 'string' && ref.version ? ref.version : 'v1',
      kind,
      role,
      status: ref.status === 'stale' || ref.status === 'pending' ? ref.status : 'active'
    })
  }
  return refs
}

export function assembleSuperAgentTools(deps: SuperAgentToolDeps): ToolDefinitionLike[] {
  const listTasks: ToolDefinitionLike = {
    name: 'list_tasks',
    label: '查看任务板',
    description:
      '查看当前工作区的 SuperAgent 任务板：每个任务的 id、范围（scope）、状态、承接专家、验收轮次与最近失败原因。' +
      '状态含义：todo 待开工 / active 执行中 / validating 机器验收中 / attention 验收失败待重派 / ' +
      'blocked 受阻（缺参考或越权）/ done 已完成。' +
      '派单前先用它确认有没有同名任务在跑；用户问「进度怎么样」时也用它回答。' +
      '可选 status 过滤，例如只列 attention 的任务来决定重派。',
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          description: '只看某个状态：todo / active / validating / attention / blocked / done'
        })
      ),
      limit: Type.Optional(Type.Number({ description: '最多返回多少条（默认 20，上限 50）' }))
    }),
    execute: async (_toolCallId, params) => {
      const dir = deps.currentDir()
      if (!dir) return { content: [{ type: 'text' as const, text: NO_WORKSPACE_TEXT }], details: { ok: false } }
      const raw = (params ?? {}) as { status?: unknown; limit?: unknown }
      const wantedStatus = typeof raw.status === 'string' ? raw.status.trim() : ''
      const limit = Math.min(50, Math.max(1, typeof raw.limit === 'number' ? Math.floor(raw.limit) : 20))
      const board = await deps.runner.board(dir)
      const filtered = wantedStatus
        ? board.tasks.filter((task) => task.status === wantedStatus)
        : board.tasks
      const rows = filtered.slice(-limit).reverse()
      const counts = board.tasks.reduce<Record<string, number>>((acc, task) => {
        acc[task.status] = (acc[task.status] ?? 0) + 1
        return acc
      }, {})
      const summary = Object.entries(counts)
        .map(([status, count]) => `${STATUS_LABEL[status] ?? status} ${count}`)
        .join(' · ')
      const lines = [
        `任务板：共 ${board.tasks.length} 个任务${summary ? `（${summary}）` : ''}` +
          `${board.runningTaskIds.length > 0 ? `，当前 ${board.runningTaskIds.length} 个在跑` : ''}。`,
        ...rows.map((task) => {
          const parts = [
            `- ${task.taskId} [${STATUS_LABEL[task.status] ?? task.status}]`,
            task.title ? `「${task.title}」` : '',
            task.scope ? `范围 ${task.scope}` : '',
            task.expert ? `专家 ${task.expert}` : '',
            task.attempts > 0 ? `已试 ${task.attempts} 次` : '',
            task.lastReason ? `原因：${task.lastReason}` : ''
          ].filter(Boolean)
          return parts.join(' · ')
        }),
        ...(filtered.length > rows.length ? [`-（另有 ${filtered.length - rows.length} 个未列出，可加 status/limit 缩小）`] : []),
        filtered.length === 0
          ? wantedStatus
            ? `没有状态为「${STATUS_LABEL[wantedStatus] ?? wantedStatus}」的任务。`
            : '任务板是空的：还没有派过单。'
          : '需要重派 attention 任务时，用相同 scope/prompt 再调 delegate_tasks（会生成新 taskId）。'
      ]
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: { ok: true, counts, running: board.runningTaskIds, tasks: rows }
      }
    }
  }

  const delegateTasks: ToolDefinitionLike = {
    name: 'delegate_tasks',
    label: '派单给专家',
    description:
      '把生成任务派给专家团执行（真正的图片/视频生成，不是文字描述），并等待专家返回最终结果。' +
      '每个任务给 scope（范围标识，同时决定专家可写的目录前缀）、prompt（画面描述）、' +
      'accept（机器可判定的验收标准，如「16:9」「时长 5 秒」「1920x1080」）。' +
      '可选：entities/adjacent 给角色/场景/上一版资产引用（path 用工作区相对路径；status 缺省 active，' +
      'stale/pending 会被预检拒绝）、lane 覆盖写区、expert 指定专家（expert-visual 视觉 / expert-exec 文本）。' +
      '这个工具会像原生 subagent 一样阻塞到每个专家任务结束，然后返回每个 taskId 的最终状态、' +
      '失败原因和产物；不要自己再调生成工具做同一个任务，也不要轮询 list_tasks。',
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          scope: Type.String({ description: '范围标识，如「第03集/第2场/第12镜」或 `scenes/s3`（也是写区前缀来源）' }),
          prompt: Type.String({ description: '给专家的画面描述：主体、风格、构图、光线、镜头运动' }),
          accept: Type.Array(Type.String(), {
            description: '机器可判定的验收标准（比例/尺寸/时长/格式），如 ["16:9","时长 5 秒"]'
          }),
          lane: Type.Optional(
            Type.Array(Type.String(), { description: '覆盖写区前缀（默认由 scope 派生为 `<scope>/`）' })
          ),
          entities: Type.Optional(
            Type.Array(
              Type.Object({
                assetId: Type.String(),
                path: Type.String({ description: '工作区相对路径' }),
                version: Type.Optional(Type.String()),
                kind: Type.Optional(Type.String({ description: 'image / video / audio / text' })),
                role: Type.Optional(Type.String({ description: 'character / location / prop / style / reference' })),
                status: Type.Optional(Type.String({ description: 'active / stale / pending' }))
              })
            )
          ),
          adjacent: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
          negative: Type.Optional(Type.Array(Type.String())),
          expert: Type.Optional(Type.String({ description: 'expert-visual（默认）/ expert-exec' }))
        }),
        { description: `要派的任务列表，一次最多 ${MAX_DELEGATE} 个` }
      ),
      shadow: Type.Optional(
        Type.Boolean({ description: 'true = 只产出候选版本不激活（默认 false，验收通过即激活）' })
      )
    }),
    execute: async (_toolCallId, params, signal) => {
      const dir = deps.currentDir()
      if (!dir) return { content: [{ type: 'text' as const, text: NO_WORKSPACE_TEXT }], details: { ok: false } }
      const raw = (params ?? {}) as { tasks?: unknown; shadow?: unknown }
      if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'tasks 不能为空：请给出要派的任务（scope + prompt + accept）。' }],
          details: { ok: false }
        }
      }
      const shadow = raw.shadow === true
      const accepted: Array<{ taskId: string; scope: string; expert: string }> = []
      const failures: string[] = []
      for (const item of raw.tasks.slice(0, MAX_DELEGATE)) {
        const task = item as {
          scope?: unknown
          prompt?: unknown
          accept?: unknown
          lane?: unknown
          entities?: unknown
          adjacent?: unknown
          negative?: unknown
          expert?: unknown
        } | null
        const scope = typeof task?.scope === 'string' ? task.scope.trim() : ''
        const prompt = typeof task?.prompt === 'string' ? task.prompt.trim() : ''
        if (!scope || !prompt) {
          failures.push(`缺少 scope 或 prompt：${JSON.stringify(item).slice(0, 80)}`)
          continue
        }
        const accept = Array.isArray(task?.accept)
          ? task.accept.map((entry) => String(entry ?? '').trim()).filter(Boolean).slice(0, 12)
          : []
        if (accept.length === 0) {
          failures.push(`${scope}：accept 为空，专家没有可判定的验收标准`)
          continue
        }
        const lane = Array.isArray(task?.lane)
          ? task.lane.map((entry) => String(entry ?? '').trim()).filter(Boolean).slice(0, 8)
          : []
        const negative = Array.isArray(task?.negative)
          ? task.negative.map((entry) => String(entry ?? '').trim()).filter(Boolean).slice(0, 12)
          : []
        const entities = toIntentRefs(task?.entities)
        const adjacent = toIntentRefs(task?.adjacent)
        const started = await deps.runner.start(dir, {
          scope,
          prompt,
          accept,
          ...(entities.length ? { entities: entities as TaskIntent['entities'] } : {}),
          ...(adjacent.length ? { adjacent: adjacent as TaskIntent['adjacent'] } : {}),
          ...(negative.length ? { negative } : {}),
          ...(lane.length ? { lane } : {}),
          ...(typeof task?.expert === 'string' && task.expert.trim() ? { expert: task.expert.trim() } : {}),
          shadow
        })
        if (!started.ok) {
          failures.push(`${scope}：${started.error.message}`)
          continue
        }
        accepted.push({ taskId: started.value.taskId, scope, expert: started.value.expert })
      }

      if (accepted.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `没有任务被受理：${failures.join('；') || '参数不合法'}。请修正后重试。`
            }
          ],
          details: { ok: false, failures }
        }
      }

      // 与 Mastra 原生 subagent 工具一致：等每个子任务跑完再返回，而不是受理即收工。
      // 主对话中止时同步取消专家任务，等待链立即释放。
      const cancelAccepted = (): void => {
        for (const entry of accepted) deps.runner.cancel(dir, entry.taskId)
      }
      if (signal?.aborted) cancelAccepted()
      signal?.addEventListener('abort', cancelAccepted, { once: true })
      try {
        await Promise.all(
          accepted.map((entry) => deps.runner.waitFor(dir, entry.taskId, signal))
        )
      } finally {
        signal?.removeEventListener('abort', cancelAccepted)
      }

      const board = await deps.runner.board(dir)
      const byId = new Map(board.tasks.map((task) => [task.taskId, task]))
      const results = accepted.map((entry) => {
        const task = byId.get(entry.taskId)
        return {
          ...entry,
          status: task?.status ?? 'blocked',
          ...(task?.lastReason ? { reason: task.lastReason } : {}),
          ...(task?.lastArtifactId ? { artifactId: task.lastArtifactId } : {})
        }
      })
      const unfinished = results.filter((result) => result.status !== 'done')
      const lines = [
        `专家团已返回：${results.length} 个任务结束。`,
        ...results.map((result) => {
          const parts = [
            `- ${result.taskId}`,
            result.scope,
            `→ ${STATUS_LABEL[result.status] ?? result.status}`,
            result.artifactId ? `产物 ${result.artifactId}` : '',
            result.reason ? `原因：${result.reason}` : ''
          ].filter(Boolean)
          return parts.join(' · ')
        }),
        ...(failures.length > 0 ? [`${failures.length} 个未受理：${failures.slice(0, 5).join('；')}`] : []),
        shadow ? '本次为 shadow 模式：只产出候选版本，不激活。' : '',
        signal?.aborted ? '主对话已中止：未完成的专家任务已取消。' : '',
        unfinished.length > 0
          ? '有任务未通过验收；如需重试，用相同 scope/prompt 再调 delegate_tasks。'
          : '全部任务通过验收并激活版本。'
      ].filter(Boolean)
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: { ok: true, accepted: results, failures, shadow, allDone: unfinished.length === 0 }
      }
    }
  }

  const cancelTask: ToolDefinitionLike = {
    name: 'cancel_task',
    label: '取消任务',
    description:
      '取消一个正在执行的任务（用户说「停下」「别生成了」时用）。' +
      '任务会中止当前生成、落一条取消事实，状态转 blocked。不在运行中的任务会返回说明（已完成/已取消/不存在）。' +
      '取消不可撤销：同一需求要重跑就再派一次单。',
    parameters: Type.Object({
      taskId: Type.String({ description: '要取消的 taskId（从 list_tasks 获取）' })
    }),
    execute: async (_toolCallId, params) => {
      const dir = deps.currentDir()
      if (!dir) return { content: [{ type: 'text' as const, text: NO_WORKSPACE_TEXT }], details: { ok: false } }
      const taskId = String((params as { taskId?: unknown })?.taskId ?? '').trim()
      if (!taskId) {
        return {
          content: [{ type: 'text' as const, text: '需要 taskId：请从 list_tasks 里取要取消的任务 id。' }],
          details: { ok: false }
        }
      }
      const cancelled = deps.runner.cancel(dir, taskId)
      return {
        content: [
          {
            type: 'text' as const,
            text: cancelled
              ? `已取消任务 ${taskId}。正在进行的生成会被中断，任务状态转为受阻（blocked）。`
              : `任务 ${taskId} 不在运行中（可能已完成、已取消或不存在）。可用 list_tasks 确认当前状态。`
          }
        ],
        details: { ok: true, cancelled, taskId }
      }
    }
  }

  return [listTasks, delegateTasks, cancelTask]
}
