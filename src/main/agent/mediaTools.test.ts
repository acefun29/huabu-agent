import { describe, expect, it } from 'vitest'
import { createMediaTools } from './mediaTools'
import type { MediaJobStatus } from '../../shared/media'
import { MEDIA_ROOT_REL } from '../../shared/assets'
import type { MediaToolContext } from './mediaTools'

/**
 * 媒体工具 → 结构化回执的接缝（A02 / 施工计划第 4 步）。
 *
 * 之前这个路径的换算写在工具里（`outputDir ?? artifactDirRel` + relPath），
 * 现在收口到 `tools/produce.ts` 的 `artifactPathOf`。这里断言工具**真的走了那条路**：
 * details.artifactPath 必须是工作区相对路径，而不是裸 relPath。
 */

/** 一个成功态媒体任务的最小形状 */
function succeededJob(overrides: Partial<MediaJobStatus> = {}): MediaJobStatus {
  return {
    jobId: 'job-1',
    provider: 'stub',
    model: 'stub-1',
    kind: 'image',
    prompt: '一只猫',
    state: 'succeeded',
    progress: 1,
    createdAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T10:00:10.000Z',
    artifact: { relPath: 'cat.png', name: 'cat', mime: 'image/png', bytes: 4096 },
    ...overrides
  }
}

function contextOf(job: MediaJobStatus): MediaToolContext {
  return {
    submit: async () => job,
    // 不附带图片：本用例只关心路径换算
    supportsImageInput: () => false,
    capabilities: () => undefined,
    resolveModel: () => undefined,
    confirmVideo: () => false,
    requestApproval: async () => true
  } as unknown as MediaToolContext
}

/** 取 image 工具并执行一次，返回 details */
async function runImageTool(job: MediaJobStatus): Promise<Record<string, unknown>> {
  const tools = createMediaTools(contextOf(job))
  const tool = tools.find((entry) => entry.name === 'generate_image') ?? tools[0]!
  const result = await tool.execute(
    'call-1',
    { prompt: '一只猫', confirmed: true },
    undefined,
    undefined,
    {}
  )
  return (result.details ?? {}) as Record<string, unknown>
}

describe('媒体工具的产物路径回执', () => {
  it('有 artifactDirRel：details.artifactPath 是工作区相对路径', async () => {
    const details = await runImageTool(succeededJob({ artifactDirRel: 'assets/visual' }))
    expect(details.artifactPath).toBe('assets/visual/cat.png')
    // 原始信息仍然保留，供下游还原落盘根
    expect(details.artifactDirRel).toBe('assets/visual')
    expect((details.artifact as { relPath: string }).relPath).toBe('cat.png')
  })

  it('outputDir 优先于 artifactDirRel', async () => {
    const details = await runImageTool(
      succeededJob({ outputDir: 'assets/visual', artifactDirRel: MEDIA_ROOT_REL })
    )
    expect(details.artifactPath).toBe('assets/visual/cat.png')
  })

  it('没有落盘目录：就是 relPath', async () => {
    const details = await runImageTool(succeededJob())
    expect(details.artifactPath).toBe('cat.png')
  })

  it('落盘目录非法（越界）时抛错——换算收口到 produce.ts 才有的行为', async () => {
    // 旧的工具内联拼法会原样返回 `../outside/cat.png`；收口后这里必须拒绝，
    // 否则一条越界产物会被当成合法回执传给编排层。
    await expect(runImageTool(succeededJob({ artifactDirRel: '../outside' }))).rejects.toThrow()
  })
})
