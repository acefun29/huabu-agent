/**
 * Artifact —— 产物（原子 1/3）。见施工计划 §2。
 *
 * 一个 Artifact 就是「一个文件 + 生成它的参数」。它没有状态、没有评分、没有通过标记：
 * 判定是动作（模型看图 / 用户看图），不是数据。
 *
 * 唯一不变量：**不可变**。同一路径再产出一份，是新的 Artifact，旧的原样留着 ——
 * 版本链由此天然成立，不需要 revision 字段，也不需要「覆盖」这个动作。
 *
 * 本模块是纯的：不起 Mastra、不调模型、不碰文件系统（传入的是路径字符串，
 * 不是文件）。这样它能只靠自己的类型单测。
 */

export type ArtifactKind = 'image' | 'video' | 'audio' | 'text'

export interface Artifact {
  readonly id: string
  /** 工作区相对路径，POSIX 分隔符 */
  readonly path: string
  readonly kind: ArtifactKind
  readonly mime: string
  readonly bytes: number
  /** 生成参数（比例、时长、提示词等）；写入类产物可省略 */
  readonly params?: Readonly<Record<string, unknown>>
  /** 产出它的任务；手工/导入产物可缺省 */
  readonly taskId?: string
  readonly createdAt: string
}

export interface ArtifactInput {
  path: string
  kind: ArtifactKind
  mime: string
  bytes: number
  params?: Record<string, unknown>
  taskId?: string
}

/** id 与时间由调用方注入，让本模块保持纯函数（可断言、可重放） */
export interface ArtifactMeta {
  id: string
  createdAt: string
}

/** 路径非法是**数据完整性问题**，属于本项目责任（计划 §12）：必须当场抛错 */
export class InvalidArtifactPathError extends Error {
  constructor(raw: string) {
    super(`产物路径必须是工作区内的相对路径：${JSON.stringify(raw)}`)
    this.name = 'InvalidArtifactPathError'
  }
}

/**
 * 归一化并校验产物路径。返回 null 表示非法（供判定用），createArtifact 里直接抛错。
 *
 * 拒绝：绝对路径、Windows 盘符、`..` 越界、空串。
 * 归一：反斜杠 → `/`、折叠重复分隔符、去掉末尾分隔符。
 */
export function normalizeArtifactPath(raw: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const posix = trimmed.replace(/\\/g, '/')
  // 绝对路径（含 UNC）与盘符一律拒绝：产物只能落在工作区内
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null
  const segments = posix.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return null
  // 折叠之后仍出现 `..` 说明想跳出工作区
  if (segments.includes('..')) return null
  return segments.join('/')
}

/**
 * 构造产物。路径非法直接抛错——宁可让工具调用失败，也不留下一个指向不合法路径的记录
 * （计划 §12 推论 3：写入失败必须让产物不存在）。
 */
export function createArtifact(input: ArtifactInput, meta: ArtifactMeta): Artifact {
  const path = normalizeArtifactPath(input.path)
  if (!path) throw new InvalidArtifactPathError(input.path)
  if (!Number.isFinite(input.bytes) || input.bytes < 0) {
    throw new Error(`产物字节数必须是非负有限数：${String(input.bytes)}`)
  }
  return {
    id: meta.id,
    path,
    kind: input.kind,
    mime: input.mime,
    bytes: input.bytes,
    ...(input.params ? { params: { ...input.params } } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    createdAt: meta.createdAt
  }
}

/** 产物所属目录（不含文件名）；用于按目录归组展示 */
export function artifactDir(artifact: Artifact): string {
  const index = artifact.path.lastIndexOf('/')
  return index <= 0 ? '' : artifact.path.slice(0, index)
}
