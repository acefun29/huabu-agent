import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { basename, resolve, sep } from 'path'
import { ensureThumbnail } from './thumbs'

/**
 * huabu-media:// 特权协议（M12；P1-5 性能改造：异步 stat + 分级缓存 + 缩略图 host）。
 *
 * 媒体一律走路径 + 该协议流式供文件，不走 base64、不放开 file://（比 file:// 安全：
 * 只服务当前工作区内的文件，越界一律 404）。与打包态 CSP 兼容：
 * scheme 注册为标准 + stream，CSP 里加一条 img-src/video-src huabu-media: 即可。
 *
 * URL 形态：
 * - `huabu-media://media/<相对媒体目录的 POSIX 路径>`（生成产物，jobId 命名不可变 → immutable）
 * - `huabu-media://ws/<相对工作区根的 POSIX 路径>`（导入的工作区文件，可变 → ETag 协商缓存）
 * - `huabu-media://inbox/<相对收件箱根的 POSIX 路径>`（临时引用素材，工作区之外）
 * - `huabu-media://thumb/<size>/<ws|media|inbox>/<路径>`（缩略图；命中缓存后 immutable）
 */

export const MEDIA_SCHEME = 'huabu-media'

/** 必须在 app ready 之前调用 */
export function registerMediaSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // 渲染端 fetch 媒体（图片转 inlineData）需要该特权；同时响应必须带 CORS 头
        corsEnabled: true,
        stream: true,
        bypassCSP: false
      }
    }
  ])
}

/** 四个主机的根目录集合：media=产物目录，ws=工作区根，inbox=临时收件箱，thumbs=缩略图缓存 */
export interface MediaRoots {
  mediaDir: string | null
  workspaceDir: string | null
  inboxDir: string | null
  thumbsDir: string | null
}

let rootProvider: () => MediaRoots = () => ({
  mediaDir: null,
  workspaceDir: null,
  inboxDir: null,
  thumbsDir: null
})

/** app ready 之后调用，绑定当前工作区的媒体目录与工作区根 */
export function initMediaProtocol(getRoots: () => MediaRoots): void {
  rootProvider = getRoots
  protocol.handle(MEDIA_SCHEME, (request) => handleMediaRequest(request))
}

async function handleMediaRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const roots = rootProvider()
  let host = url.host || url.hostname
  let relPath = decodeURIComponent(url.pathname.replace(/^\//, ''))

  // 缩略图 host：thumb/<size>/<realhost>/<relPath> → 解析出真实目标与缓存目录
  let thumbSize = 0
  if (host === 'thumb') {
    const parsed = /^(\d{2,4})\/(media|ws|inbox)\/(.+)$/.exec(relPath)
    if (!parsed) return new Response('not found', { status: 404 })
    thumbSize = Math.min(1024, Math.max(64, Number(parsed[1])))
    host = parsed[2]
    relPath = parsed[3]
    if (!roots.thumbsDir) return new Response('not found', { status: 404 })
  }

  const rootDir = host === 'media' ? roots.mediaDir : host === 'ws' ? roots.workspaceDir : host === 'inbox' ? roots.inboxDir : null
  if (!rootDir) return new Response('not found', { status: 404 })

  const target = resolve(rootDir, relPath)
  // 越界拒绝（复用 workspace.ts 的校验思路）：解码后的路径必须仍在根目录内
  if (target !== rootDir && !target.startsWith(rootDir + sep)) {
    return new Response('forbidden', { status: 403 })
  }

  // 缩略图：命中/生成缓存则改供小图；失败回退原图（调用方体验不劣化）
  let source = target
  let immutable = host === 'media'
  if (thumbSize > 0) {
    const thumb = await ensureThumbnail(target, thumbSize, roots.thumbsDir as string)
    if (thumb) {
      source = thumb
      immutable = true
    }
  }

  // 异步 stat（一次）：旧实现 existsSync + statSync×2 是主进程主线程上的同步磁盘 IO，
  // 同进程还跑着 Pi Agent，阻塞会放大成 IPC 延迟
  let mtimeMs = 0
  let size = 0
  try {
    const st = await stat(source)
    if (!st.isFile()) return new Response('not found', { status: 404 })
    mtimeMs = Math.round(st.mtimeMs)
    size = st.size
  } catch {
    return new Response('not found', { status: 404 })
  }

  const rangeHeader = request.headers.get('range')
  // <video>/<audio> 拖动进度条依赖 Range 支持
  const range = parseRange(rangeHeader, size)
  const mime = mimeFor(source)
  // 渲染端可能用 fetch 读媒体（如图片转 inlineData）；自定义 scheme 默认无 CORS，需回显 Origin
  const origin = request.headers.get('origin')
  const baseHeaders: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {})
  }
  if (immutable) {
    // 产物与缩略图按内容寻址/不可变命名：永久缓存，重挂载零请求
    baseHeaders['Cache-Control'] = 'public, max-age=31536000, immutable'
  } else {
    // 工作区文件可被外部修改：协商缓存（每次 304 重验证，比旧 no-store 每次全量重读便宜一个量级）
    baseHeaders['Cache-Control'] = 'no-cache'
    baseHeaders['ETag'] = `"${mtimeMs}:${size}"`
  }

  if (range) {
    const { start, end } = range
    const stream = createReadStream(source, { start, end })
    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1)
      }
    })
  }

  // 小文件直接整发；大文件也走流（Response 接受 Node 可读流的 ReadableStream 包装）
  return new Response(streamOf(source) as unknown as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) }
  })
}

function streamOf(target: string): ReadableStream {
  const nodeStream = createReadStream(target)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk))
      })
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', (error) => controller.error(error))
    },
    cancel() {
      nodeStream.destroy()
    }
  })
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, startRaw, endRaw] = match
  if (startRaw === '' && endRaw === '') return null
  let start: number
  let end: number
  if (startRaw === '') {
    // suffix range: bytes=-N
    const length = Number(endRaw)
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null
  return { start, end }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac'
}

function mimeFor(target: string): string {
  const dot = basename(target).lastIndexOf('.')
  const ext = dot >= 0 ? target.slice(dot).toLowerCase() : ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 构建媒体 URL（渲染端与主进程共用同一形态） */
export function buildMediaUrl(relPath: string): string {
  const normalized = relPath.split('\\').join('/')
  return `${MEDIA_SCHEME}://media/${normalized
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

/** 构建工作区文件 URL（huabu-media://ws/<相对工作区根路径>） */
export function buildWorkspaceUrl(relPath: string): string {
  const normalized = relPath.split('\\').join('/')
  return `${MEDIA_SCHEME}://ws/${normalized
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

/** 构建临时收件箱文件 URL（huabu-media://inbox/<相对收件箱根路径>） */
export function buildInboxUrl(relPath: string): string {
  const normalized = relPath.split('\\').join('/')
  return `${MEDIA_SCHEME}://inbox/${normalized
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}
