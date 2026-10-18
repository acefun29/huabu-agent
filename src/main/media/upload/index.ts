import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { extname } from 'path'
import type { MediaKind } from '../../../shared/media'
import { atomicWriteSync, recoverAtomicBackup } from '../../fsutil/atomic'
import { channelFor } from './types'
import type { UploadTicket } from './types'
// 通道自注册（与 adapters/index.ts 的 barrel 同构：加一家 = 加一行 import）
import './dashscope'
import './minimax'

/**
 * 上传通道的调用面：缓存 + 并发闸 + 失败语义。
 *
 * 三件事各自独立，凑在一起才敢把"本地文件"变成"网关临时引用"：
 *
 * 1. **缓存**：同一素材（内容摘要 + 大小 + mtime + 通道 + 模型）在有效期内不重传。
 *    索引落 `<媒体目录>/upload-index.json`，原子写（崩溃不留半截 JSON）。
 * 2. **并发**：模块级信号量限 2 路在途上传 —— 百炼的临时存储约 100 QPS，而生成任务
 *    本身并发 8，一次挂十条参考视频的提交能把排队瞬间放大成对网关的 DoS。
 * 3. **失败绝不回落 base64**：这条通道的存在理由就是"这类素材没有 base64 形态"，
 *    上传失败还去拼 data URI 只是把同一个 400 推到网关那边再报一遍，且错误更难懂。
 *
 * 有效期按官方承诺的 90% 使用（48h→43.2h、7d→6.3d）：宁可在到期前重传一次，
 * 也不要把已经失效的引用递进请求体。
 *
 * 必须保持 electron-free。
 */

export { channelFor, registerChannel } from './types'
export type { UploadChannel, UploadTarget, UploadTicket } from './types'

/** 缓存条目上限（LRU：超出按最近使用时间淘汰，索引文件不会无限膨胀） */
const MAX_ENTRIES = 200
/** TTL 安全边际 */
const TTL_SAFETY = 0.9
/** 在途上传并发上限 */
const MAX_IN_FLIGHT = 2
/** 指纹只取前 1MB 内容（配 size+mtime 已足以区分改动） */
const HEAD_BYTES = 1024 * 1024

interface UploadEntry {
  ref: string
  expiresAt: number
  bytes: number
  channelId: string
  uploadedAt: number
  lastUsedAt: number
}

interface UploadIndex {
  version: 1
  entries: Record<string, UploadEntry>
}

export interface UploadRequest {
  /** refCaps 里声明的通道 id */
  channelId: string
  absPath: string
  mime: string
  mediaType: MediaKind
  /** 真正调用的远端模型名（临时存储按模型授权） */
  model: string
  /** 该家网关的 API Key */
  key: string
  baseUrl?: string
  /** 索引文件绝对路径；null = 不缓存，每次真传 */
  indexFile: string | null
}

let indexCache: { file: string; index: UploadIndex } | null = null

const emptyIndex = (): UploadIndex => ({ version: 1, entries: {} })

/**
 * 读索引：文件不存在/坏掉都按空索引继续（上传照常，只是没有缓存收益），
 * 绝不让一个缓存文件把生成能力卡死。崩溃残留的 .bak 先还原再读。
 */
function readIndex(file: string): UploadIndex {
  if (indexCache && indexCache.file === file) return indexCache.index
  let index = emptyIndex()
  try {
    recoverAtomicBackup(file)
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<UploadIndex>
      if (raw?.entries && typeof raw.entries === 'object') index = { version: 1, entries: raw.entries }
    }
  } catch {
    index = emptyIndex()
  }
  indexCache = { file, index }
  return index
}

function writeIndex(file: string, index: UploadIndex): void {
  try {
    atomicWriteSync(file, JSON.stringify(index))
  } catch (error) {
    console.warn(`[media-upload] 上传索引写入失败（不影响本次生成）：${String(error)}`)
  }
}

/** 素材指纹：前 1MB 内容摘要 + 大小 + mtime + 通道 + 模型（改一个字节就重传） */
async function fingerprint(absPath: string, channelId: string, model: string): Promise<string> {
  const stat = statSync(absPath)
  const handle = await open(absPath, 'r')
  try {
    const length = Math.min(HEAD_BYTES, stat.size)
    const buffer = new Uint8Array(length)
    await handle.read(buffer, 0, length, 0)
    return createHash('sha256')
      .update(buffer)
      .update(`:${stat.size}:${Math.round(stat.mtimeMs)}:${channelId}:${model}`)
      .digest('hex')
  } finally {
    await handle.close()
  }
}

/** 淘汰过期条目 + LRU 截断（写盘前做一次，索引文件不会无限膨胀） */
function prune(index: UploadIndex, now: number): UploadIndex {
  const alive = Object.entries(index.entries).filter(([, entry]) => entry.expiresAt > now)
  const keep = alive.length > MAX_ENTRIES ? alive.sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt).slice(0, MAX_ENTRIES) : alive
  return { version: 1, entries: Object.fromEntries(keep) }
}

/* 模块级信号量：跨任务、跨工作区共享（网关的 QPS 限制按账号计，不按任务） */
let inFlight = 0
const waiters: Array<() => void> = []
async function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++
    return
  }
  await new Promise<void>((resolveWait) => waiters.push(resolveWait))
  inFlight++
}
function release(): void {
  inFlight--
  waiters.shift()?.()
}

/**
 * 把一个本地素材换成该家的临时引用（命中缓存则不碰网络）。
 * 抛错即"这条素材这次进不了请求"，调用方必须把原因原样透出，绝不静默降级。
 */
export async function uploadRef(req: UploadRequest): Promise<UploadTicket> {
  const channel = channelFor(req.channelId)
  if (!channel) {
    throw new Error(`该网关声明了上传通道 ${req.channelId}，但客户端尚未实现这条通道`)
  }
  const stat = statSync(req.absPath)
  if (stat.size > channel.maxBytes) {
    throw new Error(
      `素材 ${Math.round(stat.size / 1024 / 1024)}MB 超出该网关临时存储单文件上限 ${Math.round(channel.maxBytes / 1024 / 1024)}MB`
    )
  }
  const key = await fingerprint(req.absPath, req.channelId, req.model)
  const cached = (now: number): UploadTicket | null => {
    if (!req.indexFile) return null
    const entry = readIndex(req.indexFile).entries[key]
    if (!entry || entry.expiresAt <= now) return null
    entry.lastUsedAt = now
    return { ref: entry.ref, expiresAt: entry.expiresAt }
  }
  const fresh = cached(Date.now())
  if (fresh) {
    if (req.indexFile) writeIndex(req.indexFile, prune(readIndex(req.indexFile), Date.now()))
    return fresh
  }

  await acquire()
  try {
    // 排队期间别的任务可能已经把同一素材传上去了：拿锁后再看一次缓存
    const again = cached(Date.now())
    if (again) return again
    const ext = extname(req.absPath).toLowerCase().replace(/[^.a-z0-9]/g, '')
    const ticket = await channel.upload({
      absPath: req.absPath,
      // 远端文件名只用内容摘要 + 时间戳：每次落互不冲突的新 key（临时存储普遍禁覆盖），
      // 且绝不把本地路径与本地命名递给第三方网关
      fileName: `${key.slice(0, 16)}-${Date.now().toString(36)}${ext}`,
      mime: req.mime,
      mediaType: req.mediaType,
      model: req.model,
      key: req.key,
      baseUrl: req.baseUrl
    })
    if (!req.indexFile) return ticket
    const now = Date.now()
    const expiresAt = Math.min(
      ticket.expiresAt || now + channel.ttlMs,
      now + Math.floor(channel.ttlMs * TTL_SAFETY)
    )
    const index = readIndex(req.indexFile)
    index.entries[key] = {
      ref: ticket.ref,
      expiresAt,
      bytes: stat.size,
      channelId: req.channelId,
      uploadedAt: now,
      lastUsedAt: now
    }
    writeIndex(req.indexFile, prune(index, now))
    return { ref: ticket.ref, expiresAt }
  } finally {
    release()
  }
}
