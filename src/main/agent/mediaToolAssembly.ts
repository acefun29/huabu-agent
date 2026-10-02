import { join } from 'path'
import type { MediaJobStatus } from '@shared/ipc'
import type { AdapterProviderConfig } from '../media/adapters'
import { resolveMediaTarget } from '../../shared/mediaResolve'
import { MEDIA_ROOT_REL, assetDirForKind } from '../../shared/assets'
import { readArtifactAsBase64 } from '../media/artifactImage'
import { extractVideoFrames } from '../media/videoFrames'
import { createMediaTools, type MediaApprovalInfo } from './mediaTools'
import { createReadMediaTool } from './readMediaTool'
import { createVideoTools } from './videoTools'

/**
 * Agent 会话的媒体工具装配（T12 从 ipc.ts chat:create 抽出，原本是 60 行闭包）。
 *
 * 职责只有一件事：把「宿主持有的活对象」（store / mediaManager / mediaContext / host）
 * 接到媒体生成工具与 read_media 工具的依赖口上。所有依赖经显式 deps 注入（窄化结构
 * 类型，真实 WorkspaceStore/MediaJobManager/host 结构兼容），因此能在 electron 探针
 * 里用 mock 依赖逐条断言（probe:media-assembly）：
 *
 * - submit 拼装：落库链（resolveOutputLibrary）→ outputDir 条件透传；
 *   refPaths 空数组不传字段；sourceChatId = nodeId；
 * - 失败分类：resolveAgentMedia 抛「没有可用的 X 生成模型」→ mediaTools 的
 *   failureGuidance 保留关键词原样进工具结果（Agent 一轮拿到指引）；
 * - capabilities/confirmVideo 均为现读闭包（T2 语义：改设置即时生效）。
 *
 * resolveOutputLibrary / resolveAgentMedia 的实现在此收拢（原先长在 ipc.ts 尾部）：
 * 它们只服务 Agent 工具路径，语义与渲染端 canvasStore.resolveOutputLibrary 对齐。
 */

/** store 侧依赖的窄化视图（WorkspaceStore 结构兼容） */
export interface MediaAssemblyStore {
  mediaConfig(): {
    confirmVideo?: boolean
    accessMode?: 'full' | 'confirm'
    agentProvider?: string
    agentModels?: Partial<Record<'image' | 'video' | 'audio', string>>
    defaultLibraryId?: string
    kindLibraryDefaults?: Partial<Record<'image' | 'video' | 'audio', string>>
  }
  getLibraries(): Array<{ id: string; path: string; isPublic?: boolean }>
}

export interface MediaAssemblyDeps {
  store: MediaAssemblyStore
  mediaManager: {
    submit(input: {
      kind: 'image' | 'video' | 'audio'
      provider: string
      model: string
      prompt: string
      name?: string
      ratio?: string
      durationSeconds?: number
      refPaths?: string[]
      outputDir?: string
      sourceChatId?: string
    }): Promise<{ jobId: string }>
    waitForCompletion(
      jobId: string,
      opts?: {
        signal?: AbortSignal
        onProgress?: (job: MediaJobStatus) => void
      }
    ): Promise<MediaJobStatus>
  }
  /** 当前会话的对话模型是否声明图片输入（host.sessionModelSupportsImages） */
  sessionModelSupportsImages: (nodeId: string) => boolean | undefined
  currentDir: () => string | null
  mediaContext: () => {
    providers: readonly AdapterProviderConfig[]
    config: ReturnType<MediaAssemblyStore['mediaConfig']>
    mediaDir: string | null
  }
  inboxRoot: () => string
  /**
   * 变更前确认（ipc 注入）：发 media:confirm-request 事件并等待渲染端回执。
   * provider/model 由装配层在调用前解析补入（ipc 只管事件与回执）。
   */
  requestApproval?: (
    kind: 'image' | 'video' | 'audio',
    info: MediaApprovalInfo,
    nodeId: string,
    signal: AbortSignal | undefined
  ) => Promise<boolean>
}

/**
 * 生成产物的默认落库目录（Agent 工具路径用；与渲染端 canvasStore.resolveOutputLibrary 同一语义）：
 * 类型默认库 > 全局默认库 > 公共库 > 画布素材分类目录（image→assets/images 等）。
 * 特殊值：'builtin-assets' = 画布素材；'none' = 不落库（留在产物目录）；返回 undefined 同样不落库。
 */
export function resolveOutputLibrary(
  store: MediaAssemblyStore,
  config: { defaultLibraryId?: string; kindLibraryDefaults?: Partial<Record<'image' | 'video' | 'audio', string>> },
  kind: 'image' | 'video' | 'audio'
): string | undefined {
  const wanted = config.kindLibraryDefaults?.[kind] ?? config.defaultLibraryId
  if (wanted === 'none') return undefined
  if (wanted === 'builtin-assets' || !wanted) return assetDirForKind(kind)
  const hit = store.getLibraries().find((l) => l.id === wanted)
  if (hit) return hit.path
  // 配置指向的库已被删除：回退公共库，再兜底画布素材分类
  return store.getLibraries().find((l) => l.isPublic)?.path ?? assetDirForKind(kind)
}

/**
 * Agent 媒体工具的 provider/model 解析。
 *
 * 回退链的唯一实现在 shared/mediaResolve.ts（与渲染端卡片共用同一纯函数，语义一致）。
 * 默认供应商不存在、没有同类模型、没配 Key 时，都给可操作错误，绝不静默生成假图。
 */
export function resolveAgentMedia(
  providers: readonly AdapterProviderConfig[],
  config: { agentProvider?: string; agentModels?: Partial<Record<'image' | 'video' | 'audio', string>> },
  kind: 'image' | 'video' | 'audio'
): { provider: string; model: string } {
  const resolved = resolveMediaTarget(providers, {
    kind,
    agentProvider: config.agentProvider,
    agentModels: config.agentModels
  })
  if (!resolved) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'
    throw new Error(`没有可用的${label}生成模型：请在「设置 → 媒体生成」里选择供应商并录入 API Key`)
  }
  return { provider: resolved.provider, model: resolved.model }
}

/** 组装会话的媒体工具面：3 个生成工具 + read_media（顺序即 chat:create 的 customTools） */
export function assembleMediaTools(nodeId: string, deps: MediaAssemblyDeps) {
  const { store, mediaManager, mediaContext } = deps

  const mediaTools = createMediaTools({
    submit: async (input, signal, onProgress) => {
      const { providers: effective, config } = mediaContext()
      const resolution = resolveAgentMedia(effective, config, input.kind)
      // Agent 生成同样走落库链（类型默认 > 全局默认 > 公共库 > 画布素材分类），
      // 与画布卡片/设置页同一套语义——否则 Agent 生成的产物永远留在隐藏产物目录
      const outputLibrary = resolveOutputLibrary(store, config, input.kind)
      const { jobId } = await mediaManager.submit({
        kind: input.kind,
        provider: resolution.provider,
        model: resolution.model,
        prompt: input.prompt,
        ...(input.name ? { name: input.name } : {}),
        ...(input.ratio ? { ratio: input.ratio } : {}),
        ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
        ...(input.refPaths && input.refPaths.length > 0 ? { refPaths: input.refPaths } : {}),
        ...(outputLibrary ? { outputDir: outputLibrary } : {}),
        sourceChatId: nodeId
      })
      return mediaManager.waitForCompletion(jobId, {
        ...(signal ? { signal } : {}),
        ...(onProgress
          ? {
              onProgress: (job) =>
                onProgress({
                  state: job.state,
                  progress: job.progress,
                  ...(job.message ? { message: job.message } : {})
                })
            }
          : {})
      })
    },
    confirmVideo: () => store.mediaConfig().confirmVideo ?? true,
    // 访问模式现读（改 workspace.json 即时生效）；'confirm' 时 execute 先走 requestApproval
    accessMode: () => store.mediaConfig().accessMode ?? 'full',
    // 变更前确认：装配层先解析 provider/model 填进确认卡（解析失败照样弹卡，只是不带模型名），
    // 事件发射与回执等待在 ipc 注入的实现里
    ...(deps.requestApproval
      ? {
          requestApproval: (kind: 'image' | 'video' | 'audio', info: MediaApprovalInfo, signal: AbortSignal | undefined) => {
            const { providers: effective, config } = mediaContext()
            let provider: string | undefined
            let model: string | undefined
            try {
              const hit = resolveAgentMedia(effective, config, kind)
              provider = hit.provider
              model = hit.model
            } catch {
              /* 解析失败不拦确认：卡上没有模型名，用户拒绝的话错误路径照常走 submit */
            }
            return deps.requestApproval!(kind, { ...info, ...(provider ? { provider } : {}), ...(model ? { model } : {}) }, nodeId, signal)
          }
        }
      : {}),
    // 当前解析到的模型能力：工具 execute 内每次现读，做比例/时长的合法性校验
    capabilities: (kind) => {
      const { providers: effective, config } = mediaContext()
      const resolved = resolveMediaTarget(effective, {
        kind,
        agentProvider: config.agentProvider,
        agentModels: config.agentModels
      })
      return resolved?.info.capabilities
    },
    // 多模态回传开关：当前会话的对话模型支持图片输入才回传产物图
    supportsImageInput: () => deps.sessionModelSupportsImages(nodeId) ?? false,
    // 产物读图在主进程完成（解码/缩放/JPEG），base64 不落渲染进程
    readArtifactAsBase64: (relPath, maxEdge) => {
      const dir = mediaContext().mediaDir
      return dir ? readArtifactAsBase64(relPath, dir, maxEdge) : undefined
    },
    // 视频成功结果回传首帧关键帧（P2 多模态自检）：与 read_media/videoTools 同一套抽帧管线
    // （media/videoFrames.ts）与缓存目录（.huabu/vframes）。首帧是增强项：无工作区/文件缺失/
    // ffmpeg 失败/实现抛错一律返回 undefined，绝不连累 generate_video 的成功结果。
    readVideoPosterAsBase64: async (artifact) => {
      try {
        const workspaceDir = deps.currentDir()
        if (!workspaceDir) return undefined
        // 目录用任务状态里记录的 artifactDirRel（提交时的实际落盘目录，相对工作区根）——
        // media.outputDir 是随时可改的设置，按"当前配置"拼历史产物必错（见 MediaJobStatus.artifactDirRel）；
        // 缺省回退媒体产物目录根 MEDIA_ROOT_REL
        const absPath = join(workspaceDir, artifact.artifactDirRel ?? MEDIA_ROOT_REL, artifact.relPath)
        // maxFrames=2 是抽帧管线的下限：videoFrames.ts 抽帧后有 extracted.length < 2 判失败的守卫，
        // 传 1 必 ok:false（首帧永远回不来）；故传 2 取第 1 帧 —— "只回 1 帧"的意图不变，
        // 多抽的那帧只进磁盘缓存，不进模型上下文
        const result = await extractVideoFrames(absPath, {
          maxFrames: 2,
          maxEdge: 768, // 与 read_media 视频帧同档（videoFrames.VIDEO_FRAME_MAX_EDGE）
          cacheDir: join(workspaceDir, '.huabu', 'vframes')
        })
        if (!result.ok || result.value.frames.length === 0) return undefined
        const first = result.value.frames[0]
        return { data: first.data, mimeType: first.mimeType }
      } catch {
        // 首帧是增强项，不许连累成功结果：任何异常都降级为"没有首帧"（纯文本成功结果）
        return undefined
      }
    }
  })

  // T7：引用契约的另一半 —— 按路径把图片交给 Agent 看。路径判定（允许哪些根、越界、
  // 分类）在 shared/assets.ts 的纯函数里，由 pnpm asset-path:check 断言；这里只给根目录。
  const mediaRoots = () => {
    const dir = deps.currentDir()
    if (!dir) return null
    const mediaDir = mediaContext().mediaDir ?? undefined
    return { workspaceDir: dir, ...(mediaDir ? { mediaDir } : {}), inboxDir: deps.inboxRoot() }
  }
  const readMediaTool = createReadMediaTool({
    roots: mediaRoots,
    supportsImageInput: () => deps.sessionModelSupportsImages(nodeId) ?? false
  })

  // 视频理解 M2/M3：Agent 化两工具（粗扫定位 → 区间精读），与 read_media 共用同一套
  // 根解析与视觉闸门；帧抽取在 media/videoFrames.ts（T13 探针覆盖）
  const videoTools = createVideoTools({
    roots: mediaRoots,
    supportsImageInput: () => deps.sessionModelSupportsImages(nodeId) ?? false
  })

  return { mediaTools, readMediaTool, videoTools }
}
