import { randomUUID } from 'crypto'
import { basename } from 'path'
import type { MediaProviderType } from '../../../shared/media'
import { submitRefs, type ProviderMediaRef, type ProviderPollResult, type ProviderSubmitInput } from '../provider'
import { BaseGatewayProvider, buildModelRecord, type GatewayModelConfig } from './base'
import { readRefBytes } from './refImage'
import { registerAdapter, type AdapterDeps } from './registry'

// 拍我 AI 国内 API：https://docs.platform.pai.video/9405192m0
const BASE = 'https://app-api.pixverseai.cn/openapi/v2'
const LIMIT = 20 * 1024 * 1024
type Reply<T> = { ErrCode?: number; ErrMsg?: string; Resp?: T }

export class PixverseProvider extends BaseGatewayProvider<GatewayModelConfig> {
  readonly type: MediaProviderType = 'gateway-pixverse'
  private headers(key: string): Record<string, string> { return { 'API-KEY': key, 'Ai-trace-id': randomUUID() } }
  private async parse<T>(response: Response): Promise<T> {
    if (!response.ok) throw this.httpErrorMessage(response, await response.text(), '拍我 AI 认证失败', '拍我 AI 请求失败')
    const data = await response.json() as Reply<T>
    if (data.ErrCode !== 0 || !data.Resp) throw new Error(`拍我 AI 请求失败：${data.ErrMsg ?? data.ErrCode ?? '缺少结果'}`)
    return data.Resp
  }
  private async upload(key: string, ref: ProviderMediaRef): Promise<number> {
    const form = new FormData()
    if (ref.url) form.append('image_url', ref.url)
    else {
      const bytes = await readRefBytes(ref, LIMIT)
      if (!bytes) throw new Error('拍我 AI 图片无法读取或超过 20MB')
      form.append('image', new Blob([bytes], { type: ref.mime }), ref.absPath ? basename(ref.absPath) : 'image.png')
    }
    const result = await this.parse<{ img_id?: number }>(await fetch(`${BASE}/image/upload`, {
      method: 'POST', headers: this.headers(key), body: form, signal: AbortSignal.timeout(60_000)
    }))
    if (typeof result.img_id !== 'number') throw new Error('拍我 AI 图片上传响应缺少 img_id')
    return result.img_id
  }
  async submit(model: string, input: ProviderSubmitInput): Promise<string> {
    const key = await this.requireKey()
    const remote = this.requestModelOf(model)
    if (!remote) this.noSuchModel(model)
    const refs = submitRefs(input)
    const first = refs.find((r) => r.role === 'first_frame')
    const last = refs.find((r) => r.role === 'last_frame')
    if (last && !first) throw new Error('拍我 AI 尾帧需要同时提供首帧')
    const body: Record<string, unknown> = { model: remote, prompt: input.prompt, duration: input.durationSeconds ?? 5, quality: '720p' }
    let endpoint = '/video/text/generate'
    if (first) {
      const firstId = await this.upload(key, first)
      if (last) {
        endpoint = '/video/transition/generate'
        body.first_frame_img = firstId
        body.last_frame_img = await this.upload(key, last)
      } else {
        endpoint = '/video/img/generate'
        body.img_id = firstId
      }
    } else body.aspect_ratio = input.ratio ?? '16:9'
    const data = await this.parse<{ video_id?: number }>(await fetch(`${BASE}${endpoint}`, {
      method: 'POST', headers: { ...this.headers(key), 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000)
    }))
    if (typeof data.video_id !== 'number') throw new Error('拍我 AI 响应缺少 video_id')
    return String(data.video_id)
  }
  async poll(_model: string, jobId: string): Promise<ProviderPollResult> {
    const key = await this.requireKey()
    const result = await this.parse<{ status?: number; url?: string }>(await fetch(`${BASE}/video/result/${encodeURIComponent(jobId)}`, {
      headers: this.headers(key), signal: AbortSignal.timeout(30_000)
    }))
    if (result.status === 5) return { status: 'running' }
    if (result.status === 1 && result.url) return { status: 'succeeded', resultUrl: result.url }
    return { status: 'failed', message: `拍我 AI 任务未成功（状态 ${result.status ?? '未知'}）` }
  }
}

registerAdapter('gateway-pixverse', (deps: AdapterDeps, config) => new PixverseProvider(
  { ...config, models: buildModelRecord<GatewayModelConfig>(config.models) },
  () => deps.resolveKey(config), 'PIXVERSE_KEY', { id: 'pixverse', label: '拍我 AI' }
), {
  defaultAuthEnv: 'PIXVERSE_KEY', supportedKinds: ['video'],
  refCaps: { byKind: { image: { delivery: 'multipart', maxBytes: LIMIT }, video: { delivery: 'none' }, audio: { delivery: 'none' } } }
})
