import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { toMastraTools, type AdaptedToolOutput } from './tools'
import type { ToolDefinitionLike } from '../mediaTools'

/**
 * 工具桥（pi 形状 → Mastra tool）。
 *
 * 这条桥是两条运行时的接缝：所有业务工具都只认 pi 的 ToolDefinition 形状，由这里
 * 翻译成 Mastra 的 createTool。翻译错一处的后果是「模型看到的结果与真实不符」——
 * 尤其 isError：工具自己判定失败、但桥丢了标记，模型会把错误当成功继续往下做。
 */

function ctx() {
  const events: Array<{ type: string; toolName?: string; text?: string }> = []
  return {
    events,
    ctx: {
      nodeId: 'n1',
      broadcast: (event: { type: string; toolName?: string; text?: string }) => events.push(event),
      signal: undefined
    }
  }
}

function fakeTool(overrides: Partial<ToolDefinitionLike> & Pick<ToolDefinitionLike, 'name'>): ToolDefinitionLike {
  return {
    label: overrides.name,
    description: `${overrides.name} 说明`,
    parameters: Type.Object({ path: Type.String() }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...overrides
  } as ToolDefinitionLike
}

describe('toMastraTools', () => {
  it('按 name 建立索引，description 拼上 promptSnippet', () => {
    const { ctx: bridge } = ctx()
    const tools = toMastraTools(
      [fakeTool({ name: 'read', promptSnippet: '读文件' }), fakeTool({ name: 'ls' })],
      bridge
    )
    expect(Object.keys(tools)).toEqual(['read', 'ls'])
    expect(tools.read?.description).toBe('read 说明\n\n读文件')
    expect(tools.ls?.description).toBe('ls 说明')
  })

  it('文本结果透传为 text；details 一并带出', async () => {
    const { ctx: bridge } = ctx()
    const tools = toMastraTools(
      [fakeTool({ name: 'read', execute: async () => ({ content: [{ type: 'text', text: '正文' }], details: { bytes: 3 } }) })],
      bridge
    )
    const output = (await tools.read!.execute!({ path: 'a.txt' }, {})) as AdaptedToolOutput
    expect(output.text).toBe('正文')
    expect(output.details).toEqual({ bytes: 3 })
    expect(output.isError).toBeUndefined()
    expect(tools.read!.toModelOutput!(output)).toEqual({ type: 'text', value: '正文' })
  })

  it('工具自报的 isError 必须带到模型侧（否则错误会被当成成功）', async () => {
    const { ctx: bridge } = ctx()
    const tools = toMastraTools(
      [
        fakeTool({
          name: 'write',
          execute: async () => ({ content: [{ type: 'text', text: '路径越界' }], isError: true })
        })
      ],
      bridge
    )
    const output = (await tools.write!.execute!({ path: '../x' }, {})) as AdaptedToolOutput
    expect(output.isError).toBe(true)
    // 关键：toModelOutput 只有看到 isError 才输出 error-text
    expect(tools.write!.toModelOutput!(output)).toEqual({ type: 'error-text', value: '路径越界' })
  })

  it('抛异常的工具走 catch：文本带「工具执行失败」并标 isError', async () => {
    const { ctx: bridge } = ctx()
    const tools = toMastraTools(
      [
        fakeTool({
          name: 'boom',
          execute: async () => {
            throw new Error('磁盘满了')
          }
        })
      ],
      bridge
    )
    const output = (await tools.boom!.execute!({ path: 'a' }, {})) as AdaptedToolOutput
    expect(output.isError).toBe(true)
    expect(output.text).toContain('磁盘满了')
  })

  it('带图片的结果给 content/media（vision 通道），纯文本结果不给 images', async () => {
    const { ctx: bridge } = ctx()
    const tools = toMastraTools(
      [
        fakeTool({
          name: 'read_media',
          execute: async () => ({
            content: [
              { type: 'text', text: '已读取' },
              { type: 'image', data: 'BASE64', mimeType: 'image/png' }
            ]
          })
        })
      ],
      bridge
    )
    const output = (await tools.read_media!.execute!({ path: 'a.png' }, {})) as AdaptedToolOutput
    expect(output.images?.[0]).toMatchObject({ mimeType: 'image/png', data: 'BASE64' })
    const modelOutput = tools.read_media!.toModelOutput!(output) as { type: string; value: unknown[] }
    expect(modelOutput.type).toBe('content')
    expect(modelOutput.value).toHaveLength(2)
  })

  it('onUpdate 转成 tool_update 事件，长文本截断到 200 字', async () => {
    const { ctx: bridge, events } = ctx()
    const long = 'x'.repeat(500)
    const tools = toMastraTools(
      [
        fakeTool({
          name: 'generate_image',
          execute: async (_id: string, _params: unknown, _signal: AbortSignal | undefined, onUpdate: unknown) => {
            ;(onUpdate as (p: unknown) => void)({ content: [{ type: 'text', text: long }] })
            return { content: [{ type: 'text', text: 'done' }] }
          }
        })
      ],
      bridge
    )
    await tools.generate_image!.execute!({ path: 'a' }, { toolCallId: 'call-9' } as never)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tool_update', toolName: 'generate_image' })
    // 进度文本硬截到 200 字（不带省略号）：事件载荷只用于 UI 提示，不追求完整
    expect(events[0]?.text).toHaveLength(200)
  })
})
