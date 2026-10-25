import type { MediaKind } from '@shared/media'
import { REF_ROLE_LABEL } from '@shared/media'
import { shortModelLabel } from '@shared/mediaResolve'
import {
  getReferenceUpdateState,
  isReferenceSourceProduced,
  planGenerationChain,
  validateGenerateReferences
} from '../../lib/mediaReferenceGraph'
import type { AssetData, CanvasNode, GenerateInputSnapshot, GenerateRefSnapshot, GenerateReference, GenerateVersion } from '../../types'
import type { CanvasState } from '../canvasStore'
import type { StoreSet } from './chatRuntime'
import { BRIDGE_AVAILABLE, BRIDGE_UNAVAILABLE, MEDIA_LABEL, newNodeId, settingsBridgeRef } from './shared'
import type { JobRuntimeBridge, JobTerminalOutcome, SubmitPlan } from './jobRuntime'

/**
 * 生成链调度（媒体引用链的运行时）：把「目标卡 + 全部上游生成卡」按拓扑顺序串行执行，
 * 上游真实产物（任务事件捕获的 GenerateVersion）直接喂给下游请求，全程冻结本轮配置。
 *
 * 职责边界：这里只做**调度**（预检/复用判定/范围确认/顺序执行/取消与中止），
 * 提交与事件绑定细节全部经 JobRuntimeBridge 走 jobRuntime —— 纯调度与 store 胶水分明。
 *
 * 语义约定：
 * - 单 target：本轮以用户点的那张卡为目标，它的全部上游生成节点都必须成功才轮到它；
 * - 目标总重跑；上游无产物 / 输入已变更 / 本轮上游将重跑 → 跟着重跑；
 *   老结果（无输入快照，unknown）有产物可复用，复用产物在本轮开始就地固定；
 * - 预检区分「未产出但有执行配置」（链内上游，允许）与死引用/缺模型/角色配置错（结构性，拒绝）；
 * - 范围确认期间不加任何忙碌锁（用户可继续编辑画布），点击执行时重新冻结与复检；
 * - 失败/取消/工作区切换/参与卡被删除 → 停止后续提交并保留既有结果。
 */

export interface GenerationChainDeps {
  set: StoreSet
  get: () => CanvasState
  showToast: CanvasState['showToast']
  mutateNodeData: (id: string, fn: (data: AssetData) => AssetData) => void
  bridge: JobRuntimeBridge
}

/** 链上单卡的本轮冻结配置（确认执行时定格，执行中编辑卡片不影响本轮） */
interface FrozenNode {
  id: string
  kind: MediaKind
  needsRun: boolean
  provider: string
  model: string
  modelLabel: string
  prompt: string
  params: GenerateInputSnapshot['params']
  /** 本轮冻结的参考记录（执行期不重读画布，引用结构编辑不影响已确认的轮次） */
  refs: GenerateReference[]
  outputDir?: string
  libraryName?: string
}

interface PreparedChain {
  nodeIds: string[]
  nodes: Map<string, FrozenNode>
  runCount: number
}

type ChainFailure = { status: 'failed' | 'cancelled'; error: string }

interface ChainMachine {
  id: string
  /** 工作区稳定身份用 path（workspace 没有可靠 id）；每步提交前后都核对 */
  workspacePath: string
  nodeIds: string[]
  cancelled: boolean
  cancelPromise: Promise<JobTerminalOutcome>
  resolveCancel: (() => void) | null
}

export function createGenerationChain(deps: GenerationChainDeps) {
  const { set, get, showToast, mutateNodeData, bridge } = deps

  /** 同一时刻至多一条链（chainRun 全局单槽 + 机器句柄双保险） */
  let activeMachine: ChainMachine | null = null

  const patchChainRun = (machineId: string, patch: Partial<NonNullable<CanvasState['chainRun']>>) => {
    const current = get().chainRun
    if (!current || current.id !== machineId) return
    set({ chainRun: { ...current, ...patch } })
  }

  /**
   * 预检 + 冻结准备：拓扑计划 → 逐卡模型/引用结构/运行态检查 → 复用判定（拓扑序级联）。
   * 未产出（unproduced）不是结构性错误 —— 链内上游将在本轮生成；
   * 外部参考必须有产物（isReferenceSourceProduced）。
   */
  const prepareChain = (
    targetId: string,
    promptOverride?: string
  ): { ok: true; prep: PreparedChain } | { ok: false; error: string } => {
    const nodes = get().nodes
    const plan = planGenerationChain(targetId, nodes)
    if (plan.errors.length > 0) return { ok: false, error: plan.errors[0] }
    const nodeIds = plan.nodeIds
    if (!nodeIds.includes(targetId)) return { ok: false, error: '生成链计划未包含目标卡片' }
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const chainSet = new Set(nodeIds)
    const problems: string[] = []
    const needsRun = new Map<string, boolean>()
    const frozen = new Map<string, FrozenNode>()
    // 未产出的链内上游允许搭链，但角色/配额/模式约束不豁免：把链内未产出源视作
    // 「本轮将有产物」再跑一遍校验，此时报出的任何错误仍是结构错误（单卡直接提交
    // 才豁免未产出 —— 那条路径走 buildSubmitPlan 的严格校验，不由这里放行）。
    const preflightNodes = nodes.map((node) =>
      chainSet.has(node.id) && node.data.gen && !isReferenceSourceProduced(node)
        ? {
            ...node,
            data: { ...node.data, storage: 'media' as const, path: node.data.path ?? `__chain_pending__/${node.id}` }
          }
        : node
    )

    for (const id of nodeIds) {
      const node = byId.get(id)
      const gen = node?.data.gen
      if (!node || !gen) {
        problems.push('链上有一张卡片缺少生成配置')
        continue
      }
      if (gen.status === 'queued' || gen.status === 'running') {
        problems.push(`「${node.data.name}」正在生成中，请等它完成或取消后再运行链`)
        continue
      }
      const kind = (node.data.kind as MediaKind) ?? 'image'
      const resolved = settingsBridgeRef.current?.resolveMediaModel(kind, gen.params.model)
      if (!resolved) {
        problems.push(
          gen.params.model
            ? `「${node.data.name}」指定的模型已不可用，请重新选择`
            : `「${node.data.name}」没有可用的${MEDIA_LABEL[kind]}生成模型`
        )
        continue
      }
      const caps = bridge.refCapsFor(node.data)
      const validation = validateGenerateReferences(node, nodes, caps)
      // 结构性错误（死引用/角色/数量/模式，含「未产出链内上游也必须满足角色/配额/模式」
      // 的预检）拒绝；未产出本身（unproduced ⊆ errors）留给链内上游本轮生成
      const preflight = validateGenerateReferences(node, preflightNodes, caps)
      const structural = preflight.errors.filter((error) => !validation.unproduced.includes(error))
      if (structural.length > 0) {
        problems.push(`「${node.data.name}」：${structural[0]}`)
        continue
      }
      const refs = validation.references
      for (const ref of refs) {
        if (chainSet.has(ref.sourceNodeId)) continue
        const source = byId.get(ref.sourceNodeId)
        if (!source) {
          problems.push(`「${node.data.name}」的${REF_ROLE_LABEL[ref.role]}参考源卡片已被删除`)
          continue
        }
        if (!isReferenceSourceProduced(source)) {
          problems.push(`「${node.data.name}」的外部参考「${source.data.name}」还没有产物`)
        }
      }
      // 复用判定（拓扑序，级联）：目标总重跑；无产物必跑；输入已变更必跑；
      // 本轮上游将重跑 → 下游引用会指向新产物，跟着重跑；unknown 老结果有产物可复用
      let rerun = id === targetId
      const artifact = gen.versions.find((v) => v.id === gen.activeVersionId) ?? gen.versions[0]
      if (!rerun) {
        if (!artifact) rerun = true
        else {
          const state = getReferenceUpdateState(node, nodes)
          if (state === 'missing') {
            problems.push(`「${node.data.name}」的参考输入已缺失，无法复用旧结果`)
            continue
          }
          if (state === 'changed') rerun = true
          // 引用快照只覆盖 refs；提示词/模型/参数与快照的比对同样决定能否复用
          //（成功后卡片 params.ratio 会按实际产物回写，与请求值有差异时自然触发一轮重跑后收敛）
          else if (artifact.inputs) {
            const inputs = artifact.inputs
            if (
              inputs.prompt !== gen.prompt.trim() ||
              inputs.provider !== resolved.provider ||
              inputs.model !== resolved.model ||
              (inputs.params.ratio ?? null) !== (gen.params.ratio ?? null) ||
              (inputs.params.durationSeconds ?? null) !== (gen.params.durationSeconds ?? null) ||
              (inputs.params.libraryId ?? null) !== (gen.params.libraryId ?? null)
            ) {
              rerun = true
            }
          }
        }
      }
      if (!rerun) rerun = refs.some((ref) => needsRun.get(ref.sourceNodeId) === true)
      needsRun.set(id, rerun)
      const library = get().resolveOutputLibrary(kind, gen.params.libraryId)
      frozen.set(id, {
        id,
        kind,
        needsRun: rerun,
        provider: resolved.provider,
        model: resolved.model,
        modelLabel: `${resolved.provider} · ${shortModelLabel(resolved.provider, resolved.model)}`,
        prompt: gen.prompt,
        params: { ...gen.params },
        refs,
        ...(library ? { outputDir: library.path, libraryName: library.name } : {})
      })
    }
    if (problems.length > 0) return { ok: false, error: problems.slice(0, 3).join('；') }
    if (promptOverride?.trim() && frozen.get(targetId)) frozen.get(targetId)!.prompt = promptOverride.trim()
    const runCount = nodeIds.filter((id) => frozen.get(id)?.needsRun).length
    return { ok: true, prep: { nodeIds, nodes: frozen, runCount } }
  }

  /** 每步提交前后的运行护栏：工作区身份 + 全体参与卡仍在（任一被删除即停止继续提交） */
  const chainGuard = (machine: ChainMachine): ChainFailure | null => {
    const snapshot = get()
    if ((snapshot.workspace?.path ?? '') !== machine.workspacePath) {
      return { status: 'cancelled', error: '工作区已切换，生成链已停止（已完成的产物保留）' }
    }
    for (const id of machine.nodeIds) {
      if (!snapshot.nodesById.get(id)) {
        return { status: 'cancelled', error: '链上卡片被删除，生成链已停止（已完成的产物保留）' }
      }
    }
    return null
  }

  /** 用本轮冻结的配置 + 固定产物组装提交计划（参考记录与产物全部读本轮冻结，绝不回读画布/activeVersion） */
  const assembleFrozenPlan = (args: {
    node: CanvasNode
    info: FrozenNode
    prompt: string
    chainSet: ReadonlySet<string>
    frozenVersions: ReadonlyMap<string, GenerateVersion>
    frozenExternal: ReadonlyMap<string, GenerateRefSnapshot>
  }): { ok: true; plan: SubmitPlan } | { ok: false; error: string } => {
    const { node, info, prompt, chainSet, frozenVersions, frozenExternal } = args
    const refs = info.refs
    const snapshots: GenerateRefSnapshot[] = []
    for (const ref of refs) {
      if (chainSet.has(ref.sourceNodeId)) {
        // 链内上游：用本轮捕获/固定的真实产物版本
        const version = frozenVersions.get(ref.sourceNodeId)
        if (!version) {
          return { ok: false, error: `「${node.data.name}」的上游产物不可用，无法继续` }
        }
        snapshots.push({
          referenceId: ref.id,
          sourceNodeId: ref.sourceNodeId,
          role: ref.role,
          sourceName: version.name,
          sourceVersionId: version.id,
          storage: version.storage,
          path: version.path,
          ...(version.pathRoot ? { pathRoot: version.pathRoot } : {}),
          ...(version.mime ? { mime: version.mime } : {}),
          ...(version.bytes != null ? { bytes: version.bytes } : {})
        })
        continue
      }
      // 外部素材：链启动时固定的快照
      const snap = frozenExternal.get(`${node.id}|${ref.id}`)
      if (!snap || !snap.path) {
        return { ok: false, error: `「${node.data.name}」的外部参考在链启动后失效` }
      }
      snapshots.push(snap)
    }
    const snapshot: GenerateInputSnapshot = {
      prompt,
      params: { ...info.params },
      provider: info.provider,
      model: info.model,
      refs: snapshots,
      createdAt: Date.now()
    }
    const resolvePath = (ref: GenerateRefSnapshot): string =>
      ref.pathRoot ? `${ref.pathRoot.replace(/\/+$/, '')}/${ref.path}` : ref.path
    return {
      ok: true,
      plan: {
        nodeId: node.id,
        kind: info.kind,
        provider: info.provider,
        model: info.model,
        prompt,
        ...(info.params.ratio ? { ratio: info.params.ratio } : {}),
        ...(info.params.durationSeconds ? { durationSeconds: info.params.durationSeconds } : {}),
        ...(info.outputDir ? { outputDir: info.outputDir } : {}),
        refs: snapshots.map((ref) => ({ role: ref.role, path: resolvePath(ref) })),
        snapshot
      }
    }
  }

  const runGenerationChain = async (nodeId: string, prompt?: string): Promise<void> => {
    if (!BRIDGE_AVAILABLE) {
      showToast(BRIDGE_UNAVAILABLE)
      return
    }
    const state = get()
    const target = state.nodesById.get(nodeId)
    if (!target?.data.gen) {
      showToast('目标卡片不是可生成的媒体卡片')
      return
    }
    if (activeMachine || state.chainRun?.status === 'running') {
      showToast('已有一条生成链在运行，请先等待完成或取消')
      return
    }
    if (target.data.gen.status === 'queued' || target.data.gen.status === 'running') {
      showToast('目标卡片正在生成中，等完成后再运行生成链')
      return
    }
    if (!state.workspace) {
      showToast('请先打开一个工作区再运行生成链')
      return
    }
    const first = prepareChain(nodeId, prompt)
    if (!first.ok) {
      showToast(`无法运行生成链：${first.error}`)
      return
    }
    // 范围确认：明确卡数 + 各卡模型 + 复用情况；确认期间不加忙碌锁，用户可继续操作画布
    const { nodeIds, nodes: frozen, runCount } = first.prep
    const toRun = nodeIds.filter((id) => frozen.get(id)?.needsRun)
    const reuseCount = nodeIds.length - runCount
    const runLines = toRun
      .slice(0, 6)
      .map((id) => `· 「${get().nodesById.get(id)?.data.name ?? id}」→ ${frozen.get(id)?.modelLabel ?? ''}`)
    if (toRun.length > 6) runLines.push(`· …等共 ${toRun.length} 张`)
    get().requestConfirm({
      title: `运行生成链（执行 ${runCount} 张${reuseCount > 0 ? `，复用 ${reuseCount} 张` : ''}）`,
      body: [
        `目标「${target.data.name}」总会重新生成，其全部上游生成卡将按拓扑顺序执行${prompt?.trim() ? '（目标提示词使用本次输入）' : ''}。`,
        ...runLines,
        ...(reuseCount > 0 ? [`复用 ${reuseCount} 张已有产物：不重新生成、不消耗额度。`] : []),
        '点击「执行生成」后本轮配置（提示词/模型/参考产物）即被固定；执行中可随时取消，失败即停止后续依赖并保留已有结果。'
      ].join('\n'),
      confirmLabel: `执行生成（${runCount} 卡）`,
      onConfirm: () => {
        void startChain(nodeId, prompt)
      }
    })
  }

  /** 确认后的实际启动：重新冻结与复检（确认期间状态可能已变），然后串行拓扑执行 */
  const startChain = async (targetId: string, promptOverride?: string) => {
    if (activeMachine) return
    const state = get()
    if (state.chainRun?.status === 'running') return
    const prep = prepareChain(targetId, promptOverride)
    if (!prep.ok) {
      showToast(`生成链预检失败：${prep.error}`)
      return
    }
    const { nodeIds, nodes: frozen } = prep.prep
    const chainSet = new Set(nodeIds)
    const machine: ChainMachine = {
      id: newNodeId(),
      workspacePath: state.workspace?.path ?? '',
      nodeIds,
      cancelled: false,
      cancelPromise: null as unknown as Promise<JobTerminalOutcome>,
      resolveCancel: null
    }
    machine.cancelPromise = new Promise<JobTerminalOutcome>((resolve) => {
      machine.resolveCancel = () => resolve({ state: 'cancelled', version: null })
    })
    activeMachine = machine

    // 本轮冻结：复用产物就地固定（不随后续 activeVersion 切换漂移）；
    // 外部参考快照按「本轮开始」时刻定格
    const frozenVersions = new Map<string, GenerateVersion>()
    const frozenExternal = new Map<string, GenerateRefSnapshot>()
    const snapshotNodes = get().nodes
    for (const id of nodeIds) {
      const node = snapshotNodes.find((n) => n.id === id)
      const gen = node?.data.gen
      if (!node || !gen) continue
      const info = frozen.get(id)
      if (info && !info.needsRun) {
        const artifact = gen.versions.find((v) => v.id === gen.activeVersionId) ?? gen.versions[0]
        if (artifact) frozenVersions.set(id, artifact)
      }
      // 外部参考按本轮冻结的参考记录遍历（与执行期 assembleFrozenPlan 同一来源）
      for (const ref of info?.refs ?? []) {
        if (chainSet.has(ref.sourceNodeId)) continue
        const source = snapshotNodes.find((n) => n.id === ref.sourceNodeId)
        if (!source || !isReferenceSourceProduced(source)) continue
        const sd = source.data
        frozenExternal.set(`${id}|${ref.id}`, {
          referenceId: ref.id,
          sourceNodeId: ref.sourceNodeId,
          role: ref.role,
          sourceName: sd.name,
          ...(sd.gen?.activeVersionId ? { sourceVersionId: sd.gen.activeVersionId } : {}),
          storage: sd.storage ?? 'ws',
          path: sd.path ?? '',
          ...(sd.pathRoot ? { pathRoot: sd.pathRoot } : {}),
          ...(sd.mime ? { mime: sd.mime } : {}),
          ...(sd.bytes != null ? { bytes: sd.bytes } : {})
        })
      }
    }

    set({
      chainRun: {
        id: machine.id,
        targetNodeId: targetId,
        nodeIds,
        completedNodeIds: [],
        currentNodeId: undefined,
        status: 'running'
      }
    })
    for (const id of nodeIds) {
      mutateNodeData(id, (d) => (d.gen ? { ...d, gen: { ...d.gen, chainRunId: machine.id } } : d))
    }

    const completed: string[] = []
    let executed = 0
    let failure: ChainFailure | null = null
    /** 当前已提交、尚未确认终态的任务（停止链时按它取消在途付费任务） */
    let inFlightJobId: string | null = null
    const stopInFlight = () => {
      const jobId = inFlightJobId
      inFlightJobId = null
      if (jobId) void bridge.cancelJob(jobId)
    }
    try {
      for (const id of nodeIds) {
        if (machine.cancelled) {
          failure = { status: 'cancelled', error: '已取消' }
          break
        }
        const guard = chainGuard(machine)
        if (guard) {
          stopInFlight()
          failure = guard
          break
        }
        const info = frozen.get(id)
        if (!info) continue
        if (!info.needsRun) {
          completed.push(id)
          patchChainRun(machine.id, { completedNodeIds: [...completed] })
          continue
        }
        const node = get().nodesById.get(id)
        const gen = node?.data.gen
        if (!node || !gen) {
          failure = { status: 'cancelled', error: '链上卡片已被删除，生成链已停止' }
          break
        }
        const prompt = info.prompt.trim()
        if (!prompt) {
          failure = { status: 'failed', error: `「${node.data.name}」提示词为空，无法执行` }
          break
        }
        const plan = assembleFrozenPlan({
          node,
          info,
          prompt,
          chainSet,
          frozenVersions,
          frozenExternal
        })
        if (!plan.ok) {
          failure = { status: 'failed', error: plan.error }
          break
        }
        patchChainRun(machine.id, { currentNodeId: id })
        const submitted = await bridge.submitFrozen(plan.plan, machine.id)
        if (machine.cancelled) {
          // 取消的补执行已全覆盖：jobId 已绑定 → cancelGeneration 直取消；仍在 IPC 途中 →
          // 取消意图由 submitFrozen 绑定后补取消。这里不再重复调 cancel。
          failure = { status: 'cancelled', error: '已取消' }
          break
        }
        if (!submitted.ok) {
          failure = { status: 'failed', error: `「${node.data.name}」提交失败：${submitted.error}` }
          break
        }
        inFlightJobId = submitted.jobId
        const outcome =
          submitted.outcome ??
          (await Promise.race([bridge.waitJobTerminal(submitted.jobId), machine.cancelPromise]))
        if (machine.cancelled) {
          // 取消方（cancelGeneration）已对所有绑定 jobId 发起取消；这里只停止调度
          failure = { status: 'cancelled', error: '已取消' }
          break
        }
        // 工作区切换唤醒等待 → 由护栏给出真实原因并停止
        const postGuard = chainGuard(machine)
        if (postGuard) {
          stopInFlight()
          failure = postGuard
          break
        }
        if (outcome.state !== 'succeeded' || !outcome.version) {
          // 语境失效型唤醒（工作区切换/卡片被删除）时任务可能仍在跑：停止链并取消；
          // 真实失败/取消/超时的任务已终态（或按约定继续在卡片上收尾），不重复取消
          if (outcome.origin === 'workspace' || outcome.origin === 'card-gone') stopInFlight()
          inFlightJobId = null
          failure = {
            status: 'failed',
            error:
              outcome.state === 'cancelled'
                ? `「${node.data.name}」已取消，后续依赖已停止`
                : `「${node.data.name}」生成失败：${outcome.error ?? '未知原因'}，后续依赖已停止`
          }
          break
        }
        inFlightJobId = null
        // 真实捕获的产物版本直接传给下游（不回读 activeVersion）
        frozenVersions.set(id, outcome.version)
        executed += 1
        completed.push(id)
        patchChainRun(machine.id, { completedNodeIds: [...completed], currentNodeId: undefined })
      }
    } catch (error) {
      stopInFlight()
      failure = {
        status: 'failed',
        error: `生成链执行异常：${error instanceof Error ? error.message : String(error)}`
      }
    } finally {
      // 收尾：解除参与者标记（不删参与者状态/版本 —— 失败保留旧结果）
      for (const id of machine.nodeIds) {
        mutateNodeData(id, (d) =>
          d.gen && d.gen.chainRunId === machine.id ? { ...d, gen: { ...d.gen, chainRunId: undefined } } : d
        )
      }
      const current = get().chainRun
      if (current && current.id === machine.id) {
        const status: NonNullable<CanvasState['chainRun']>['status'] = failure
          ? failure.status
          : 'succeeded'
        set({
          chainRun: {
            ...current,
            completedNodeIds: [...completed],
            currentNodeId: undefined,
            status,
            ...(failure ? { error: failure.error } : {})
          }
        })
      }
      // 兜底 settle 取消竞争 Promise，避免悬挂
      machine.resolveCancel?.()
      activeMachine = null
      if (!failure) {
        showToast(`生成链完成：执行 ${executed} 张，复用 ${nodeIds.length - executed} 张`)
      } else if (failure.status === 'failed') {
        showToast(`生成链失败：${failure.error}`)
      } else if (failure.error !== '已取消') {
        showToast(failure.error)
      }
    }
  }

  /**
   * 取消：链内卡片 → 取消整条链（中断等待 + media.cancel 在跑任务，取消后不再启动下游；
   * 提交仍在 IPC 途中的卡片记取消意图，任务绑定后由 runtime 立即取消）；
   * 普通卡片 → 取消其单个任务（cancelled 事件由 patchGenByJob 收尾：保留旧版本、释放 pending）。
   */
  const cancelGeneration = async (nodeId: string): Promise<void> => {
    if (!BRIDGE_AVAILABLE) {
      showToast(BRIDGE_UNAVAILABLE)
      return
    }
    const state = get()
    const chainRun = state.chainRun
    if (chainRun && chainRun.status === 'running' && chainRun.nodeIds.includes(nodeId)) {
      const machine = activeMachine
      if (!machine || machine.id !== chainRun.id) return
      machine.cancelled = true
      machine.resolveCancel?.()
      for (const id of chainRun.nodeIds) {
        const gen = state.nodesById.get(id)?.data.gen
        const jobId = gen?.jobId
        if (!jobId) {
          // 无 jobId 可取消：要么还没轮到（机器已停，不会启动），要么提交在 IPC 途中
          //（记取消意图，submitFrozen 绑定 jobId 后立即取消，不留付费任务）
          bridge.requestSubmitCancel(id)
          continue
        }
        const result = await bridge.cancelJob(jobId)
        if (!result.ok) console.warn('[generationChain] 取消任务失败：', result.error)
      }
      return
    }
    const gen = state.nodesById.get(nodeId)?.data.gen
    if (!gen?.jobId) {
      // 无绑定任务：单卡提交可能仍在 IPC 途中 —— 记取消意图，绑定后立即取消
      if (bridge.requestSubmitCancel(nodeId)) {
        showToast('已记录取消请求，任务启动后将立即取消')
        return
      }
      showToast('该卡片没有进行中的生成任务')
      return
    }
    const result = await bridge.cancelJob(gen.jobId)
    if (!result.ok) showToast(`取消失败：${result.error}`)
  }

  return { runGenerationChain, cancelGeneration }
}
