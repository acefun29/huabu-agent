/**
 * 画布节点 → 工作区相对路径。
 *
 * 画布卡片有两种存储形态：
 * - `media`：`path` 相对产物目录（`.huabu/media`），要拼上 `pathRoot` 才是工作区相对路径
 * - `ws`：`path` 已经是工作区相对路径
 *
 * 任务产物记的是工作区相对路径，所以要把两种形态归一后才能对上——
 * 这个换算原先在 libraryOps 与 jobRuntime 里各写了一份，这里收成唯一实现。
 */
import { MEDIA_ROOT_REL } from '@shared/assets'

export interface NodePathRef {
  storage?: string
  path?: string
  pathRoot?: string
}

export function nodeRelPath(ref: NodePathRef | null | undefined): string | null {
  if (!ref?.path) return null
  if (ref.storage === 'media') {
    const root = (ref.pathRoot ?? MEDIA_ROOT_REL).replace(/\/+$/, '')
    return `${root}/${ref.path}`
  }
  return ref.path
}
