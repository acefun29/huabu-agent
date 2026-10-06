/**
 * 历史图片分层淘汰（image-context-eviction-plan.md）。
 *
 * pi 每轮请求全量重发会话历史，read_media / 媒体生成附带的 base64 图块会逐轮重复计费
 * （≤1024px 的图每张约 1200 vision token/轮），直到压缩发生才被摘要整体替换。
 * 本模块在「用户发消息前」与「会话创建/重绑历史加载后」两个时机执行淘汰：
 * 历史里所有工具结果中的 image 块原地替换为固定格式的路径锚点文本；
 * 当前轮（执行点之后）产生的图全程保持真图，跨轮需要旧图时由模型按锚点里的路径
 * 自行 read_media，或直接把路径填进生成参数（图生图/图生视频）。
 *
 * 两条铁律：
 * 1. 必须原地改写（content 数组里的块替换），不能整体重赋值 state.messages ——
 *    pi 的 setter 会拷贝顶层数组，重赋值会与 pi 内部持有的引用脱钩；
 * 2. 锚点文本逐字节固定（不含时间戳等可变内容）：每张图只被改写一次，改写后
 *    前缀缓存重新稳定；压缩保留清单（compaction.ts）按锚点开头原样保留路径。
 */

/** 工具结果文本里携带产物路径的标记行前缀；路径提取按前缀精确定位，不走自然语言解析 */
export const MEDIA_SRC_MARKER = '[huabu:media-src '

/** 锚点开头：幂等判断依据（已淘汰的块以它开头，重跑直接跳过） */
const ANCHOR_HEAD = '[图片已从上下文移除'

/** 标记行缺失时的占位路径（旧历史、未带标记的工具/MCP 结果） */
const UNKNOWN_PATH = '路径未记录'

/**
 * 路径锚点文本。逐字节固定：同一路径永远得到同一锚点（前缀缓存友好）。
 */
export function mediaEvictionAnchor(path: string | null): string {
  return `${ANCHOR_HEAD} · 文件：${path ?? UNKNOWN_PATH} · 画面未随历史保留。需要查看画面或将其用作图生图/图生视频参考时，必须用 read_media 读取该路径，或在生成参数中直接引用该路径。不要凭文件名猜测画面内容。]`
}

/** 从一段工具结果文本里提取标记行路径；无标记行或格式残缺返回 null */
function extractMarkerPath(text: string): string | null {
  const at = text.indexOf(MEDIA_SRC_MARKER)
  if (at === -1) return null
  const rest = text.slice(at + MEDIA_SRC_MARKER.length)
  const end = rest.indexOf(']')
  if (end === -1) return null
  const value = rest.slice(0, end).trim()
  return value.length > 0 ? value : null
}

/**
 * 淘汰全部历史图片。只处理 role='toolResult' 的消息（用户/助手消息一律不碰），
 * 把 content 里的 image 块替换为锚点文本，文字部分（时长/时间戳/尺寸/说明）一字不动。
 * 幂等：重复执行结果不变（已淘汰的消息不再含 image 块）。
 *
 * @param messages 会话消息列表（AgentMessage[]，含自定义消息也安全——按 role 过滤）
 * @returns 本次实际替换掉的 image 块数量（0 = 无事可做，可用于日志）
 */
export function evictAllImages(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): number {
  let evicted = 0
  for (const message of messages) {
    if (!message || message.role !== 'toolResult' || !Array.isArray(message.content)) continue
    const content = message.content as Array<{ type?: unknown; text?: unknown; data?: unknown }>
    if (!content.some((block) => block?.type === 'image')) continue

    // 路径取自同条结果的标记行（帧组共享同一源文件，一条标记即可覆盖整组图块）
    let path: string | null = null
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const found = extractMarkerPath(block.text)
      if (found) {
        path = found
        break
      }
    }

    for (let i = 0; i < content.length; i++) {
      if (content[i]?.type !== 'image') continue
      content[i] = { type: 'text', text: mediaEvictionAnchor(path) }
      evicted += 1
    }
  }
  return evicted
}
