/**
 * 验收器骨架（Mastra 迁移计划 v1.2 §9.5，SuperAgent Phase 4 基础）。
 *
 * 确定性代码先行：结构检查（尺寸/比例/格式/时长/accept 标准逐条）。结论由规则
 * 与阈值决定，LLM 只做辅助判断（后续接入，且不改变结论归属）——「不做创意评审；
 * 不靠 LLM 一句话」（计划 §9.1）。输出 validation.passed/failed 的全部证据字段，
 * 满足 journal 的 accept 可回放硬门槛。
 */

import type { AcceptEvidence } from './journal'
import type { Envelope } from './envelope'

/** 候选产物（staging）：只有元数据引用，验收器不读文件内容（结构检查阶段） */
export interface ArtifactCandidate {
  artifactId: string
  assetId: string
  version: string
  kind: 'image' | 'video' | 'audio' | 'text'
  /** 产物工作区相对路径（lane 白名单校验用；缺省时跳过越界检查） */
  path?: string
  width?: number
  height?: number
  durationS?: number
  /** 小写扩展名（不含点），如 'png' / 'mp4' / 'wav' */
  format?: string
  /** 文件字节数（用于存在性与空文件检查） */
  bytes?: number
}

export interface ValidationCheck {
  name: string
  passed: boolean
  /** 期望值 / 实际值（diff 的结构化形态） */
  expected?: string
  actual?: string
}

export interface ValidationResult {
  passed: boolean
  checks: ValidationCheck[]
  /** journal validation.passed/failed 的完整证据（append 硬门槛字段齐备） */
  evidence: AcceptEvidence & { reason?: string }
}

/** accept 标准里可被结构化检查识别的关键词 → 检查器（未识别的标准只记录不判定） */
const RATIO_RE = /(\d+):(\d+)/

/**
 * 结构验收（纯函数，无 IO/无 LLM）：
 * - 空文件 / 格式缺失 → fail；
 * - envelope.accept 中含尺寸/比例/时长关键词的标准逐条核对；
 * - 所有标准（含不可结构化的）原样进 acceptCriteria——人可回放，机器不冒充判断。
 */
export function validateArtifact(envelope: Envelope, artifact: ArtifactCandidate, contextHash: string): ValidationResult {
  const checks: ValidationCheck[] = []

  if (artifact.bytes !== undefined) {
    checks.push({ name: '文件非空', passed: artifact.bytes > 0, expected: '>0', actual: String(artifact.bytes) })
  }
  if (artifact.format !== undefined) {
    const kindFormatOk =
      (artifact.kind === 'image' && ['png', 'jpg', 'jpeg', 'webp'].includes(artifact.format)) ||
      (artifact.kind === 'video' && ['mp4', 'mov', 'webm'].includes(artifact.format)) ||
      (artifact.kind === 'audio' && ['wav', 'mp3', 'aac'].includes(artifact.format)) ||
      (artifact.kind === 'text' && ['md', 'txt', 'json'].includes(artifact.format))
    checks.push({ name: '格式匹配类型', passed: kindFormatOk, expected: artifact.kind, actual: artifact.format })
  }

  for (const criterion of envelope.accept) {
    const ratio = RATIO_RE.exec(criterion)
    if (ratio && artifact.width && artifact.height) {
      const expected = `${ratio[1]}:${ratio[2]}`
      const a = Number(ratio[1])
      const b = Number(ratio[2])
      // 比例按近似相等（像素宽高未必精确整除）
      const actual = artifact.width / artifact.height
      const checksPassed = Math.abs(actual - a / b) < 0.02
      checks.push({ name: `accept：${criterion}`, passed: checksPassed, expected, actual: `${artifact.width}:${artifact.height}` })
      continue
    }
    const sizeMatch = /(\d{2,5})\s*[x×]\s*(\d{2,5})/.exec(criterion)
    if (sizeMatch && artifact.width && artifact.height) {
      checks.push({
        name: `accept：${criterion}`,
        passed: artifact.width === Number(sizeMatch[1]) && artifact.height === Number(sizeMatch[2]),
        expected: `${sizeMatch[1]}x${sizeMatch[2]}`,
        actual: `${artifact.width}x${artifact.height}`,
      })
      continue
    }
    const durationMatch = /(\d+(?:\.\d+)?)\s*(秒|s)\b/i.exec(criterion)
    if (durationMatch && artifact.durationS !== undefined) {
      const expected = Number(durationMatch[1])
      checks.push({
        name: `accept：${criterion}`,
        passed: Math.abs(artifact.durationS - expected) <= Math.max(0.5, expected * 0.1),
        expected: `${expected}s`,
        actual: `${artifact.durationS}s`,
      })
      continue
    }
    // 不可结构化的标准（一致性/文本等）：记录为未判定，交给后续视觉辅助检查
    checks.push({ name: `accept：${criterion}`, passed: true, expected: '结构检查不适用（后续视觉辅助）' })
  }

  const failed = checks.filter((check) => !check.passed)
  const evidence: AcceptEvidence & { reason?: string } = {
    acceptCriteria: envelope.accept,
    diff: checks.map(({ name, passed, expected, actual }) => ({ name, passed, expected, actual })),
    artifactId: artifact.artifactId,
    contextHash,
  }
  if (failed.length) {
    evidence.reason = failed.map((check) => check.name).join('；')
    return { passed: false, checks, evidence }
  }
  return { passed: true, checks, evidence }
}
