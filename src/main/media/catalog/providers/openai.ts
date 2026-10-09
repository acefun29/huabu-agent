import { defineProvider } from '../define'

/**
 * OpenAI 官方内置目录（gateway-openai-compat 协议家族）。
 *
 * 模型清单 2026-10-09 对照 openai-openapi 仓库核实（platform.openai.com 文档页有反爬，
 * OpenAPI spec 是官方 API 契约的同等来源）：
 * - 图片在列：images.md 的 ImageModel——gpt-image-2.5-flare（2026-09-08 快照）、
 *   gpt-image-2.5-sunburst、gpt-image-2、gpt-image-1.5（图片编辑默认值）、
 *   gpt-image-1 系列、dall-e-2/3；
 * - 视频在列：videos.md 的 VideoModel——sora-2、sora-3（异步任务制：POST /videos
 *   创建 → GET /videos/{id} 轮询 → GET /videos/{id}/content 取回 mp4；seconds
 *   官方枚举 4/8/12，input_reference 单图即首帧图生视频）；
 * - 语音在列：audio/speech.md 的 SpeechModel——tts-1、tts-1-hd、gpt-4o-mini-tts。
 * 只放官方端点确实支持的模型；兼容网关（硅基流动、302.AI 等）不要往这里加——
 * 用户在设置页「新增供应商」选 OpenAI 兼容类型 + 填 baseUrl 即可接入，零代码。
 */
export default defineProvider({
  id: 'openai',
  label: 'OpenAI',
  adapter: 'gateway-openai-compat',
  auth: { env: 'OPENAI_KEY', label: 'OpenAI API Key', helpUrl: 'https://platform.openai.com/api-keys' },
  region: 'global',
  models: [
    {
      id: 'openai/sora-3',
      kind: 'video',
      label: 'Sora 3（文生 / 首帧图生视频，最新）',
      remoteModel: 'sora-3',
      costHint: '按秒计费（官方定价页为准）',
      // seconds 官方枚举 4/8/12；size 官方形如 WxH，按应用比例体系只放横竖两档
      capabilities: { ratios: ['16:9', '9:16'], durations: [4, 8, 12], maxRefImages: 1 }
    },
    {
      id: 'openai/sora-2',
      kind: 'video',
      label: 'Sora 2（文生 / 首帧图生视频）',
      remoteModel: 'sora-2',
      costHint: '按秒计费（官方定价页为准）',
      capabilities: { ratios: ['16:9', '9:16'], durations: [4, 8, 12], maxRefImages: 1 }
    },
    {
      id: 'openai/gpt-image-2.5-flare',
      kind: 'image',
      label: 'GPT Image 2.5 Flare（最新）',
      remoteModel: 'gpt-image-2.5-flare',
      costHint: '按质量档与尺寸计费（官方定价页为准）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },
    {
      id: 'openai/gpt-image-1.5',
      kind: 'image',
      label: 'GPT Image 1.5',
      remoteModel: 'gpt-image-1.5',
      costHint: '按质量档与尺寸计费（官方图片编辑的默认模型）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },
    {
      id: 'openai/gpt-image-1',
      kind: 'image',
      label: 'GPT Image 1（旧版）',
      remoteModel: 'gpt-image-1',
      costHint: '约 $0.02–0.19/张（按质量档与尺寸）',
      status: 'deprecated',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },
    {
      id: 'openai/gpt-4o-mini-tts',
      kind: 'audio',
      label: 'GPT-4o mini TTS（语音合成，提示词即文稿）',
      remoteModel: 'gpt-4o-mini-tts',
      costHint: '按字符计费；时长由文稿长度决定'
    },
    {
      id: 'openai/tts-1',
      kind: 'audio',
      label: 'TTS-1（旧版语音合成）',
      remoteModel: 'tts-1',
      costHint: '约 $15/百万字符',
      status: 'deprecated'
    }
  ]
})
