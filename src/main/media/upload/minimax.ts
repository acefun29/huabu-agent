import { readFile } from 'fs/promises'
import { registerChannel } from './types'
import type { UploadTicket } from './types'

/**
 * MiniMax 文件上传通道（`mm_file://{file_id}`）。
 *
 * 官方形态（2026-10 文档核实）：V2 视频接口的 `content[].url` **三类素材都接受 data URI**，
 * 也接受文件服务换来的 `mm_file://{file_id}` 引用（有效期 7 天）。这一家是五家里唯一
 * 能把参考视频直接 base64 送进去的，所以默认走 data URI；本通道留给超大文件
 * （base64 会把请求体顶到 64MB 总闸）与"同一素材反复用"的场景。
 *
 * 必须保持 electron-free。
 */

const BASE_URL = 'https://api.minimaxi.com'
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_BYTES = 500 * 1024 * 1024

async function upload(target: {
  absPath: string
  fileName: string
  mime: string
  key: string
  baseUrl?: string
}): Promise<UploadTicket> {
  const base = (target.baseUrl ?? BASE_URL).replace(/\/+$/, '')
  const form = new FormData()
  form.append('purpose', 'file')
  form.append('file', new Blob([await readFile(target.absPath)], { type: target.mime }), target.fileName)
  const response = await fetch(`${base}/v1/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.key}` },
    body: form,
    signal: AbortSignal.timeout(600_000)
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`MiniMax 文件上传失败（HTTP ${response.status}）${text.slice(0, 160)}`)
  }
  const payload = (await response.json()) as {
    data?: { file_id?: string | number }
    base_resp?: { status_code?: number; status_msg?: string }
  }
  // MiniMax 的错误都在 200 响应体里（base_resp），不看它就等于把失败读成成功
  const status = payload.base_resp?.status_code
  if (status !== undefined && status !== 0) {
    throw new Error(`MiniMax 文件上传被拒（status_code=${status} ${payload.base_resp?.status_msg ?? ''}）`.trim())
  }
  const fileId = payload.data?.file_id
  if (fileId === undefined || fileId === null || fileId === '') {
    throw new Error('MiniMax 文件上传响应里没有 file_id（响应形态与官方文档不一致）')
  }
  return { ref: `mm_file://${fileId}`, expiresAt: Date.now() + TTL_MS }
}

registerChannel({ id: 'minimax-files', ttlMs: TTL_MS, maxBytes: MAX_BYTES, upload })
