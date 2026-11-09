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
import { buildEnvelope, envelopeToInstructions, isPathAllowed, type TaskIntent } from './dispatch'
import type { ClampResult } from './envelope'
import { validateArtifact, type ArtifactCandidate, type ValidationResult } from './validator'
import type { SuperAgentService } from './index'
import type { TaskEvent } from '../../shared/ipc'

/** 专家执行器：跑一轮专家 Agent，返回候选产物（staging，未验收） */
export interface ExpertRunner {
  /**
   * @param envelope 已预检裁剪的信封
   * @param threadId 专家会话线程（与主会话隔离）
   * @param broadcast 事件出口（可选，供 UI 展示专家进度）
   */
  run(params: {
    envelope: ClampResult['envelope']
    threadId: string
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
  /** 专家线程 id 前缀（默认 taskId） */
  threadId?: string
  /** 事件出口（task:event 通道；渲染端未接时忽略，计划 §9.7） */
  onTaskEvent?: (event: TaskEvent) => void
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
  const threadId = options.threadId ?? `expert-${intent.taskId}`
  const emit = (event: TaskEvent): void => {
    try {
      options.onTaskEvent?.(event)
    } catch {
      // 事件出口故障不得影响编排（journal 才是事实源）
    }
  }

  // 信封预检 + 裁剪（stale/pending 拒注入、超预算裁剪，原因记录）
  const clamp = buildEnvelope(intent)

  await service.append('task.created', intent.taskId, 'main', {
    title: intent.prompt.slice(0, 200),
    lane: clamp.envelope.lane.join(','),
    scope: intent.scope,
    ...(clamp.rejected.length ? { rejected: clamp.rejected } : {}),
    ...(clamp.dropped.length ? { dropped: clamp.dropped } : {}),
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

  await service.append('task.assigned', intent.taskId, 'main', {
    expert: 'expert-visual',
    lane: clamp.envelope.lane.join(','),
  })

  emit({ type: 'task.status', taskId: intent.taskId, status: 'active', attempts: 0 })
  const failures: string[] = []
  let lastValidation: ValidationResult | undefined
  let lastArtifact: ArtifactCandidate | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await service.append('task.started', intent.taskId, 'expert', { attempt })

    let run: ExpertRunResult
    try {
      run = await expert.run({
        envelope: clamp.envelope,
        threadId: attempt === 1 ? threadId : `${threadId}-r${attempt}`,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`专家执行失败（第 ${attempt} 次）：${reason}`)
      await service.append('artifact.rejected', intent.taskId, 'expert', { reason, attempt })
      emit({ type: 'task.status', taskId: intent.taskId, status: 'attention', attempts: attempt, reason })
      break
    }

    lastArtifact = run.artifact
    // lane 白名单校验：产物必须落在允许写区（越界视为失败，计划 §9.3）
    const artifactPath = (run.artifact as { path?: string }).path
    if (artifactPath && !isPathAllowed(clamp.envelope, artifactPath)) {
      const reason = `产物越出 lane 写区：${artifactPath}`
      failures.push(reason)
      await service.append('artifact.rejected', intent.taskId, 'expert', { reason, attempt })
      break
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
 * 信封 instructions（不含主会话历史）、只暴露 lane 内可写的工具。
 *
 * 首版约束：专家用「文本回执」声明产物元数据（JSON 行），由编排层解析成
 * ArtifactCandidate。真正落盘生成（画布/媒体队列）在 Phase 4 后续接
 * mediaManager —— 这里先把「派单 → 产物 → 验收 → 版本」的闭环钉死。
 */
export function createLlmExpertRunner(deps: {
  gateway: ModelGateway
  modelRef: ModelRef
  memory: Memory
  /** 可选的产物解析钩子（默认解析回执里的 JSON 行） */
  parseArtifact?: (receipt: string, envelope: ClampResult['envelope']) => ArtifactCandidate | null
}): ExpertRunner {
  return {
    async run({ envelope }) {
      const agent = new Agent({
        name: `expert-${envelope.taskId}`,
        id: `expert-${envelope.taskId}`,
        instructions: envelopeToInstructions(envelope),
        model: aiSdkLanguageModel(deps.gateway, deps.modelRef),
        memory: deps.memory,
      })
      const events = await agent.stream(envelope.promptLayers.at(-1)?.prompt ?? '执行任务', {
        memory: { thread: `expert-thread-${envelope.taskId}`, resource: 'workspace' },
      })
      let receipt = ''
      for await (const chunk of events.fullStream) {
        if (chunk.type === 'text-delta') receipt += chunk.payload.text
      }
      const artifact =
        deps.parseArtifact?.(receipt, envelope) ?? parseArtifactFromReceipt(receipt, envelope)
      if (!artifact) throw new Error('专家未产出可解析的产物元数据（回执需含 artifact JSON 行）')
      return { artifact, receipt, contextHash: `envelope:${envelope.taskId}:${envelope.scope}` }
    },
  }
}

/**
 * 默认产物解析：回执里找形如 `{"artifactId","assetId","version","kind",...}` 的 JSON。
 * 找不到返回 null（由调用方判定失败）。
 */
export function parseArtifactFromReceipt(
  receipt: string,
  envelope: ClampResult['envelope']
): ArtifactCandidate | null {
  const matches = receipt.match(/\{[^{}]*"artifactId"[^{}]*\}/g) ?? []
  for (const raw of matches) {
    try {
      const parsed = JSON.parse(raw) as Partial<ArtifactCandidate>
      if (!parsed.artifactId || !parsed.assetId || !parsed.version) continue
      if (!parsed.kind) continue
      return {
        artifactId: parsed.artifactId,
        assetId: parsed.assetId,
        version: parsed.version,
        kind: parsed.kind,
        ...(parsed.path ? { path: parsed.path } : {}),
        ...(typeof parsed.width === 'number' ? { width: parsed.width } : {}),
        ...(typeof parsed.height === 'number' ? { height: parsed.height } : {}),
        ...(typeof parsed.durationS === 'number' ? { durationS: parsed.durationS } : {}),
        ...(parsed.format ? { format: parsed.format } : {}),
        ...(typeof parsed.bytes === 'number' ? { bytes: parsed.bytes } : {}),
      }
    } catch {
      continue
    }
  }
  void envelope
  return null
}
