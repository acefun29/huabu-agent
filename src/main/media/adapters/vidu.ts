import type { MediaProviderType } from '../../../shared/media'
import { submitRefs, type ProviderPollResult, type ProviderSubmitInput } from '../provider'
import { BaseGatewayProvider, buildModelRecord, type GatewayModelConfig } from './base'
import { prepareRefs } from './refImage'
import { registerAdapter, type AdapterDeps } from './registry'

// Vidu 国内开放平台：图片与视频均为异步任务。
// https://platform.vidu.cn/docs/api-reference/image-generation
// https://platform.vidu.cn/docs/api-reference/task-management/task-detail
const BASE = 'https://api.vidu.cn/ent/v2'
const IMAGE_LIMIT = 10 * 1024 * 1024

export class ViduProvider extends BaseGatewayProvider<GatewayModelConfig> {
  readonly type: MediaProviderType = 'gateway-vidu'

  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const remote = this.requestModelOf(model)
    if (!remote) this.noSuchModel(model)
    const supplied = submitRefs(input)
    const refs = await prepareRefs(supplied, { image: IMAGE_LIMIT })
    if (refs.skipped.length) throw new Error('Vidu 参考图片无法读取或超过大小限制')
    const images = refs.items.filter((ref) => ref.mediaType === 'image')
    const kind = this.kindOf(model)
    let endpoint = '/reference2image'
    if (kind === 'video') {
      endpoint = images.some((r) => r.role === 'reference_image') ? '/reference2video'
        : images.some((r) => r.role === 'last_frame') ? '/start-end2video'
          : images.length ? '/img2video' : '/text2video'
    }
    const ordered = endpoint === '/start-end2video'
      ? [images.find((r) => r.role === 'first_frame'), images.find((r) => r.role === 'last_frame')].filter((r) => r !== undefined)
      : images
    const body = {
      model: remote,
      prompt: input.prompt,
      ...(ordered.length ? { images: ordered.map((r) => r.url) } : {}),
      ...(input.ratio && (kind === 'image' || endpoint === '/text2video' || endpoint === '/reference2video') ? { aspect_ratio: input.ratio } : {}),
      ...(kind === 'video' && input.durationSeconds ? { duration: input.durationSeconds } : {})
    }
    const response = await fetch(`${BASE}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw this.httpErrorMessage(response, await response.text(), 'Vidu 认证失败', 'Vidu 提交失败')
    const data = await response.json() as { task_id?: string }
    if (!data.task_id) throw new Error('Vidu 响应缺少 task_id')
    return data.task_id
  }

  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    const key = await this.requireKey()
    const response = await fetch(`${BASE}/tasks/${encodeURIComponent(jobId)}/creations`, {
      headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw this.httpErrorMessage(response, await response.text(), 'Vidu 认证失败', 'Vidu 查询失败')
    const data = await response.json() as { state?: string; err_code?: string; creations?: { url?: string }[] }
    if (data.state === 'created' || data.state === 'queueing' || data.state === 'processing') return { status: 'running' }
    if (data.state === 'success' && data.creations?.[0]?.url) return { status: 'succeeded', resultUrl: data.creations[0].url }
    return { status: 'failed', message: `Vidu 任务失败：${data.err_code ?? data.state ?? '未知状态或缺少结果'}` }
  }
}

registerAdapter('gateway-vidu', (deps: AdapterDeps, config) => new ViduProvider(
  { ...config, models: buildModelRecord<GatewayModelConfig>(config.models) },
  () => deps.resolveKey(config), 'VIDU_KEY', { id: 'vidu', label: 'Vidu' }
), {
  defaultAuthEnv: 'VIDU_KEY', supportedKinds: ['image', 'video'],
  refCaps: { byKind: { image: { delivery: 'data_uri', maxBytes: IMAGE_LIMIT }, video: { delivery: 'none' }, audio: { delivery: 'none' } }, maxBodyBytes: 20 * 1024 * 1024 }
})
