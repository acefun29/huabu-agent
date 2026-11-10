/**
 * SuperAgent 编排闭环（Mastra 迁移计划 v1.2 §9.2，Phase 4 主体）。
 *
 * 一次任务的全部事实都落 journal（append-only），board / 版本槽由投影重建：
 *
 *   task.created → task.assigned → task.started
 *     → [专家 Agent 执行，独立 memory + 信封 + lane]
 *     → artifact.ready（staging）
 *     → validator（确定性结构验收）
 *        pass → validation.passed → version.activated（shadow 模式下不激活）
 *        fail → validation.failed + diff → attention（主 Agent 重派 / 专家重试）
 *
 * 关键不变量（由 journal 校验 + 投影共同保证）：
 * - 版本只在 accept 后 active（shadow 模式下一律不写 version.activated）；
 * - 专家不继承主会话（独立 thread + 信封 instructions，不传主会话历史）；
 * - 失败带 diff 退回，不进入人工审批队列（计划 §1.1-3）。
 */

import { Agent } from '@mastra/core/agent'
import type { Memory } from '@mastra/memory'
import type { ModelGateway, ModelRef } from '../agent/mastra/modelGateway'
import { aiSdkLanguageModel } from '../agent/mastra/modelGateway'
import { MEMORY_RESOURCE } from '../agent/mastra/storage'
import { buildEnvelope, envelopeToInstructions, isPathAllowed, type TaskIntent } from './dispatch'
import type { ClampResult } from './envelope'
import { resolveExpert, type ExpertDefinition } from './experts'
import { validateArtifact, type ArtifactCandidate, type ValidationResult } from './validator'
import type { SuperAgentService } from './index'
import type { TaskEvent } from '../../shared/ipc'
import { toToolArgs, toToolResultText } from './conversation'

/** 专家执行器：跑一轮专家 Agent，返回候选产物（staging，未验收） */
export interface ExpertRunner {
  /**
   * @param envelope 已预检裁剪的信封
   * @param threadId 专家会话线程（与主会话隔离；重试换新线程）
   * @param expert 专家定义（指令追加 + 工具面）
   * @param signal 任务级取消信号（用户点「取消」）
   * @param broadcast 事件出口（可选，供 UI 展示专家进度）
   */
  run(params: {
    envelope: ClampResult['envelope']
    threadId: string
    expert: ExpertDefinition
    signal?: AbortSignal
    broadcast?: (event: Record<string, unknown>) => void
  }): Promise<ExpertRunResult>
}

export interface ExpertRunResult {
  /** 专家产出的候选产物元数据（staging） */
  artifact: ArtifactCandidate
  /** 回执文本（进 journal） */
  receipt?: string
  /** 专家侧记录的上下文哈希（accept 证据） */
  contextHash: string
}

export interface RunTaskOptions {
  /** shadow：只写 staging/journal，不切 active（Phase 4 出口要求先 shadow） */
  shadow?: boolean
  /** 最大验收重试次数（计划 §9.6：验收 2 次） */
  maxValidationAttempts?: number
  /** 专家线程 id 前缀（默认 `expert-<expertId>-<taskId>`） */
  threadId?: string
  /** 事件出口（task:event 通道；渲染端未接时忽略，计划 §9.7） */
  onTaskEvent?: (event: TaskEvent) => void
  /** 取消信号：abort 后不再发起新一轮，当前轮由专家执行器自行中断 */
  signal?: AbortSignal
}

export interface RunTaskResult {
  taskId: string
  status: 'done' | 'attention' | 'blocked'
  /** 专家产出的候选产物（staging） */
  artifact?: ArtifactCandidate
  validation?: ValidationResult
  /** 本次是否激活了版本（shadow 模式恒 false） */
  activated: boolean
  /** 预检/裁剪记录（可观测） */
  clamp: ClampResult
  /** 失败时的原因列表 */
  failures: string[]
}

/**
 * 跑一次完整任务（派单 → 专家 → 验收 → 版本槽）。
 * 所有状态变化先 append journal 再行动——journal 是唯一事实源，
 * 中途崩溃时 board/版本槽由已落盘事件重建，不会出现「版本已激活但无验收证据」。
 */
export async function runTask(params: {
  service: SuperAgentService
  intent: TaskIntent
  expert: ExpertRunner
  options?: RunTaskOptions
}): Promise<RunTaskResult> {
  const { service, intent, expert } = params
  const options = params.options ?? {}
  const maxAttempts = options.maxValidationAttempts ?? 2
  const shadow = options.shadow ?? false
  const resolved = resolveExpert(intent.expert)
  const expertId = resolved.expert.id
  const threadId = options.threadId ?? `expert-${expertId}-${intent.taskId}`
  const signal = options.signal
  const emit = (event: TaskEvent): void => {
    try {
      options.onTaskEvent?.(event)
    } catch {
      // 事件出口故障不得影响编排（journal 才是事实源）
    }
  }

  // 信封预检 + 裁剪（stale/pending 拒注入、超预算裁剪，原因记录）
  const clamp = buildEnvelope({ ...intent, expert: expertId })

  await service.append('task.created', intent.taskId, 'main', {
    title: intent.prompt.slice(0, 200),
    prompt: intent.prompt,
    accept: intent.accept,
    lane: clamp.envelope.lane.join(','),
    scope: intent.scope,
    expert: expertId,
    ...(clamp.rejected.length ? { rejected: clamp.rejected } : {}),
    ...(clamp.dropped.length ? { dropped: clamp.dropped } : {}),
    ...(resolved.fellBack && intent.expert ? { expertFallbackFrom: intent.expert } : {}),
    shadow,
  })
  if (clamp.rejected.length > 0 && clamp.envelope.entities.length + clamp.envelope.adjacent.length === 0) {
    // 全部引用都不可用 → 缺参考，不生成（计划 §8.4：缺参考不生成，转 needs_context）
    await service.append('artifact.rejected', intent.taskId, 'system', {
      reason: '缺参考：全部资产引用均为 stale/pending，未进入生成',
      rejected: clamp.rejected,
    })
    emit({ type: 'task.status', taskId: intent.taskId, status: 'blocked', attempts: 0, reason: '缺参考' })
    return {
      taskId: intent.taskId,
      status: 'blocked',
      clamp,
      activated: false,
      failures: ['缺参考：全部资产引用不可用'],
    }
  }

  if (signal?.aborted) {
    await service.append('artifact.rejected', intent.taskId, 'system', { reason: '任务在派单后立即被取消' })
    emit({ type: 'task.status', taskId: intent.taskId, status: 'blocked', attempts: 0, reason: '已取消' })
    return { taskId: intent.taskId, status: 'blocked', clamp, activated: false, failures: ['已取消'] }
  }

  await service.append('task.assigned', intent.taskId, 'main', {
    expert: expertId,
    lane: clamp.envelope.lane.join(','),
  })

  emit({ type: 'task.status', taskId: intent.taskId, status: 'active', attempts: 0 })
  const failures: string[] = []
  let lastValidation: ValidationResult | undefined
  let lastArtifact: ArtifactCandidate | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      await service.append('artifact.rejected', intent.taskId, 'system', { reason: '任务被取消', attempt })
      emit({ type: 'task.status', taskId: intent.taskId, status: 'blocked', attempts: attempt, reason: '已取消' })
      return { taskId: intent.taskId, status: 'blocked', clamp, activated: false, failures: [...failures, '已取消'] }
    }
    await service.append('task.started', intent.taskId, 'expert', { attempt, expert: expertId })

    let run: ExpertRunResult
    try {
      run = await expert.run({
        envelope: clamp.envelope,
        threadId: attempt === 1 ? threadId : `${threadId}-r${attempt}`,
        expert: resolved.expert,
        ...(signal ? { signal } : {}),
        // 流式事件与任务状态共用一个出口；taskId/attempt 由编排层补齐，
        // 专家执行器只管发 text/thinking/tool 片段。
        broadcast: (event) => {
          emit({ ...event, taskId: intent.taskId, attempt } as unknown as TaskEvent)
        }
      })
    } catch (error) {
      const cancelled = signal?.aborted === true
      const raw = error instanceof Error ? error.message : String(error)
      // 取消不是「执行失败」：状态统一为 blocked（与 board 投影一致），不再留 attention 让主 Agent 重派；
      // 原因文案也按取消写，否则会被读成「专家不会产出回执」
      const reason = cancelled ? '任务被用户取消' : raw
      failures.push(`${cancelled ? '专家执行被取消' : '专家执行失败'}（第 ${attempt} 次）：${reason}`)
      await service.append('artifact.rejected', intent.taskId, 'expert', {
        reason,
        attempt,
        ...(cancelled ? { cancelled: true } : {})
      })
      emit({
        type: 'task.status',
        taskId: intent.taskId,
        status: cancelled ? 'blocked' : 'attention',
        attempts: attempt,
        reason
      })
      return {
        taskId: intent.taskId,
        status: cancelled ? 'blocked' : 'attention',
        ...(lastArtifact ? { artifact: lastArtifact } : {}),
        ...(lastValidation ? { validation: lastValidation } : {}),
        activated: false,
        clamp,
        failures
      }
    }

    lastArtifact = run.artifact
    // lane 白名单校验：产物必须落在允许写区（越界视为失败，计划 §9.3）。
    // 越界是「专家越权」而不是「可重试的验收失败」：状态统一 blocked，
    // 与 board 投影的 artifact.rejected→blocked 保持一致，并补发事件（此前静默）。
    const artifactPath = (run.artifact as { path?: string }).path
    if (artifactPath && !isPathAllowed(clamp.envelope, artifactPath)) {
      const reason = `产物越出 lane 写区：${artifactPath}`
      failures.push(reason)
      await service.append('artifact.rejected', intent.taskId, 'expert', { reason, attempt, lane: clamp.envelope.lane })
      emit({ type: 'task.status', taskId: intent.taskId, status: 'blocked', attempts: attempt, reason })
      return {
        taskId: intent.taskId,
        status: 'blocked',
        artifact: run.artifact,
        activated: false,
        clamp,
        failures,
      }
    }

    await service.append('artifact.ready', intent.taskId, 'expert', {
      artifactId: run.artifact.artifactId,
      assetId: run.artifact.assetId,
      version: run.artifact.version,
      attempt,
      ...(run.receipt ? { receipt: run.receipt } : {}),
    })

    // 确定性结构验收（LLM 不参与结论归属）
    const validation = validateArtifact(clamp.envelope, run.artifact, run.contextHash)
    lastValidation = validation

    emit({
      type: 'task.validation',
      taskId: intent.taskId,
      passed: validation.passed,
      artifactId: run.artifact.artifactId,
      ...(validation.evidence.reason ? { reason: validation.evidence.reason } : {}),
    })
    if (validation.passed) {
      await service.append('validation.passed', intent.taskId, 'validator', { ...validation.evidence })
      if (!shadow) {
        // 版本激活：投影侧还会校验「有 accept 证据」，双保险
        await service.append('version.activated', intent.taskId, 'system', {
          assetId: run.artifact.assetId,
          version: run.artifact.version,
          artifactId: run.artifact.artifactId,
        })
        emit({
          type: 'task.activated',
          taskId: intent.taskId,
          assetId: run.artifact.assetId,
          version: run.artifact.version,
          artifactId: run.artifact.artifactId,
        })
      }
      emit({ type: 'task.status', taskId: intent.taskId, status: 'done', attempts: attempt })
      return {
        taskId: intent.taskId,
        status: 'done',
        artifact: run.artifact,
        validation,
        activated: !shadow,
        clamp,
        failures,
      }
    }

    const reason = validation.evidence.reason ?? '结构验收未通过'
    failures.push(reason)
    await service.append('validation.failed', intent.taskId, 'validator', { ...validation.evidence, reason, attempt })
    emit({ type: 'task.status', taskId: intent.taskId, status: 'attention', attempts: attempt, reason })
  }

  return {
    taskId: intent.taskId,
    status: 'attention',
    ...(lastArtifact ? { artifact: lastArtifact } : {}),
    ...(lastValidation ? { validation: lastValidation } : {}),
    activated: false,
    clamp,
    failures,
  }
}

/* --------------------------------------------------------- 默认专家执行器 */

/**
 * 基于 Mastra Agent 的默认专家执行器：独立 thread（memory 与主会话隔离）、
 * 信封 instructions（不含主会话历史）、按专家定义挂工具（媒体专家 = 真实生成能力）。
 *
 * 产物元数据由专家的「回执 JSON 行」声明，编排层解析成 ArtifactCandidate。
 * 媒体专家的 generate_image / generate_video 真正落盘，回执里的 path 必须是
 * 工具返回的真实相对路径——回执与落盘不一致时由 lane 校验与后续结构验收暴露。
 */
export function createLlmExpertRunner(deps: {
  gateway: ModelGateway
  modelRef: ModelRef
  memory: Memory
  /** 专家工具面（由调用方按 expert.tools 装配；缺省 = 纯文本专家） */
  toolsForExpert?: (
    expert: ExpertDefinition,
    signal?: AbortSignal
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
  /** 可选的产物解析钩子（默认解析回执里的 JSON 行） */
  parseArtifact?: (receipt: string, envelope: ClampResult['envelope']) => ArtifactCandidate | null
}): ExpertRunner {
  return {
    async run({ envelope, threadId, expert, signal, broadcast }) {
      const instructions = [envelopeToInstructions(envelope), '', '## 专家规则', expert.instructions]
        .filter(Boolean)
        .join(String.fromCharCode(10))
      const tools = deps.toolsForExpert ? await deps.toolsForExpert(expert, signal) : {}
      const agent = new Agent({
        name: `${expert.id}-${envelope.taskId}`,
        id: `${expert.id}-${envelope.taskId}`,
        instructions,
        model: aiSdkLanguageModel(deps.gateway, deps.modelRef),
        memory: deps.memory,
        ...(Object.keys(tools).length > 0 ? { tools: tools as never } : {}),
      })
      broadcast?.({ type: 'task.expert_start', expert: expert.id })
      let receipt = ''
      try {
        const events = await agent.stream(envelope.promptLayers.at(-1)?.prompt ?? '执行任务', {
          // threadId 真正生效：重试换新线程，不复用上一轮失败的上下文
          memory: { thread: threadId, resource: MEMORY_RESOURCE },
          ...(signal ? { abortSignal: signal } : {}),
          // 专家一轮内允许多次工具调用（参考读取 → 生成 → 校验），但不无限转
          maxSteps: 12,
        })
        for await (const chunk of events.fullStream) {
          if (chunk.type === 'text-delta') {
            receipt += chunk.payload.text
            broadcast?.({ type: 'task.expert_delta', channel: 'text', text: chunk.payload.text })
          } else if (chunk.type === 'reasoning-delta') {
            broadcast?.({
              type: 'task.expert_delta',
              channel: 'thinking',
              text: chunk.payload.text
            })
          } else if (chunk.type === 'tool-call') {
            broadcast?.({
              type: 'task.expert_tool_start',
              toolCallId: chunk.payload.toolCallId,
              toolName: chunk.payload.toolName,
              args: toToolArgs(chunk.payload.args)
            })
          } else if (chunk.type === 'tool-result') {
            broadcast?.({
              type: 'task.expert_tool_end',
              toolCallId: chunk.payload.toolCallId,
              toolName: chunk.payload.toolName,
              ...(toToolResultText(chunk.payload.result)
                ? { resultText: toToolResultText(chunk.payload.result) }
                : {}),
              ...(chunk.payload.isError ? { isError: true } : {})
            })
          } else if (chunk.type === 'tool-error') {
            broadcast?.({
              type: 'task.expert_tool_end',
              toolCallId: chunk.payload.toolCallId,
              toolName: chunk.payload.toolName,
              resultText: errorText(chunk.payload.error),
              isError: true
            })
          } else if (chunk.type === 'tool-output-denied') {
            broadcast?.({
              type: 'task.expert_tool_end',
              toolCallId: chunk.payload.toolCallId,
              toolName: chunk.payload.toolName,
              resultText: '用户拒绝了本次工具调用',
              isError: true
            })
          } else if (chunk.type === 'error') {
            broadcast?.({ type: 'task.expert_error', message: errorText(chunk.payload.error) })
          }
        }
      } finally {
        broadcast?.({ type: 'task.expert_end' })
      }
      const artifact =
        deps.parseArtifact?.(receipt, envelope) ?? parseArtifactFromReceipt(receipt, envelope)
      if (!artifact) throw new Error('专家未产出可解析的产物元数据（回执需含 artifact JSON 行）')
      return { artifact, receipt, contextHash: `envelope:${envelope.taskId}:${envelope.scope}` }
    },
  }
}

/** 流式错误统一转成可读文本（Error / 字符串 / 结构化错误对象） */
function errorText(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.trim()) return record.message
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value ?? '未知错误')
}

/**
 * 默认产物解析：回执里找形如 `{"artifactId","assetId","version","kind",...}` 的 JSON。
 * 找不到返回 null（由调用方判定失败）。
 *
 * 用「括号配平扫描」而不是单行正则：专家可能把回执包在代码块里或带嵌套字段
 * （如 params），正则会漏掉；配平扫描能取出完整对象，逐个尝试解析。
 */
export function parseArtifactFromReceipt(
  receipt: string,
  envelope: ClampResult['envelope']
): ArtifactCandidate | null {
  for (const raw of jsonObjectsIn(receipt)) {
    let parsed: Partial<ArtifactCandidate>
    try {
      parsed = JSON.parse(raw) as Partial<ArtifactCandidate>
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    if (!parsed.artifactId || !parsed.assetId || !parsed.version || !parsed.kind) continue
    const path = parsed.path ? String(parsed.path).replace(/\\/g, '/') : undefined
    const formatFromPath = path?.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : undefined
    return {
      artifactId: String(parsed.artifactId),
      assetId: String(parsed.assetId),
      version: String(parsed.version),
      kind: parsed.kind,
      ...(path ? { path } : {}),
      ...(typeof parsed.width === 'number' ? { width: parsed.width } : {}),
      ...(typeof parsed.height === 'number' ? { height: parsed.height } : {}),
      ...(typeof parsed.durationS === 'number' ? { durationS: parsed.durationS } : {}),
      ...(parsed.format ? { format: String(parsed.format).toLowerCase() } : formatFromPath ? { format: formatFromPath } : {}),
      ...(typeof parsed.bytes === 'number' ? { bytes: parsed.bytes } : {}),
    }
  }
  void envelope
  return null
}

/** 从文本里按花括号配平抽取所有可解析的顶层 JSON 对象（跳过字符串内的括号） */
function jsonObjectsIn(text: string): string[] {
  const found: string[] = []
  let inString = false
  let escaped = false
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) {
          found.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return found
}
