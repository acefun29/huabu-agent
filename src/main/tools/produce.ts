/**
 * produce —— 把「一次生成/写入」变成 Artifact（施工计划 §10 第 4 步）。
 *
 * 这一层只做四件事，每件都是数据完整性（§12 划给我们的那半边）：
 *
 * 1. **算出产物在工作区里的相对路径**。媒体工具给的是 `relPath`（相对落盘目录），
 *    编排层要的是工作区相对路径——这个换算只有这里做，避免各处各拼一遍。
 * 2. **校验节不在 lane 内**。越界的产物不属于这个任务，直接拒绝。
 * 3. **拒绝坏产物**。0 字节 / 非有限字节数一律抛错：宁可这次生成失败，
 *    也不能留一条"记录说产出了，文件却是坏的"（§12 推论 3）。
 * 4. **附带图片本体**，让模型能直接看图——这是"判定"能成立的前提：
 *    模型看图决定满意/不满意，不需要任何 pass/fail 状态。
 *
 * 本模块是纯的：输入是媒体任务的状态快照，输出是 Artifact + 可选图片。
 */

import { createArtifact, normalizeArtifactPath, type Artifact, type ArtifactKind } from '../core/artifact'
import { isWithinLane } from '../core/task'

/** 媒体工具成功后 details 里实际会带的东西（只取这里用得到的） */
export interface MediaDetailsLike {
  artifact?: {
    relPath?: string
    name?: string
    mime?: string
    bytes?: number
    width?: number
    height?: number
    durationSeconds?: number
  }
  /** 提交时实际落盘目录（工作区相对）；缺省 = 媒体产物目录 */
  outputDir?: string
  artifactDirRel?: string
  params?: Record<string, unknown>
}

export interface ProduceMeta {
  artifactId: string
  createdAt: string
  /** 任务写区；缺省表示不校验（手工/导入产物） */
  lane?: string
  taskId?: string
}

export interface ProduceResult {
  artifact: Artifact
  /** 给模型看的图本体（base64）；无视觉能力或非图片产物时为 undefined */
  image?: { data: string; mimeType: string }
}

/** 产物越出任务写区：这是任务归属问题，不是可重试的失败 */
export class OutsideLaneError extends Error {
  constructor(lane: string, path: string) {
    super(`产物不在任务写区内：${path}（写区 ${lane}/）`)
    this.name = 'OutsideLaneError'
  }
}

/** 产物无效（0 字节 / 缺路径）：媒体服务出了故障，必须让调用方看见 */
export class EmptyArtifactError extends Error {
  constructor(reason: string) {
    super(`产物无效：${reason}`)
    this.name = 'EmptyArtifactError'
  }
}

/**
 * 从媒体任务 details 算出产物的**工作区相对路径**。
 *
 * 落盘目录的优先级与 `MediaJobStatus` 的语义一致：
 * `outputDir`（提交时指定的落库目录）→ `artifactDirRel`（实际落盘目录）→ 相对根。
 * 绝不按"当前配置"去拼——`media.outputDir` 是可随时改的设置，按当前值拼历史产物必然错位。
 */
export function artifactPathOf(details: MediaDetailsLike): string {
  const relPath = details.artifact?.relPath?.trim()
  if (!relPath) throw new EmptyArtifactError('媒体任务没有给出产物文件路径')
  const dir = (details.outputDir ?? details.artifactDirRel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  const joined = dir ? `${dir}/${relPath}` : relPath
  const normalized = normalizeArtifactPath(joined)
  if (!normalized) throw new EmptyArtifactError(`产物路径不合法：${joined}`)
  return normalized
}

/**
 * 把媒体任务的成功结果转成 Artifact。
 *
 * 失败语义（与 §12 推论 2/3 一致）：
 * - 没有产物 / 路径非法 / 0 字节 → **抛错**，调用方据此报错给模型；
 * - 越出 lane → 抛 `OutsideLaneError`，不写入产物。
 *
 * 不做的事：不判好坏、不打分、不写通过标记。质量归模型与用户（§12）。
 */
export function produceFromMedia(
  details: MediaDetailsLike,
  meta: ProduceMeta,
  image?: { data: string; mimeType: string }
): ProduceResult {
  const path = artifactPathOf(details)
  const media = details.artifact
  const bytes = media?.bytes
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
    throw new EmptyArtifactError('媒体任务没有给出产物字节数')
  }
  if (bytes <= 0) throw new EmptyArtifactError(`产物文件是空的（0 字节）：${path}`)

  if (meta.lane && !isWithinLane(meta.lane, path)) throw new OutsideLaneError(meta.lane, path)

  const kind = kindFromMime(media?.mime)
  const artifact = createArtifact(
    {
      path,
      kind,
      mime: media?.mime ?? 'application/octet-stream',
      bytes,
      ...(details.params ? { params: details.params } : {}),
      ...(meta.taskId ? { taskId: meta.taskId } : {})
    },
    { id: meta.artifactId, createdAt: meta.createdAt }
  )
  return { artifact, ...(image ? { image } : {}) }
}

/** mime → 产物大类。未知按 text 处理（不猜成图片，避免下游按图渲染坏文件） */
export function kindFromMime(mime: string | undefined): ArtifactKind {
  const value = (mime ?? '').toLowerCase()
  if (value.startsWith('image/')) return 'image'
  if (value.startsWith('video/')) return 'video'
  if (value.startsWith('audio/')) return 'audio'
  return 'text'
}
