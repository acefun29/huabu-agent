/**
 * 逐轮注入段的「自产稳定文本头」——三处同源的唯一常量（计划 T4 硬性要求）：
 *
 * 1. 渲染端 harness/prompt.ts    buildReferencePayload 生成 `[引用素材 · 共 N 项]`；
 * 2. 渲染端 contextCollector.ts  生成 `[素材库清单]` / `[画布态势]`；
 * 3. 主进程回放拆分（agent/history.ts）按这些头把用户消息切成「正文 / 本轮上下文」。
 *
 * 改任何一处头部文案必须改这里——否则历史回放的拆分会静默失效
 * （scripts/session-history-check.mjs 对这些头有断言，改头即红）。
 */

/** 引用素材载荷的头（后接 ` N 项]（仅传入绝对路径…）`，N 为可变数字） */
export const REFERENCE_PAYLOAD_HEADER_PREFIX = '[引用素材 · 共 '
export const REFERENCE_PAYLOAD_HEADER_SUFFIX = ' 项]'

/** 素材库清单摘要的头（contextCollector.buildLibraryDigest） */
export const LIBRARY_DIGEST_HEADER = '[素材库清单]'

/** 画布态势摘要的头（contextCollector.buildCanvasDigest） */
export const CANVAS_DIGEST_HEADER = '[画布态势]'

/** 全部注入段头的精确前缀（逐行行首匹配） */
export const INJECTION_HEADERS: readonly string[] = [LIBRARY_DIGEST_HEADER, CANVAS_DIGEST_HEADER]

/** 引用素材行 = 前缀 + 数字 + ' 项]'（计数可变，按前后缀匹配） */
export function isReferenceHeaderLine(line: string): boolean {
  if (!line.startsWith(REFERENCE_PAYLOAD_HEADER_PREFIX)) return false
  return /^\d+ 项\]/.test(line.slice(REFERENCE_PAYLOAD_HEADER_PREFIX.length))
}

/** 判断一行文本是否是注入段的起始行（常量头前缀，或带计数的引用素材头） */
export function isInjectionHeaderLine(line: string): boolean {
  return (
    INJECTION_HEADERS.some((header) => line.startsWith(header)) || isReferenceHeaderLine(line)
  )
}
