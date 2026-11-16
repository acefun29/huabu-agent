/**
 * 验收器（Mastra 迁移计划 v1.2 §9.5，SuperAgent Phase 4 基础）。
 *
 * 确定性代码先行：结论由规则与阈值决定，LLM 不参与结论归属（计划 §9.1）。
 * 输出 validation.passed/failed 的全部证据字段，满足 journal 的 accept 可回放硬门槛。
 *
 * **验收必须落到真实文件上（C1）**：此前所有输入都取自专家回执里的自报元数据，
 * 验收器一行 IO 也不做——专家只要在回执里写 `bytes:204800` / `width:1920` 就能过，
 * 字段不填连「文件非空」「格式匹配」两条检查都不会生成，accept 里的比例标准因缺
 * width/height 直接落到「结构检查不适用」并通过；`accept=[]` 且无元数据时
 * checks=[] → 零检查 passed。现在改成：
 * - 路径必填，且必须落在工作区内（resolve + realpath 双重校验，防符号链接逃逸）；
 * - 存在性 / 是否为文件 / 字节数 / 扩展名全部来自 `stat` 与真实文件名；
 * - 图片宽高来自读文件头（media/imageSize.ts），与自报值不一致时以真实值为准；
 * - 机器判不了的标准记为 undetermined（不计失败，也绝不冒充通过）。
 */

import { createHash } from 'node:crypto'
import { realpath, readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { posix } from 'node:path'
import { imageSizeOf } from '../media/imageSize'
import { probeMediaMetadata } from '../media/videoFrames'
import type { AcceptEvidence } from './journal'
import type { Envelope } from './envelope'

/** 候选产物（staging）：专家自报 + 真实文件事实的合并视图 */
export interface ArtifactCandidate {
  artifactId: string
  assetId: string
  version: string
  kind: 'image' | 'video' | 'audio' | 'text'
  /** 产物工作区相对路径。**必填**——没有路径就无法验收（C1/C2） */
  path?: string
  width?: number
  height?: number
  durationS?: number
  /** 小写扩展名（不含点），如 'png' / 'mp4' / 'wav' */
  format?: string
  /** 文件字节数 */
  bytes?: number
}

export interface ValidationCheck {
  name: string
  passed: boolean
  /** true = 机器无法判定（不计入失败，也不冒充通过） */
  undetermined?: boolean
  /**
   * 该标准是**激活前必须满足的硬条件**（A04）。
   *
   * 比例/尺寸/时长这类机器可测的标准属于硬条件：拿不到证据时不能放行。
   * 语义类标准（风格一致、是否为中文…）标记为非硬条件——它们会被记录成证据缺口
   * 交给产品策略处理，但不阻断激活，否则任何一次语义标准都会把任务卡死。
   */
  required?: boolean
  /** 期望值 / 实际值（diff 的结构化形态） */
  expected?: string
  actual?: string
}

export interface ValidationResult {
  passed: boolean
  checks: ValidationCheck[]
  /** 证据缺口：无法机器判定的标准（含只有回执自报、无测量佐证的项） */
  gaps: string[]
  /** journal validation.passed/failed 的完整证据（append 硬门槛字段齐备） */
  evidence: AcceptEvidence & { reason?: string }
}

/** 媒体实测元数据（视频/音频靠 ffmpeg 探；图片靠文件头） */
export interface MeasuredMedia {
  width?: number
  height?: number
  durationS?: number
}

export interface ValidationOptions {
  /** 工作区根：所有文件事实都相对它解析 */
  workspaceDir: string
  /** 专家侧记录的上下文哈希（回退用；文件哈希可用时以文件哈希为准，见 C7） */
  expertContextHash?: string
  /**
   * 音视频实测入口。缺省用 ffmpeg 探测；测试可注入替身避免每次跑真实二进制。
   * 返回 null = 探不到（验收器记证据缺口，不采信回执自报值）。
   */
  probeMedia?: (absPath: string) => Promise<MeasuredMedia | null>
}

/** 图片/视频/音频/文本各自允许的扩展名 */
const KIND_FORMATS: Record<ArtifactCandidate['kind'], readonly string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp'],
  video: ['mp4', 'mov', 'webm'],
  audio: ['wav', 'mp3', 'aac'],
  text: ['md', 'txt', 'json'],
}

/** accept 标准里可被结构化检查识别的关键词 → 检查器（未识别的标准记为 undetermined） */
const RATIO_RE = /(\d+):(\d+)/
const SIZE_RE = /(\d{2,5})\s*[x×]\s*(\d{2,5})/
const DURATION_RE = /(\d+(?:\.\d+)?)\s*(秒|s)\b/i

/** 工作区内的相对路径解析：拒绝绝对路径与 `..` 穿越，越界返回 null */
function resolveInside(workspaceDir: string, relPath: string): string | null {
  const raw = relPath.replace(/\\/g, '/').trim()
  if (!raw) return null
  if (raw.startsWith('/') || raw.startsWith('//') || /^[a-zA-Z]:\//.test(raw)) return null
  const normalized = posix.normalize(raw)
  if (normalized === '..' || normalized.startsWith('../')) return null
  const root = resolve(workspaceDir)
  const abs = resolve(root, normalized)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

/** 真实文件事实（全部来自磁盘，不采信回执） */
interface FileFacts {
  exists: boolean
  isFile: boolean
  bytes?: number
  format?: string
  imageSize?: { width: number; height: number }
  /** 音视频实测元数据（ffmpeg 探；图片不填） */
  media?: MeasuredMedia
  /** 内容哈希（C7：accept 证据要钉住真实字节，而不是 `envelope:<taskId>:<scope>` 常量） */
  sha256?: string
  /** 解析失败的原因（越界 / 不存在 / 不是文件） */
  problem?: string
}

async function readFileFacts(
  workspaceDir: string,
  relPath: string,
  kind: ArtifactCandidate['kind'],
  probeMedia: (absPath: string) => Promise<MeasuredMedia | null>
): Promise<FileFacts> {
  const abs = resolveInside(workspaceDir, relPath)
  if (!abs) return { exists: false, isFile: false, problem: `路径越出工作区：${relPath}` }

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(abs)
  } catch {
    return { exists: false, isFile: false, problem: `文件不存在：${relPath}` }
  }
  if (!info.isFile()) return { exists: true, isFile: false, problem: `不是普通文件：${relPath}` }

  // 符号链接逃逸：stat 跟随链接，realpath 再核一次真实落点是否仍在工作区内（C6）
  let real: string
  try {
    real = await realpath(abs)
  } catch {
    return { exists: true, isFile: true, problem: `无法解析真实路径：${relPath}` }
  }
  const root = resolve(workspaceDir)
  if (real !== root && !real.startsWith(root + sep)) {
    return { exists: true, isFile: false, problem: `符号链接指向工作区外：${relPath}` }
  }

  const dot = relPath.lastIndexOf('.')
  const format = dot >= 0 ? relPath.slice(dot + 1).toLowerCase() : undefined
  const facts: FileFacts = { exists: true, isFile: true, bytes: info.size, ...(format ? { format } : {}) }
  if (facts.format && ['png', 'jpg', 'jpeg', 'webp'].includes(facts.format)) {
    const size = imageSizeOf(real)
    if (size) facts.imageSize = size
  }
  // 音视频：尺寸与时长必须实测（A04）——回执自报不算证据
  if (kind === 'video' || kind === 'audio') {
    try {
      const measured = await probeMedia(real)
      if (measured) facts.media = measured
    } catch {
      /* 探不到就保持空：验收器会把它记成证据缺口 */
    }
  }
  try {
    facts.sha256 = createHash('sha256').update(await readFile(real)).digest('hex')
  } catch {
    /* 内容哈希拿不到不阻断验收：文件事实已由 stat 确认，哈希只影响证据强度 */
  }
  return facts
}

/**
 * 结构验收（有 IO，无 LLM）：产物必须真实存在且与 accept 标准一致。
 * CLI/测试入口：`await validateArtifact(envelope, artifact, { workspaceDir })`。
 */
export async function validateArtifact(
  envelope: Envelope,
  artifact: ArtifactCandidate,
  options: ValidationOptions
): Promise<ValidationResult> {
  const checks: ValidationCheck[] = []
  // 音视频实测入口：缺省走 ffmpeg；测试注入替身，避免每个用例都拉子进程
  const probeMedia = options.probeMedia ?? probeMediaMetadata

  if (!artifact.path) {
    checks.push({ name: '产物路径已声明', passed: false, expected: '工作区内相对路径', actual: '缺失' })
    // 没有路径就没有任何文件事实可采：直接以这一条失败收口，不再用自报元数据凑结论
    return {
      passed: false,
      checks,
      gaps: [],
      evidence: {
        acceptCriteria: envelope.accept,
        diff: checks.map(({ name, passed, expected, actual }) => ({ name, passed, expected, actual })),
        artifactId: artifact.artifactId,
        contextHash: options.expertContextHash ?? `artifact:${artifact.artifactId}`,
        reason: '回执未声明产物路径，无法验收',
      },
    }
  }

  const facts = await readFileFacts(options.workspaceDir, artifact.path, artifact.kind, probeMedia)
  checks.push({
    name: '产物文件存在',
    passed: facts.exists && facts.isFile,
    expected: artifact.path,
    actual: facts.problem ?? '存在',
  })
  if (facts.bytes !== undefined) {
    checks.push({ name: '文件非空', passed: facts.bytes > 0, expected: '>0', actual: String(facts.bytes) })
  }
  if (facts.format) {
    checks.push({
      name: '格式匹配类型',
      passed: KIND_FORMATS[artifact.kind].includes(facts.format),
      expected: artifact.kind,
      actual: facts.format,
    })
  }

  /*
   * 尺寸/时长的来源（A04）：
   * - 图片：文件头实测（imageSizeOf）；
   * - 视频/音频：ffmpeg 实测（probeMedia）；
   * - **回执自报值一律不参与判定**，只在证据里留作 claim 便于排查。
   * 此前 `facts.imageSize?.width ?? artifact.width` 会让视频用模型自报的宽高
   * 通过比例检查——被验的一方自己出证据。
   */
  const measuredWidth = facts.imageSize?.width ?? facts.media?.width
  const measuredHeight = facts.imageSize?.height ?? facts.media?.height
  const measuredDuration = facts.media?.durationS
  if (measuredWidth && measuredHeight) {
    checks.push({
      name: '尺寸来自实测',
      passed: true,
      expected: '可解析',
      actual: `${measuredWidth}x${measuredHeight}`,
    })
  }

  for (const criterion of envelope.accept) {
    const ratio = RATIO_RE.exec(criterion)
    if (ratio) {
      const expected = `${ratio[1]}:${ratio[2]}`
      if (measuredWidth && measuredHeight) {
        const actual = measuredWidth / measuredHeight
        checks.push({
          name: `accept：${criterion}`,
          required: true,
          passed: Math.abs(actual - Number(ratio[1]) / Number(ratio[2])) < 0.02,
          expected,
          actual: `${measuredWidth}:${measuredHeight}`,
        })
      } else {
        // 硬条件缺证据：记未判定且 required → 不允许激活（A04）
        checks.push({ name: `accept：${criterion}`, passed: false, undetermined: true, required: true, expected, actual: '无法实测' })
      }
      continue
    }
    const sizeMatch = SIZE_RE.exec(criterion)
    if (sizeMatch) {
      const expected = `${sizeMatch[1]}x${sizeMatch[2]}`
      if (measuredWidth && measuredHeight) {
        checks.push({
          name: `accept：${criterion}`,
          required: true,
          passed: measuredWidth === Number(sizeMatch[1]) && measuredHeight === Number(sizeMatch[2]),
          expected,
          actual: `${measuredWidth}x${measuredHeight}`,
        })
      } else {
        checks.push({ name: `accept：${criterion}`, passed: false, undetermined: true, required: true, expected, actual: '无法实测' })
      }
      continue
    }
    const durationMatch = DURATION_RE.exec(criterion)
    if (durationMatch) {
      const expected = Number(durationMatch[1])
      if (measuredDuration !== undefined) {
        checks.push({
          name: `accept：${criterion}`,
          required: true,
          passed: Math.abs(measuredDuration - expected) <= Math.max(0.5, expected * 0.1),
          expected: `${expected}s`,
          actual: `${measuredDuration.toFixed(2)}s`,
        })
      } else {
        // 时长不再采信回执自报的 durationS
        checks.push({ name: `accept：${criterion}`, passed: false, undetermined: true, required: true, expected: `${expected}s`, actual: '无法实测' })
      }
      continue
    }
    // 不可结构化（一致性/风格/语种等）：记未判定，非硬条件（否则任何语义标准都会卡死任务）
    checks.push({ name: `accept：${criterion}`, passed: false, undetermined: true })
  }

  const failed = checks.filter((check) => !check.passed && !check.undetermined)
  const gaps = checks.filter((check) => check.undetermined).map((check) => check.name)
  // 硬条件缺证据 = 阻断（A04）：没有确定失败项也不再自动放行
  const blockingGaps = checks.filter((check) => check.passed === false && check.undetermined && check.required)
  const evidence: AcceptEvidence & { reason?: string } = {
    acceptCriteria: envelope.accept,
    diff: checks.map(({ name, passed, undetermined, required, expected, actual }) => ({
      name,
      passed,
      ...(undetermined ? { undetermined } : {}),
      ...(required ? { required } : {}),
      expected,
      actual,
    })),
    artifactId: artifact.artifactId,
    // 文件内容哈希优先：accept 可回放要钉住真实字节（C7）
    contextHash: facts.sha256 ?? options.expertContextHash ?? `artifact:${artifact.artifactId}`,
  }
  if (failed.length || blockingGaps.length) {
    evidence.reason = [...failed, ...blockingGaps].map((check) => check.name).join('；')
    return { passed: false, checks, gaps, evidence }
  }
  if (gaps.length) {
    // 通过但存在证据缺口：留痕，供产品层决定是否需要人工确认
    evidence.reason = `存在无法机器判定的标准（未阻断激活）：${gaps.join('；')}`
  }
  return { passed: true, checks, gaps, evidence }
}
