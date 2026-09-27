import type { AssetData, AssetKind } from '../types'

/**
 * 媒体/资产文件 helper。
 *
 * 文件一律存工作目录、卡片只存引用；渲染端经自定义特权协议 huabu-media:// 读：
 * - `huabu-media://media/<相对产物目录路径>`（生成产物）
 * - `huabu-media://ws/<相对工作区根路径>`（工作区内文件）
 * - `huabu-media://inbox/<相对收件箱根路径>`（临时引用素材，工作区之外）
 * 主进程只服务对应根目录内的文件，越界拒绝。
 *
 * 路径引用契约（新原型同步）：文件内容不再读进对话上下文 —— 发给 Agent 的只有
 * 绝对路径列表（harness/prompt.ts buildReferencePayload），内容读取由 Agent 按路径自助。
 */

/** 卡片缩略图的宽度档（性能优化方案 P1-5）：解码内存比原图低一个量级 */
export const CARD_THUMB_SIZE = 512

/** 由卡片数据得到可播放/可显示的 src；给 size 时走缩略图管线；无文件时返回 null */
export function assetSrc(data: Pick<AssetData, 'storage' | 'path' | 'pathRoot'>, size?: number): string | null {
  if (!data.path || !data.storage) return null
  // 三条路按"path 相对哪个根"分派，别再判当前配置：
  // - ws：path 已经是相对工作区根的完整路径（pathRoot 不参与，拼上去就是双前缀）
  // - media 且有 pathRoot：位置完全确定，走 ws 根 + 落盘当时的根，与引用契约同一口径
  //   （产物根可被 media.outputDir 改，事后按"当前配置"解析老卡片就会指偏）
  // - media 且无 pathRoot：历史卡片，仍走 media host（语义没变，还保住它的 immutable 缓存）
  const precise = data.storage === 'media' && Boolean(data.pathRoot)
  const rel = precise ? `${data.pathRoot!.replace(/\/+$/, '')}/${data.path}` : data.path
  const host = data.storage === 'ws' || precise ? 'ws' : 'media'
  const encoded = rel
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  if (size) return `huabu-media://thumb/${size}/${host}/${encoded}`
  return `huabu-media://${host}/${encoded}`
}

/** 临时附件（inbox 绝对路径）→ 可预览 src；inboxDir 来自 asset:libraries 的返回 */
export function inboxSrc(absPath: string, inboxDir: string | null): string | null {
  if (!inboxDir) return null
  const root = inboxDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  const normalized = absPath.replace(/\\/g, '/')
  if (!normalized.startsWith(root)) return null
  const rel = normalized.slice(root.length)
  const encoded = rel
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `huabu-media://inbox/${encoded}`
}

/** 人类可读的体积（KB/MB） */
export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 由扩展名/文件名推断文件卡片类型（导入与 OS 拖放共用；归档分类以此为准，见 shared/assets.ts） */
export function guessKind(name: string, mime?: string): AssetKind {
  if (mime?.startsWith('video/')) return 'video'
  if (mime?.startsWith('audio/')) return 'audio'
  if (mime?.startsWith('image/')) return 'image'
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext)) return 'audio'
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'].includes(ext)) return 'image'
  if (['.md', '.txt', '.pdf', '.doc', '.docx', '.rtf'].includes(ext)) return 'doc'
  return 'code'
}
