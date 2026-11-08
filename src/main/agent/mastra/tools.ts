/**
 * Pi 工具定义 → Mastra createTool 适配层（Mastra 迁移计划 v1.2 §10/§11.5）。
 *
 * 现有工具（read_media / generate_* / skim_video / read_video_frames / create_note）
 * 的 execute 全部框架无关（pi 依赖仅 type-only，onUpdate 可选），本层零复制复用：
 * - inputSchema：TypeBox 产物即 JSON Schema，直传（Mastra PublicSchema 接受 JSON Schema，
 *   spike 已验证）；参数级 description 随 schema 原样保留。
 * - description：pi 的顶层 description + promptSnippet（给模型的行为指令）拼接。
 * - onUpdate：桥接为现有 ChatEvent `tool_update`（进度文本经 broadcast 直发，不经 Mastra）。
 * - 返回：pi AgentToolResult {content:[text|image], details} → 模型友好的
 *   {text, images 元数据, details}。图片 bytes 首版不进模型（vision 通道为
 *   Phase 0 遗留 #5，read_media 在 supportsImageInput=false 时本就只回元数据）；
 *   details 原样保留——renderer 的 tool_end 钉卡契约（blockout 成片/create_note 文本卡）不变。
 * - 失败：pi 语义是 throw；这里捕获转成 isError 结果文本（Agent 据此引导用户，流不炸）。
 */

import { createTool } from '@mastra/core/tools'
import type { ToolDefinitionLike } from '../mediaTools'
import type { ChatEvent } from '../../../shared/ipc'

export interface ToolBridgeContext {
  nodeId: string
  broadcast(event: ChatEvent): void
  /** 会话级取消（abort 会话时工具内的等待链路一并终止） */
  signal: AbortSignal | undefined
}

/** pi onUpdate 的 partial 结果（AgentToolResult 子集） */
interface PiPartialResult {
  content?: Array<{ type: string; text?: string }>
}

/** 适配后的工具输出形状（进模型 + 事件层共用） */
export interface AdaptedToolOutput {
  text: string
  isError?: boolean
  /**
   * 图片 part（vision 通道）：base64 原样给模型（V2 tool-result content/media），
   * 事件层只用 mimeType/bytes 元数据——bytes 绝不进 ChatEvent（计划 §10.2）。
   */
  images?: Array<{ mimeType: string; bytes: number; data?: string }>
  details?: unknown
}

export function toMastraTools(
  piTools: readonly ToolDefinitionLike[],
  ctx: ToolBridgeContext
): Record<string, ReturnType<typeof createTool>> {
  const tools: Record<string, ReturnType<typeof createTool>> = {}
  for (const tool of piTools) {
    tools[tool.name] = toMastraTool(tool, ctx)
  }
  return tools
}

function toMastraTool(tool: ToolDefinitionLike, ctx: ToolBridgeContext) {
  const description = [tool.description, tool.promptSnippet].filter(Boolean).join('\n\n')
  return createTool({
    id: tool.name,
    description: description || tool.label || tool.name,
    inputSchema: tool.parameters as Record<string, unknown>,
    /**
     * 工具结果 → 模型消息形状（vision 通道）：
     * 带图片时给 V2 tool-result 的 content/media（图片 base64 进模型），
     * 纯文本时给 text output（与原行为一致，含 isError 前缀）。
     */
    toModelOutput: (output: unknown) => {
      const out = output as AdaptedToolOutput | undefined
      const images = (out?.images ?? []).filter((img) => img.data)
      if (!images.length) {
        return out?.isError ? { type: 'error-text', value: out.text } : { type: 'text', value: out?.text ?? '' }
      }
      const value: Array<{ type: 'text'; text: string } | { type: 'media'; data: string; mediaType: string }> = [
        { type: 'text', text: out?.text ?? '' },
      ]
      for (const img of images) {
        value.push({ type: 'media', data: img.data!, mediaType: img.mimeType })
      }
      return { type: 'content', value }
    },
    // Mastra 1.82 的 execute 形状：(inputData=校验后的输入, context=执行上下文[toolCallId 等])
    execute: async (inputData: unknown, execContext: unknown) => {
      const params = inputData
      const exec = (execContext ?? {}) as { toolCallId?: string; abortSignal?: AbortSignal }
      const toolCallId = exec.toolCallId ?? `${tool.name}-${Date.now().toString(36)}`
      const onUpdate = (partial: PiPartialResult | undefined) => {
        const text = (partial?.content ?? [])
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join('')
        if (text) {
          ctx.broadcast({
            nodeId: ctx.nodeId,
            type: 'tool_update',
            toolCallId,
            toolName: tool.name,
            text: text.length > 200 ? text.slice(0, 200) : text,
          })
        }
      }
      try {
        const result = (await tool.execute(
          toolCallId,
          params as never,
          exec.abortSignal ?? ctx.signal,
          onUpdate as never,
          undefined as never
        )) as {
          content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
          details?: unknown
        } | undefined
        const texts: string[] = []
        const images: Array<{ mimeType: string; bytes: number; data?: string }> = []
        for (const block of result?.content ?? []) {
          if (block.type === 'text' && block.text) texts.push(block.text)
          else if (block.type === 'image' && block.data) {
            images.push({
              mimeType: block.mimeType ?? 'image/png',
              bytes: block.data.length,
              data: block.data,
            })
          }
        }
        const output: AdaptedToolOutput = {
          text: texts.join('\n') || '(无文本输出)',
          ...(images.length ? { images } : {}),
          ...(result?.details !== undefined ? { details: result.details } : {}),
        }
        return output
      } catch (error) {
        // pi 的错误语义：失败信息进结果文本回给模型（Agent 据此引导用户配置/重试）
        const message = error instanceof Error ? error.message : String(error)
        const output: AdaptedToolOutput = { text: `工具执行失败：${message}`, isError: true }
        return output
      }
    },
  })
}
