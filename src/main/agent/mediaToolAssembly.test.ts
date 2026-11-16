import { describe, expect, it } from 'vitest'
import { assembleMediaTools, laneOutputDir, type MediaAssemblyDeps } from './mediaToolAssembly'

/**
 * 媒体工具装配的任务写区（A02）。
 *
 * 真机症状：专家按默认库把图写到 `assets/images`，而任务 lane 是 `scenes/s3/`，
 * 编排器随后用 `isPathAllowed()` 判越界——**钱已经花了，产物却过不了验收**。
 * 这里断言的是 submit 拼装出的 `outputDir`，也就是真正决定落盘位置的那一个字段。
 */

function makeDeps(overrides: Partial<MediaAssemblyDeps> = {}): {
  deps: MediaAssemblyDeps
  submitted: Array<{ kind: string; outputDir?: string; sourceChatId?: string }>
} {
  const submitted: Array<{ kind: string; outputDir?: string; sourceChatId?: string }> = []
  // 媒体配置强制化后没有「供应商首个同类模型」兜底：必须显式给出 agentModels，
  // 否则 resolveAgentMedia 直接报可操作错误（测试要的是装配语义，不是错误路径）
  const mediaConfig = { agentProvider: 'prov', agentModels: { image: 'prov/img', video: 'prov/vid', audio: 'prov/aud' } }
  const deps: MediaAssemblyDeps = {
    store: {
      mediaConfig: () => mediaConfig,
      getLibraries: () => []
    },
    mediaManager: {
      submit: async (input) => {
        submitted.push({ kind: input.kind, ...(input.outputDir ? { outputDir: input.outputDir } : {}), sourceChatId: input.sourceChatId })
        return { jobId: 'job-1' }
      },
      waitForCompletion: async () =>
        ({
          jobId: 'job-1',
          kind: 'image',
          state: 'succeeded',
          progress: 1,
          prompt: 'p',
          provider: 'prov',
          model: 'prov/img',
          updatedAt: 't',
          // 真实 MediaArtifact 用 relPath（相对落盘目录）；这里必须给对的形状，
          // 否则产物路径换算会把 undefined 拼进路径而静默通过
          artifact: { relPath: 'x.png', name: 'x', mime: 'image/png', bytes: 1024 }
        }) as never
    },
    sessionModelSupportsImages: () => true,
    currentDir: () => '/ws',
    mediaContext: () => ({
      providers: [
        {
          id: 'prov',
          label: 'Prov',
          adapter: 'gateway-openai-compat',
          baseUrl: 'https://x/v1',
          apiKey: 'k',
          models: [
            { id: 'prov/img', kind: 'image', capabilities: { ratios: ['1:1', '16:9'], durations: [4] } }
          ]
        }
      ] as never,
      config: mediaConfig,
      mediaDir: null
    }),
    inboxRoot: () => '/inbox',
    ...overrides
  }
  return { deps, submitted }
}

async function runImageTool(deps: MediaAssemblyDeps): Promise<void> {
  const { mediaTools } = assembleMediaTools('node-1', deps)
  const imageTool = mediaTools.find((tool) => tool.name === 'generate_image')!
  await imageTool.execute('call-1', { prompt: 'x', ratio: '16:9' }, undefined, undefined, undefined)
}

describe('任务 lane → 媒体落盘目录（A02）', () => {
  it('laneOutputDir：取首条可用前缀并去掉首尾斜杠', () => {
    expect(laneOutputDir(['scenes/s3/'])).toBe('scenes/s3')
    expect(laneOutputDir(['./story/s1/'])).toBe('story/s1')
    // 绝对/盘符/穿越一律跳过（不回退成「相对化」的误解）
    expect(laneOutputDir(['/abs/path'])).toBeUndefined()
    expect(laneOutputDir(['../outside', 'C:/win', 'ok/dir'])).toBe('ok/dir')
    expect(laneOutputDir([])).toBeUndefined()
    expect(laneOutputDir(['   '])).toBeUndefined()
  })

  it('专家装配时 submit 的 outputDir 是任务 lane，而不是默认素材库', async () => {
    const { deps, submitted } = makeDeps({ outputDirFor: () => 'scenes/s3' })
    await runImageTool(deps)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.outputDir).toBe('scenes/s3')
  })

  it('没有写区时回退默认落库链（画布素材分类目录）', async () => {
    const { deps, submitted } = makeDeps()
    await runImageTool(deps)
    expect(submitted[0]?.outputDir).toBe('assets/images')
  })

  it('outputDirFor 返回 undefined 时同样回退默认链（不是不落库）', async () => {
    const { deps, submitted } = makeDeps({ outputDirFor: () => undefined })
    await runImageTool(deps)
    expect(submitted[0]?.outputDir).toBe('assets/images')
  })
})
