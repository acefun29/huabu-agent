import type { WorkspaceModels } from '../agent/workspaceModels'
import type { WorkspaceStore } from '../workspace/store'
import type { MediaJobStatus } from '../../shared/ipc'
import { createAdapters, type AdapterHostDeps } from './adapters'
import { BUILTIN_PROVIDERS, mergeCatalog } from './catalog'
import { MediaJobManager, type MediaJobContext } from './manager'
import type { MediaProviderAdapter } from './provider'

/** mediaContext 的返回形态（MediaJobManager 与 Agent 媒体工具装配共同消费） */
export type MediaContextReturnType = MediaJobContext & {
  keySourceOf: NonNullable<MediaJobContext['keySourceOf']>
  resolveKey: NonNullable<MediaJobContext['resolveKey']>
}

/** 媒体运行时由应用入口注入工作区、凭据和事件通知依赖。 */
export interface MediaRuntimeDeps {
  store: Pick<WorkspaceStore, 'mediaDir' | 'mediaConfig'>
  /** 工作区凭据服务。 */
  models: Pick<WorkspaceModels, 'getMediaKey' | 'hasMediaKey'>
  currentDir: () => string | null
  broadcastAssetChanged: () => void
  broadcastMediaJob: (job: MediaJobStatus) => void
}

/**
 * 创建凭据解析器、适配器缓存和任务管理器，并恢复持久化任务。
 * 聊天和媒体 IPC 共用这个实例，必须在注册处理器之前创建。
 */
export function createMediaRuntime(
  deps: MediaRuntimeDeps
): { mediaManager: MediaJobManager; mediaContext: () => MediaContextReturnType } {
  const { store, models, currentDir, broadcastAssetChanged, broadcastMediaJob } = deps

  /**
   * 加密凭据优先，其次使用供应商声明的环境变量。
   * 使用适配器所属的工作区，避免切换工作区后在途任务读取到其他工作区的凭据。
   */
  const resolveMediaKey = async (
    auth: { authKey?: string; authEnv?: string },
    workspace: string | null
  ): Promise<string | undefined> => {
    const dir = workspace ?? currentDir()
    if (!dir) return undefined
    if (auth.authKey) {
      const stored = await models.getMediaKey(dir, auth.authKey)
      if (stored) return stored
    }
    return auth.authEnv ? process.env[auth.authEnv] : undefined
  }

  const adapterDeps: AdapterHostDeps = {
    mediaDir: () => store.mediaDir(),
    resolveKey: resolveMediaKey
  }

  /**
   * 适配器按「工作区 + 合并清单指纹」缓存：config 指纹不变则复用实例，
   * 避免每次 context() 都重建全部适配器。
   */
  let adapterCache: { workspace: string | null; fingerprint: string; adapters: MediaProviderAdapter[] } | null = null

  const mediaContext = (): MediaContextReturnType => {
    const mediaDir = store.mediaDir()
    const config = store.mediaConfig()
    const workspace = currentDir()
    // mergeCatalog 是清单的唯一入口：内置目录 + workspace.json 覆盖层 → 生效供应商
    const providers = mergeCatalog(BUILTIN_PROVIDERS, config)
    const fingerprint = JSON.stringify(providers)
    if (!adapterCache || adapterCache.workspace !== workspace || adapterCache.fingerprint !== fingerprint) {
      adapterCache = {
        workspace,
        fingerprint,
        adapters: createAdapters(providers, adapterDeps, workspace)
      }
    }
    return {
      mediaDir,
      workspaceDir: workspace,
      config,
      providers,
      adapters: adapterCache.adapters,
      ready: Boolean(workspace),
      // 上传通道与适配器使用同一凭据解析器，并绑定当前快照所属工作区。
      resolveKey: (auth) => resolveMediaKey(auth, workspace),
      keySourceOf: async (auth) => {
        if (!workspace) return 'none'
        if (auth.authKey && (await models.hasMediaKey(workspace, auth.authKey))) return 'workspace-store'
        return auth.authEnv && process.env[auth.authEnv] ? 'environment' : 'none'
      },
      // 产物归档后通知素材库刷新。
      notifyAssetsChanged: broadcastAssetChanged
    }
  }

  const mediaManager = new MediaJobManager(broadcastMediaJob, mediaContext)
  try {
    mediaManager.reconcilePersistedJobs()
  } catch (error) {
    // 不阻断应用启动；查询或提交任务时会再次报告错误，且不会覆盖原账本。
    console.warn('[media-jobs] 任务账本恢复失败：', error)
  }

  return { mediaManager, mediaContext }
}

