import { defineProvider } from '../define'

/**
 * 阿里云百炼内置目录（2026-09-22 对照 help.aliyun.com/zh/model-studio 官方文档核实；
 * 图生图/图生视频 2026-09-25 增补，逐页核对 wan-image-generation-and-editing-api-reference、
 * image-to-video-general-api-reference、wan3-video-generation-api-reference）。
 *
 * 模型 id 是稳定承诺（合入后不得改名）；价格随官方调价漂移，costHint 标「约」。
 * 协议核实记录（详见 adapters/dashscope.ts）：
 * - wan2.6-t2i 起走新图片协议（image-generation/generation + messages + choices 产物）；
 * - wan2.7-t2v 起走新视频参数（resolution + ratio + duration 整数 [2,15]）；
 * - wan2.5 及以下走旧协议（text2image/image-synthesis 与 video-synthesis + size 字段）。
 * - 图生图：wan2.7-image(-pro) 与文生图同端点，content 追加 {image}（支持 data URI）；
 * - 图生视频：wan2.7-i2v / wan3.0-video 走 input.media[{type:'first_frame'}]（支持 data URI）。
 * 端点核实：wan2.6-t2i、wan2.7-t2v、wan2.5-t2i-preview 均在官方 API 参考页在列；
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
