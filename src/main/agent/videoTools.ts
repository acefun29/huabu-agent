import { join } from 'path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { MediaRoots } from '../../shared/assets'
import { MEDIA_SRC_MARKER } from './contextEviction'
import {
  SWITCH_VISION_MODEL_HINT,
  humanBytes,
  pathGuard,
  resolveMediaEntry,
  textResult
} from './mediaReadCommon'
import {
  MAX_VIDEO_BYTES,
  extractVideoFrames,
  formatMediaTime,
  parseMediaTime
} from '../media/videoFrames'

/**
 * `skim_video(path)` + `read_video_frames(path, t1, t2, hi_res?)` —— 视频 Agent 化两工具
 * （视频理解 M2/M3 的 pi 无阻塞部分；M4 起视频读取全部收口到这对工具，
 * read_media 遇到视频只指路到这里）。
 *
 * 把"看视频"拆成两级范式（Gemini agentic video / VideoAgent 验证，长视频省 ~88% token）：
 *
 * 1. **skim_video**：低分辨率（384px）× 少帧（6）全片粗扫 + 时长/摘要文本，
 *    建立"哪一段大概在讲什么"的全局认知；
 * 2. **read_video_frames**：带着 skim 得到的时间定位，对 [t1, t2] 区间高分辨率精读
 *    （768px，hi_res 时 1024px），一次只看一小段。
 *
 * 设计约束：
 * - **帧就是图片块**：两工具的视觉闸门同源 —— 模型不声明图片输入时，
 *   skim 只回文本元数据（粗扫仍有价值），read_video_frames 干脆不抽（区间帧没有文本价值）。
 * - **时间入参收得起 MM:SS**：我们在提示词里要求模型用 MM:SS 引用画面，就得接受它
 *   原样传回来 —— parseMediaTime 兼容数字秒 / "90" / "MM:SS" / "H:MM:SS"。
 * - **区间上限 300s**：精读的"精"建立在区间小而清上；超过 5 分钟该先 skim 定位再切。
 */

/** 粗扫帧最长边：全局认知只需"认得出场景"，384px 足够且单帧 token 减半再减半 */
const SKIM_MAX_EDGE = 384

/** 粗扫帧数：目的是定位，不是精读 */
const SKIM_MAX_FRAMES = 6

/** 精读最长边：hi_res 时给到与图片分支同档的 1024px */
const READ_MAX_EDGE = 768
const READ_MAX_EDGE_HI = 1024

/** 精读帧数 */
const READ_MAX_FRAMES = 8

/** 单次精读的区间上限（秒）：超过就该回去 skim 重新定位 */
const READ_RANGE_LIMIT_SEC = 300

export interface VideoToolsContext {
  /** 每次现读：工作区可切换，media.outputDir 也可在运行中改 */
  roots: () => MediaRoots | null
  /** 当前会话的对话模型是否声明图片输入（决定回不回帧图片块） */
  supportsImageInput: () => boolean
}

export function createVideoTools(ctx: VideoToolsContext): ToolDefinition[] {
  const cacheDir = (roots: MediaRoots): string => join(roots.workspaceDir, '.huabu', 'vframes')

  const skim: ToolDefinition = {
    name: 'skim_video',
    label: '粗扫视频',
    description:
      '视频读取的入口：低成本粗扫整个视频，返回时长与 ' + SKIM_MAX_FRAMES + ' 张低分辨率关键帧（覆盖全片），用于建立全局认知、定位感兴趣的区间。' +
      '定位到区间后用 read_video_frames 高清精读。参数是视频的绝对路径（引用素材清单里那条）。',
    parameters: Type.Object({
      path: Type.String({ description: '视频文件路径：优先用引用素材清单里给出的绝对路径' })
    }),
    execute: async (_toolCallId, params) => {
      const requested = String((params as { path?: unknown })?.path ?? '').trim()
      const guard = pathGuard('skim_video', requested, ctx.roots(), '（引用素材清单里给出的视频绝对路径）')
      if ('error' in guard) return textResult(guard.error, { ok: false, reason: guard.reason })

      const found = await resolveMediaEntry(requested, guard.roots, { kind: 'video' })
      if ('error' in found) return textResult(found.error, { ok: false, reason: found.reason, requested })
      const { absPath, size, summary } = found.entry

      if (size > MAX_VIDEO_BYTES) {
        return textResult(
          `${summary}\n视频超过 ${humanBytes(MAX_VIDEO_BYTES)}，不做抽帧。请让用户裁剪或压缩后再试。`,
          { ok: true, decoded: false, reason: 'too-large' }
        )
      }

      const extraction = await extractVideoFrames(absPath, {
        cacheDir: cacheDir(guard.roots),
        maxEdge: SKIM_MAX_EDGE,
        maxFrames: SKIM_MAX_FRAMES
      })
      if (!extraction.ok) {
        return textResult(
          `${summary}\n视频粗扫失败（${extraction.code}）。常见原因是编码不受支持或文件损坏；可让用户重新导出为 MP4（H.264）。`,
          { ok: true, decoded: false, reason: 'video-decode-failed' }
        )
      }
      const set = extraction.value
      const stamps = set.frames.map((f, i) => `帧${i + 1}=${formatMediaTime(f.ptsSec)}`).join('、')
      const vision = ctx.supportsImageInput()

      // 无视觉模型仍回元数据 + 时间轴：粗扫的一半价值（知道多长、切成几段）不依赖画面
      const header =
        `${summary}\n时长 ${formatMediaTime(set.durationSec)}；已粗扫 ${set.frames.length} 个低分辨率关键帧覆盖全片，时间点：${stamps}。\n` +
        (vision
          ? `帧已随本条结果附上。基于粗扫定位到感兴趣的区间后，用 read_video_frames(path, t1, t2) 高清精读该区间；引用画面请标注时间点（MM:SS）。\n${MEDIA_SRC_MARKER}${absPath}]`
          : `当前会话模型没有声明图片输入能力，帧图块没有回传（回传也会被协议层丢弃）。可基于时间轴与文件信息做初步判断；确实需要看画面时，${SWITCH_VISION_MODEL_HINT}。`)
      return {
        content: [
          { type: 'text', text: header },
          ...(vision ? set.frames.map((f) => ({ type: 'image' as const, data: f.data, mimeType: f.mimeType })) : [])
        ],
        details: {
          ok: true,
          decoded: vision,
          frames: vision ? set.frames.length : 0,
          durationSec: set.durationSec,
          sceneEnhanced: set.sceneEnhanced,
          deduped: set.deduped,
          cached: set.cached
        }
      }
    }
  }

  const readFrames: ToolDefinition = {
    name: 'read_video_frames',
    label: '精读视频区间',
    description:
      '对视频的一个时间区间做高分辨率精读：在 [t1, t2] 内抽取至多 ' + READ_MAX_FRAMES + ' 帧（默认 ' + READ_MAX_EDGE + 'px，hi_res 时 ' + READ_MAX_EDGE_HI + 'px）。' +
      '先用 skim_video 粗扫定位区间，再用它看清细节。区间上限 ' + READ_RANGE_LIMIT_SEC / 60 + ' 分钟。' +
      '时间参数接受秒数或 "MM:SS" / "H:MM:SS" 格式。',
    parameters: Type.Object({
      path: Type.String({ description: '视频文件路径：优先用引用素材清单里给出的绝对路径' }),
      t1: Type.String({ description: '区间起点：秒数（如 90）或 MM:SS（如 01:30）' }),
      t2: Type.String({ description: '区间终点：秒数或 MM:SS；缺省为起点 +60 秒' }),
      hi_res: Type.Optional(Type.Boolean({ description: 'true 时帧最长边 1024px（默认 768px），看文字/小字时用' }))
    }),
    execute: async (_toolCallId, params) => {
      const p = params as { path?: unknown; t1?: unknown; t2?: unknown; hi_res?: unknown }
      const requested = String(p?.path ?? '').trim()
      const guard = pathGuard('read_video_frames', requested, ctx.roots(), '（引用素材清单里给出的视频绝对路径）')
      if ('error' in guard) return textResult(guard.error, { ok: false, reason: guard.reason })

      const found = await resolveMediaEntry(requested, guard.roots, { kind: 'video' })
      if ('error' in found) return textResult(found.error, { ok: false, reason: found.reason, requested })
      const { absPath, size, summary } = found.entry

      if (!ctx.supportsImageInput()) {
        return textResult(
          `${summary}\n当前会话模型没有声明图片输入能力，区间帧没有回传（回传也会被协议层丢弃）。精读画面需要换支持视觉的模型。`,
          { ok: true, decoded: false, reason: 'model-no-vision' }
        )
      }
      if (size > MAX_VIDEO_BYTES) {
        return textResult(`${summary}\n视频超过 ${humanBytes(MAX_VIDEO_BYTES)}，不做抽帧。`, { ok: true, decoded: false, reason: 'too-large' })
      }

      const t1 = parseMediaTime(p?.t1)
      if (t1 === null) {
        return textResult(
          `t1 不是可解析的时间点：${String(p?.t1)}。接受秒数（90）、"MM:SS"（01:30）或 "H:MM:SS"。`,
          { ok: true, decoded: false, reason: 'bad-time' }
        )
      }
      const t2Given = p?.t2 !== undefined && p?.t2 !== null && String(p.t2).trim() !== ''
      let t2 = parseMediaTime(p?.t2)
      if (t2 === null && t2Given) {
        return textResult(
          `t2 不是可解析的时间点：${String(p?.t2)}。接受秒数（90）、"MM:SS"（01:30）或 "H:MM:SS"；也可以不传（默认起点 +60 秒）。`,
          { ok: true, decoded: false, reason: 'bad-time' }
        )
      }
      if (t2 === null) t2 = t1 + 60
      if (t2 - t1 > READ_RANGE_LIMIT_SEC) {
        return textResult(
          `区间 ${formatMediaTime(t1)} ~ ${formatMediaTime(t2)} 超过单次精读上限（${READ_RANGE_LIMIT_SEC / 60} 分钟）。请先用 skim_video 定位到更小的区间再精读。`,
          { ok: true, decoded: false, reason: 'range-too-wide' }
        )
      }

      const extraction = await extractVideoFrames(absPath, {
        cacheDir: cacheDir(guard.roots),
        t1,
        t2,
        maxEdge: p?.hi_res === true ? READ_MAX_EDGE_HI : READ_MAX_EDGE,
        maxFrames: READ_MAX_FRAMES
      })
      if (!extraction.ok) {
        const hint =
          extraction.code === 'bad-range'
            ? '请检查 t1/t2 是否超出视频时长或顺序颠倒；不确定时长就先 skim_video。'
            : '常见原因是编码不受支持或文件损坏；可让用户重新导出为 MP4（H.264）。'
        return textResult(
          `${summary}\n区间精读失败（${extraction.code}）：${extraction.error}\n${hint}`,
          { ok: true, decoded: false, reason: extraction.code === 'bad-range' ? 'bad-range' : 'video-decode-failed' }
        )
      }
      const set = extraction.value
      const stamps = set.frames.map((f, i) => `帧${i + 1}=${formatMediaTime(f.ptsSec)}`).join('、')
      const range = `${formatMediaTime(t1)} ~ ${formatMediaTime(Math.min(t2, set.durationSec))}`
      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n精读区间 ${range}（时长上限 ${READ_RANGE_LIMIT_SEC / 60} 分钟内）：已抽取 ${set.frames.length} 帧（最长边 ≤${p?.hi_res === true ? READ_MAX_EDGE_HI : READ_MAX_EDGE}px${set.deduped ? '，已剔除重复画面' : ''}），对应时间点：${stamps}。\n请基于实际画面回答；引用画面请标注时间点（MM:SS）。区间外内容未读取，不要对其下结论。\n${MEDIA_SRC_MARKER}${absPath}]`
          },
          ...set.frames.map((f) => ({ type: 'image' as const, data: f.data, mimeType: f.mimeType }))
        ],
        details: {
          ok: true,
          decoded: true,
          frames: set.frames.length,
          durationSec: set.durationSec,
          t1,
          t2,
          hiRes: p?.hi_res === true,
          deduped: set.deduped,
          cached: set.cached
        }
      }
    }
  }

  return [skim, readFrames]
}
