import type { MediaProviderType } from '../../../shared/media'
import { submitRefs, type ProviderPollResult, type ProviderSubmitInput } from '../provider'
import { BaseGatewayProvider, buildModelRecord, type GatewayModelConfig } from './base'
import { prepareRefs } from './refImage'
import { registerAdapter, type AdapterDeps } from './registry'

// https://cloud.tencent.com/document/product/1823/135745
// https://cloud.tencent.com/document/product/1823/135742
const BASE = 'https://tokenhub.tencentmaas.com/v1/wand'
const IMAGE_PREFIX = 'tokenhub-image|'
const VEGA_PREFIX = 'tokenhub-vega|'
const PIXVERSE_PREFIX = 'tokenhub-pixverse|'
const LIMIT = 20 * 1024 * 1024

export class TokenHubProvider extends BaseGatewayProvider<GatewayModelConfig> {
  readonly type: MediaProviderType = 'gateway-tokenhub'
  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const remote = this.requestModelOf(model)
    if (!remote) this.noSuchModel(model)
    const refs = await prepareRefs(submitRefs(input), { image: LIMIT })
    if (refs.skipped.length) throw new Error('TokenHub 参考图片无法读取或超过 20MB')
    const image = this.kindOf(model) === 'image'
    const vega = image && remote.startsWith('wand-vega-image-')
    const pixverse = remote.startsWith('pixverse-video-')
    const first = refs.items.find((r) => r.role === 'first_frame')
    const last = refs.items.find((r) => r.role === 'last_frame')
    const referenceImages = refs.items.filter((r) => r.role === 'reference_image')
    const pixEndpoint = referenceImages.length ? '/pixverse/reference-to-video' : last ? '/pixverse/start-end-to-video' : first ? '/pixverse/image-to-video' : '/pixverse/text-to-video'
    const endpoint = vega ? '/vega-images/generations' : image ? '/hunyuan-image/v35-generation' : pixverse ? pixEndpoint : first ? '/kling/image-to-video' : '/kling/text-to-video'
    let body: Record<string, unknown>
    if (pixverse) {
      body = { model: remote, prompt: input.prompt, duration: input.durationSeconds ?? 5, quality: '720p',
        ...(first && last ? { first_frame_img: first.url, last_frame_img: last.url } : first ? { img_id: first.url } : {}),
        ...(referenceImages.length ? { image_references: referenceImages.map((ref) => ({ img_id: ref.url, type: 'subject' })) } : {}),
        ...(!first && input.ratio ? { aspect_ratio: input.ratio } : {}) }
    } else if (vega) {
      body = { model: remote, prompt: input.prompt,
        ...(refs.items.length ? { input: [{ content: refs.items.map((ref) => ({ type: 'input_image', image_url: ref.url })) }] } : {}),
        ...(input.width && input.height ? { size: `${input.width}x${input.height}` } : {}) }
    } else if (image) {
      body = { model: remote, messages: [{ role: 'user', content: [
        { type: 'text', text: input.prompt },
        ...refs.items.map((ref) => ({ type: 'image_url', image_url: { url: ref.url } }))
      ] }], ...(input.width && input.height ? { size: `${input.width}x${input.height}` } : {}) }
    } else {
      const settings = { ...(input.durationSeconds ? { duration: input.durationSeconds } : {}),
        ...(!first && input.ratio ? { aspect_ratio: input.ratio } : {}) }
      body = first ? { model: remote, contents: [{ type: 'prompt', text: input.prompt },
        { type: 'first_frame', url: first.url }, ...(last ? [{ type: 'last_frame', url: last.url }] : [])], settings }
        : { model: remote, prompt: input.prompt, settings }
    }
    const response = await fetch(`${BASE}${endpoint}`, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(image ? 300_000 : 30_000) })
    if (!response.ok) throw this.httpErrorMessage(response, await response.text(), 'TokenHub 认证失败', 'TokenHub 提交失败')
    const data = await response.json() as { code?: number; message?: string; task_id?: string; data?: { id?: string }; choices?: { delta?: { image?: { url?: string } } }[]; error?: { message?: string }; ErrCode?: number; ErrMsg?: string; Resp?: { video_id?: string } }
    if (pixverse && data.ErrCode === 0 && data.Resp?.video_id) return `${PIXVERSE_PREFIX}${data.Resp.video_id}`
    if (pixverse) throw new Error(`TokenHub PixVerse 提交失败：${data.ErrMsg ?? '缺少任务 ID'}`)
    if (vega && data.task_id) return `${VEGA_PREFIX}${data.task_id}`
    if (image && data.choices?.[0]?.delta?.image?.url) return `${IMAGE_PREFIX}${data.choices[0].delta.image.url}`
    if (!image && data.code === 0 && data.data?.id) return data.data.id
    throw new Error(`TokenHub 响应缺少任务或图片：${data.error?.message ?? data.message ?? '未知错误'}`)
  }
  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    if (jobId.startsWith(IMAGE_PREFIX)) return { status: 'succeeded', resultUrl: jobId.slice(IMAGE_PREFIX.length) }
    const key = await this.requireKey()
    if (jobId.startsWith(PIXVERSE_PREFIX)) {
      const response = await fetch(`${BASE}/pixverse/tasks/${encodeURIComponent(jobId.slice(PIXVERSE_PREFIX.length))}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw this.httpErrorMessage(response, await response.text(), 'TokenHub 认证失败', 'TokenHub PixVerse 查询失败')
      const result = await response.json() as { ErrCode?: number; ErrMsg?: string; Resp?: { status?: number; url?: string } }
      if (result.ErrCode === 0 && result.Resp?.status === 5) return { status: 'running' }
      if (result.ErrCode === 0 && result.Resp?.status === 1 && result.Resp.url) return { status: 'succeeded', resultUrl: result.Resp.url }
      return { status: 'failed', message: `TokenHub PixVerse 任务未成功：${result.ErrMsg ?? result.Resp?.status ?? '缺少结果'}` }
    }
    if (jobId.startsWith(VEGA_PREFIX)) {
      const response = await fetch(`${BASE}/vega-images/tasks/${encodeURIComponent(jobId.slice(VEGA_PREFIX.length))}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw this.httpErrorMessage(response, await response.text(), 'TokenHub 认证失败', 'TokenHub WAND 查询失败')
      const result = await response.json() as { status?: string; data?: { url?: string }[] }
      if (result.status === 'queued' || result.status === 'in_progress') return { status: 'running' }
      if (result.status === 'completed' && result.data?.[0]?.url) return { status: 'succeeded', resultUrl: result.data[0].url }
      return { status: 'failed', message: `TokenHub WAND 任务未成功：${result.status ?? '缺少结果'}` }
    }
    const response = await fetch(`${BASE}/kling/tasks/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw this.httpErrorMessage(response, await response.text(), 'TokenHub 认证失败', 'TokenHub 查询失败')
    const data = await response.json() as { code?: number; message?: string; data?: { status?: string; message?: string; outputs?: { url?: string }[] }[] }
    const task = data.data?.[0]
    if (data.code === 0 && task?.status === 'processing') return { status: 'running' }
    if (data.code === 0 && task?.status === 'succeeded' && task.outputs?.[0]?.url) return { status: 'succeeded', resultUrl: task.outputs[0].url }
    return { status: 'failed', message: `TokenHub 任务未成功：${task?.message ?? data.message ?? task?.status ?? '缺少结果'}` }
  }
}

registerAdapter('gateway-tokenhub', (deps: AdapterDeps, config) => new TokenHubProvider(
  { ...config, models: buildModelRecord<GatewayModelConfig>(config.models) },
  () => deps.resolveKey(config), 'TOKENHUB_KEY', { id: 'tokenhub', label: '腾讯 TokenHub' }
), {
  defaultAuthEnv: 'TOKENHUB_KEY', supportedKinds: ['image', 'video'],
  refCaps: { byKind: { image: { delivery: 'data_uri', maxBytes: LIMIT }, video: { delivery: 'none' }, audio: { delivery: 'none' } } }
})
