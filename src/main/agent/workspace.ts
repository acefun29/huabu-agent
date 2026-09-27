import { existsSync, mkdirSync } from 'fs'
import { resolve, sep } from 'path'

/**
 * 会话 cwd 与会话文件路径校验。
 *
 * 概念模型（开发计划 2.1）：一个工作区 = 一张画布 + 一个磁盘目录，**目录即 Agent 的 cwd**。
 * 目录约定（开发计划 3.4）：
 *
 * ```
 * <工作区目录>/
 * ├── .huabu/
 * │   ├── canvas.json      # 画布布局（M5 扩展）
 * │   ├── workspace.json   # 工作区设置（M5 扩展）
 * │   └── sessions/        # Pi JSONL 会话文件
 * └── .pi/                 # M6 / M7
 * ```
 *
 * M5 扩展后不再有「默认工作区」：渲染端必须先打开工作区，主进程把当前工作区
 * 传进来做校验锚点。渲染进程即使被攻破，也不能把 Agent 的 cwd 指向工作区之外，
 * 或让会话重绑到别的目录的 JSONL 文件上。
 */

/** 会话 JSONL 落盘目录，与开发计划的目录约定一致 */
export function getSessionDir(cwd: string): string {
  return resolve(cwd, '.huabu', 'sessions')
}

export type CwdResolution = { ok: true; cwd: string } | { ok: false; error: string }

/**
 * 把渲染进程传来的 cwd 收敛成一个合法目录。
 *
 * 规则：
 * 1. 未传 → 当前工作区根（尚未打开工作区时拒绝，不静默落到任何默认目录）
 * 2. 传了 → 必须解析后仍位于当前工作区之内（含根本身），否则拒绝
 *
 * 越界一律拒绝，不做「悄悄纠正」—— 那会让用户以为 Agent 在 A 目录工作、
 * 实际却写在 B 目录，属于比报错更糟的失败模式。
 */
export function resolveSessionCwd(requested: string | undefined, currentDir: string | null): CwdResolution {
  if (!currentDir) {
    return { ok: false, error: '尚未打开工作区：请先选择工作区目录再创建会话' }
  }
  if (!requested || requested.trim() === '') {
    return { ok: true, cwd: currentDir }
  }

  const target = resolve(requested)
  if (target !== currentDir && !target.startsWith(currentDir + sep)) {
    return { ok: false, error: `cwd 越出当前工作区，已拒绝：${requested}` }
  }
  mkdirSync(target, { recursive: true })
  return { ok: true, cwd: target }
}

export type FileResolution = { ok: true; sessionFile: string } | { ok: false; error: string }

/**
 * 校验渲染端传来的会话文件路径（画布恢复时重绑历史会话）。
 * 必须位于当前工作区的 .huabu/sessions/ 内且真实存在 —— 防止借重绑读任意路径的文件。
 */
export function resolveSessionFile(requested: string, workspaceDir: string): FileResolution {
  const file = resolve(requested)
  const allowedDir = getSessionDir(workspaceDir)
  if (!file.startsWith(allowedDir + sep)) {
    return { ok: false, error: `会话文件越出工作区 sessions 目录，已拒绝：${requested}` }
  }
  if (!existsSync(file)) {
    return { ok: false, error: `会话文件不存在：${requested}` }
  }
  return { ok: true, sessionFile: file }
}
