import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { MediaRoots } from '../../shared/assets'
import {
  SWITCH_VISION_MODEL_HINT,
  humanBytes,
  pathGuard,
  resolveMediaEntry,
  textResult
} from './mediaReadCommon'
import { readImageFileAsBase64 } from '../media/artifactImage'
import { MEDIA_SRC_MARKER } from './contextEviction'

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
 * 2. **路径判定全在 `shared/assets.ts` 的纯函数里**（`resolveMediaTarget`，经
 *    mediaReadCommon 收口），由 `pnpm asset-path:check` 断言越界与分类；本文件不做
 *    字符串前缀判断。stat/读图走异步——素材读取在主进程，同步 IO 会卡住聊天流。
 * 3. **文本类不重复实现**：`read` 已在工具白名单（host.ts 的 TOOL_ALLOWLIST），
 *    这里遇到文本就指过去，避免两套截断规则互相漂移。
 * 4. **视频只指路不抽帧**：视频读取统一走 skim_video（全片粗扫）+ read_video_frames
 *    （区间精读）的两级范式——read_media 曾有自己的整段快照分支，与 skim_video 同一条
 *    抽帧管线、同档参数，职能重叠还让模型在三个工具里挑花眼（M4 收敛）。
 *    音频一期仍不解码——没有 ASR 能力，"猜一段音频里有什么"比明说读不了更坏。
 */

export interface ReadMediaContext {
  /** 每次现读：工作区可切换，media.outputDir 也可在运行中改 */
  roots: () => MediaRoots | null
  /** 当前会话的对话模型是否声明图片输入（决定回不回图片块） */
  supportsImageInput: () => boolean
}

/** 送进解码前先拒掉超大文件：解码是主进程内存，一张 60MB TIFF 能卡住整个会话 */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024

/** 与 M13 多模态回传同一档：1024px 内足够"看懂内容"，再大只是烧 token */
const READ_MEDIA_MAX_EDGE = 1024

export function createReadMediaTool(ctx: ReadMediaContext): ToolDefinition {
  return {
    name: 'read_media',
    label: '读取素材',
    description:
      '按路径读取工作区内的图片素材，把画面交给你看。参数是引用素材清单里的那条绝对路径（也接受工作区相对路径）。' +
      '文本文件请用 read 工具；视频请用 skim_video / read_video_frames；音频只给出文件信息（一期无转写能力）。',
    parameters: Type.Object({
      path: Type.String({
        description: '图片文件路径：优先用引用清单里给出的绝对路径；相对路径按工作区解析'
      })
    }),
    execute: async (_toolCallId, params) => {
      const requested = String((params as { path?: unknown })?.path ?? '').trim()
      const guard = pathGuard('read_media', requested, ctx.roots(), '（请传引用素材清单里给出的绝对路径）')
      if ('error' in guard) return textResult(guard.error, { ok: false, reason: guard.reason })

      const found = await resolveMediaEntry(requested, guard.roots)
      if ('error' in found) {
        // 文案要能自纠：给允许范围 + 提醒用引用清单原样的绝对路径，而不是让 Agent 反复猜路径
        return textResult(found.error, { ok: false, reason: found.reason, requested })
      }
      const { absPath, kind, size, summary } = found.entry

      if (kind === 'text') {
        return textResult(
          `${summary}\n这是文本文件，请改用 read 工具读取内容（本工具只处理图片的读取与展示）。`,
          { ok: true, kind, absPath, handedOff: 'read' }
        )
      }

      if (kind === 'video') {
        return textResult(
          `${summary}\n这是视频文件，本工具不对视频抽帧。请改用 skim_video 粗扫全片（时长 + 带时间戳的低分辨率关键帧），` +
            `需要看清某段画面时再用 read_video_frames 对该区间高清精读。`,
          { ok: true, kind, absPath, handedOff: 'skim_video' }
        )
      }

      if (kind === 'audio') {
        return textResult(
          `${summary}\n这是音频文件，本工具一期没有语音转写（ASR）能力，无法得知声音内容。` +
            `需要音频信息时，请让用户提供文字稿，或改用图片/视频素材。`,
          { ok: true, kind, absPath, decoded: false }
        )
      }

      if (kind !== 'image') {
        return textResult(
          `${summary}\n该类型文件不在本工具的解读范围（图片之外）。文本内容请用 read 工具；视频请用 skim_video；其它格式请让用户说明用途。`,
          { ok: true, kind, absPath, decoded: false }
        )
      }

      if (!ctx.supportsImageInput()) {
        return textResult(
          `${summary}\n当前会话使用的模型没有声明图片输入能力，所以本工具没有回传图片 —— 回传了也会被协议层丢弃，` +
            `那样只会得到一个"附件已发送"的假象。确实需要看图时，${SWITCH_VISION_MODEL_HINT}，或让用户直接描述图片内容。`,
          { ok: true, kind, absPath, decoded: false, reason: 'model-no-vision' }
        )
      }

      if (size > MAX_IMAGE_BYTES) {
        return textResult(
          `${summary}\n图片超过 ${humanBytes(MAX_IMAGE_BYTES)}，主进程不解码（会占住内存）。请让用户提供更小的图或截图局部。`,
          { ok: true, kind, absPath, decoded: false, reason: 'too-large' }
        )
      }

      const image = await readImageFileAsBase64(absPath, READ_MEDIA_MAX_EDGE)
      if (!image) {
        return textResult(
          `${summary}\n图片解码失败（nativeImage 不支持该格式或文件已损坏）。可以试着让用户重新导入。`,
          { ok: true, kind, absPath, decoded: false, reason: 'decode-failed' }
        )
      }

      // 元数据 + 图块一起回：图块给"看见"，文本给可引用的路径与尺寸（多轮后图被压缩掉时仍有凭据）；
      // 标记行供历史淘汰层提取锚点路径（contextEviction）
      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n原图 ${image.width}×${image.height}px，已缩到 ${READ_MEDIA_MAX_EDGE}px 内以 JPEG 随本条结果附上，请基于实际画面回答，不要凭文件名猜测内容。\n${MEDIA_SRC_MARKER}${absPath}]`
          },
          { type: 'image', data: image.data, mimeType: image.mimeType }
        ],
        details: { ok: true, kind, absPath, decoded: true, width: image.width, height: image.height }
      }
    }
  }
}
