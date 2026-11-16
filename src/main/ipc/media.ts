/** 媒体任务、导入和审批回执的 IPC 入口。 */
import { ipcMain } from './ipcMainBridge'
import { randomUUID } from 'crypto'
import { mkdirSync, statSync } from 'fs'
import { writeFile } from 'fs/promises'
import { basename, extname, join, resolve } from 'path'
import { buildMediaUrl } from '../media/protocol'
import { copyIntoDir } from '../fsutil/copy'
import { IpcChannel } from '../../shared/ipc'
import type {
  ChatResult,
  MediaGenerateRequest,
  MediaImportRequest,
  MediaJobStatus,
  MediaProviderInfo
} from '../../shared/ipc'
import type { MediaKind, MediaRatio, MediaRefInput, MediaRefRole } from '../../shared/media'
import {
  MEDIA_EXT_KIND_MIME,
  MEDIA_RATIOS,
  MEDIA_REF_ROLES,
  mediaKindOfPath
} from '../../shared/media'
import type { IpcContext } from './shared'
import { describe, guardSync, invalidPayload, isNonEmptyString, ok } from './shared'
import { consumeSourcePath } from './workspace'
import { resolveMediaApproval } from './mediaApproval'
import { registerMediaSettingsIpc } from './mediaSettings'

export function registerMediaIpc(ctx: IpcContext): void {
  const store = ctx.store
  const mediaManager = ctx.mediaManager
  registerMediaSettingsIpc(ctx)

  ipcMain.handle(IpcChannel.MediaProviders, async (): Promise<ChatResult<MediaProviderInfo[]>> => {
    try {
      // 异步凭据探测（isReady：查加密存储/环境变量），设置页绿点才真实
      return { ok: true, value: await mediaManager.providers() }
    } catch (error) {
      return { ok: false, code: 'unknown', error: describe(error) }
    }
  })

  ipcMain.handle(
    IpcChannel.MediaGenerate,
    async (_event, payload: unknown): Promise<ChatResult<{ jobId: string }>> => {
      const wrapped = payload !== null && typeof payload === 'object' && 'request' in payload
      const envelope = payload as { request?: unknown; workspacePath?: unknown } | null
      if (wrapped && !isNonEmptyString(envelope?.workspacePath)) {
        return invalidPayload('media:generate 需要有效的 workspacePath')
      }
      const expectedWorkspace = wrapped ? envelope?.workspacePath as string : undefined
      const request = (wrapped ? envelope?.request : payload) as Partial<MediaGenerateRequest> | null
      if (!isNonEmptyString(request?.provider)) return invalidPayload('media:generate 需要 provider')
      if (!isNonEmptyString(request.model)) return invalidPayload('media:generate 需要 model')
      if (!isNonEmptyString(request.prompt)) return invalidPayload('media:generate 需要 prompt')
      if (request.kind !== 'image' && request.kind !== 'video' && request.kind !== 'audio') {
        return invalidPayload('media:generate 需要 kind=image|video|audio')
      }
      const generateRequest: MediaGenerateRequest = {
        provider: request.provider,
        model: request.model,
        kind: request.kind,
        prompt: request.prompt
      }
      if (isNonEmptyString(request.nodeId)) generateRequest.nodeId = request.nodeId
      if (isNonEmptyString(request.sourceChatId)) generateRequest.sourceChatId = request.sourceChatId
      // 比例是语义参数（像素换算在编排层收口）；width/height 仅作高级覆盖保留
      if (isNonEmptyString(request.ratio)) {
        if (!(MEDIA_RATIOS as readonly string[]).includes(request.ratio)) {
          return invalidPayload(`media:generate 的 ratio 不合法（可选：${MEDIA_RATIOS.join('/')}）`)
        }
        generateRequest.ratio = request.ratio as MediaRatio
      }
      if (typeof request.width === 'number' && request.width > 0) {
        generateRequest.width = Math.min(4096, Math.round(request.width))
      }
      if (typeof request.height === 'number' && request.height > 0) {
        generateRequest.height = Math.min(4096, Math.round(request.height))
      }
      if (typeof request.durationSeconds === 'number' && request.durationSeconds > 0) {
        generateRequest.durationSeconds = Math.min(120, Math.round(request.durationSeconds))
      }
      // 音色：只清洗形态，是否在模型清单内由编排层按 capabilities.voices 校验
      if (isNonEmptyString(request.voice)) generateRequest.voice = request.voice
      if (Array.isArray(request.refPaths)) {
        // 只做形态清洗；数量上限的权威是模型能力声明，唯一执行点在 MediaJobManager.submit
        const refPaths = request.refPaths.filter((p): p is string => isNonEmptyString(p))
        if (refPaths.length > 0) generateRequest.refPaths = refPaths
      }
      if (Array.isArray(request.refs)) {
        // 带角色参考素材：只认枚举内的 role、且必须给出 path 或 url 之一；
        // 角色是否被当前模型接受、组合是否合法，由编排层按能力声明判定
        const refs: MediaRefInput[] = []
        for (const raw of request.refs as unknown[]) {
          if (!raw || typeof raw !== 'object') continue
          const entry = raw as { role?: unknown; path?: unknown; url?: unknown }
          if (typeof entry.role !== 'string' || !MEDIA_REF_ROLES.includes(entry.role as MediaRefRole)) continue
          const path = typeof entry.path === 'string' && entry.path.trim() ? entry.path : undefined
          const url = typeof entry.url === 'string' && entry.url.trim() ? entry.url : undefined
          if (!path && !url) continue
          refs.push({ role: entry.role as MediaRefRole, ...(path ? { path } : {}), ...(url ? { url } : {}) })
        }
        if (refs.length > 0) generateRequest.refs = refs
      }
      // 落库目录（相对工作区根）：越界校验在 MediaJobManager.submit 内做
      if (isNonEmptyString(request.outputDir)) generateRequest.outputDir = request.outputDir
      // 附加参数：IPC 只清洗形态（键名 + 原始值类型），是否被该模型接受由编排层按声明判
      if (request.extra && typeof request.extra === 'object' && !Array.isArray(request.extra)) {
        const extra: Record<string, string | number | boolean> = {}
        for (const [key, raw] of Object.entries(request.extra as Record<string, unknown>)) {
          if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') extra[key] = raw
        }
        if (Object.keys(extra).length > 0) generateRequest.extra = extra
      }
      // 产物命名：净化与重名序号在 MediaJobManager.submit/materialize 内收口
      if (isNonEmptyString(request.name)) generateRequest.name = request.name
      try {
        return { ok: true, value: await mediaManager.submit(generateRequest, expectedWorkspace) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, code: 'unknown', error: message }
      }
    }
  )

  ipcMain.handle(IpcChannel.MediaCancel, async (_event, payload: unknown) => {
    const request = payload as { jobId?: unknown; workspacePath?: unknown } | null
    const jobId = request?.jobId
    if (!isNonEmptyString(jobId)) return invalidPayload('media:cancel 需要 jobId')
    if (request?.workspacePath !== undefined && !isNonEmptyString(request.workspacePath)) {
      return invalidPayload('media:cancel 的 workspacePath 不合法')
    }
    const workspace = request?.workspacePath ?? ctx.currentDir()
    const job = workspace ? mediaManager.getForWorkspace(jobId, workspace) : undefined
    if (!job || (job.state !== 'queued' && job.state !== 'running')) {
      return { ok: false, code: 'unknown' as const, error: '任务不存在或已结束' }
    }
    const cancelled = await mediaManager.cancel(jobId)
    return {
      ok: cancelled,
      ...(cancelled ? {} : { code: 'unknown' as const, error: '任务不存在或已结束' })
    }
  })

  ipcMain.handle(IpcChannel.MediaJobs, () => {
    return guardSync(() => {
      const workspace = ctx.currentDir()
      return mediaManager.list().filter((job) => workspace && job.workspacePath === workspace)
    }) satisfies ChatResult<MediaJobStatus[]>
  })

  ipcMain.handle(IpcChannel.MediaConfirmResolve, (_event, payload: unknown) => {
    const request = payload as { requestId?: unknown; accepted?: unknown } | null
    if (!isNonEmptyString(request?.requestId) || typeof request.accepted !== 'boolean') {
      return invalidPayload('media:confirm-resolve 需要 requestId 与 accepted:boolean')
    }
    // 未知 requestId 静默 ok：回执可能晚于中止/清理的先行 settle，幂等
    resolveMediaApproval(request.requestId, request.accepted)
    return ok()
  })

  /**
   * 导入 OS 媒体文件：拷入当前工作区 .huabu/media/，返回产物描述。
   * sourcePath 来自 preload 的 webUtils.getPathForFile（不把文件字节搬过 IPC）；
   * 剪贴板图片没有磁盘路径，走 base64 兜底通道。
   */
  ipcMain.handle(IpcChannel.MediaImport, async (_event, payload: unknown): Promise<ChatResult<unknown>> => {
    const request = payload as Partial<MediaImportRequest> | null
    const dir = store.mediaDir()
    if (!dir) return invalidPayload('尚未打开工作区')
    if (!request || (typeof request.sourcePath !== 'string' && typeof request.base64 !== 'string')) {
      return invalidPayload('media:import 需要 sourcePath 或 base64')
    }
    const kind: MediaKind =
      request.kind === 'video' || request.kind === 'audio' || request.kind === 'image'
        ? request.kind
        : guessKind(request.sourcePath ?? '', request.mime)
    try {
      mkdirSync(dir, { recursive: true })
      let target: string
      let displayName: string
      if (typeof request.base64 === 'string') {
        // base64 通道在解码前先卡长度：渲染端异常可把数百 MB 文本灌进主进程，
        // Buffer.from + 写盘会瞬时膨胀内存并冻结 UI（写盘已走 fs/promises）
        if (request.base64.length > 32 * 1024 * 1024) {
          return invalidPayload('剪贴板图片超过 32MB 上限，已拒绝导入')
        }
        const ext = request.mime?.includes('jpeg') ? '.jpg' : '.png'
        displayName = `clipboard-${randomUUID().slice(0, 8)}${ext}`
        target = join(dir, displayName)
        await writeFile(target, Buffer.from(request.base64, 'base64'))
      } else if (typeof request.sourcePath === 'string') {
        // 安全闸：sourcePath 只可能来自 preload pathForFile 的拖拽登记（未 resolve 的原样字符串）；
        // 未登记的路径一律拒绝，堵住「伪造路径把任意用户文件复制进工作区」的口子
        if (!consumeSourcePath(request.sourcePath)) {
          return invalidPayload('导入路径未经过拖拽登记，已拒绝：请重新把文件拖入画布')
        }
        const source = resolve(request.sourcePath)
        displayName = `${randomUUID().slice(0, 8)}-${sanitizeName(request.name ?? basename(source))}`
        target = await copyIntoDir(source, dir, displayName)
      } else {
        return invalidPayload('media:import 需要 sourcePath 或 base64')
      }
      const bytes = statSync(target).size
      const mime = request.mime ?? mimeFromExt(extname(target)) ?? defaultMime(kind)
      const relPath = basename(target)
      return {
        ok: true,
        value: {
          artifact: {
            relPath,
            name: sanitizeName(request.name ?? relPath),
            mime,
            bytes
          },
          url: buildMediaUrl(relPath)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'unknown', error: `导入失败：${message}` }
    }
  })
}

/**
 * Agent 媒体工具的 provider/model 解析。
 *
 * 回退链的唯一实现在 shared/mediaResolve.ts（与渲染端卡片共用同一纯函数，语义一致）。
 * 默认供应商不存在、没有同类模型、没配 Key 时，都给可操作错误，绝不静默生成假图。
 */
/**
 * 生成产物的默认落库目录与 Agent 媒体解析已收拢进 agent/mediaToolAssembly.ts
 * （T12）：它们只服务 Agent 工具路径，此处原先的两份实现随之删除。
 */

/** 从扩展名猜媒体大类（导入时渲染端可不传 kind）；认不出的一律按 image，与历史行为一致 */
function guessKind(pathOrName: string, mime?: string): MediaKind {
  if (mime?.startsWith('video/')) return 'video'
  if (mime?.startsWith('audio/')) return 'audio'
  return mediaKindOfPath(pathOrName)?.kind ?? 'image'
}

function mimeFromExt(ext: string): string | undefined {
  return MEDIA_EXT_KIND_MIME[ext.toLowerCase()]?.mime
}

function defaultMime(kind: MediaKind): string {
  return kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/wav' : 'image/png'
}

/** 文件名只保留安全字符，防止路径穿越与奇怪字符进 canvas.json */
function sanitizeName(name: string): string {
  const cleaned = basename(name)
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5 ]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120)
  return cleaned || 'media'
}
