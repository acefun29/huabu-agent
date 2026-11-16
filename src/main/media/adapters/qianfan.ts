import type { MediaProviderType } from '../../../shared/media'
import { submitRefs, type ProviderPollResult, type ProviderSubmitInput } from '../provider'
import { BaseGatewayProvider, buildModelRecord, type GatewayModelConfig } from './base'
import { prepareRefs } from './refImage'
import { registerAdapter, type AdapterDeps } from './registry'

// https://cloud.baidu.com/doc/qianfan-api/s/7mwbl44jo
// https://cloud.baidu.com/doc/qianfan-api/s/zmwbl4cg1
// https://cloud.baidu.com/doc/qianfan-api/s/dmwbl4ce3
const BASE = 'https://qianfan.baidubce.com'
const IMAGE_PREFIX = 'qianfan-image|'
const IMAGE_LIMIT = 10 * 1024 * 1024

export class QianfanProvider extends BaseGatewayProvider<GatewayModelConfig> {
  readonly type: MediaProviderType = 'gateway-qianfan'

  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const remote = this.requestModelOf(model)
    if (!remote) this.noSuchModel(model)
    const isVideo = this.kindOf(model) === 'video'
    let body: Record<string, unknown>
    if (isVideo) {
      const refs = await prepareRefs(submitRefs(input), { image: IMAGE_LIMIT })
      const image = refs.items.find((ref) => ref.role === 'first_frame')
      if (refs.skipped.length || !image) throw new Error('百度蒸汽机图生视频需要一张可读取的首帧图片（不超过 10MB）')
      body = { model: remote, content: [{ type: 'text', text: input.prompt }, { type: 'image_url', image_url: { url: image.url } }],
        ...(input.durationSeconds ? { duration: input.durationSeconds } : {}) }
    } else {
      const sizes: Record<string, string> = { '1:1': '1024x1024', '3:4': '864x1152', '4:3': '1152x864', '9:16': '720x1280', '16:9': '1280x720' }
      body = { model: remote, prompt: input.prompt, response_format: 'url', ...(input.ratio && sizes[input.ratio] ? { size: sizes[input.ratio] } : {}) }
    }
    const response = await fetch(`${BASE}${isVideo ? '/video/generations' : '/v2/musesteamer/images/generations'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(isVideo ? 30_000 : 300_000)
    })
    if (!response.ok) throw this.httpErrorMessage(response, await response.text(), '百度千帆认证失败', '百度千帆提交失败')
    const data = await response.json() as { task_id?: string; data?: { url?: string }[] }
    if (isVideo && data.task_id) return data.task_id
    if (!isVideo && data.data?.[0]?.url) return `${IMAGE_PREFIX}${data.data[0].url}`
    throw new Error('百度千帆响应缺少任务 ID 或图片地址')
  }

  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    if (jobId.startsWith(IMAGE_PREFIX)) return { status: 'succeeded', resultUrl: jobId.slice(IMAGE_PREFIX.length) }
    const key = await this.requireKey()
    const response = await fetch(`${BASE}/video/generations?task_id=${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw this.httpErrorMessage(response, await response.text(), '百度千帆认证失败', '百度千帆任务查询失败')
    const data = await response.json() as { status?: string; content?: { video_url?: string }; duration?: number; error?: { message?: string } }
    if (data.status === 'pending' || data.status === 'queued' || data.status === 'running') return { status: 'running' }
    if (data.status === 'succeeded' && data.content?.video_url) return { status: 'succeeded', resultUrl: data.content.video_url, durationSeconds: data.duration }
    return { status: 'failed', message: `百度千帆任务失败：${data.error?.message ?? data.status ?? '未知状态或缺少结果'}` }
  }
}

registerAdapter('gateway-qianfan', (deps: AdapterDeps, config) => new QianfanProvider(
  { ...config, models: buildModelRecord<GatewayModelConfig>(config.models) },
  () => deps.resolveKey(config), 'QIANFAN_KEY', { id: 'qianfan', label: '百度千帆' }
), {
  defaultAuthEnv: 'QIANFAN_KEY', supportedKinds: ['image', 'video'],
  refCaps: { byKind: { image: { delivery: 'data_uri', maxBytes: IMAGE_LIMIT }, video: { delivery: 'none' }, audio: { delivery: 'none' } } }
})
