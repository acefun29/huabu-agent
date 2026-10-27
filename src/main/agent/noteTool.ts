import { existsSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { Type } from 'typebox'
import { broadcastAssetChanged } from '../ipc/shared'
import type { ToolDefinitionLike } from './mediaTools'

/**
 * `create_note(title, content)` —— Agent 在画布上显式创建文本资产（markdown 卡片）。
 *
 * 画布拦截契约（与 chatRuntime 的钉卡规则配套）：
 * - 媒体文件（图片/视频/音频）落盘即被画布拦截成卡片；
 * - 文本类恰恰相反——Agent 工作中写的 author JSON、脚本、配置全是文本，
 *   「写了个文件就上画布」只会制造垃圾卡。文本要上画布必须经本工具显式
 *   声明"这是面向用户的产物"；write 落盘的文本永远只在磁盘上。
 *
 * 落点与用户手建笔记同一约定（libraryOps.createNote）：assets/documents/<标题>.md，
 * 重名自动加序号。钉卡由渲染端完成：execute 返回 details.published
 * （与 blockout 成片同一通道，chatRuntime 对任何带 published 的成功 tool_end 钉卡）。
 */

export interface NoteToolDeps {
  /** 当前工作区根目录（无工作区时工具返回指引文本而不是抛错） */
  currentDir: () => string | null
}

/** 标题净化后仍可能整串变空（纯符号标题），保底一个名字 */
const FALLBACK_TITLE = '未命名卡片'

export function assembleNoteTool(deps: NoteToolDeps): ToolDefinitionLike {
  return {
    name: 'create_note',
    label: '创建文本卡',
    description:
      '在用户画布上创建一张文本卡片（markdown），用于把面向用户的文本产物（文案、方案、摘要、设定等）作为卡片交付。' +
      '注意：用 write 写的文本文件只落盘、不会出现在画布上；要让用户在画布上看到文本内容必须用本工具。' +
      '非面向用户的中间文件（数据、脚本、配置、给后续工具读的文本）请继续用 write，不要用本工具。',
    parameters: Type.Object({
      title: Type.String({ description: '卡片标题（同时是文件名主名，会自动去除文件名非法字符）' }),
      content: Type.String({ description: '卡片正文（markdown）' })
    }),
    execute: async (_toolCallId, params) => {
      const fail = (message: string) => ({
        content: [{ type: 'text' as const, text: message }],
        details: { created: false }
      })

      const workspaceDir = deps.currentDir()
      if (!workspaceDir) {
        return fail('尚未打开工作区：文本卡片需要落进工作区 assets/documents/，请先让用户打开/选择一个工作区。')
      }

      const title =
        String((params as { title?: unknown })?.title ?? '')
          .trim()
          .replace(/[\\/:*?"<>|\s]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || FALLBACK_TITLE
      const content = String((params as { content?: unknown })?.content ?? '')
      if (!content.trim()) return fail('content 不能为空：卡片需要正文内容。')

      // 与手建笔记同款：时间戳主名天然错开不同轮次；同分钟同标题再撞时补序号
      const stamp = new Date().toISOString().slice(11, 16).replace(':', '')
      const dirAbs = join(workspaceDir, 'assets', 'documents')
      await mkdir(dirAbs, { recursive: true })
      let name = `${title}-${stamp}.md`
      for (let seq = 2; existsSync(join(dirAbs, name)); seq += 1) {
        name = `${title}-${stamp}-${seq}.md`
      }
      const absPath = join(dirAbs, name)

      // 临时文件 + rename：写一半的卡片不会以正式文件名被素材库/画布看到
      const tempPath = `${absPath}.part`
      await writeFile(tempPath, content, 'utf8')
      await rename(tempPath, absPath)
      broadcastAssetChanged()

      const relPath = `assets/documents/${name}`
      return {
        content: [
          {
            type: 'text',
            text: `文本卡片已创建并钉在用户画布上：${relPath}（标题「${title}」）。请基于真实创建结果回复用户。`
          }
        ],
        details: { created: true, published: { relPath, name, kind: 'doc' } }
      }
    }
  }
}
