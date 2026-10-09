import { defineProvider } from '../define'

/**
 * 阿里云百炼内置目录（2026-10-09 逐页对照 help.aliyun.com/zh/model-studio 官方文档核实：
 * model-list-image-generation、model-list-video-generation、wan-image-generation-and-
 * editing-api-reference、qwen-image-generation-and-editing-api-reference、
 * wan3-0-video、happyhorse-image-to-video-api-reference、happyhorse-text-to-video-api-reference）。
 *
 * 模型 id 是稳定承诺（合入后不得改名）；价格随官方调价漂移，costHint 标「约」。
 * 协议核实记录（详见 adapters/dashscope.ts）：
 * - 图片新协议（image-generation/generation + input.messages + choices 产物）覆盖
 *   wan2.6 起与 qwen-image 全系：万相与千问是同一端点、同一请求体、同一产物结构；
 * - 视频新参数（resolution + ratio + duration 整数）覆盖 wan2.7 起与 happyhorse 族；
 * - wan2.5 及以下走旧协议（text2image/image-synthesis 与 video-synthesis + size 字段）。
 * - 图生图：wan2.7-image(-pro) / qwen-image-3.0(-pro) 与文生图同端点，content 追加
 *   {image}（支持 data URI）；
 * - 图生视频：wan2.7-i2v / wan3.0-video(-prime) / happyhorse-1.1-i2v 走
 *   input.media[{type:'first_frame'}]（支持 data URI）。
 * - 官方「选择模型」页当前推荐位（2026-10 快照）：图像 qwen-image-3.0-pro 居首，
 *   视频 wan3.0-video / wan3.0-video-prime / happyhorse-1.1 三件套。
 * wan2.2 家族已让位，标 deprecated 保留（老任务可回放，新建入口不再出现）。
 */
export default defineProvider({
  id: 'dashscope',
  label: '阿里云百炼',
  adapter: 'gateway-dashscope',
  auth: {
    env: 'DASHSCOPE_KEY',
    label: '百炼 API Key',
    helpUrl: 'https://bailian.console.aliyun.com/?apiKey=1'
  },
  region: 'cn-direct',
  models: [
    /* ---------------- 图片 ---------------- */
    {
      id: 'dashscope/qwen-image-3.0-pro',
      kind: 'image',
      label: '千问图像 3.0 Pro（最新旗舰）',
      remoteModel: 'qwen-image-3.0-pro',
      costHint: '按张计费（文生图/图生图统一；像素窗口 512²~2048²，1~3 张参考图）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        maxRefImages: 3
      }
    },
    {
      id: 'dashscope/qwen-image-3.0',
      kind: 'image',
      label: '千问图像 3.0（兼顾质量与速度）',
      remoteModel: 'qwen-image-3.0',
      costHint: '按张计费（3.0 标准档，1~3 张参考图）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        maxRefImages: 3
      }
    },
    {
      id: 'dashscope/wan2.7-image',
      kind: 'image',
      label: '通义万相 2.7 图像生成与编辑',
      remoteModel: 'wan2.7-image',
      costHint: '按张计费（文生图/图生图统一；图生图指定比例时按比例出图，未指定则随参考图）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        maxRefImages: 1
      }
    },
    {
      id: 'dashscope/wan2.7-image-pro',
      kind: 'image',
      label: '通义万相 2.7 图像生成与编辑 Pro',
      remoteModel: 'wan2.7-image-pro',
      costHint: '按张计费（专业版：文生图 4K / 编辑 2K；图生图指定比例时按比例出图，未指定则随参考图）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        maxRefImages: 1
      }
    },
    {
      id: 'dashscope/wan2.6-image',
      kind: 'image',
      label: '通义万相 2.6 图像生成与编辑',
      remoteModel: 'wan2.6-image',
      costHint: '按张计费（新协议；图生图指定比例时按比例出图，未指定则随参考图）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        maxRefImages: 1
      }
    },
    {
      id: 'dashscope/wan2.6-t2i',
      kind: 'image',
      label: '通义万相 2.6 文生图',
      remoteModel: 'wan2.6-t2i',
      costHint: '按张计费（新一代协议，画质与文字渲染提升）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },
    {
      id: 'dashscope/wan2.5-t2i-preview',
      kind: 'image',
      label: '通义万相 2.5 文生图 Preview',
      remoteModel: 'wan2.5-t2i-preview',
      costHint: '按张计费（旧协议稳定档）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },
    {
      id: 'dashscope/wan2.2-t2i-flash',
      kind: 'image',
      label: '通义万相 2.2 文生图 Flash（旧版）',
      remoteModel: 'wan2.2-t2i-flash',
      costHint: '约 0.14 元/张',
      status: 'deprecated',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },
    {
      id: 'dashscope/wan2.2-t2i-plus',
      kind: 'image',
      label: '通义万相 2.2 文生图 Plus（旧版）',
      remoteModel: 'wan2.2-t2i-plus',
      costHint: '约 0.20 元/张',
      status: 'deprecated',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },

    /* ---------------- 视频 ---------------- */
    {
      id: 'dashscope/wan3.0-video-prime',
      kind: 'video',
      label: '通义万相 3.0 视频 优速版（快速档）',
      remoteModel: 'wan3.0-video-prime',
      costHint: '按秒计费（与 wan3.0-video 同能力，生成更快；2~30 秒 1080P 30fps，含音轨）',
      capabilities: {
        durations: [5, 10, 15, 20, 30],
        maxRefImages: 1
      }
    },
    {
      id: 'dashscope/happyhorse-1.1-i2v',
      kind: 'video',
      label: 'HappyHorse 1.1 图生视频（首帧，有声）',
      remoteModel: 'happyhorse-1.1-i2v',
      costHint: '约 0.9 元/秒@720P（首帧图生；3~15 秒，默认加水印）',
      capabilities: {
        durations: [5, 10, 15],
        maxRefImages: 1
      }
    },
    {
      id: 'dashscope/happyhorse-1.1-t2v',
      kind: 'video',
      label: 'HappyHorse 1.1 文生视频（有声）',
      remoteModel: 'happyhorse-1.1-t2v',
      costHint: '约 0.9 元/秒@720P（文生；3~15 秒，默认加水印）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        durations: [5, 10, 15]
      }
    },
    {
      id: 'dashscope/wan3.0-video',
      kind: 'video',
      label: '通义万相 3.0 视频（全能：文生/图生/参考生）',
      remoteModel: 'wan3.0-video',
      costHint: '按秒计费（2~30 秒 1080P 30fps，含音轨；挂参考图即首帧图生视频）',
      capabilities: {
        durations: [5, 10, 15, 20, 30],
        maxRefImages: 1
      }
    },
    {
      id: 'dashscope/wan2.7-i2v',
      kind: 'video',
      label: '通义万相 2.7 图生视频',
      remoteModel: 'wan2.7-i2v',
      costHint: '按秒计费（首帧图生视频，2~15 秒，720P/1080P）',
      capabilities: {
        durations: [5, 10, 15],
        maxRefImages: 1
      }
    },
    {
      id: 'dashscope/wan2.7-t2v',
      kind: 'video',
      label: '通义万相 2.7 文生视频',
      remoteModel: 'wan2.7-t2v',
      costHint: '按秒计费（支持 2~15 秒，720P/1080P）',
      capabilities: { durations: [5, 10, 15] }
    },
    {
      id: 'dashscope/wan2.2-t2v-plus',
      kind: 'video',
      label: '通义万相 2.2 文生视频 Plus（旧版）',
      remoteModel: 'wan2.2-t2v-plus',
      costHint: '按秒计费',
      status: 'deprecated',
      capabilities: { durations: [5, 10] }
    }
  ]
})
