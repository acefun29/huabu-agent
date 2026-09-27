import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

/**
 * 原子写：同目录临时文件 + rename。本模块只依赖 fs/path，不引入 electron，
 * 主进程任意域（workspace / media / assets / credentials）都可复用。
 *
 * 强杀进程也不会留下半写的 JSON（rename 在同一卷上是原子替换）。
 * Windows 特例：目标文件被其他进程占用时 rename 会失败（EBUSY/EPERM）。
 * 此时先把旧文件挪成 .bak 腾位（占用句柄通常仍允许改名），再落新文件——
 * 绝不先 rm 旧文件：rm 与 rename 之间崩溃会把原文件彻底丢掉（而不是退回旧版）。
 * 若旧文件也挪不动，保持原样抛错，调用方的数据完好。
 */
export function atomicWriteSync(target: string, content: string): void {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(target)}.${process.pid}.tmp`)
  writeFileSync(tmp, content, 'utf8')
  try {
    try {
      renameSync(tmp, target)
    } catch (error) {
      const bak = `${target}.bak`
      try {
        renameSync(target, bak)
      } catch {
        throw error // 旧文件挪不动：原文件保持原样，抛原始错误
      }
      renameSync(tmp, target)
      rmSync(bak, { force: true })
    }
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
  }
}

/**
 * 启动恢复：崩溃若停在「旧文件已挪成 .bak、新文件未落位」之间，把旧版还原回去。
 * 在各持久化文件（workspace.json / jobs.json / tags.json 等）首次读取前调用。
 */
export function recoverAtomicBackup(target: string): void {
  const bak = `${target}.bak`
  if (!existsSync(bak)) return
  if (existsSync(target)) {
    rmSync(bak, { force: true }) // 新文件已落位，.bak 只是上次成功的残留
  } else {
    renameSync(bak, target)
  }
}
