import { existsSync, statSync } from 'fs'
import { resolve, sep } from 'path'
import type {
  MediaKind,
  MediaRefInput,
  MediaRefRole,
  ModelCapabilities
} from '../../shared/media'
import {
  REF_ROLE_LABEL,
  checkMediaRefs,
  mediaKindOfPath,
  normalizeMediaCaps
} from '../../shared/media'
import type { AdapterRefCaps } from './adapters/registry'
import type { ProviderMediaRef } from './provider'
import { channelFor, uploadRef } from './upload'

/**
 * 参考素材的解析与闸门（画布提交与 Agent 工具两个入口在这里合流）。
 *
 * 单独成模块（而不是长在 manager.ts 里）有两个理由：
 * - manager 依赖 jobs.json 的原子写与产物下载，把闸门放在它里面就没法被
 *   `scripts/catalog-check.mjs` 单独加载断言（那边只转译 media 域且不含 fsutil）；
 * - "素材能不能进这次请求"是独立于"任务怎么排队轮询"的一件事，混在一起两边都难读。
 *
 * 必须保持 electron-free（只准 node 内建 + shared 纯函数）。
 */

const REF_KIND_LABEL: Record<MediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频'
}

export interface ResolvedMediaRefs {
  refs: ProviderMediaRef[]
  notes: string[]
  /** 实际进入请求的参考素材回执（原样 path + 定位到的 absPath），随任务状态回传渲染端成链 */
  echo: Array<{ role: MediaRefRole; path?: string; absPath?: string; url?: string }>
}

/** 上传所需的一次性上下文（每次提交构造，同批素材共用） */
export interface MediaUploadContext {
  /** 上传索引文件（`<媒体目录>/upload-index.json`）；null = 不缓存 */
  indexFile: string | null
  /** 真正调用的远端模型名（百炼的临时存储按模型授权） */
  model: string
  /**
   * 现取该家凭据（只有真的要上传时才调用）。返回空 = 未配置凭据，
   * 闸门会把它报成"请先到设置录入 API Key"，不会静默跳过这条素材。
   */
  resolveKey: () => Promise<string | null>
  baseUrl?: string
}

/** 参考文件解析：媒体产物目录优先，工作区根兜底；两个根都不收留 null（越界/不存在） */
function resolveRefFile(rel: string, mediaRoot: string, wsRoot: string | null): string | null {
  const inMedia = resolve(mediaRoot, rel)
  if (inMedia.startsWith(mediaRoot + sep) && existsSync(inMedia)) return inMedia
  if (wsRoot) {
    const inWs = resolve(wsRoot, rel)
    if (inWs !== wsRoot && inWs.startsWith(wsRoot + sep) && existsSync(inWs)) return inWs
  }
  return null
}

/**
 * 参考素材的唯一权威闸门。三段判定，顺序有讲究：
 *
 * 1. **定位**：路径解析（产物根优先、工作区根兜底、越界丢弃）＋ 扩展名定类型 ＋ stat 取字节；
 *    认不出/不存在/越界的先变成 notes，不进后面的角色判定 —— 免得把"文件没了"说成"模型不支持"。
 * 2. **模型能力**：角色是否被声明、素材大类与角色是否匹配、组合落不落得到某个用法模式、
 *    数量是否超配额 —— 全部由 shared/media 的纯函数判（因此能被 catalog:check 直接断言）。
 * 3. **协议投递形态**：本地文件能不能进这家网关（`url_only` 必须拒、`none` 根本不接受、
 *    `upload` 先经上传通道换临时引用——需要 `upload` 上下文，缺凭据时报错说清）。
 *
 * 语义分工：**数量超限截断 + 留痕，其余不合规一律抛错**。今天挂 5 张图到只吃 1 张的模型
 * 是能正常出图的，把数量做成硬失败是负向回归；而"拖进来的 mp4 被静默丢掉"是真 bug。
 *
 * 体积预算在**读盘之前**完成（base64 按 4/3 膨胀估），并发 8 × 数十 MB 的素材不会先把
 * 主进程内存吃满再报错。
 */
export async function resolveMediaRefs(
  request: { refs?: MediaRefInput[]; refPaths?: string[] },
  kind: MediaKind,
  capabilities: ModelCapabilities | undefined,
  refCaps: AdapterRefCaps,
  roots: { mediaRoot: string; wsRoot: string | null },
  modelLabel: string,
  upload?: MediaUploadContext
): Promise<ResolvedMediaRefs> {
  const caps = normalizeMediaCaps(capabilities, kind)
  // 老入口 refPaths 不带角色：图片通道按参考图、视频通道按首帧（就是它的历史语义）
  const legacyRole: MediaRefRole = kind === 'video' ? 'first_frame' : 'reference_image'
  const inputs: (MediaRefInput & { mediaType?: MediaKind })[] = [
    ...(request.refs ?? []),
    ...(request.refPaths ?? []).map((path) => ({ role: legacyRole, path }))
  ]
  const notes: string[] = []
  if (inputs.length === 0) return { refs: [], notes, echo: [] }

  type Located = MediaRefInput & { mediaType: MediaKind; mime: string; bytes: number; absPath?: string }
  const located: Located[] = []
  for (const input of inputs) {
    if (input.url) {
      const hit = mediaKindOfPath(input.url)
      if (!hit) {
        notes.push(`参考素材的 URL 认不出媒体类型：${input.url.slice(0, 120)}`)
        continue
      }
      located.push({ ...input, mediaType: hit.kind, mime: hit.mime, bytes: 0 })
      continue
    }
    const abs = input.path ? resolveRefFile(input.path, roots.mediaRoot, roots.wsRoot) : null
    if (!abs) {
      notes.push(`参考素材不存在或不在工作区内：${input.path ?? '(既没有路径也没有 URL)'}`)
      continue
    }
    const hit = mediaKindOfPath(abs)
    if (!hit) {
      notes.push(`参考素材的格式无法识别：${input.path}`)
      continue
    }
    located.push({ ...input, mediaType: hit.kind, mime: hit.mime, absPath: abs, bytes: statSync(abs).size })
  }

  const checked = checkMediaRefs(located, caps, REF_KIND_LABEL[kind])
  if (checked.issues.length > 0) {
    throw new Error(`模型 ${modelLabel} 拒绝这组参考素材：${checked.issues.map((i) => i.message).join('；')}`)
  }
  notes.push(...checked.notes)
  // 生成事实回执：判定通过、真正会进请求的素材（含定位到的绝对路径），随任务状态
  // 回传渲染端 —— 引用链在渲染端据此自动形成，画布与 Agent 两个入口同构。
  const echo = checked.accepted.map((ref) => ({
    role: ref.role,
    ...(ref.path ? { path: ref.path } : {}),
    ...(ref.absPath ? { absPath: ref.absPath } : {}),
    ...(ref.url ? { url: ref.url } : {})
  }))

  const refs: ProviderMediaRef[] = []
  let encodedBytes = 0
  const overSized: string[] = []
  const failedUploads: string[] = []
  for (const ref of checked.accepted) {
    const delivery = refCaps.byKind[ref.mediaType]
    if (!delivery || delivery.delivery === 'none') {
      throw new Error(
        `模型 ${modelLabel} 所在的网关不接受${REF_KIND_LABEL[ref.mediaType]}参考素材（该家只有图片可作为参考）`
      )
    }
    if (ref.url) {
      refs.push({ role: ref.role, mediaType: ref.mediaType, mime: ref.mime, bytes: 0, url: ref.url })
      continue
    }
    if (delivery.delivery === 'url_only') {
      throw new Error(
        `模型 ${modelLabel} 的${REF_KIND_LABEL[ref.mediaType]}参考只接受公网 URL：${ref.path} 是本地文件，无法提交。请改用公网可访问的地址`
      )
    }
    const tooLarge = delivery.maxBytes !== undefined && ref.bytes > delivery.maxBytes
    // 需要换临时引用的两种情况：这类素材在该家根本没有 base64 形态（百炼的参考视频/音频），
    // 或文件大到 base64 装不下但该家有上传通道（MiniMax 的 64MB 请求体总闸）
    const needUpload = delivery.delivery === 'upload' || (tooLarge && delivery.uploadChannel !== undefined)
    if (needUpload) {
      const channelId = delivery.uploadChannel
      const absPath = ref.absPath
      if (!channelId || !absPath) {
        throw new Error(
          `模型 ${modelLabel} 的${REF_KIND_LABEL[ref.mediaType]}参考需要先上传换临时引用，但这条通道没有上传通道 id：${ref.path}`
        )
      }
      if (!channelFor(channelId)) {
        throw new Error(
          `模型 ${modelLabel} 的${REF_KIND_LABEL[ref.mediaType]}参考需要上传通道 ${channelId}，客户端尚未实现它。可以改用公网可访问的 URL`
        )
      }
      if (!upload) {
        throw new Error(
          `模型 ${modelLabel} 的${REF_KIND_LABEL[ref.mediaType]}参考需要先上传换临时引用，但这次提交没有开放上传通道。可以改用公网可访问的 URL`
        )
      }
      const key = await upload.resolveKey()
      if (!key) {
        throw new Error(
          `模型 ${modelLabel} 的${REF_KIND_LABEL[ref.mediaType]}参考需要先上传换临时引用，但该供应商没有可用凭据：请先到「设置 → 媒体生成」录入 API Key`
        )
      }
      try {
        const ticket = await uploadRef({
          channelId,
          absPath,
          mime: ref.mime,
          mediaType: ref.mediaType,
          model: upload.model,
          key,
          ...(upload.baseUrl ? { baseUrl: upload.baseUrl } : {}),
          indexFile: upload.indexFile
        })
        refs.push({ role: ref.role, mediaType: ref.mediaType, mime: ref.mime, bytes: ref.bytes, url: ticket.ref })
      } catch (error) {
        failedUploads.push(
          `${REF_ROLE_LABEL[ref.role]}参考 ${ref.path}：${error instanceof Error ? error.message : String(error)}`
        )
      }
      continue
    }
    if (tooLarge) {
      overSized.push(
        `${ref.path ?? ref.url}（${Math.round(ref.bytes / 1024 / 1024)}MB > 单文件上限 ${Math.round((delivery.maxBytes ?? 0) / 1024 / 1024)}MB）`
      )
      continue
    }
    // base64 内联的膨胀按 4/3 估；multipart/上传通道是原始字节
    const encoded = delivery.delivery === 'data_uri' ? Math.ceil(ref.bytes / 3) * 4 : ref.bytes
    encodedBytes += encoded
    refs.push({
      role: ref.role,
      mediaType: ref.mediaType,
      mime: ref.mime,
      bytes: ref.bytes,
      absPath: ref.absPath
    })
  }
  if (overSized.length > 0) {
    throw new Error(`参考素材超出该网关的单文件上限，未提交：${overSized.join('、')}。请换小文件或更少素材`)
  }
  if (failedUploads.length > 0) {
    throw new Error(`参考素材上传到该网关的临时存储失败，未提交：${failedUploads.join('；')}。可以改用公网可访问的 URL`)
  }
  if (refCaps.maxBodyBytes && encodedBytes > refCaps.maxBodyBytes) {
    throw new Error(
      `参考素材合计 ${Math.round(encodedBytes / 1024 / 1024)}MB 超出该网关单次请求 ${Math.round(refCaps.maxBodyBytes / 1024 / 1024)}MB 上限，请减少素材或用更小的素材`
    )
  }
  return { refs, notes, echo }
}
