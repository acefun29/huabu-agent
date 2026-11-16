/**
 * 产物路径以**工具回执**为准（A02 后半句）。
 *
 * 断点：产物记录里的 `path` 一直取自模型的回执 JSON——模型要自己把生成工具返回的路径
 * 抄一遍。抄错了，表现是「验收失败 → 重试」（不是自动纠正）；极端情况下模型声明一个
 * 从未存在的路径，看起来像是专家没交付。
 *
 * 现在媒体工具在 `details.artifactPath` 里给出**自己算出来的**工作区相对路径
 * （`outputDir/relPath`），编排器优先采信它：
 * - 工具给了路径 → 用它（并在证据里保留模型原本声明的 `receiptPath`，便于排查）；
 * - 工具没给（纯文本专家、旧工具）→ 维持回执路径，行为不变。
 *
 * 只看媒体生成工具：文本专家可能一次写多个文件，自动挑一个当交付物反而更容易挑错。
 */

export interface ObservedArtifact {
  /** 工作区相对路径（POSIX 风格） */
  path: string
  kind?: 'image' | 'video' | 'audio'
  width?: number
  height?: number
  durationS?: number
}

/** 工具结果里可能带 `details` 的结构（pi 形状的 AgentToolResult） */
interface ToolResultLike {
  details?: unknown
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 从工具结果里提取「真实产物」。只认我们自己媒体工具放的 `details.artifactPath`；
 * 别的工具（write / read / blockout）一律返回 null，避免误把中间文件当交付物。
 */
export function observedArtifactOf(result: unknown): ObservedArtifact | null {
  if (!result || typeof result !== 'object') return null
  const details = (result as ToolResultLike).details
  if (!details || typeof details !== 'object') return null
  const record = details as Record<string, unknown>
  const path = typeof record.artifactPath === 'string' ? record.artifactPath.trim() : ''
  if (!path) return null
  const artifact = (record.artifact ?? {}) as Record<string, unknown>
  const kind = artifact.kind
  const width = num(artifact.width)
  const height = num(artifact.height)
  const durationS = num(artifact.durationSeconds)
  return {
    path: path.replace(/\\/g, '/'),
    ...(kind === 'image' || kind === 'video' || kind === 'audio' ? { kind } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationS !== undefined ? { durationS } : {})
  }
}

export interface PreferObservedResult<T> {
  artifact: T
  /** 回执路径与工具回执不一致时，模型原本声明的路径（证据用） */
  receiptPath?: string
  /** 是否采用了工具回执的路径 */
  overridden: boolean
}

/**
 * 用观测到的真实路径覆盖候选产物（纯函数，便于单测）。
 *
 * 尺寸/时长同样是实测值，优先于回执自报（与 A04 的口径一致）。
 */
export function preferObservedArtifact<
  T extends { path?: string; width?: number; height?: number; durationS?: number }
>(artifact: T, observed: ObservedArtifact | null): PreferObservedResult<T> {
  if (!observed) return { artifact, overridden: false }
  const receiptPath = artifact.path
  const pathDiffers = receiptPath !== observed.path
  const next: T = {
    ...artifact,
    path: observed.path,
    ...(observed.width !== undefined ? { width: observed.width } : {}),
    ...(observed.height !== undefined ? { height: observed.height } : {}),
    ...(observed.durationS !== undefined ? { durationS: observed.durationS } : {})
  }
  return {
    artifact: next,
    ...(receiptPath && pathDiffers ? { receiptPath } : {}),
    overridden: pathDiffers
  }
}
