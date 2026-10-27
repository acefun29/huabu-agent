/**
 * 画布存量迁移：旧结构 AssetData.gen（生成卡壳）→ 新结构（versions/activeVersionId/
 * pendingJob/references 直接挂在 AssetData 上，产物即普通媒体卡）。
 *
 * 载入咽喉（canvasStore.loadWorkspaceCanvas）逐卡调用；scripts 回归直接断言本模块。
 * 迁移规则（见重构方案）：
 * - gen.versions / activeVersionId / references / refs / refRoles 无损搬到 data 顶层；
 * - 在途任务（jobId 非空且未失败）→ data.pendingJob（重启后 reconcileJobs 对账收尾）；
 * - 运行态（status/progress/error/notes）丢弃，由对账重建；
 * - 空壳卡（无版本、无文件、无在途任务）→ 返回 null 丢弃（生成卡 UI 已不存在，
 *   从未产出过的纯配置卡在新模型里没有语义）。
 */

import type { MediaRefRole } from '@shared/media'
import type {
  AssetData,
  AssetPendingJob,
  CanvasNode,
  GenerateInputSnapshot,
  GenerateReference,
  GenerateVersion
} from '../types'

/** 旧结构的 AssetGen 壳（迁移读入用；新代码不再有这个类型） */
export interface LegacyAssetGen {
  prompt?: string
  refs?: string[]
  refRoles?: Record<string, MediaRefRole>
  references?: GenerateReference[]
  pendingInputs?: GenerateInputSnapshot
  chainRunId?: string
  status?: string
  progress?: number
  jobId?: string
  error?: string
  notes?: string[]
  versions?: GenerateVersion[]
  activeVersionId?: string
}

type LegacyAssetData = AssetData & { gen?: LegacyAssetGen }

/**
 * 单卡迁移。返回 null = 丢弃（空壳卡）；返回 data = 新结构（gen 字段已移除）。
 * 非 asset 数据（无 gen 的普通卡）原样返回（仅剥掉残留的空 pendingJob）。
 */
export function migrateAssetData(raw: unknown): AssetData | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as LegacyAssetData
  const gen = data.gen
  if (!gen || typeof gen !== 'object') {
    // 新结构或纯媒体卡：丢掉空绑定的 pendingJob（IPC 在途崩溃的残渣）
    if (data.pendingJob && !data.pendingJob.jobId) {
      const { pendingJob: _drop, ...rest } = data
      void _drop
      return rest
    }
    return data
  }
  const versions = Array.isArray(gen.versions) ? gen.versions : []
  const hasFile = (data.storage === 'media' || data.storage === 'ws') && Boolean(data.path)
  const busy = typeof gen.jobId === 'string' && gen.jobId !== '' && gen.status !== 'idle' && gen.status !== 'failed'
  if (versions.length === 0 && !hasFile && !busy) return null

  const { gen: _dropGen, ...rest } = data
  void _dropGen
  const next: AssetData = { ...rest }
  if (versions.length > 0) {
    next.versions = versions
    next.activeVersionId =
      gen.activeVersionId && versions.some((v) => v.id === gen.activeVersionId) ? gen.activeVersionId : versions[0].id
  }
  // 引用链：显式 references 优先原样保留（legacy 手动链，只读展示）；
  // 只有 refs/refRoles 的更旧数据继续走懒派生（getCardReferences 第三级）
  if (Array.isArray(gen.references) && gen.references.length > 0) {
    next.references = gen.references
    next.refs = undefined
    next.refRoles = undefined
  } else if (Array.isArray(gen.refs) && gen.refs.length > 0) {
    next.refs = gen.refs
    if (gen.refRoles) next.refRoles = gen.refRoles
  }
  if (busy) {
    const pending: AssetPendingJob = { jobId: gen.jobId as string }
    if (gen.pendingInputs) pending.inputs = gen.pendingInputs
    next.pendingJob = pending
  }
  return next
}

/** 画布载入的整批迁移：返回保留下来的节点（空壳卡被剔除） */
export function migrateCanvasNodes(nodes: readonly CanvasNode[]): CanvasNode[] {
  const out: CanvasNode[] = []
  for (const node of nodes) {
    const data = migrateAssetData(node.data)
    if (!data) continue
    out.push({ ...node, data })
  }
  return out
}
