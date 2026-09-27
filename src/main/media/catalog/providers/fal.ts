import { defineProvider } from '../define'

/**
 * fal.ai 聚合网关内置目录（2026-09 对照 fal.ai 模型页/官方博客核实端点）。
 *
 * 模型 id 是稳定承诺（合入后不得改名，用户配置与 Agent 默认都引用它）；
 * 厂商升级时老条目标 deprecated 保留，新模型加新条目。
 * 端点核实记录：FLUX.2 家族（fal-ai/flux-2-pro / flux-2/turbo / flux-2/flash）、
 * Veo 3.1（fal-ai/veo3.1 与 /fast）、Kling 3.0（fal-ai/kling-video/o3/pro/text-to-video）、
 * Hailuo 02 Pro（fal-ai/minimax/hailuo-02/pro）、Nano Banana Pro（fal-ai/gemini-3-pro-image-preview）、
 * ACE-Step（fal-ai/ace-step，$0.0002/秒）。Suno 不在 fal 上架，音乐走 ACE-Step。
 * 未入库模型（Seedance 2.0、MiniMax Music 等）经 workspace.json media.userProviders 声明即可，
 * 无需改代码。
 */
export default defineProvider({
  id: 'fal',
  label: 'fal.ai 聚合网关',
  adapter: 'gateway-fal',
  auth: { env: 'FAL_KEY', label: 'fal.ai API Key', helpUrl: 'https://fal.ai/dashboard/keys' },
  region: 'global',
  models: [
    /* ---------------- 图片 ---------------- */
    {
      id: 'fal/flux-2-flash',
      kind: 'image',
      label: 'FLUX.2 Flash',
      remoteModel: 'fal-ai/flux-2/flash',
      costHint: '约 $0.005/百万像素（默认首选，成本最低）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },
    {
      id: 'fal/flux-2-turbo',
      kind: 'image',
      label: 'FLUX.2 Turbo',
      remoteModel: 'fal-ai/flux-2/turbo',
      costHint: '约 $0.008/百万像素',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },
    {
      id: 'fal/flux-2-pro',
      kind: 'image',
      label: 'FLUX.2 Pro',
      remoteModel: 'fal-ai/flux-2-pro',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },
    {
      id: 'fal/nano-banana-pro',
      kind: 'image',
      label: 'Nano Banana Pro（Gemini 3 Image）',
      remoteModel: 'fal-ai/gemini-3-pro-image-preview',
      costHint: '约 $0.15/张（文字渲染与指令遵循强）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },

    /* ---------------- 视频 ---------------- */
    {
      id: 'fal/veo3.1',
      kind: 'video',
      label: 'Veo 3.1（含原生音频）',
      remoteModel: 'fal-ai/veo3.1',
      costHint: '按秒计费，高质量档',
      capabilities: { durations: [4, 6, 8], maxRefImages: 1 }
    },
    {
      id: 'fal/veo3.1-fast',
      kind: 'video',
      label: 'Veo 3.1 Fast',
      remoteModel: 'fal-ai/veo3.1/fast',
      costHint: '按秒计费（Veo 3.1 的低价快速档）',
      capabilities: { durations: [4, 6, 8], maxRefImages: 1 }
    },
    {
      id: 'fal/kling-3-pro',
      kind: 'video',
      label: 'Kling 3.0 Pro',
      remoteModel: 'fal-ai/kling-video/o3/pro/text-to-video',
      capabilities: { durations: [5, 10], maxRefImages: 1 }
    },
    {
      id: 'fal/hailuo-02-pro',
      kind: 'video',
      label: 'Hailuo 02 Pro',
      remoteModel: 'fal-ai/minimax/hailuo-02/pro/text-to-video',
      costHint: '约 $0.08/秒',
      capabilities: { durations: [6, 10], maxRefImages: 1 }
    },

    /* ---------------- 音频 ---------------- */
    {
      id: 'fal/ace-step',
      kind: 'audio',
      label: 'ACE-Step（音乐/音效）',
      remoteModel: 'fal-ai/ace-step',
      costHint: '约 $0.0002/秒（$1 ≈ 83 分钟）',
      capabilities: { durations: [30, 60, 120] }
    }
  ]
})
