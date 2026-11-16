/**
 * SuperAgent 编排闭环（Mastra 迁移计划 v1.2 §9.2，Phase 4 主体）。
 *
 * ⚠️ **已停用（施工计划 v4）**：新任务模型不再经过专家编排——没有派单、没有 validator、
 * 没有 pass/fail 判定。任务事实由 `create_task` / `artifact.recorded` / `work.finished`
 * 直接写进同一个 journal（`work.*` 事件），由 `store/tasks.ts` 投影。
 *
 * 本文件仍服务于**历史任务**（`task.*` 事件的重派与只读展示）。它里面的 validator 与
 * 状态机是被 v4 明确推翻的设计，**不要照着它给新功能加状态**；要删就整条链路一起删。
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
import { observedArtifactOf, preferObservedArtifact, type ObservedArtifact } from './artifactPath'
import type { ClampResult } from './envelope'
import { resolveExpert, type ExpertDefinition } from './experts'
import { validateArtifact, type ArtifactCandidate, type ValidationCheck, type ValidationResult } from './validator'
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
    /**
     * 上一次尝试的验收失败摘要（第 2 次及以后才有）。
     *
     * 重试此前是「同一封信封再跑一遍」：专家看不到上一轮错在哪，只能靠运气。
     * 真机上表现为内容写得完全正常、却因为「产物文件存在」失败，第二次原样再失败一次。
     */
    previousFailure?: string
  }): Promise<ExpertRunResult>
}

export interface ExpertRunResult {
  /** 专家产出的候选产物元数据（staging） */
  artifact: ArtifactCandidate
  /** 回执文本（进 journal） */
  receipt?: string
  /** 专家侧记录的上下文哈希（accept 证据） */
  contextHash: string
  /**
   * 工具实测到的真实产物（A02）：媒体生成工具在 details 里带回工作区相对路径。
   * 存在时编排器以它为准，而不是模型在回执里抄的路径。
   */
  observed?: ObservedArtifact
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
  /**
   * 并发闸（C15）：包住「记 task.started + 跑专家」这一段。
   * 排队期间不写 task.started，任务因此停在 todo（task.assigned 的投影），
   * 取得槽位后才转 active —— 看板不会把排队中的任务谎报成执行中。
   */
  withSlot?: <T>(fn: () => Promise<T>) => Promise<T>
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
  /**
   * **信封**对应的需求版本（A05/R02）。
   *
   * 版本属于实际执行的那份输入，不是执行时刻：信封按派单时的 intent 构建，排队期间
   * 或两次尝试之间用户改需求，信封不会自动变成新版。此前每次尝试开始重读 revision，
   * 于是旧信封的结果被标成满足新版需求、比对形同虚设。这里在 `task.created` 落盘后
   * 钉死一次（创建即第 1 版），后续尝试复用；只有真的用新版输入重建信封才该换版本。
   */
  let envelopeRevision = 1

  await service.append('task.created', intent.taskId, 'main', {
    title: intent.prompt.slice(0, 200),
    prompt: intent.prompt,
    accept: intent.accept,
    lane: clamp.envelope.lane.join(','),
    scope: intent.scope,
    expert: expertId,
    /*
     * 完整输入快照（A10）：重派此前只带 scope/prompt/accept，参考资产、邻接镜、
     * 负面约束、分层提示与自定义 lane 全丢了——需要参考图的任务点「重派」后等于
     * 换了个任务重做。journal 是唯一事实源，所以要把可重建输入的字段一并落下来。
     */
    spec: {
      ...(intent.promptLayers?.length ? { promptLayers: intent.promptLayers } : {}),
      ...(intent.entities?.length ? { entities: intent.entities } : {}),
      ...(intent.adjacent?.length ? { adjacent: intent.adjacent } : {}),
      ...(intent.negative?.length ? { negative: intent.negative } : {}),
      ...(intent.lane?.length ? { lane: intent.lane } : {}),
    },
    ...(clamp.rejected.length ? { rejected: clamp.rejected } : {}),
    ...(clamp.dropped.length ? { dropped: clamp.dropped } : {}),
    ...(resolved.fellBack && intent.expert ? { expertFallbackFrom: intent.expert } : {}),
    shadow,
  })
  /*
   * 信封 = 第 1 版需求（R02）：revision 由 `task.created` 定义，之后的 user.changed
   * 都是新版需求。这里显式落一次，避免"执行时再读"把旧信封标成新版本。
   */
  envelopeRevision = await currentRequirementRevision(service, intent.taskId)
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
    await service.append('task.cancelled', intent.taskId, 'user', { reason: '任务在派单后立即被取消' })
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
  /** 上一轮验收失败摘要：传给下一次尝试，让重试有方向（此前的重试是原样再跑一遍） */
  let previousFailure: string | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      await service.append('task.cancelled', intent.taskId, 'user', { reason: '任务被取消', attempt })
      emit({ type: 'task.status', taskId: intent.taskId, status: 'blocked', attempts: attempt, reason: '已取消' })
      return { taskId: intent.taskId, status: 'blocked', clamp, activated: false, failures: [...failures, '已取消'] }
    }
    // 记 started 与跑专家一起进闸（C15）：排队中的任务不该有 task.started，
    // 否则看板会把它显示成「执行中」，而它其实连模型都没调
    const startedAttempt = async (): Promise<ExpertRunResult> => {
      await service.append('task.started', intent.taskId, 'expert', { attempt, expert: expertId })
      return expert.run({
        envelope: clamp.envelope,
        threadId: attempt === 1 ? threadId : `${threadId}-r${attempt}`,
        expert: resolved.expert,
        ...(signal ? { signal } : {}),
        // 重试要带上上一轮的失败摘要，否则「再跑一遍」等于让专家猜（第 2 次才需要）
        ...(attempt > 1 && previousFailure ? { previousFailure } : {}),
        // 流式事件与任务状态共用一个出口；taskId/attempt 由编排层补齐，
        // 专家执行器只管发 text/thinking/tool 片段。
        broadcast: (event) => {
          emit({ ...event, taskId: intent.taskId, attempt } as unknown as TaskEvent)
        }
      })
    }

    let run: ExpertRunResult
    try {
      run = options.withSlot ? await options.withSlot(startedAttempt) : await startedAttempt()
    } catch (error) {
      const cancelled = signal?.aborted === true
      const raw = error instanceof Error ? error.message : String(error)
      // 取消不是「执行失败」：状态统一为 blocked（与 board 投影一致），不再留 attention 让主 Agent 重派；
      // 原因文案也按取消写，否则会被读成「专家不会产出回执」
      const reason = cancelled ? '任务被用户取消' : raw
      failures.push(`${cancelled ? '专家执行被取消' : '专家执行失败'}（第 ${attempt} 次）：${reason}`)
      // 取消与「做不出」落不同事实（C5）：前者是任务没跑完，后者是专家判明做不出。
      // 两者投影都收成 blocked，但 journal 里必须能区分，重派/对账才有依据。
      await service.append(cancelled ? 'task.cancelled' : 'artifact.rejected', intent.taskId, cancelled ? 'user' : 'expert', {
        reason,
        attempt,
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

    /*
     * 产物路径以工具回执为准（A02/R06）：先确定**本次采用的产物记录**，再对最终路径
     * 做一次 lane 与文件验收。此前的顺序是先检查模型声明的路径、再采用工具路径——
     * 模型抄错到 lane 外时，正确产物会被提前判越界（R06）。
     */
    const preferred = preferObservedArtifact(run.artifact, run.observed ?? null)
    const artifact = preferred.artifact
    lastArtifact = artifact
    // lane 白名单校验：产物必须落在允许写区（越界视为失败，计划 §9.3）。
    // 越界是「专家越权」而不是「可重试的验收失败」：状态统一 blocked，
    // 与 board 投影的 artifact.rejected→blocked 保持一致，并补发事件（此前静默）。
    if (artifact.path && !isPathAllowed(clamp.envelope, artifact.path)) {
      const reason = `产物越出 lane 写区：${artifact.path}`
      failures.push(reason)
      await service.append('artifact.rejected', intent.taskId, 'expert', { reason, attempt, lane: clamp.envelope.lane })
      emit({ type: 'task.status', taskId: intent.taskId, status: 'blocked', attempts: attempt, reason })
      return {
        taskId: intent.taskId,
        status: 'blocked',
        artifact,
        activated: false,
        clamp,
        failures,
      }
    }
    await service.append('artifact.ready', intent.taskId, 'expert', {
      artifactId: artifact.artifactId,
      assetId: artifact.assetId,
      version: artifact.version,
      attempt,
      ...(artifact.path ? { path: artifact.path } : {}),
      ...(preferred.receiptPath ? { receiptPath: preferred.receiptPath } : {}),
      ...(run.receipt ? { receipt: run.receipt } : {}),
    })

    // 确定性结构验收（LLM 不参与结论归属）。验收落真实文件：专家回执只是线索，
    // 存在性/字节数/扩展名/图片尺寸一律以磁盘为准（C1）
    const validation = await validateArtifact(clamp.envelope, artifact, {
      workspaceDir: service.workspaceDir,
      expertContextHash: run.contextHash,
    })
    lastValidation = validation

    emit({
      type: 'task.validation',
      taskId: intent.taskId,
      passed: validation.passed,
      artifactId: artifact.artifactId,
      ...(validation.evidence.reason ? { reason: validation.evidence.reason } : {}),
    })
    if (validation.passed) {
      // 验收通过 → 激活之间还有一次写盘：用户在这段时间点取消，旧实现照样会激活版本
      // 并回报 done（C8）。取消优先于激活——产物留在 staging，不切 active。
      if (signal?.aborted) {
        await service.append('task.cancelled', intent.taskId, 'user', {
          reason: '验收通过后、版本激活前被取消',
          attempt,
        })
        emit({ type: 'task.status', taskId: intent.taskId, status: 'blocked', attempts: attempt, reason: '已取消' })
        return {
          taskId: intent.taskId,
          status: 'blocked',
          artifact: run.artifact,
          validation,
          activated: false,
          clamp,
          failures: [...failures, '已取消'],
        }
      }
      /*
       * 激活前核对需求版本（A05）：验收跑的是**启动时**那份信封，用户中途把标准从
       * 16:9 改成 4:3 时，旧结果仍会按旧标准「通过」。这里在写验收结论之前比对
       * 投影里的最新 revision，不一致就落一条 stale 事实并退回 attention——
       * 不激活、不假装满足新需求。
       */
      const latestRevision = await currentRequirementRevision(service, intent.taskId)
      if (latestRevision > envelopeRevision) {
        const staleReason =
          `需求已变更（第 ${envelopeRevision} 版 → 第 ${latestRevision} 版），` +
          `本轮产物按旧需求验收通过，不予激活；请按最新需求重派或改回原需求`
        await service.append('requirement.stale', intent.taskId, 'validator', {
          reason: staleReason,
          attempt,
          artifactId: artifact.artifactId,
          staleRevision: envelopeRevision,
          requirementRevision: latestRevision,
        })
        emit({ type: 'task.status', taskId: intent.taskId, status: 'attention', attempts: attempt, reason: staleReason })
        return {
          taskId: intent.taskId,
          status: 'attention',
          artifact: run.artifact,
          validation,
          activated: false,
          clamp,
          failures: [...failures, staleReason],
        }
      }
      await service.append('validation.passed', intent.taskId, 'validator', {
        ...validation.evidence,
        // 把验收结论绑到具体产物上（C4）：不记 assetId/version，投影就无法阻止
        // 「A 的验收结论激活 B 的版本」；shadow 身份也要落下来（C19），
        // 否则「shadow 不切 active」只是 orchestrator 里的一个 if。
        assetId: artifact.assetId,
        version: artifact.version,
        shadow,
        // 结论绑定的需求版本（A05）：回放时能看出这次验收是针对第几版需求
        requirementRevision: envelopeRevision,
      })
      if (!shadow) {
        /*
         * 提交边界（A08）：上面的 abort 检查发生在写 `validation.passed` **之前**，
         * 而那次写盘本身就是一段可被取消介入的 await——期间用户点「停止」，
         * 旧实现照样往下写 `version.activated`，于是「取消成功」与「迟到激活」
         * 同时成立。激活前再核一次，把这扇窗收到只剩一次 append 的宽度。
         */
        if (signal?.aborted) {
          await service.append('task.cancelled', intent.taskId, 'user', {
            reason: '验收通过后、版本激活前被取消（产物留在 staging，不激活）',
            attempt,
          })
          emit({ type: 'task.status', taskId: intent.taskId, status: 'blocked', attempts: attempt, reason: '已取消' })
          return {
            taskId: intent.taskId,
            status: 'blocked',
            artifact: run.artifact,
            validation,
            activated: false,
            clamp,
            failures: [...failures, '已取消（激活前）'],
          }
        }
        // 版本激活：投影侧还会校验 accept 证据、assetId/version 一致与未被 shadow（双保险）
        await service.append('version.activated', intent.taskId, 'system', {
          assetId: artifact.assetId,
          version: artifact.version,
          artifactId: artifact.artifactId,
          requirementRevision: envelopeRevision,
        })
        emit({
          type: 'task.activated',
          taskId: intent.taskId,
          assetId: artifact.assetId,
          version: artifact.version,
          artifactId: artifact.artifactId,
          // 产物身份（R01）：画布只激活这一份，不能按 taskId 批量激活同任务的其它候选
          ...(artifact.path ? { path: artifact.path } : {}),
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
    // 失败细节进下一轮的指令：只带失败项与期望/实际，避免把整份 diff 塞进提示词
    const diff = Array.isArray(validation.evidence.diff) ? (validation.evidence.diff as ValidationCheck[]) : []
    const failedChecks = diff
      .filter((entry) => entry.passed === false)
      .map((entry) => `- ${entry.name}：期望 ${entry.expected}，实际 ${entry.actual}`)
      .join(String.fromCharCode(10))
    previousFailure = failedChecks ? `${reason}\n${failedChecks}` : reason
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
/**
 * 任务当前的需求版本（A05）：投影里 `task.created` = 1，每次 `user.changed` +1。
 * 读投影而不是自己数事件，保证「执行/验收/激活」与看板看到的是同一个 revision。
 */
async function currentRequirementRevision(service: SuperAgentService, taskId: string): Promise<number> {
  const board = await service.board()
  return board.find((task) => task.taskId === taskId)?.requirementRevision ?? 0
}

export function createLlmExpertRunner(deps: {
  gateway: ModelGateway
  modelRef: ModelRef
  memory: Memory
  /** 专家工具面（由调用方按 expert.tools 装配；缺省 = 纯文本专家） */
  toolsForExpert?: (
    expert: ExpertDefinition,
    signal: AbortSignal | undefined,
    /** 信封上下文：写区 lane 由派单信封决定，工具实现据此限制写入 */
    context: { taskId: string; lane: readonly string[] }
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
  /** 可选的产物解析钩子（默认解析回执里的 JSON 行） */
  parseArtifact?: (receipt: string, envelope: ClampResult['envelope']) => ArtifactCandidate | null
}): ExpertRunner {
  return {
    async run({ envelope, threadId, expert, signal, broadcast, previousFailure }) {
      const instructions = [
        envelopeToInstructions(envelope),
        '',
        previousFailure
          ? [
              '## 上一轮尝试未通过验收',
              '按下面的失败项修正后重新交付；不要重复同样的做法。',
              previousFailure,
            ].join(String.fromCharCode(10))
          : '',
        '## 专家规则',
        expert.instructions,
      ]
        .filter(Boolean)
        .join(String.fromCharCode(10))
      const tools = deps.toolsForExpert
        ? await deps.toolsForExpert(expert, signal, { taskId: envelope.taskId, lane: envelope.lane })
        : {}
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
      /** 工具实测到的最后一个媒体产物（A02）：模型回执里的 path 只作线索 */
      let lastObserved: ObservedArtifact | undefined
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
            // 媒体生成工具会带回真实产物路径（A02）：记住最后一个成功的产物
            const observed = observedArtifactOf(chunk.payload.result)
            if (observed) lastObserved = observed
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
      return {
        artifact,
        receipt,
        contextHash: `envelope:${envelope.taskId}:${envelope.scope}`,
        ...(lastObserved ? { observed: lastObserved } : {})
      }
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
    /*
     * 资产身份由系统持有，模型只需要说清「交付了什么」。
     *
     * 此前 `assetId` 被当成必填：模型写 `"assetId":""`（它确实不知道账本里的资产 id）
     * 就会被整条跳过，于是一个已经写好 13.8 KB 文件的任务报「回执格式不合格」→ blocked。
     * 现在只要求 artifactId/version/kind；assetId 缺省按 artifactId 生成——
     * 同一资产的后续版本要复用旧 id 时，模型显式填上即可。
     */
    if (!parsed.artifactId || !parsed.version || !parsed.kind) continue
    const artifactId = String(parsed.artifactId).trim()
    if (!artifactId) continue
    const declaredAssetId = typeof parsed.assetId === 'string' ? parsed.assetId.trim() : ''
    const path = parsed.path ? String(parsed.path).replace(/\\/g, '/') : undefined
    const formatFromPath = path?.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : undefined
    return {
      artifactId,
      assetId: declaredAssetId || artifactId,
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
