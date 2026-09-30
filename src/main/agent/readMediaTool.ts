import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { resolveMediaTarget, type MediaRoots } from '../../shared/assets'
import { readImageFileAsBase64 } from '../media/artifactImage'
import {
  MAX_VIDEO_BYTES,
  VIDEO_FRAME_MAX_EDGE,
  extractVideoFrames,
  formatMediaTime
} from '../media/videoFrames'

/**
 * `read_media(path)` —— 素材引用契约的另一半闭环（架构计划 T7）。
 *
 * 契约规定"引用只发绝对路径、内容不随消息携带"，所以 Agent 必须自己按路径读；
 * 而白名单里的 pi `read` 只回文本，图片走不到模型眼前。本工具补的就是"看图"这一口。
 *
 * 三条设计约束（都有出处，不是偏好）：
 *
 * 1. **图片块只在当前会话模型声明了图片输入时才回**。pi 的序列化的确会丢：
 *    `openai-completions.js` 把带图工具结果拆成"tool 消息发文本占位 + 追加一条 user 消息
 *    带 image_url"，而这段的前置判断就是 `model.input.includes('image')`；
 *    `anthropic-messages.js` 则原生放进 `tool_result.content`。所以在声明不视觉时
 *    主动回元数据 + 说明，比"发了但被丢掉、模型对着占位文本瞎猜"诚实。
 * 2. **路径判定全在 `shared/assets.ts` 的纯函数里**（`resolveMediaTarget`），
 *    由 `pnpm asset-path:check` 断言越界与分类；本文件只做 exists/stat 这类真 IO。
 *    越界检查不能只看字符串前缀，必须折叠 `..` 后再比 —— 那条规则写在纯函数侧。
 * 3. **文本类不重复实现**：`read` 已在工具白名单（host.ts 的 TOOL_ALLOWLIST），
 *    这里遇到文本就指过去，避免两套截断规则互相漂移。
 * 4. **视频走本地抽帧（视频理解 M1）**：ffmpeg-static 定点 seek 抽关键帧、带时间戳回传
 *    （media/videoFrames.ts，`pnpm probe:video-frames` 覆盖），所以任何声明图片输入的模型
 *    都能"看"视频；音频一期仍不解码 —— 没有 ASR 能力，"猜一段音频里有什么"比明说读不了更坏。
 */

export interface ReadMediaContext {
  /** 每次现读：工作区可切换，media.outputDir 也可在运行中改 */
  roots: () => MediaRoots | null
  /** 当前会话的对话模型是否声明图片输入（决定回不回图片块） */
  supportsImageInput: () => boolean
}

/** 送进 nativeImage 前先拒掉超大文件：解码是主进程内存，一张 60MB TIFF 能卡住整个会话 */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024

/** 与 M13 多模态回传同一档：1024px 内足够"看懂内容"，再大只是烧 token */
const READ_MEDIA_MAX_EDGE = 1024

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

function rootsHint(roots: MediaRoots): string {
  const lines = [`- 工作区：${roots.workspaceDir}`, ...(roots.mediaDir ? [`- 媒体产物目录：${roots.mediaDir}`] : []), ...(roots.inboxDir ? [`- 临时上传（inbox）：${roots.inboxDir}`] : [])]
  return lines.join('\n')
}

export function createReadMediaTool(ctx: ReadMediaContext): ToolDefinition {
  return {
    name: 'read_media',
    label: '读取素材',
    description:
      '按路径读取工作区内的图片或视频素材，并把画面交给你看（图片直读；视频抽取带时间戳的关键帧），' +
      '从而能描述画布卡片、生成产物或用户引用的素材内容。参数是引用素材清单里的那条绝对路径（也接受工作区相对路径）。' +
      '文本文件请用 read 工具；音频只给出文件信息（一期无转写能力）。',
    parameters: Type.Object({
      path: Type.String({
        description: '图片文件路径：优先用引用清单里给出的绝对路径；相对路径按工作区解析'
      })
    }),
    execute: async (_toolCallId, params) => {
      const requested = String((params as { path?: unknown })?.path ?? '').trim()
      const roots = ctx.roots()
      if (!roots) {
        return {
          content: [textBlock('当前没有打开中的工作区，read_media 无法解析任何路径。')],
          details: { ok: false, reason: 'no-workspace' }
        }
      }
      if (!requested) {
        return {
          content: [textBlock('read_media 需要一个路径参数。请传引用素材清单里给出的绝对路径。')],
          details: { ok: false, reason: 'no-path' }
        }
      }
      const target = resolveMediaTarget(requested, roots, existsSync)
      if (!target) {
        // 文案要能自纠：给允许范围 + 提醒用引用清单原样的绝对路径，而不是让 Agent 反复猜路径
        return {
          content: [
            textBlock(
              `没找到该文件，或它不在允许读取的范围内：${requested}\n` +
                `可读取的根：\n${rootsHint(roots)}\n` +
                `请用「引用素材」清单里原样给出的绝对路径重试；相对路径也支持，但裸文件名会先按媒体产物目录找。`
            )
          ],
          details: { ok: false, reason: 'not-found-or-out-of-scope', requested }
        }
      }

      const size = statSync(target.absPath).size
      const summary = `文件：${target.absPath}\n位置：${target.root === 'media' ? '媒体产物目录' : target.root === 'inbox' ? '临时上传（工作区之外）' : '工作区'}\n大小：${humanBytes(size)}`

      if (target.kind === 'text') {
        return {
          content: [textBlock(`${summary}\n这是文本文件，请改用 read 工具读取内容（本工具只处理图片/音视频的文件信息）。`)],
          details: { ok: true, kind: target.kind, absPath: target.absPath, handedOff: 'read' }
        }
      }

      if (target.kind === 'audio') {
        return {
          content: [
            textBlock(
              `${summary}\n这是音频文件，本工具一期没有语音转写（ASR）能力，无法得知声音内容。` +
                `需要音频信息时，请让用户提供文字稿，或改用图片/视频素材。`
            )
          ],
          details: { ok: true, kind: 'audio', absPath: target.absPath, decoded: false }
        }
      }

      if (target.kind === 'video') {
        // 抽帧的产物就是图片块，视觉闸门与图片分支同源：不声明图片输入的模型收了也会被协议层丢
        if (!ctx.supportsImageInput()) {
          return {
            content: [
              textBlock(
                `${summary}\n当前会话使用的模型没有声明图片输入能力，视频要先转成关键帧图片才能被理解，所以本工具没有回传画面 ——` +
                  `回传了也会被协议层丢弃，那样只会得到一个"已看过视频"的假象。确实需要看画面时，请告诉用户把会话模型换成支持视觉的模型` +
                  `（设置 → 模型供应商里该模型需带「视觉」标记），或让用户直接描述视频内容。`
              )
            ],
            details: { ok: true, kind: 'video', absPath: target.absPath, decoded: false, reason: 'model-no-vision' }
          }
        }
        if (size > MAX_VIDEO_BYTES) {
          return {
            content: [textBlock(`${summary}\n视频超过 ${humanBytes(MAX_VIDEO_BYTES)}，本工具不对超大视频做抽帧（解码耗时会占住会话）。请让用户裁剪或压缩后再试。`)],
            details: { ok: true, kind: 'video', absPath: target.absPath, decoded: false, reason: 'too-large' }
          }
        }
        const extraction = await extractVideoFrames(target.absPath, {
          cacheDir: join(roots.workspaceDir, '.huabu', 'vframes')
        })
        if (!extraction.ok) {
          return {
            content: [
              textBlock(
                `${summary}\n视频关键帧抽取失败（${extraction.code}）。常见原因是编码不受支持或文件已损坏；` +
                  `可以试着让用户重新导出为 MP4（H.264），或改用图片素材。`
              )
            ],
            details: { ok: true, kind: 'video', absPath: target.absPath, decoded: false, reason: 'video-decode-failed' }
          }
        }
        const set = extraction.value
        const stamps = set.frames.map((f, i) => `帧${i + 1}=${formatMediaTime(f.ptsSec)}`).join('、')
        return {
          content: [
            textBlock(
              `${summary}\n时长 ${formatMediaTime(set.durationSec)}；已${set.sceneEnhanced ? '按场景切换 + 均匀采样' : '均匀采样'}抽取 ${set.frames.length} 个关键帧（最长边 ≤${VIDEO_FRAME_MAX_EDGE}px${set.deduped ? '，已剔除重复画面' : ''}），随本条结果按时间顺序附上，对应时间点：${stamps}。\n请基于实际画面回答，不要凭文件名猜测内容；引用画面时请标注时间点（如 00:23）。`
            ),
            ...set.frames.map((f) => ({ type: 'image' as const, data: f.data, mimeType: f.mimeType }))
          ],
          details: {
            ok: true,
            kind: 'video',
            absPath: target.absPath,
            decoded: true,
            frames: set.frames.length,
            durationSec: set.durationSec,
            sceneEnhanced: set.sceneEnhanced,
            deduped: set.deduped,
            cached: set.cached
          }
        }
      }

      if (target.kind !== 'image') {
        return {
          content: [
            textBlock(`${summary}\n该类型文件不在本工具的解读范围（图片/视频/音频之外）。文本内容请用 read 工具；其它格式请让用户说明用途。`)
          ],
          details: { ok: true, kind: target.kind, absPath: target.absPath, decoded: false }
        }
      }

      if (!ctx.supportsImageInput()) {
        return {
          content: [
            textBlock(
              `${summary}\n当前会话使用的模型没有声明图片输入能力，所以本工具没有回传图片 —— 回传了也会被协议层丢弃，` +
                `那样只会得到一个"附件已发送"的假象。确实需要看图时，请告诉用户把会话模型换成支持视觉的模型` +
                `（设置 → 模型供应商里该模型需带「视觉」标记），或让用户直接描述图片内容。`
            )
          ],
          details: { ok: true, kind: 'image', absPath: target.absPath, decoded: false, reason: 'model-no-vision' }
        }
      }

      if (size > MAX_IMAGE_BYTES) {
        return {
          content: [textBlock(`${summary}\n图片超过 ${humanBytes(MAX_IMAGE_BYTES)}，主进程不解码（会占住内存）。请让用户提供更小的图或截图局部。`)],
          details: { ok: true, kind: 'image', absPath: target.absPath, decoded: false, reason: 'too-large' }
        }
      }

      const image = readImageFileAsBase64(target.absPath, READ_MEDIA_MAX_EDGE)
      if (!image) {
        return {
          content: [textBlock(`${summary}\n图片解码失败（nativeImage 不支持该格式或文件已损坏）。可以试着让用户重新导入。`)],
          details: { ok: true, kind: 'image', absPath: target.absPath, decoded: false, reason: 'decode-failed' }
        }
      }

      // 元数据 + 图块一起回：图块给"看见"，文本给可引用的路径与尺寸（多轮后图被压缩掉时仍有凭据）
      return {
        content: [
          textBlock(`${summary}\n原图 ${image.width}×${image.height}px，已缩到 ${READ_MEDIA_MAX_EDGE}px 内以 JPEG 随本条结果附上，请基于实际画面回答，不要凭文件名猜测内容。`),
          { type: 'image', data: image.data, mimeType: image.mimeType }
        ],
        details: { ok: true, kind: 'image', absPath: target.absPath, decoded: true, width: image.width, height: image.height }
      }
    }
  }
}
