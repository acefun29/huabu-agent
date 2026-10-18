import { readFile } from 'fs/promises'
import { registerChannel } from './types'
import type { UploadTicket } from './types'

/**
 * 百炼（DashScope）临时文件上传通道。
 *
 * 官方形态（2026-10 文档核实）：参考视频/音频/文档这类素材**没有 base64 通道**，
 * 只收公网 URL 或 `oss://` 临时引用。临时引用要两步换：
 *   1. `GET /api/v1/uploads?action=getPolicy&model=<模型>` 拿一份 OSS 直传凭证
 *      （凭证按模型授权，所以 model 必须是本次真正要调用的那个模型）；
 *   2. 按凭证把文件 POST 到 `upload_host`，之后用 `oss://<key>` 作引用。
 * 有效期 48 小时、单文件 ≤1GB、约 100 QPS。
 *
 * 使用 `oss://` 引用的那次生成请求必须带 `X-DashScope-OssResourceResolve: enable`
 * ——那个头在 dashscope 适配器里按引用前缀加，不在这里。
 */

const BASE_URL = 'https://dashscope.aliyuncs.com'
const TTL_MS = 48 * 60 * 60 * 1000
const MAX_BYTES = 1024 * 1024 * 1024

/** OSS 直传凭证的必需字段（缺任何一个都没法拼表单） */
const REQUIRED_FIELDS = ['policy', 'signature', 'upload_dir', 'upload_host', 'oss_access_key_id']

async function upload(target: {
  absPath: string
  fileName: string
  mime: string
  model: string
  key: string
  baseUrl?: string
}): Promise<UploadTicket> {
  const base = (target.baseUrl ?? BASE_URL).replace(/\/+$/, '')
  const policyUrl = `${base}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(target.model)}`
  const policyResponse = await fetch(policyUrl, {
    headers: { Authorization: `Bearer ${target.key}` },
    signal: AbortSignal.timeout(60_000)
  })
  if (!policyResponse.ok) {
    const text = await policyResponse.text().catch(() => '')
    throw new Error(`百炼上传凭证获取失败（HTTP ${policyResponse.status}）${text.slice(0, 160)}`)
  }
  const payload = (await policyResponse.json()) as { data?: Record<string, unknown> }
  const data = payload.data ?? {}
  const missing = REQUIRED_FIELDS.filter((field) => typeof data[field] !== 'string' || !data[field])
  if (missing.length > 0) {
    throw new Error(`百炼上传凭证响应缺少字段：${missing.join('、')}（响应形态与官方文档不一致）`)
  }
  const objectKey = `${String(data.upload_dir).replace(/\/+$/, '')}/${target.fileName}`
  const form = new FormData()
  form.append('OSSAccessKeyId', String(data.oss_access_key_id))
  form.append('policy', String(data.policy))
  form.append('Signature', String(data.signature))
  form.append('key', objectKey)
  form.append('x-oss-object-acl', typeof data.x_oss_object_acl === 'string' ? data.x_oss_object_acl : 'private')
  form.append('x-oss-forbid-overwrite', typeof data.x_oss_forbid_overwrite === 'string' ? data.x_oss_forbid_overwrite : 'true')
  form.append('success_action_status', '200')
  form.append('file', new Blob([await readFile(target.absPath)], { type: target.mime }), target.fileName)
  const response = await fetch(String(data.upload_host), {
    method: 'POST',
    body: form,
    // 大文件直传：1GB 上限给 10 分钟
    signal: AbortSignal.timeout(600_000)
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`百炼临时存储上传失败（HTTP ${response.status}）${text.slice(0, 160)}`)
  }
  // expire 是 epoch 秒；异常形态（毫秒/缺失）退回本地按 TTL 推算，绝不给出过去的时间
  const expire = Number(data.expire)
  const expiresAt =
    Number.isFinite(expire) && expire > 1e9
      ? expire > 1e12
        ? Math.floor(expire)
        : Math.floor(expire) * 1000
      : Date.now() + TTL_MS
  return { ref: `oss://${objectKey}`, expiresAt }
}

registerChannel({ id: 'dashscope-instant', ttlMs: TTL_MS, maxBytes: MAX_BYTES, upload })
