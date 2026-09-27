/**
 * 素材分类与路径契约（单一事实来源）。
 *
 * 对应原型 huabuai-proto-v2 的 src/harness/assetCategories.ts（@backend(asset-map) 标注处）：
 * 拖入画布的 OS 文件按本表复制到 <工作区>/assets/<子目录>/ 下；重名追加时间戳。
 * 调整分类或目录只需改这一处 —— 主进程归档（main/assets/）与 Agent 系统提示词
 * （renderer harness/prompt.ts → main/agent/host.ts 注入）都从这里取。
 */

/** 渲染端 AssetKind 的超集字符串形式（shared 不依赖 renderer 的 types） */
export type AssetKindName = 'image' | 'video' | 'audio' | 'doc' | 'code' | 'other'

export interface AssetCategory {
  /** 分类 id（= 素材库子目录语义名） */
  id: 'image' | 'doc' | 'audio' | 'video' | 'other'
  /** 工作区内相对目录 */
  dir: string
  /** 展示名 */
  label: string
  /** 对应的卡片渲染类型 */
  kind: AssetKindName
  /** 归入此类的文件后缀（小写、不含点） */
  exts: string[]
}

export const ASSET_CATEGORIES: AssetCategory[] = [
  {
    id: 'image',
    dir: 'assets/images',
    label: '图片',
    kind: 'image',
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
  },
  {
    id: 'doc',
    dir: 'assets/documents',
    label: '文档',
    kind: 'doc',
    exts: ['pdf', 'doc', 'docx', 'md', 'txt', 'pptx', 'xlsx', 'csv', 'rtf']
  },
  {
    id: 'audio',
    dir: 'assets/audio',
    label: '音频',
    kind: 'audio',
    exts: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']
  },
  {
    id: 'video',
    dir: 'assets/video',
    label: '视频',
    kind: 'video',
    exts: ['mp4', 'mov', 'webm', 'mkv', 'avi']
  }
]

/** 代码文件：目录上归入 documents，卡片按 code 类型渲染 */
export const CODE_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'json', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs', 'rb', 'php',
  'css', 'html', 'sh', 'yml', 'yaml', 'toml'
]

/** 兜底分类：认识的后缀之外全部落 assets/others/ */
export const OTHER_CATEGORY: AssetCategory = {
  id: 'other',
  dir: 'assets/others',
  label: '其他',
  kind: 'other',
  exts: []
}

/** 按文件名推断分类与渲染类型 */
export function categorizeFileName(name: string): { category: AssetCategory; kind: AssetKindName } {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const hit = ASSET_CATEGORIES.find((c) => c.exts.includes(ext))
  if (hit) return { category: hit, kind: hit.kind }
  if (CODE_EXTS.includes(ext)) return { category: ASSET_CATEGORIES[1], kind: 'code' }
  return { category: OTHER_CATEGORY, kind: 'other' }
}

/**
 * 媒体生成产物落入内置「画布素材」库时的归类子目录（image→assets/images 等）。
 * 素材库面板只扫分类子目录（不扫 assets 根），产物必须按大类归位才可见；
 * 渲染端落库链与主进程 Agent 工具路径共用这一映射。
 */
export function assetDirForKind(kind: 'image' | 'video' | 'audio'): string {
  return (ASSET_CATEGORIES.find((c) => c.id === kind) ?? OTHER_CATEGORY).dir
}

/** 统一 '/' 分隔符（消息载荷里的路径约定） */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Agent 自助读文件（read_media）的路径解析：把模型递来的路径落到"允许的根"之内。
 *
 * 契约的入口是绝对路径（引用载荷就发绝对路径），但也接受工作区相对路径与裸文件名，
 * 因为模型常把这三者混着写。规则与 assetAbsPath 同源，所以放在同一份纯函数文件里 ——
 * 只有纯函数才进得了 `pnpm asset-path:check`，"越界读文件"这种事不该只在真机上验一次。
 *
 * 只判定"落在哪个根内、文件在不在"，不读内容：读与缩放归主进程（nativeImage 是 electron）。
 */
export type MediaTargetKind = 'image' | 'video' | 'audio' | 'text' | 'other'

export interface MediaRoots {
  /** 工作区根（绝对路径） */
  workspaceDir: string
  /** 媒体产物目录（绝对路径，= 主进程 store.mediaDir()，可被 media.outputDir 改） */
  mediaDir?: string
  /** 临时上传收件箱（工作区之外，引用素材的合法来源） */
  inboxDir?: string
}

/** read_media 允许的根（都是绝对路径；media/inbox 可缺省 = 该来源不可用） */
export type MediaRootName = 'workspace' | 'media' | 'inbox'

/** 后缀 → read_media 的处置大类（认识不了的落 other，工具会说明本工具不解码媒体流） */
const MEDIA_EXT_KIND: Record<string, MediaTargetKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image', avif: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  txt: 'text', md: 'text', markdown: 'text', json: 'text', csv: 'text', log: 'text'
}

export function mediaKindForFileName(name: string): MediaTargetKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_EXT_KIND[ext] ?? 'other'
}

/** 归一化各根并排优先级：更具体的在前（media 在工作区之内时不该被报成工作区文件） */
function orderedRoots(roots: MediaRoots): Array<{ abs: string; name: MediaRootName }> {
  const out: Array<{ abs: string; name: MediaRootName }> = []
  for (const item of [
    { abs: roots.mediaDir, name: 'media' as const },
    { abs: roots.inboxDir, name: 'inbox' as const },
    { abs: roots.workspaceDir, name: 'workspace' as const }
  ]) {
    const base = normalizePath(item.abs ?? '').replace(/\/+$/, '')
    if (base && !out.some((r) => r.abs === base)) out.push({ abs: base, name: item.name })
  }
  return out
}

function insideBase(absPath: string, base: string): boolean {
  return absPath === base || absPath.startsWith(base + '/')
}

/** 折叠 '.' 与 '..'（统一 '/'）；消不掉的 '..' 原样留下，交给"是否仍在根内"那一步拒掉 */
function collapsePath(p: string): string {
  const absolute = p.startsWith('/')
  const out: string[] = []
  for (const segment of p.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      const last = out[out.length - 1]
      if (last !== undefined && last !== '..' && !/^[a-zA-Z]:$/.test(last)) out.pop()
      else out.push('..')
      continue
    }
    out.push(segment)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/**
 * 把模型递来的路径落到"允许的根"之内。
 *
 * 引用契约发的是绝对路径，但模型常把工作区相对路径与裸文件名混着写，所以三种都收：
 * 绝对路径要求本来就在某个根内；相对路径按根优先级依次拼。给了 `exists` 时还会跳过
 * 不存在的候选（主进程传 existsSync），避免"拼到第一个根但文件在那儿不存在"。
 *
 * 越界判定必须先折叠再比前缀：只看字符串会放过 `…/assets/../../Windows/x` 这类写法。
 */
export function resolveMediaTarget(
  raw: string,
  roots: MediaRoots,
  exists?: (absPath: string) => boolean
): { absPath: string; root: MediaRootName; kind: MediaTargetKind } | null {
  const value = normalizePath(raw?.trim() ?? '').replace(/\/{2,}/g, '/')
  if (!value) return null
  const isAbsolute = /^[a-zA-Z]:\//.test(value) || value.startsWith('/')
  const entries = orderedRoots(roots)
  const candidates = isAbsolute
    ? entries.map((r) => ({ abs: collapsePath(value), name: r.name, base: r.abs }))
    : entries.map((r) => ({ abs: collapsePath(`${r.abs}/${value.replace(/^\/+/, '')}`), name: r.name, base: r.abs }))
  for (const candidate of candidates) {
    if (!insideBase(candidate.abs, candidate.base)) continue
    if (exists && !exists(candidate.abs)) continue
    // 绝对路径可能同时落在 media 与 workspace 内：报更具体的那个
    const owner = isAbsolute ? (entries.find((r) => insideBase(candidate.abs, r.abs))?.name ?? candidate.name) : candidate.name
    return { absPath: candidate.abs, root: owner, kind: mediaKindForFileName(candidate.abs) }
  }
  return null
}

/** 工作区内相对路径 → 绝对路径（消息载荷用；统一 '/' 分隔） */
export function workspaceAbs(relPath: string, workspaceDir: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(relPath) || relPath.startsWith('/')) return normalizePath(relPath)
  const trimmed = relPath.replace(/^\/+/, '')
  return `${normalizePath(workspaceDir).replace(/\/+$/, '')}/${trimmed}`
}

/**
 * 媒体产物默认根目录（相对工作区根）。
 *
 * 两处共用这一常量：主进程 `WorkspaceStore.mediaDir()` 的默认值，以及渲染端"老卡片没有
 * pathRoot 时"的回退根。分开写会成为第二次「两个写入方」那种错——改了默认目录，
 * 老卡片就指不到文件，而且不报错。
 */
export const MEDIA_ROOT_REL = '.huabu/media'

/**
 * 卡片引用 → 绝对路径（素材引用契约唯一的解析入口）。
 *
 * `path` 的语义是**相对 storage 根**：`ws` = 工作区根，`media` = 媒体产物目录。
 * 产物目录可被 `media.outputDir` 改到工作区内任何地方，所以 `media` 这一路必须再看
 * `pathRoot`（该产物落盘时的实际目录，相对工作区根）；缺省 = 默认产物根。
 * 只按工作区根拼 `path` 会拼出 `<工作区>/<裸文件名>`，Agent 侧表现为"引用的文件不存在"。
 */
export function assetAbsPath(
  ref: { storage?: 'media' | 'ws'; path?: string; pathRoot?: string },
  workspaceDir: string
): string | null {
  const rel = ref.path?.trim()
  if (!rel) return null
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('/')) return normalizePath(rel)
  if (ref.storage === 'media') {
    const root = normalizePath(ref.pathRoot?.trim() || MEDIA_ROOT_REL).replace(/^\/+|\/+$/g, '')
    return workspaceAbs(`${root}/${rel}`, workspaceDir)
  }
  return workspaceAbs(rel, workspaceDir)
}

/** 重名防覆盖：在文件名上追加分秒时间戳（poster.png → poster_093012.png） */
export function dedupeName(name: string, now: Date = new Date()): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${base}_${stamp}${ext}`
}
