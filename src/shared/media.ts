/**
 * media 域共享类型（M11/M12）。
 *
 * 与 chat 域同一约定：这些是桥接层自定义结构，渲染端只认这些字段，
 * 不 import 任何 provider/网关 SDK 类型；主进程对各家 API 只做防腐层。
 */

/** 媒体大类。生成与导入共用 */
export type MediaKind = 'image' | 'video' | 'audio'

/**
 * Agent 媒体访问模式（workspace.json media.accessMode）：
 * - 'full'    完全访问：生成直接执行（视频仍受 confirmVideo 对话闸门约束，即现状）；
 * - 'confirm' 变更前确认：generate_image/video/audio 提交前先弹确认卡（模型/提示词/比例等），
 *             用户接受才执行、拒绝则不提交；该模式下视频的对话式闸门被确认卡取代。
 */
export type MediaAccessMode = 'full' | 'confirm'

/**
 * 媒体域默认值与比例的**唯一声明处**。
 *
 * 此前 '16:9' / 5s / 并发 3 散在 ipc.ts、canvasStore、SettingsPanel 五处，
 * 改一处忘其余；主进程与渲染端一律从这里取。
 */
/**
 * 比例枚举。`21:9` 是 2026-10 官方文档核实的三家共有档（方舟 Seedance、百炼 Wan、
 * MiniMax H3 都收）。
 *
 * 官方还有个 `adaptive`，但它**不是比例**、语义是"跟着首帧/输入素材走"，
 * 所以不进这个 union：调用方不给 ratio，由各适配器在有首帧时按自家协议发 adaptive
 *（见 volcark / openaiCompat / dashscope 的 ratio 处理）。
 */
export const MEDIA_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'] as const
export type MediaRatio = (typeof MEDIA_RATIOS)[number]
export const DEFAULT_MEDIA_PROVIDER = 'dashscope'
export const DEFAULT_MEDIA_RATIO: MediaRatio = '16:9'
/** 新建生成卡片 / Agent 工具的默认时长（秒） */
export const DEFAULT_MEDIA_DURATION_S = 5
/** 并发上限缺省值；workspace.json media.concurrency 可覆盖（1..8） */
export const DEFAULT_MEDIA_CONCURRENCY = 3

/**
 * 比例 → 标准像素（1K 档）。这是唯一的换算点：调用方只传语义化的 ratio，
 * 各适配器在自家协议约束上再调整（火山放大到像素下限、百炼 clamp 边长）。
 */
export function ratioToPixels(ratio: MediaRatio): { width: number; height: number } {
  switch (ratio) {
    case '1:1':
      return { width: 1024, height: 1024 }
    case '3:4':
      return { width: 864, height: 1152 }
    case '4:3':
      return { width: 1152, height: 864 }
    case '9:16':
      return { width: 720, height: 1280 }
    case '16:9':
      return { width: 1280, height: 720 }
    case '21:9':
      return { width: 1536, height: 640 }
  }
}

/**
 * 实际宽高 → 最接近的声明比例（工具结果回显与画布节点展示用）。
 * 产物像素是事实源（图生图等场景可能不按请求比例出图），比例标签从它反推；
 * 宽高缺失/非法时返回 undefined，调用方退回请求值展示。
 */
export function nearestMediaRatio(width: number, height: number): MediaRatio | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  const aspect = width / height
  let best: MediaRatio = MEDIA_RATIOS[0]
  let bestDiff = Infinity
  for (const ratio of MEDIA_RATIOS) {
    const [w, h] = ratio.split(':').map(Number) as [number, number]
    const diff = Math.abs(w / h - aspect)
    if (diff < bestDiff) {
      best = ratio
      bestDiff = diff
    }
  }
  return best
}

/**
 * 扩展名 → 媒体大类与 MIME 的**唯一事实源**（原先散在 provider.mimeForKind、
 * ipc/media.guessKind/mimeFromExt、adapters/refImage.EXT_MIME、
 * adapters/openaiCompat.mimeForImage 五份，改一处漏其余）。
 *
 * 判定只看扩展名、**不做魔数嗅探**：参考素材要能喂给网关就必须先读盘，而类型判定的
 * 调用点在读盘之前（体积预算要能在不开盘的前提下先算总闸），且 catalog:check 的夹具是
 * 假字节文件 —— 嗅探会把回归夹具全打挂。后来人请勿"顺手加嗅探"。
 *
 * 取值范围按各家官方声明的并集（火山/百炼/MiniMax 的参考图接受 bmp/tiff/heic），
 * 具体某个网关收哪些格式属于投递形态约束，在各适配器与 refCaps 里判，不在这张表里判。
 */
export const MEDIA_EXT_KIND_MIME: Record<string, { kind: MediaKind; mime: string }> = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.bmp': { kind: 'image', mime: 'image/bmp' },
  '.tif': { kind: 'image', mime: 'image/tiff' },
  '.tiff': { kind: 'image', mime: 'image/tiff' },
  '.heic': { kind: 'image', mime: 'image/heic' },
  '.heif': { kind: 'image', mime: 'image/heif' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mkv': { kind: 'video', mime: 'video/x-matroska' },
  '.avi': { kind: 'video', mime: 'video/x-msvideo' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },
  '.aac': { kind: 'audio', mime: 'audio/aac' }
}

/** 取路径/文件名的扩展名（小写含点；无扩展名或点开头文件返回 ''） */
export function extOfPath(pathOrName: string): string {
  const base = (pathOrName.split(/[\\/]/).pop() ?? '').split(/[?#]/)[0]
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** 按扩展名识别媒体大类与 MIME；认不出返回 undefined（调用方决定丢弃还是报错） */
export function mediaKindOfPath(pathOrName: string): { kind: MediaKind; mime: string } | undefined {
  return MEDIA_EXT_KIND_MIME[extOfPath(pathOrName)]
}

/**
 * 适配器类型 union 的**唯一声明处**（built-in catalog 架构）。
 *
 * workspace/store.ts 与 shared/ipc.ts 一律从这里引用，不再各自手写 union；
 * 每个类型必须在 src/main/media/adapters/registry.ts 里注册了工厂（catalog:check 校验），
 * 不允许出现「声明了类型却没有实现」的幽灵条目。
 */
export type MediaProviderType = 'gateway-dashscope' | 'gateway-volcark' | 'gateway-openai-compat' | 'gateway-minimax' | 'gateway-tencent'

/**
 * 参考素材的角色（2026-10 官方文档核实：方舟 Seedance 与 MiniMax V2 的 role 枚举逐字相同，
 * 百炼 Wan3.0 是同一套并集再加 file/link）。角色是各家协议的共同语言，不是某家的私有能力。
 */
export type MediaRefRole = 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio'

export const MEDIA_REF_ROLES: readonly MediaRefRole[] = [
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio'
]

/** 每个角色吃哪种媒体大类（缺这个就没法校验"给 reference_video 挂了张 png"） */
export const MEDIA_ROLE_KIND: Record<MediaRefRole, MediaKind> = {
  first_frame: 'image',
  last_frame: 'image',
  reference_image: 'image',
  reference_video: 'video',
  reference_audio: 'audio'
}

/**
 * 生成场景模式。三家官方都把"首帧 / 首尾帧 / 全模态参考"写成**互斥的三种用法**，
 * 与其让上层自由拼角色再指望网关给个好错误，不如把模式显式建模。
 */
export type MediaGenMode = 't2i' | 'i2i' | 't2v' | 'i2v_first' | 'i2v_fl' | 'r2v'

export const MEDIA_GEN_MODES: readonly MediaGenMode[] = ['t2i', 'i2i', 't2v', 'i2v_first', 'i2v_fl', 'r2v']

/** 模式 → 该模式允许的角色的唯一事实源（互斥关系就在这里，不在任何适配器里） */
export const MEDIA_MODE_ROLES: Record<MediaGenMode, readonly MediaRefRole[]> = {
  t2i: [],
  i2i: ['reference_image'],
  t2v: [],
  i2v_first: ['first_frame'],
  i2v_fl: ['first_frame', 'last_frame'],
  r2v: ['reference_image', 'reference_video', 'reference_audio']
}

/** 模式的中文说法（错误文案与设置页展示共用） */
export const MEDIA_MODE_LABEL: Record<MediaGenMode, string> = {
  t2i: '文生图',
  i2i: '图生图',
  t2v: '文生视频',
  i2v_first: '首帧图生视频',
  i2v_fl: '首尾帧图生视频',
  r2v: '全模态参考生成'
}

/**
 * 角色依赖：尾帧必须与首帧同批提交（方舟、百炼、MiniMax 三家一致——尾帧没有独立语义）。
 * 全模态参考的三类角色之间没有依赖，只挂一条参考视频是合法用法。
 */
export const MEDIA_ROLE_REQUIRES: Partial<Record<MediaRefRole, readonly MediaRefRole[]>> = {
  last_frame: ['first_frame']
}

/** 单个角色的配额（未声明的角色 = 该模型不接受） */
export interface MediaRefQuota {
  role: MediaRefRole
  max: number
}

/**
 * 未显式指定角色时，按素材大类 + 序数 + 模型配额派生角色（画布与工具共用同一条规则）。
 *
 * 派生刻意保守：视频通道的第一张图是首帧（就是老语义），其余优先按参考图；
 * 优先项没被声明时退回该大类里被声明的角色 —— 让"多挂的素材"走截断留痕，
 * 而不是冒出一条"角色不支持"把整单拦死。一个都找不到才认定这条素材用不到。
 */
export function deriveRefRole(
  assetKind: MediaKind,
  modelKind: MediaKind,
  index: number,
  quota: Partial<Record<MediaRefRole, number>>
): MediaRefRole | null {
  const has = (role: MediaRefRole) => (quota[role] ?? 0) > 0
  const candidates: MediaRefRole[] =
    assetKind === 'image'
      ? modelKind === 'video' && index === 0
        ? ['first_frame', 'reference_image']
        : ['reference_image', 'first_frame']
      : assetKind === 'video'
        ? ['reference_video']
        : ['reference_audio']
  return candidates.find(has) ?? null
}

/** 跨 IPC 的参考素材形状：path（工作区内相对路径）与 url（公网/临时引用）二选一 */
export interface MediaRefInput {
  role: MediaRefRole
  path?: string
  url?: string
}

/** 派生完成、可直接判定的能力（只在内存里存在，不落盘、不跨 IPC） */
export interface ResolvedRefCaps {
  modes: MediaGenMode[]
  quota: Partial<Record<MediaRefRole, number>>
  /** 素材总件数闸（百炼单次 ≤20 这类）；缺省 = 各角色配额之和 */
  total: number
  /** true = 由 maxRefImages/兜底值派生（文案与设置页据此说明"这是老声明，未逐角色建模"） */
  legacy: boolean
}

/** 素材上限的兜底值（模型什么都没声明时沿用历史行为：最多 4 张图片参考） */
export const DEFAULT_MAX_REF_IMAGES = 4

/**
 * 把能力声明归一成可判定的参考配额。这是**唯一**的降级入口：
 * 存量 workspace.json 里只有 `maxRefImages` 的老配置、以及什么都没写的模型，
 * 都从这里派生出与逐角色声明同形的结果，因此不需要任何数据迁移。
 *
 * 老语义映射（保守，不外推）：图片模型 `maxRefImages:N` → `reference_image:N`；
 * 视频模型 `maxRefImages:N` → `first_frame:1` —— 老字段的语义本来就是"垫图/首帧数量"，
 * 绝不因为用户填了 3 就替他打开 30 张全模态参考。
 */
export function normalizeMediaCaps(caps: ModelCapabilities | undefined, kind: MediaKind): ResolvedRefCaps {
  const hasNew = Boolean(caps?.refQuota?.length || caps?.refModes?.length)
  if (hasNew) {
    const quota: Partial<Record<MediaRefRole, number>> = {}
    for (const entry of caps?.refQuota ?? []) {
      const prev = quota[entry.role]
      // 同角色重复声明取更保守的那个（小值）
      quota[entry.role] = prev === undefined ? entry.max : Math.min(prev, entry.max)
    }
    const sum = Object.values(quota).reduce((acc, n) => acc + (n ?? 0), 0)
    const modes = (caps?.refModes?.length ? caps.refModes : deriveModes(quota, kind)) as MediaGenMode[]
    return {
      modes,
      quota,
      total: caps?.refTotal && caps.refTotal > 0 ? caps.refTotal : sum,
      legacy: false
    }
  }
  if (kind === 'image') {
    const max = caps?.maxRefImages ?? DEFAULT_MAX_REF_IMAGES
    return { modes: ['t2i', 'i2i'], quota: { reference_image: max }, total: max, legacy: true }
  }
  if (kind === 'video') {
    // 视频通道按老声明只能确定"有首帧、一张"；尾帧/多参考/视音频参考必须逐角色声明才开启
    return { modes: ['t2v', 'i2v_first'], quota: { first_frame: 1 }, total: 1, legacy: true }
  }
  // 音频通道今天没有任何参考素材入口
  return { modes: [], quota: {}, total: 0, legacy: true }
}

/** 由配额反推可用模式（模型条目只写了 refQuota 时的缺省，与官方"三场景互斥"一致） */
function deriveModes(quota: Partial<Record<MediaRefRole, number>>, kind: MediaKind): MediaGenMode[] {
  const has = (role: MediaRefRole) => (quota[role] ?? 0) > 0
  if (kind === 'image') {
    return has('reference_image') ? ['t2i', 'i2i'] : ['t2i']
  }
  // 音频通道没有任何参考素材模式可推导
  if (kind !== 'video') return []
  const modes: MediaGenMode[] = ['t2v']
  if (has('first_frame')) {
    modes.push('i2v_first')
    if (has('last_frame')) modes.push('i2v_fl')
  }
  if (has('reference_image') || has('reference_video') || has('reference_audio')) modes.push('r2v')
  return modes
}

/**
 * 这组角色组合是否落在某个模式的语义内：**子集**关系，不是相等关系。
 * 全模态参考只挂一条参考视频是合法用法；反过来首帧与 reference_* 谁也不属于对方的模式，
 * 混用因此仍然不可达。尾帧另有依赖（见 MEDIA_ROLE_REQUIRES）。
 */
function modeCovers(mode: MediaGenMode, roles: ReadonlySet<MediaRefRole>): boolean {
  const modeRoles = MEDIA_MODE_ROLES[mode]
  if (roles.size === 0) return modeRoles.length === 0
  if (modeRoles.length === 0) return false
  for (const role of roles) {
    if (!modeRoles.includes(role)) return false
    const deps = MEDIA_ROLE_REQUIRES[role]
    if (deps && !deps.every((dep) => roles.has(dep))) return false
  }
  return true
}

export type MediaRefIssueCode = 'role_unsupported' | 'mode_unreachable' | 'kind_mismatch'

export interface MediaRefIssue {
  code: MediaRefIssueCode
  /** 面向用户/模型的可操作文案（含模型能接受什么，不含密钥与绝对路径） */
  message: string
}

export interface RefCheckResult<T extends MediaRefInput> {
  /** 通过校验、实际进请求的素材（原对象透传，调用方附带的字段都在） */
  accepted: T[]
  /** 因数量超限被截断掉的素材（不是错误，但必须留痕告知） */
  truncated: T[]
  /** 截断的中文说明（按角色与总闸分别成句），编排层原样写进任务状态的 notes */
  notes: string[]
  /** 硬错误：角色未声明、素材类型与角色不符、组合落不到任何允许的模式 */
  issues: MediaRefIssue[]
}

/**
 * 带角色参考素材的合法性判定（纯函数、无 fs/网络/electron，因此能被 catalog:check 直接断言）。
 *
 * 判定顺序刻意是"先角色、再类型、后模式、最后数量"：前三种是"这条素材模型压根用不到"，
 * 一律报错；只有数量超限才截断 —— 今天挂 5 张图到只吃 1 张的模型是能正常出图的，
 * 把数量也做成硬失败是纯负向回归。
 *
 * 投递形态（本地文件 vs 只收公网 URL）不在此判 —— 那是协议家族的属性、不是模型能力，
 * 由编排层按适配器自述的 refCaps 处理。
 */
export function checkMediaRefs<T extends MediaRefInput>(
  refs: readonly (T & { mediaType?: MediaKind })[],
  caps: ResolvedRefCaps,
  /** 素材大类的中文说法前缀（"图片"/"视频"），用于把文案写成"该图片模型…" */
  kindLabel?: string
): RefCheckResult<T> {
  const issues: MediaRefIssue[] = []
  const notes: string[] = []
  const accepted: T[] = []
  const truncated: T[] = []
  const perRoleCount: Partial<Record<MediaRefRole, number>> = {}
  const perRoleDropped: Partial<Record<MediaRefRole, number>> = {}

  for (const ref of refs) {
    const max = caps.quota[ref.role]
    if (!max || max <= 0) {
      issues.push({
        code: 'role_unsupported',
        message: `该${kindLabel ?? '模型'}不接受${REF_ROLE_LABEL[ref.role]}参考（支持的参考角色：${supportedRoleText(caps)}）`
      })
      continue
    }
    if (ref.mediaType && ref.mediaType !== MEDIA_ROLE_KIND[ref.role]) {
      issues.push({
        code: 'kind_mismatch',
        message: `按${REF_ROLE_LABEL[ref.role]}提交的素材是${KIND_TEXT[ref.mediaType]}，该角色只能收${KIND_TEXT[MEDIA_ROLE_KIND[ref.role]]}`
      })
      continue
    }
    const used = perRoleCount[ref.role] ?? 0
    if (used >= max) {
      perRoleDropped[ref.role] = (perRoleDropped[ref.role] ?? 0) + 1
      truncated.push(ref)
      continue
    }
    perRoleCount[ref.role] = used + 1
    accepted.push(ref)
  }

  // 模式可达性按**截断后**的组合判：截断让组合合法时不该报错
  if (accepted.length > 0) {
    const roles = new Set(accepted.map((r) => r.role))
    if (!caps.modes.some((mode) => modeCovers(mode, roles))) {
      const hint =
        roles.has('last_frame') && !roles.has('first_frame')
          ? '尾帧需要与首帧一起提交'
          : '首帧/首尾帧与 reference_* 类参考不能混用'
      issues.push({
        code: 'mode_unreachable',
        message: `这些参考素材的组合不属于该${kindLabel ?? '模型'}支持的任何一种用法（支持：${caps.modes.map((m) => MEDIA_MODE_LABEL[m]).join(' / ')}；${hint}）`
      })
    }
  }

  for (const [role, dropped] of Object.entries(perRoleDropped)) {
    notes.push(`${REF_ROLE_LABEL[role as MediaRefRole]}参考超出该模型上限 ${caps.quota[role as MediaRefRole]} 个，${dropped} 条未进请求`)
  }
  if (issues.length === 0 && caps.total > 0 && accepted.length > caps.total) {
    truncated.push(...accepted.splice(caps.total))
    notes.push(`参考素材合计超出该模型上限 ${caps.total} 条，多出的未进请求`)
  }
  return { accepted, truncated, notes, issues }
}

export const REF_ROLE_LABEL: Record<MediaRefRole, string> = {
  first_frame: '首帧',
  last_frame: '尾帧',
  reference_image: '参考图',
  reference_video: '参考视频',
  reference_audio: '参考音频'
}

const KIND_TEXT: Record<MediaKind, string> = { image: '图片', video: '视频', audio: '音频' }

function supportedRoleText(caps: ResolvedRefCaps): string {
  const roles = Object.entries(caps.quota)
    .filter(([, max]) => (max ?? 0) > 0)
    .map(([role]) => REF_ROLE_LABEL[role as MediaRefRole])
  return roles.length ? roles.join(' / ') : '无（该模型只接受纯文字提示词）'
}

/**
 * 从素材组合反推用法模式（渲染端与适配器据此决定协议形态，不用用户手选）。
 * 落不到任何允许模式时返回 null —— 调用方按"该组合不被支持"处理。
 */
export function inferMediaMode(
  roles: readonly MediaRefRole[],
  kind: MediaKind,
  allowed: readonly MediaGenMode[]
): MediaGenMode | null {
  if (roles.length === 0) return kind === 'image' ? 't2i' : kind === 'video' ? 't2v' : null
  const set = new Set(roles)
  for (const mode of allowed) {
    if (modeCovers(mode, set)) return mode
  }
  return null
}

/** 单个供应商特有参数的声明（`capabilities.extraParams` 的元素） */
export interface ModelExtraParam {
  key: string
  label: string
  type: 'select' | 'number' | 'text' | 'boolean'
  options?: string[]
  default?: unknown
}

/**
 * 附加参数按声明清洗（唯一实现，编排层与回归脚本共用）：
 * 没声明的键、类型对不上、select 值不在 options 里 —— 一律成条报出来，
 * 绝不"猜一个意思"塞进请求体。空声明（模型没写 extraParams）时任何附加参数都是越界。
 */
export function sanitizeMediaExtra(
  declared: ModelExtraParam[] | undefined,
  given: Record<string, unknown> | undefined
): { value: Record<string, string | number | boolean>; issues: string[] } {
  const value: Record<string, string | number | boolean> = {}
  const issues: string[] = []
  for (const [key, raw] of Object.entries(given ?? {})) {
    const spec = (declared ?? []).find((p) => p.key === key)
    if (!spec) {
      const known = (declared ?? []).map((p) => p.key)
      issues.push(`模型不支持附加参数 ${key}（可传：${known.length ? known.join(' / ') : '无'}）`)
      continue
    }
    if (spec.type === 'number') {
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        issues.push(`附加参数 ${spec.label} 需要数字，收到 ${JSON.stringify(raw)}`)
        continue
      }
      value[key] = n
      continue
    }
    if (spec.type === 'boolean') {
      // 渲染端的开关与文本输入都可能递来 "true"/"false" 串，收成布尔再交给适配器
      if (typeof raw === 'boolean') value[key] = raw
      else if (raw === 'true') value[key] = true
      else if (raw === 'false') value[key] = false
      else issues.push(`附加参数 ${spec.label} 需要 true/false，收到 ${JSON.stringify(raw)}`)
      continue
    }
    if (spec.type === 'select') {
      const text = typeof raw === 'string' ? raw : String(raw)
      if (!spec.options?.includes(text)) {
        issues.push(`附加参数 ${spec.label} 只接受：${(spec.options ?? []).join(' / ') || '（该参数未声明可选值）'}`)
        continue
      }
      value[key] = text
      continue
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      issues.push(`附加参数 ${spec.label} 需要文本，收到 ${JSON.stringify(raw)}`)
      continue
    }
    value[key] = raw
  }
  return { value, issues }
}

/** 声明式能力（`capabilities.extraParams`）之外的参考素材声明见上方 MediaRefQuota/MediaGenMode */
export interface ModelCapabilities {
  ratios?: MediaRatio[]
  /** 可选时长档位（秒）；`-1` 表示"由模型自选"（方舟/百炼的官方语义，适配器自己决定怎么发） */
  durations?: number[]
  /**
   * 垫图/首帧数量上限。
   * @deprecated 老字段＝"首帧/垫图一张"的粗粒度声明；新声明一律用 refQuota/refModes。
   * 仍可读（normalizeMediaCaps 派生），新代码不再写、设置页不再存。
   */
  maxRefImages?: number
  /** 逐角色参考配额（未声明的角色＝该模型不接受这种参考） */
  refQuota?: MediaRefQuota[]
  /** 该模型支持的用法模式（互斥关系的声明位；缺省时由 refQuota 反推） */
  refModes?: MediaGenMode[]
  /** 参考素材总件数上限（百炼单次 ≤20 这类）；缺省 = 各角色配额之和 */
  refTotal?: number
  /** TTS 音色清单 */
  voices?: { id: string; label: string }[]
  /** 供应商特有参数的声明式描述，渲染端按此动态生成表单 */
  extraParams?: ModelExtraParam[]
}

/** 单个可生成的媒体模型（来自 provider 配置/内置目录，数据驱动：新增模型=加一行数据） */
export interface MediaModelInfo {
  /** 稳定模型 id（内置目录形态为 `provider/模型名`，如 `dashscope/wan2.7-image`）；跨进程引用用 `provider:模型id` 复合串（见 mediaResolve.toModelRef） */
  id: string
  kind: MediaKind
  /** 展示名 */
  label?: string
  /** 所属 provider id */
  provider: string
  /** 能力元数据（内置目录来源才有；可选字段，存量零破坏） */
  capabilities?: ModelCapabilities
  /** 生命周期：beta 仅标记；deprecated 不出现在新建入口 */
  status?: 'stable' | 'beta' | 'deprecated'
  /** 一句人话的成本提示，展示在参数面板 */
  costHint?: string
}

export interface MediaProviderInfo {
  id: string
  label: string
  type: MediaProviderType
  /** 清单来源：builtin 内置目录 / user 用户自建（设置页据此决定能否删除/改模型清单） */
  source?: 'builtin' | 'user'
  /** 是否已可提交（网关 = 凭据已录入或环境变量存在；mock 适配器已于 42db3cf 移除） */
  configured: boolean
  /** 凭据来源提示（workspace-store / environment:<环境变量名> / none），不含密钥内容 */
  authHint?: string
  models: MediaModelInfo[]
}

/** 提交一个媒体生成任务 */
export interface MediaGenerateRequest {
  /** 承载生成占位的画布节点 id（完成后把产物写回该节点） */
  nodeId?: string
  provider: string
  model: string
  kind: MediaKind
  prompt: string
  /**
   * 画面比例（语义参数，推荐）。像素换算在编排层统一完成（ratioToPixels），
   * 适配器只做自家协议的约束调整。与 width/height 同时给时 width/height 优先。
   */
  ratio?: MediaRatio
  /** 图片尺寸（像素，高级覆盖项；一般传 ratio 即可） */
  width?: number
  height?: number
  /** 视频/音频时长（秒，可选）；模型声明了时长档位时就近归档到合法档 */
  durationSeconds?: number
  /** 音色 id（音频通道）；模型声明了 voices 清单时按 id 校验，缺省 = 适配器自家默认 */
  voice?: string
  /**
   * 供应商特有参数（watermark / prompt_extend / output_format 这类）。
   * 只有出现在该模型 `capabilities.extraParams` 声明里的键才允许传，越界的键直接报错。
   */
  extra?: Record<string, string | number | boolean>
  /** 来源会话节点 id（M13：Agent 工具发起时标记产物归属） */
  sourceChatId?: string
  /**
   * 参考文件（垫图/首帧），POSIX 相对路径：优先按媒体产物目录解析（画布卡片语义），
   * 找不到再按工作区根解析（Agent 工具语义）；越出工作区的路径一律丢弃。
   * 网关 provider 会把首个图片参考转为 data URI 附到请求里。
   */
  refPaths?: string[]
  /**
   * 带角色的参考素材（多图/首尾帧/参考视频/参考音频）。给了 refs 时以它为准，
   * `refPaths` 是不带角色的老入口（等价于按模型语义推断角色），两者可以并存但不该混用。
   */
  refs?: MediaRefInput[]
  /**
   * 产物落库目录（相对工作区根的 POSIX 路径，如 素材库/海报产出）。
   * 缺省 = 媒体产物目录（.huabu/media 或 media.outputDir 配置）；
   * 指定后产物落进素材库目录，卡片以 storage=ws 引用（协议经 huabu-media://ws 服务）。
   */
  outputDir?: string
  /**
   * 期望的产物文件主名（不含扩展名；扩展名按产物实际格式定）。Agent 工具用它在生成时
   * 给素材命名（如沿用参考图的文件名前缀）。非法字符被净化、同名产物自动加序号；
   * 缺省 = jobId（随机 id 命名，即历史行为）。
   */
  name?: string
}

export type MediaJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 已落盘产物描述。渲染端用 `huabu-media://media/<相对路径>` 播放 */
export interface MediaArtifact {
  /** 相对当前工作区 `.huabu/media/` 的路径（POSIX 风格，跨平台稳定） */
  relPath: string
  name: string
  mime: string
  bytes: number
  durationSeconds?: number
  width?: number
  height?: number
}

/** 一条媒体任务的完整状态（media:job 事件与 media:jobs 查询共用） */
export interface MediaJobStatus {
  jobId: string
  provider: string
  model: string
  kind: MediaKind
  prompt: string
  state: MediaJobState
  /** 0..1，running 态才有意义 */
  progress: number
  /** 可展示的进度/错误信息 */
  message?: string
  artifact?: MediaArtifact
  /** 失败原因（可操作，不含密钥） */
  error?: string
  createdAt: string
  updatedAt: string
  nodeId?: string
  sourceChatId?: string
  /** 本任务的落库目录（相对工作区根；缺省 = 媒体产物目录）。渲染端据此决定卡片引用的 storage */
  outputDir?: string
  /**
   * 实际落盘目录（相对工作区根，POSIX）：落库时 = outputDir，否则 = 当时的媒体产物目录。
   * 卡片的 `path` 是相对这个根的，引用契约要还原绝对路径必须有它——`media.outputDir`
   * 是可以随时改的设置，事后按"当前配置"去拼老产物就会拼错。
   */
  artifactDirRel?: string
  /**
   * 参考素材的处置留痕（哪条没进请求、为什么）。编排层解析参考时逐条判定：
   * 类型不匹配 / 超出模型上限 → 丢弃但必须在这里说一声，不再让素材凭空消失。
   */
  notes?: string[]
  /**
   * 协商后的实际生成参数（clamp/归档之后的值）。Agent 工具结果与画布卡片以这里为准，
   * 避免"Agent 声明 1:1、卡片按默认 16:9"的错位
   */
  params?: {
    ratio?: MediaRatio
    width?: number
    height?: number
    durationSeconds?: number
  }
}

/** media:import 请求：把操作系统里的媒体文件收编进工作区 */
export interface MediaImportRequest {
  /** 文件在磁盘上的绝对路径（preload 经 webUtils.getPathForFile 取得）；剪贴板通道可省略 */
  sourcePath?: string
  /** 文件名（拖拽时来自 File 对象） */
  name?: string
  kind?: MediaKind
  /** 剪贴板图片走这个：渲染端读出的 base64（无路径文件时的兜底通道） */
  base64?: string
  mime?: string
}

export interface MediaImportResult {
  artifact: MediaArtifact
}

/**
 * media:browse-catalog 返回的单条：设置页「浏览完整模型库」的展示形态。
 *
 * 数据来自随应用打包的全量浏览目录（main/media/catalog/data/*.ts，脚本自动生成），
 * 与生效清单分离——enabled 由主进程按当前生效清单标注，点「添加」才写入 workspace.json。
 */
export interface MediaCatalogBrowseItem {
  /** 发给网关的标识（predict 协议即 endpoint，如 'veo-4-text-to-video'） */
  id: string
  kind: MediaKind
  label: string
  /** 上游提供方名（Google / OpenAI / Kling…），列表展示用 */
  provider?: string
  capabilities?: ModelCapabilities
  /** 除 prompt 外的额外必填参数；非空时生成可能失败（提交链路只带 prompt/比例/时长/参考图） */
  needsExtra?: string[]
  /** 已在生效清单中（内置精选或用户已添加） */
  enabled: boolean
}
