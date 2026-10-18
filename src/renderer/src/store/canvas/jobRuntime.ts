import type { MediaJobStatus } from '@shared/ipc'
import { DEFAULT_MEDIA_DURATION_S, DEFAULT_MEDIA_RATIO, deriveRefRole, nearestMediaRatio, normalizeMediaCaps } from '@shared/media'
import type { MediaRefInput, MediaRefRole, ResolvedRefCaps } from '@shared/media'
import { shortModelLabel } from '@shared/mediaResolve'
import { normalizePath } from '../../harness/assetCategories'
import type { AssetData, AssetGen, CanvasNode, GenerateVersion, MediaKind } from '../../types'
import type { CanvasState } from '../canvasStore'
import { MEDIA_LABEL, BRIDGE_AVAILABLE, jobCardIndex, newNodeId, settingsBridgeRef, spawnOffset, zCounter } from './shared'
import type { StoreSet } from './chatRuntime'

/**
 * 生成任务域（T8 拆分）：生成不是卡片而是一种状态 —— 任务事件驱动卡片状态机，
 * 产物写成新版本挂在原卡片上，产物即素材。三条主链路：
 *
 * - job 事件 → 卡片状态机（patchGenByJob）：queued/running 更新进度；succeeded
 *   写新版本 + 解绑任务；failed/cancelled 保留卡片与可操作错误。
 * - Agent 工具发起的任务没有现成卡片 → spawnGenCardForJob 建卡承接；
 *   同一 jobId 只建一张（jobCardIndex 是同步事实源，在 shared.ts）。
 * - 画布（重）载入后对账（reconcileJobs）：卡片引用的任务若已终态/失效则收尾。
 *
 * 提交链（submitGeneration）：并发上限/排队在主进程编排，卡片只认任务事件；
 * 落库优先级链经 resolveOutputLibrary（libraryOps）解析，参考图按 pathRoot
 * 精确送相对路径（产物目录被改过也不指偏，见 §2.8）。
 */

export interface JobRuntimeDeps {
  set: StoreSet
  get: () => CanvasState
  showToast: CanvasState['showToast']
  applyNodes: (fn: (prev: CanvasNode[]) => CanvasNode[]) => void
  mutateNodeData: (id: string, fn: (data: AssetData) => AssetData) => void
}

export function createJobRuntime(deps: JobRuntimeDeps) {
  const { set, get, showToast, applyNodes, mutateNodeData } = deps

  const versionFromJob = (job: MediaJobStatus): GenerateVersion | null => {
    if (!job.artifact) return null
    // 落库目录（素材库映射）产物 = 工作区内普通文件；默认产物目录仍是 media 形态
    const storage = job.outputDir ? ('ws' as const) : ('media' as const)
    const path = job.outputDir
      ? normalizePath(`${job.outputDir.replace(/\/+$/, '')}/${job.artifact.relPath}`)
      : job.artifact.relPath
    return {
      id: crypto.randomUUID(),
      storage,
      path,
      // 只有 media 形态需要 pathRoot（它的 path 相对产物目录）；ws 形态的 path 已经是
      // 相对工作区根的完整路径，再带一个根就是双前缀陷阱
      ...(!job.outputDir && job.artifactDirRel ? { pathRoot: job.artifactDirRel } : {}),
      name: job.artifact.name,
      mime: job.artifact.mime,
      bytes: job.artifact.bytes,
      thumbnail: undefined,
      prompt: job.prompt,
      model: `${job.provider}:${job.model}`,
      createdAt: job.updatedAt
    }
  }

  const patchGenByJob = (job: MediaJobStatus): boolean => {
    let handled = false
    applyNodes((prev) =>
      prev.map((node) => {
        const data = node.data
        if (!data.gen || data.gen.jobId !== job.jobId) return node
        handled = true
        const gen = data.gen
        if (job.state === 'queued' || job.state === 'running') {
          return {
            ...node,
            data: {
              ...data,
              gen: {
                ...gen,
                status: job.state as AssetGen['status'],
                progress: job.progress,
                error: undefined,
                // 参考素材的处置留痕（哪条没进请求、为什么）；每次事件都按最新任务覆盖，
                // 新一轮提交没有 notes 时自然清空
                notes: job.notes
              }
            }
          }
        }
        if (job.state === 'succeeded') {
          const version = versionFromJob(job)
          if (!version) return node
          return {
            ...node,
            data: {
              ...data,
              name: version.name,
              kind: job.kind,
              storage: version.storage,
              path: version.path,
              ...(version.pathRoot ? { pathRoot: version.pathRoot } : {}),
              mime: version.mime,
              bytes: version.bytes,
              // 产物落库后卡片归入对应素材库（提交时记下的落库目标）
              ...(job.outputDir && data.gen.params.libraryId ? { libraryId: data.gen.params.libraryId } : {}),
              gen: {
                ...gen,
                status: 'succeeded',
                progress: 1,
                error: undefined,
                notes: job.notes,
                // 终态即解绑任务：再次载入画布时对账不会重复入库同一产物
                jobId: undefined,
                // 比例标签对齐产物事实：图生图等场景可能不按请求比例出图，成功后按
                // 实际宽高反推（与工具结果回显同一 nearestMediaRatio），请求值不再冒充结果
                params: {
                  ...gen.params,
                  ...(job.artifact?.width && job.artifact?.height
                    ? {
                        ratio:
                          nearestMediaRatio(job.artifact.width, job.artifact.height) ??
                          gen.params.ratio
                      }
                    : {})
                },
                versions: [version, ...gen.versions],
                activeVersionId: version.id
              }
            }
          }
        }
        // failed / cancelled：卡片保留，错误可操作（可改提示词重试）
        return {
          ...node,
          data: {
            ...data,
            gen: {
              ...gen,
              status: 'failed',
              error: job.error ?? (job.state === 'cancelled' ? '已取消' : '生成失败'),
              notes: job.notes,
              jobId: undefined
            }
          }
        }
      })
    )
    return handled
  }

  /** Agent 工具发起的任务：没有现成卡片 → 建一张生成卡片承接（落点按现有卡片错开） */
  const spawnGenCardForJob = (job: MediaJobStatus) => {
    // 同一 jobId 只建一张卡
    if (jobCardIndex.has(job.jobId)) return
    const id = newNodeId()
    jobCardIndex.set(job.jobId, id)
    zCounter.current += 1
    applyNodes((prev) => [
      ...prev,
      {
        id,
        type: 'asset',
        x: 140 + spawnOffset(prev),
        y: 120 + spawnOffset(prev) + 40,
        width: 320,
        height: 430,
        zIndex: zCounter.current,
        data: {
          name: `生成中 · ${job.model}`,
          kind: job.kind,
          fromChatId: job.sourceChatId,
          gen: {
            prompt: job.prompt,
            refs: [],
            // 任务协商后的真实参数优先（Agent 工具声明的 ratio/时长），
            // 手动路径没有 params 才回退设置默认值 —— 避免"Agent 说 1:1、卡片 16:9"的错位
            params: {
              ratio: job.params?.ratio ?? settingsBridgeRef.current?.mediaStatus?.defaultRatio ?? DEFAULT_MEDIA_RATIO,
              durationSeconds:
                job.params?.durationSeconds ??
                (job.kind === 'image'
                  ? undefined
                  : settingsBridgeRef.current?.mediaStatus?.defaultDuration ?? DEFAULT_MEDIA_DURATION_S),
              model: `${job.provider}:${job.model}`
            },
            status: job.state as AssetGen['status'],
            progress: job.progress,
            jobId: job.jobId,
            versions: []
          }
        } satisfies AssetData
      } satisfies CanvasNode
    ])
  }

  const handleJobEvent = (job: MediaJobStatus) => {
    const indexed = jobCardIndex.has(job.jobId)
    // 终态即解绑：卡片上的 jobId 由 patchGenByJob 清掉，同步索引在这里收尾
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') {
      jobCardIndex.delete(job.jobId)
    }
    const handled = patchGenByJob(job) || indexed
    if (handled) {
      if (job.state === 'succeeded') showToast('生成完成，产物已写入工作目录')
      if (job.state === 'failed') showToast(`生成失败：${job.error ?? '未知原因'}`)
      return
    }
    if (job.sourceChatId && (job.state === 'queued' || job.state === 'running')) {
      spawnGenCardForJob(job)
    }
  }

  /** 画布（重）载入后对账：卡片引用的任务若已终态/失效则收尾 */
  const reconcileJobs = async () => {
    if (!BRIDGE_AVAILABLE) return
    const result = await window.huabu.media.jobs()
    if (!result.ok) return
    const byId = new Map(result.value.map((job) => [job.jobId, job]))
    for (const node of get().nodes) {
      const data = node.data
      const gen = data.gen
      const jobId = gen?.jobId
      if (!jobId || gen.status === 'idle') continue
      const job = byId.get(jobId)
      if (!job) {
        mutateNodeData(node.id, (d) => {
          if (!d.gen) return d
          return {
            ...d,
            gen: { ...d.gen, status: 'failed', error: '任务状态未知（可能来自其他工作区）' }
          }
        })
        continue
      }
      if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') {
        jobCardIndex.delete(jobId)
        patchGenByJob(job)
      }
    }
  }

  /* ---------------- 生成：提交（并发上限/排队在主进程编排，卡片只认任务事件） ---------------- */

  /**
   * 卡片当前生效模型的参考配额（角色 + 总量）。判据与主进程闸门同源
   * （normalizeMediaCaps 从同一份能力声明派生），渲染端只做即时反馈，权威判定在提交时。
   */
  const refCapsFor = (data: AssetData): ResolvedRefCaps => {
    const kind = (data.kind as MediaKind) ?? 'image'
    const resolved = settingsBridgeRef.current?.resolveMediaModel(kind, data.gen?.params.model)
    const caps = resolved
      ? settingsBridgeRef.current?.mediaProviders
          ?.find((p) => p.id === resolved.provider)
          ?.models.find((m) => m.id === resolved.model)?.capabilities
      : undefined
    return normalizeMediaCaps(caps, kind)
  }

  /** 一条参考素材在本次提交里的角色：卡片上显式指定优先，否则按大类 + 序数派生 */
  const roleOfRef = (
    gen: AssetGen,
    refData: AssetData,
    refId: string,
    index: number,
    caps: ResolvedRefCaps,
    modelKind: MediaKind
  ): MediaRefRole | null =>
    gen.refRoles?.[refId] ?? deriveRefRole((refData.kind as MediaKind) ?? 'image', modelKind, index, caps.quota)

  const submitGeneration = async (nodeId: string, prompt: string) => {
    const text = prompt.trim()
    if (!text) return
    const node = get().nodes.find((n) => n.id === nodeId)
    const data = node?.data
    if (!node || !data?.gen) return
    const kind = data.kind as MediaKind
    if (data.gen.status === 'queued' || data.gen.status === 'running') {
      showToast('该卡片正在生成中，等完成后再提交')
      return
    }
    const resolved = settingsBridgeRef.current?.resolveMediaModel(kind, data.gen.params.model)
    if (!resolved) {
      showToast(
        data.gen.params.model
          ? '卡片指定的模型已不可用（供应商或模型已变更），请在卡片参数里重新选择'
          : `未配置可用的${MEDIA_LABEL[kind]}生成模型，请到「设置 → 媒体生成」选择`
      )
      return
    }
    // 当前生效模型的参考配额（判据与主进程闸门同源）
    const caps = refCapsFor(data)
    // 落库优先级链：卡片指定 > 类型默认 > 全局默认 > 公共库；命中素材库 → outputDir 落库
    const library = get().resolveOutputLibrary(kind, data.gen.params.libraryId)
    // 参考文件：产物目录（storage=media）与工作区素材库（storage=ws）两种落点都能直接喂给
    // 网关 —— 主进程闸门是"产物根优先、工作区根兜底"的两段试，ws 卡的相对路径正好落第二段。
    // 有 pathRoot 时送"相对工作区根"的完整路径（产物目录被改过也不会指偏）；
    // 没有 pathRoot 的历史卡片仍送裸文件名（等价于按当前产物根解析，语义不变）。
    const refEntries = data.gen.refs
      .map((refId) => ({ id: refId, node: get().nodes.find((n) => n.id === refId) }))
      .filter((entry): entry is { id: string; node: CanvasNode } => Boolean(entry.node))
      .filter((entry) => (entry.node.data.storage === 'media' || entry.node.data.storage === 'ws') && Boolean(entry.node.data.path))
    const refs: MediaRefInput[] = []
    const unusable: string[] = []
    for (const [index, entry] of refEntries.entries()) {
      const role = roleOfRef(data.gen, entry.node.data, entry.id, index, caps, kind)
      const path = entry.node.data.pathRoot
        ? `${entry.node.data.pathRoot.replace(/\/+$/, '')}/${entry.node.data.path}`
        : (entry.node.data.path as string)
      // 角色派生不出来 = 该模型对这种素材根本没有参考输入（例如只有首帧的老声明模型挂了视频）
      if (!role) unusable.push(path)
      else refs.push({ role, path })
    }
    if (unusable.length > 0) {
      showToast(`${unusable.length} 条参考素材当前模型用不到（该模型没有这种媒体的参考输入），不会进请求`)
    }
    if (caps.total > 0 && refs.length > caps.total) {
      showToast(`该模型最多用 ${caps.total} 条参考素材，多出的 ${refs.length - caps.total} 条不会进请求`)
    }
    mutateNodeData(nodeId, (d) => {
      if (!d.gen) return d
      return { ...d, gen: { ...d.gen, prompt: text, status: 'queued', progress: 0, error: undefined, jobId: undefined } }
    })
    // 比例是语义参数：像素换算在主进程编排层统一完成（ratioToPixels），渲染端不再定死尺寸
    const result = await window.huabu.media.generate({
      provider: resolved.provider,
      model: resolved.model,
      kind,
      prompt: text,
      ...(data.gen.params.ratio ? { ratio: data.gen.params.ratio } : {}),
      ...(data.gen.params.durationSeconds ? { durationSeconds: data.gen.params.durationSeconds } : {}),
      nodeId,
      ...(library ? { outputDir: library.path } : {}),
      ...(refs.length > 0 ? { refs } : {})
    })
    if (!result.ok) {
      mutateNodeData(nodeId, (d) => {
        if (!d.gen) return d
        return { ...d, gen: { ...d.gen, status: 'failed', error: result.error } }
      })
      showToast(`提交生成失败：${result.error}`)
      return
    }
    mutateNodeData(nodeId, (d) => {
      if (!d.gen) return d
      return { ...d, gen: { ...d.gen, jobId: result.value.jobId } }
    })
    showToast(`已提交${MEDIA_LABEL[kind]}生成 → ${library?.name ?? '产物目录'} · ${resolved.provider} · ${shortModelLabel(resolved.provider, resolved.model)}`)
  }

  const updateGenerate = (nodeId: string, patch: Partial<AssetGen>) => {
    mutateNodeData(nodeId, (d) => {
      if (!d.gen) return d
      return { ...d, gen: { ...d.gen, ...patch } }
    })
  }

  const addGenerateRef = (nodeId: string, refId: string) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    const gen = node?.data.gen
    if (!gen || gen.refs.includes(refId) || refId === nodeId) return
    const caps = refCapsFor(node.data)
    // 挂不上来的两种情况：这种素材在该模型里根本没有角色；或已经挂到总量上限
    const refData = get().nodes.find((n) => n.id === refId)?.data
    if (refData && !deriveRefRole((refData.kind as MediaKind) ?? 'image', node.data.kind as MediaKind, gen.refs.length, caps.quota)) {
      showToast('当前模型用不到这条参考素材（该模型没有这种媒体的参考输入）')
      return
    }
    if (caps.total > 0 && gen.refs.length >= caps.total) {
      showToast(`当前模型最多使用 ${caps.total} 条参考素材，先移除一条再添加`)
      return
    }
    mutateNodeData(nodeId, (d) => {
      if (!d.gen || d.gen.refs.includes(refId)) return d
      return { ...d, gen: { ...d.gen, refs: [...d.gen.refs, refId] } }
    })
    showToast('已加入参考（角色按当前模型派生，点卡片上的角色胶囊可改）')
  }

  const removeGenerateRef = (nodeId: string, refId: string) => {
    mutateNodeData(nodeId, (d) => {
      if (!d.gen) return d
      return { ...d, gen: { ...d.gen, refs: d.gen.refs.filter((r) => r !== refId) } }
    })
  }

  const requestClearGenerateVersions = (nodeId: string) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node) return
    const data = node.data
    if (!data.gen) return
    set({
      confirm: {
        title: `清空「${data.name}」的全部版本？`,
        body: '版本记录清掉后找不回来（此操作不可逆）；各版本对应的文件仍留在工作目录。',
        confirmLabel: '清空结果',
        danger: true,
        onConfirm: () => clearGenerateVersions(nodeId)
      }
    })
  }

  const clearGenerateVersions = (nodeId: string) => {
    mutateNodeData(nodeId, (d) => {
      if (!d.gen) return d
      return {
        ...d,
        gen: { ...d.gen, versions: [], activeVersionId: undefined, status: 'idle', progress: 0, jobId: undefined, error: undefined }
      }
    })
    showToast('已清空结果（保留卡片）')
  }

  return {
    handleJobEvent,
    reconcileJobs,
    submitGeneration,
    updateGenerate,
    addGenerateRef,
    removeGenerateRef,
    clearGenerateVersions,
    requestClearGenerateVersions
  }
}
