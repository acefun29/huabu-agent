/**
 * 工作区文件工具（`read` / `write` / `ls`）——Mastra 侧的会话工具面。
 *
 * ## 为什么需要这个文件
 *
 * 这两三件工具原先**只由 Pi 提供**（`host.ts` 的 `TOOL_ALLOWLIST = ['ls','read','write']`
 * 交给 pi 的内置工具集）。而 `shared/prompt.ts` 一直在教模型「文本/代码用 read 工具」
 * 「中间文件继续用 write」——Mastra 运行时没有这些工具，等于在教模型用一个不存在的东西。
 * 另外渲染端的「Agent 写的媒体文件自动上画布」（`pinWrittenFile`）也挂在 `write` 的
 * 工具事件上。所以全量去 pi 之前，这三件必须由我们自己提供。
 *
 * ## 安全边界（比 Pi 的内置工具更严）
 *
 * Pi 的内置工具按会话 cwd 工作；这里的每个路径都要过一遍守卫：
 * - 只接受**工作区内相对路径**：绝对路径 / 盘符 / UNC 一律拒绝（与 `validator.ts` 的
 *   产物路径守卫同一套判定，避免两处口径漂移）；
 * - `..` 穿越归一化后仍必须在工作区内；
 * - 解析出的真实路径再过一次 `realpath` 包含性检查，堵住符号链接逃逸；
 * - 读有上限（超限截断并说明）、写有上限、ls 有条目上限，避免一次调用把主进程拖住。
 *
 * ## 不做的事
 *
 * 不提供 `bash`/`edit`（与 Pi 侧的白名单一致：不给任意命令执行），也不做模糊搜索——
 * 需要递归查找时由调用方分次 `ls`。
 */

import { readFile, mkdir, readdir, realpath, stat, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { Type } from 'typebox'
import type { ToolDefinition } from './contracts'

export interface FileToolDeps {
  /** 工作区根（Agent 的 cwd）；返回 null = 尚未打开工作区 */
  currentDir: () => string | null
  /**
   * **写区**限制（专家 = 派单信封的 lane）。返回 null/省略 = 不限制。
   *
   * 只约束 `write`：专家的写区是它的 lane 前缀，越界写入会让两个专家抢同一份产物；
   * 读不受限（专家可能要读 lane 外的参考素材）。原先这条约束只能靠验收端事后检查
   * 声明路径——而声明和实际落盘是两件事，专家可以声明 lane 内的路径却把文件写到别处。
   */
  allowedPrefixes?: () => readonly string[] | null
}

/** 单次读取上限：超过就截断并明确告知，而不是让模型以为读完了 */
export const FILE_READ_MAX_BYTES = 256 * 1024
/** 单次写入上限：防一次工具调用把磁盘打满 */
export const FILE_WRITE_MAX_BYTES = 2 * 1024 * 1024
/** ls 单层条目上限 */
export const FILE_LS_MAX_ENTRIES = 200

const NO_WORKSPACE = '当前没有打开工作区，无法访问文件。'

/**
 * 把「工作区相对路径」解析成工作区内的绝对路径；越界返回 null。
 *
 * 判定与 `superagent/validator.ts` 的产物路径守卫同源（拒绝绝对路径、拒绝 `..` 穿越）。
 * 真实路径（符号链接）的包含性检查在 `assertRealPathInside` 里另做——那是异步 IO，
 * 不能塞进这个同步纯函数。
 */
export function resolveInWorkspace(workspaceDir: string, relPath: string): string | null {
  const raw = relPath.replace(/\\/g, '/').trim()
  if (!raw) return null
  if (raw.startsWith('/') || raw.startsWith('//') || /^[a-zA-Z]:\//.test(raw)) return null
  const base = resolve(workspaceDir)
  const abs = resolve(base, raw)
  if (abs !== base && !abs.startsWith(base + sep)) return null
  return abs
}

/**
 * 符号链接逃逸检查：解析真实路径后必须仍在工作区内。
 * 返回 null = 越界（调用方按「路径越界」报错）。
 */
async function realPathInside(workspaceDir: string, absPath: string): Promise<string | null> {
  try {
    const real = await realpath(absPath)
    const base = await realpath(resolve(workspaceDir))
    if (real !== base && !real.startsWith(base + sep)) return null
    return real
  } catch {
    // 文件还不存在（write 新建）：路径本身已通过同步守卫，交给后续 IO 决定成败
    return absPath
  }
}

function ok(text: string, details: Record<string, unknown> = {}): {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
} {
  return { content: [{ type: 'text', text }], details }
}

function fail(text: string, details: Record<string, unknown> = {}): {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
  isError: true
} {
  return { content: [{ type: 'text', text }], details, isError: true }
}

/** 相对工作区的可读路径（报错信息里用它，避免把本机绝对路径写进上下文） */
function displayPath(workspaceDir: string, absPath: string): string {
  const base = resolve(workspaceDir)
  return absPath.startsWith(base + sep) ? absPath.slice(base.length + 1).replace(/\\/g, '/') : absPath
}

/**
 * 路径是否落在允许的写区前缀内（专家 lane 约束）。
 *
 * 前缀按目录边界比较：`story/s1/` 命中 `story/s1/x.md`，不命中 `story/s10/x.md`。
 * 只用于 `write`——读不受限。
 */
export function withinWriteLane(relPath: string, prefixes: readonly string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  return prefixes.some((raw) => {
    const prefix = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!prefix) return true
    return normalized === prefix || normalized.startsWith(`${prefix}/`)
  })
}

export function createFileTools(deps: FileToolDeps): ToolDefinition[] {
  const read: ToolDefinition = {
    name: 'read',
    label: '读取文件',
    description:
      '读取工作区内一个文本文件的内容。只接受工作区相对路径（如 `scenes/s3/shot1.json`）。' +
      '超过 256KB 会截断并标注；二进制文件（图片/视频）请用 read_media / skim_video，不要用本工具。',
    parameters: Type.Object({
      path: Type.String({ description: '工作区相对路径' })
    }),
    execute: async (_toolCallId, params) => {
      const root = deps.currentDir()
      if (!root) return fail(NO_WORKSPACE)
      const rel = String((params as { path?: unknown })?.path ?? '')
      const abs = resolveInWorkspace(root, rel)
      if (!abs) return fail(`路径不合法或越出工作区：${rel}`)
      const real = await realPathInside(root, abs)
      if (!real) return fail(`路径越出工作区（符号链接指向外部）：${rel}`)
      try {
        const info = await stat(real)
        if (!info.isFile()) return fail(`不是普通文件：${rel}`)
        const buf = await readFile(real)
        // 含 NUL 字节按二进制处理：把二进制当文本塞进上下文既浪费 token 又会误导模型
        if (buf.subarray(0, 8192).includes(0)) {
          return fail(`${rel} 看起来是二进制文件；图片/视频请用 read_media / skim_video 读取。`)
        }
        const truncated = buf.byteLength > FILE_READ_MAX_BYTES
        const text = buf.subarray(0, FILE_READ_MAX_BYTES).toString('utf8')
        return ok(
          truncated
            ? `${text}\n\n…（文件共 ${buf.byteLength} 字节，只读取了前 ${FILE_READ_MAX_BYTES} 字节）`
            : text,
          { path: displayPath(root, real), bytes: buf.byteLength, truncated }
        )
      } catch (error) {
        return fail(`读取失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * 局部替换（施工计划 §5 点名的 `patch`）。
   *
   * 为什么需要它：`studio.md` 每轮注入、是有上限的常驻记忆，改一行用 `write` 就得整篇
   * 重新输出——既费 token，又有模型抄漏原文的风险。`patch` 只要求给出改动的那一段。
   *
   * 为什么要求 oldText 唯一命中：命中多处时「改哪一处」是歧义，猜错就是静默改坏别的地方。
   * 宁可报错让模型补足上下文，也不做模糊匹配。
   */
  const patch: ToolDefinition = {
    name: 'patch',
    label: '局部修改文件',
    description:
      '在一个已有文本文件里做一次精确替换：把 oldText 换成 newText。只接受工作区相对路径。\n' +
      'oldText 必须**恰好出现一次**（多一处或少一处都会报错，并告诉你当前命中几次）——所以要把\n' +
      '能让它唯一定位的那几行一起带上。改记忆文件（.huabu/memory/*.md）就用它，不要用 write 整篇覆盖。',
    parameters: Type.Object({
      path: Type.String({ description: '工作区相对路径' }),
      oldText: Type.String({ description: '要被替换的原文，必须与文件内容逐字符一致且只出现一次' }),
      newText: Type.String({ description: '替换成的新文本；传空串表示删除这段' })
    }),
    execute: async (_toolCallId, params) => {
      const root = deps.currentDir()
      if (!root) return fail(NO_WORKSPACE)
      const input = params as { path?: unknown; oldText?: unknown; newText?: unknown }
      const rel = String(input?.path ?? '')
      const oldText = typeof input?.oldText === 'string' ? input.oldText : ''
      const newText = typeof input?.newText === 'string' ? input.newText : ''
      if (!oldText) return fail('oldText 不能为空。要整篇覆盖请用 write，要新建文件也用 write。')
      const abs = resolveInWorkspace(root, rel)
      if (!abs) return fail(`路径不合法或越出工作区：${rel}`)
      const lanes = deps.allowedPrefixes?.() ?? null
      if (lanes && !withinWriteLane(rel, lanes)) {
        return fail(`写入越出本任务的写区：${rel}（允许：${lanes.join('、')}）`)
      }
      const real = await realPathInside(root, abs)
      if (!real) return fail(`路径越出工作区（符号链接指向外部）：${rel}`)

      let previous: string
      try {
        previous = await readFile(real, 'utf8')
      } catch {
        return fail(`文件不存在或读不了：${rel}。新建文件请用 write。`)
      }
      const first = previous.indexOf(oldText)
      if (first < 0) return fail(`文件里找不到这段原文（${rel}）。请先 read 确认实际内容。`)
      const second = previous.indexOf(oldText, first + 1)
      if (second >= 0) {
        return fail(
          `这段原文在 ${rel} 里出现了多次，无法确定改哪一处。请多带几行让它唯一。`
        )
      }

      const next = previous.slice(0, first) + newText + previous.slice(first + oldText.length)
      const bytes = Buffer.byteLength(next, 'utf8')
      if (bytes > FILE_WRITE_MAX_BYTES) {
        return fail(`改完过大：${bytes} 字节，单文件上限 ${FILE_WRITE_MAX_BYTES} 字节`)
      }
      try {
        await writeFile(real, next, 'utf8')
        return ok(
          `已修改 ${displayPath(root, real)}（第 ${previous.slice(0, first).split('\n').length} 行附近，${bytes} 字节）`,
          { path: displayPath(root, real), bytes }
        )
      } catch (error) {
        return fail(`写入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const write: ToolDefinition = {
    name: 'write',
    label: '写入文件',
    description:
      '把一个文本文件写入工作区（父目录会自动创建，已存在则覆盖）。只接受工作区相对路径。' +
      '写入的媒体文件（图片/视频/音频）会自动回到用户画布；文本文件只落盘，' +
      '要把文本作为画布卡片交付请用 create_note。',
    parameters: Type.Object({
      path: Type.String({ description: '工作区相对路径' }),
      content: Type.String({ description: '要写入的完整文本（不是增量）' })
    }),
    execute: async (_toolCallId, params) => {
      const root = deps.currentDir()
      if (!root) return fail(NO_WORKSPACE)
      const input = params as { path?: unknown; content?: unknown }
      const rel = String(input?.path ?? '')
      const content = typeof input?.content === 'string' ? input.content : ''
      const abs = resolveInWorkspace(root, rel)
      if (!abs) return fail(`路径不合法或越出工作区：${rel}`)
      // 写区（专家 lane）：越界直接拒，不靠验收端事后发现
      const lanes = deps.allowedPrefixes?.() ?? null
      if (lanes && !withinWriteLane(rel, lanes)) {
        return fail(`写入越出本任务的写区：${rel}（允许：${lanes.join('、')}）`)
      }
      const real = await realPathInside(root, abs)
      if (!real) return fail(`路径越出工作区（符号链接指向外部）：${rel}`)
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > FILE_WRITE_MAX_BYTES) {
        return fail(`内容过大：${bytes} 字节，单次写入上限 ${FILE_WRITE_MAX_BYTES} 字节`)
      }
      try {
        await mkdir(dirname(real), { recursive: true })
        await writeFile(real, content, 'utf8')
        return ok(`已写入 ${displayPath(root, real)}（${bytes} 字节）`, {
          path: displayPath(root, real),
          bytes
        })
      } catch (error) {
        return fail(`写入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const ls: ToolDefinition = {
    name: 'ls',
    label: '列出目录',
    description:
      '列出工作区内某一层目录的条目（目录以 `/` 结尾并标 `dir`，文件带字节数）。' +
      '不递归；需要看下一层就对目录再调一次。',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: '工作区相对路径，缺省 = 工作区根' }))
    }),
    execute: async (_toolCallId, params) => {
      const root = deps.currentDir()
      if (!root) return fail(NO_WORKSPACE)
      const rel = String((params as { path?: unknown })?.path ?? '').trim()
      const abs = rel ? resolveInWorkspace(root, rel) : resolve(root)
      if (!abs) return fail(`路径不合法或越出工作区：${rel}`)
      const real = await realPathInside(root, abs)
      if (!real) return fail(`路径越出工作区（符号链接指向外部）：${rel}`)
      try {
        const info = await stat(real)
        if (!info.isDirectory()) return fail(`不是目录：${rel}`)
        const entries = await readdir(real, { withFileTypes: true })
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        const shown = entries.slice(0, FILE_LS_MAX_ENTRIES)
        const lines = shown.map((entry) => {
          if (entry.isDirectory()) return `${entry.name}/`
          return entry.name
        })
        // 文件带字节数需要额外 stat；条目多时逐条 stat 的代价可接受（有上限），
        // 但只对文件做，目录名后面已用 `/` 标出类型
        const detail: string[] = []
        for (let i = 0; i < shown.length; i += 1) {
          const entry = shown[i]
          if (!entry || entry.isDirectory()) continue
          try {
            const s = await stat(join(real, entry.name))
            detail.push(`${entry.name} (${s.size} 字节)`)
            lines[i] = detail[detail.length - 1]!
          } catch {
            /* 单个条目读不到：保留裸名字 */
          }
        }
        const header = `[${displayPath(root, real) || '.'}] ${entries.length} 个条目`
        const rest = entries.length - shown.length
        return ok(
          [header, ...lines, ...(rest > 0 ? [`…（另有 ${rest} 个未列出）`] : [])].join('\n'),
          { path: displayPath(root, real), count: entries.length }
        )
      } catch (error) {
        return fail(`列目录失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return [ls, read, write, patch]
}
