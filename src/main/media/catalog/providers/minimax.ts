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
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        // 官方 V2 全模态参考：首/尾帧、9 参考图、3 参考视频、3 参考音频
        // （三类素材都支持 data URI，是五家里唯一能免上传通道用本地视频的一家）
        refModes: ['t2v', 'i2v_first', 'i2v_fl', 'r2v'],
        refQuota: [
          { role: 'first_frame', max: 1 },
          { role: 'last_frame', max: 1 },
          { role: 'reference_image', max: 9 },
          { role: 'reference_video', max: 3 },
          { role: 'reference_audio', max: 3 }
        ]
      }
    },
    {
      id: 'minimax/h3-max',
      kind: 'video',
      label: 'MiniMax H3 Max 视频（快速档）',
      remoteModel: 'MiniMax-H3-Max',
      costHint: '按秒计费（480P/768P 快速档，5~15 秒，不支持 2K）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
        durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        // 与 H3 同一套 content 角色（官方 V2），上限同为 1/1/9/3/3
        refModes: ['t2v', 'i2v_first', 'i2v_fl', 'r2v'],
        refQuota: [
          { role: 'first_frame', max: 1 },
          { role: 'last_frame', max: 1 },
          { role: 'reference_image', max: 9 },
          { role: 'reference_video', max: 3 },
          { role: 'reference_audio', max: 3 }
        ]
      }
    }
  ]
})
