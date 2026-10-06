import { defineProvider } from '../define'

/**
 * MiniMax 开放平台内置目录（2026-10 对照 platform.minimax.io 官方 API 文档核实，
 * 国内 api.minimaxi.com 实测同构）。协议核实记录详见 adapters/minimax.ts：
 * - image-01：/v1/image_generation 同步生图，aspect_ratio 枚举覆盖本应用全部 5 档比例；
 * - MiniMax-H3 / H3-Max：/v2/video_generation 异步视频（content 数组协议，原生有声），
 *   duration 为整数（H3 4~15、H3-Max 5~15），图生视频比例随首帧、文生视频必传比例。
 * 未入库模型经 workspace.json media.userProviders 声明即可，无需改代码。
 */
export default defineProvider({
  id: 'minimax',
  label: 'MiniMax',
  adapter: 'gateway-minimax',
  auth: {
    env: 'MINIMAX_KEY',
    label: 'MiniMax API Key',
    helpUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key'
  },
  region: 'cn-direct',
  models: [
    /* ---------------- 图片 ---------------- */
    {
      id: 'minimax/image-01',
      kind: 'image',
      label: 'MiniMax 生图（image-01）',
      remoteModel: 'image-01',
      costHint: '按张计费（垫图为人像主体参考；8 档比例枚举，不收自由像素）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },

    /* ---------------- 视频 ---------------- */
    {
      id: 'minimax/h3',
      kind: 'video',
      label: 'MiniMax H3 视频（原生有声）',
      remoteModel: 'MiniMax-H3',
      costHint: '按秒计费（768P/2K，4~15 秒；图生视频比例随首帧）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        maxRefImages: 1
      }
    },
    {
      id: 'minimax/h3-max',
      kind: 'video',
      label: 'MiniMax H3 Max 视频（快速档）',
      remoteModel: 'MiniMax-H3-Max',
      costHint: '按秒计费（480P/768P 快速档，5~15 秒，不支持 2K）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        maxRefImages: 1
      }
    }
  ]
})
