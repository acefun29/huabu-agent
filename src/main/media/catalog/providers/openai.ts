import { defineProvider } from '../define'

/**
 * OpenAI 官方内置目录（gateway-openai-compat 协议家族）。
 *
 * 模型清单 2026-09-22 对照官方 openai-node SDK 的模型枚举核实
 * （openai/openai-node@master src/resources/images.ts 的 ImageModel 与
 * audio/speech.ts 的 SpeechModel；platform.openai.com 文档页有反爬，SDK 类型
 * 定义是官方 API 契约的同等来源）。核实记录：
 * - 图片在列：gpt-image-2.5-flare（2026-09-08 快照）、gpt-image-2.5-sunburst、
 *   gpt-image-2、gpt-image-1.5（图片编辑默认值）、gpt-image-1 系列、dall-e-2/3；
 * - 语音在列：tts-1、tts-1-hd、gpt-4o-mini-tts（2025-12-15 快照）。
 * 只放官方端点确实支持的模型；视频类本协议族不支持。兼容网关（硅基流动、
 * 302.AI 等）不要往这里加——用户在设置页「新增供应商」选 OpenAI 兼容类型
 * + 填 baseUrl 即可接入，零代码。
 */
export default defineProvider({
  id: 'openai',
  label: 'OpenAI',
  adapter: 'gateway-openai-compat',
  auth: { env: 'OPENAI_KEY', label: 'OpenAI API Key', helpUrl: 'https://platform.openai.com/api-keys' },
  region: 'global',
  models: [
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
