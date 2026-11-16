import type { MediaProviderType } from '../../../shared/media'
import { submitRefs, type ProviderPollResult, type ProviderSubmitInput } from '../provider'
import { BaseGatewayProvider, buildModelRecord, type GatewayModelConfig } from './base'
import { prepareRefs } from './refImage'
import { registerAdapter, type AdapterDeps } from './registry'

// https://docs.bigmodel.cn/api-reference/模型-api/视频生成异步
const BASE = 'https://open.bigmodel.cn/api/paas/v4'
const IMAGE_PREFIX = 'zhipu-image|'
const LIMIT = 5 * 1024 * 1024

export class ZhipuMediaProvider extends BaseGatewayProvider<GatewayModelConfig> {
  readonly type: MediaProviderType = 'gateway-zhipu-media'
  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const remote = this.requestModelOf(model)
    if (!remote) this.noSuchModel(model)
    const video = this.kindOf(model) === 'video'
    const body: Record<string, unknown> = { model: remote, prompt: input.prompt }
    if (video) {
      const refs = await prepareRefs(submitRefs(input), { image: LIMIT })
      if (refs.skipped.length) throw new Error('智谱视频参考图片无法读取或超过 5MB')
      const first = refs.items.find((r) => r.role === 'first_frame')
      const last = refs.items.find((r) => r.role === 'last_frame')
      if (last && !first) throw new Error('智谱视频尾帧需要同时提供首帧')
      if (first) body.image_url = last ? [first.url, last.url] : first.url
      if (input.durationSeconds) body.duration = input.durationSeconds
      if (!first && input.ratio) {
        const sizes: Record<string, string> = { '1:1': '1024x1024', '9:16': '720x1280', '16:9': '1280x720' }
        if (sizes[input.ratio]) body.size = sizes[input.ratio]
      }
    } else {
      const sizes: Record<string, string> = { '1:1': '1280x1280', '3:4': '1088x1472', '4:3': '1472x1088', '9:16': '960x1728', '16:9': '1728x960' }
      if (input.ratio && sizes[input.ratio]) body.size = sizes[input.ratio]
    }
    const response = await fetch(`${BASE}/${video ? 'videos' : 'images'}/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(video ? 30_000 : 300_000)
    })
    if (!response.ok) throw this.httpErrorMessage(response, await response.text(), '智谱认证失败', '智谱媒体生成提交失败')
    const result = await response.json() as { id?: string; data?: { url?: string }[] }
    if (video && result.id) return result.id
    if (!video && result.data?.[0]?.url) return `${IMAGE_PREFIX}${result.data[0].url}`
    throw new Error('智谱响应缺少任务 ID 或图片地址')
  }
  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    if (jobId.startsWith(IMAGE_PREFIX)) return { status: 'succeeded', resultUrl: jobId.slice(IMAGE_PREFIX.length) }
    const key = await this.requireKey()
    const response = await fetch(`${BASE}/async-result/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw this.httpErrorMessage(response, await response.text(), '智谱认证失败', '智谱任务查询失败')
    const result = await response.json() as { task_status?: string; video_result?: { url?: string }[]; error?: { message?: string } }
    if (result.task_status === 'PROCESSING') return { status: 'running' }
    if (result.task_status === 'SUCCESS' && result.video_result?.[0]?.url) return { status: 'succeeded', resultUrl: result.video_result[0].url }
    return { status: 'failed', message: `智谱任务未成功：${result.error?.message ?? result.task_status ?? '未知状态或缺少结果'}` }
  }
}

registerAdapter('gateway-zhipu-media', (deps: AdapterDeps, config) => new ZhipuMediaProvider(
  { ...config, models: buildModelRecord<GatewayModelConfig>(config.models) },
  () => deps.resolveKey(config), 'ZHIPU_MEDIA_KEY', { id: 'zhipu-media', label: '智谱媒体' }
), {
  defaultAuthEnv: 'ZHIPU_MEDIA_KEY', supportedKinds: ['image', 'video'],
  refCaps: { byKind: { image: { delivery: 'data_uri', maxBytes: LIMIT }, video: { delivery: 'none' }, audio: { delivery: 'none' } } }
})
