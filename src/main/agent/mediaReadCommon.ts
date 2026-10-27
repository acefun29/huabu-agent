import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { resolveMediaTarget, type MediaRoots } from '../../shared/assets'

/**
 * 素材读取类工具（read_media / skim_video / read_video_frames）的共用件。
 *
 * 这些工具共享同一套「入口守卫 → 路径解析 → 元信息摘要 → 视觉闸门」骨架，原先在
 * readMediaTool.ts 与 videoTools.ts 各有一份近乎逐字相同的实现——两份文案一旦只改
 * 一边，Agent 在两个工具里拿到的自纠指引就开始互相矛盾。收口在这里，工具文件只留
 * 各自的分支逻辑与工具特有文案。
 *
 * 约定与原实现一致：路径合法性的全部规则在 shared/assets.ts 的纯函数里（由
 * `pnpm asset-path:check` 断言），本文件只做 exists/stat 这类真 IO；stat 走异步——
 * 素材读取发生在 Electron 主进程，同步 IO 会把聊天流/画布事件卡到磁盘回包为止。
 */

export function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

export function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/** 纯文本工具结果的统一形态（details 由调用方各自补齐） */
export function textResult(text: string, details: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
} {
  return { content: [textBlock(text)], details }
}

export function rootsHint(roots: MediaRoots): string {
  const lines = [`- 工作区：${roots.workspaceDir}`, ...(roots.mediaDir ? [`- 媒体产物目录：${roots.mediaDir}`] : []), ...(roots.inboxDir ? [`- 临时上传（inbox）：${roots.inboxDir}`] : [])]
  return lines.join('\n')
}

/** 视觉闸门共用的换模型指引：三个工具的"模型不声明图片输入"话术都以此句收尾 */
export const SWITCH_VISION_MODEL_HINT =
  '请告诉用户把会话模型换成支持视觉的模型（设置 → 模型供应商里该模型需带「视觉」标记）'

/**
 * 入口守卫：无工作区 / 无路径参数两种硬失败。成功时原样带回收窄后的 roots，
 * 调用方 `'error' in guard` 一分支部就拿到非空 MediaRoots（自纠指引不猜路径）。
 */
export function pathGuard(
  toolName: string,
  requested: string,
  roots: MediaRoots | null,
  paramHint: string
): { error: string; reason: string } | { roots: MediaRoots } {
  if (!roots) return { reason: 'no-workspace', error: `当前没有打开中的工作区，${toolName} 无法解析任何路径。` }
  if (!requested) return { reason: 'no-path', error: `${toolName} 需要一个路径参数${paramHint}。` }
  return { roots }
}

export interface ResolvedMediaEntry {
  absPath: string
  kind: string
  /** 命中的根（workspace / media / inbox），用于"位置"行文案 */
  root: string
  size: number
  /** 文件/位置/大小三行摘要，各工具结果的开头都从它起步 */
  summary: string
}

/**
 * 路径解析 + 异步 stat + 元信息摘要（read_media 与 videoTools 原两份实现的合并）。
 * expect 指定时额外要求解析结果就是该类型（videoTools 只吃视频），不匹配按找不到处理。
 * exists 与 stat 之间文件可能被删：按"找不到"收敛而不是抛异常炸会话。
 */
export async function resolveMediaEntry(
  requested: string,
  roots: MediaRoots,
  expect?: { kind: 'video' }
): Promise<{ entry: ResolvedMediaEntry } | { error: string; reason: string }> {
  const notFound = (): { error: string; reason: string } => ({
    reason: 'not-found-or-out-of-scope',
    error:
      `没找到该${expect ? '视频' : '文件'}，或它不在允许读取的范围内：${requested}\n` +
      `可读取的根：\n${rootsHint(roots)}\n` +
      `请用「引用素材」清单里原样给出的绝对路径重试；相对路径也支持，但裸文件名会先按媒体产物目录找。`
  })
  const resolved = resolveMediaTarget(requested, roots, existsSync)
  if (!resolved || (expect && resolved.kind !== expect.kind)) return notFound()
  try {
    const size = (await stat(resolved.absPath)).size
    const summary =
      `文件：${resolved.absPath}\n` +
      `位置：${resolved.root === 'media' ? '媒体产物目录' : resolved.root === 'inbox' ? '临时上传（工作区之外）' : '工作区'}\n` +
      `大小：${humanBytes(size)}`
    return { entry: { absPath: resolved.absPath, kind: resolved.kind, root: resolved.root, size, summary } }
  } catch {
    return notFound()
  }
}
