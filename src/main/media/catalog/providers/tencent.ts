import { defineProvider } from '../define'

/**
 * 腾讯云混元内置目录（2026-10 对照 cloud.tencent.com 官方接口文档核实，
 * 生图走 hunyuan 服务、生视频走 vclm 服务，协议核实记录详见 adapters/tencent.ts）：
 * - 混元生图：SubmitHunyuanImageJob / QueryHunyuanImageJob 异步任务，
 *   Resolution 为「宽:高」枚举且覆盖本应用全部 5 档比例（参考图场景仅 1:1/3:4/4:3）；
 * - 混元生视频：SubmitHunyuanToVideoJob / DescribeHunyuanToVideoJob 异步任务，
 *   720p 固定分辨率、无时长参数（模型自定），Image 可选（有图即首帧图生视频），
 *   无比例参数（随提示词/首帧）。
 * 未入库模型经 workspace.json media.userProviders 声明即可，无需改代码。
 */
export default defineProvider({
  id: 'tencent',
  label: '腾讯混元',
  adapter: 'gateway-tencent',
  auth: {
    env: 'TENCENT_KEY',
    label: '腾讯云 API 密钥（SecretId:SecretKey，冒号分隔）',
    helpUrl: 'https://console.cloud.tencent.com/cam/capi'
  },
  region: 'cn-direct',
  models: [
    /* ---------------- 图片 ---------------- */
    {
      id: 'tencent/hunyuan-image',
      kind: 'image',
      label: '混元生图',
      remoteModel: 'hunyuan-image',
      costHint: '按张计费（参考图场景仅支持 1:1/3:4/4:3 档；默认加"AI 生成"水印，置 0 需控制台申请）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },

    /* ---------------- 视频 ---------------- */
    {
      id: 'tencent/hunyuan-video',
      kind: 'video',
      label: '混元生视频',
      remoteModel: 'hunyuan-video',
      costHint: '按条计费（720p 固定分辨率；时长与比例由模型按提示词/首帧自定）',
      capabilities: { maxRefImages: 1 }
    }
  ]
})
