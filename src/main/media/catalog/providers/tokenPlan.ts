import { defineProvider } from '../define'

/**
 * 阿里云百炼 Token Plan（订阅制）内置媒体目录
 * （2026-11-03 对照 help.aliyun.com/zh/model-studio 官方文档核实：
 * token-plan-personal-overview / token-plan-video-generation 的支持模型清单与端点，
 * HappyHorse 参考生视频 API 参考核实 media/reference_image、Base64 data URI 和参数）。
 *
 * 与按量百炼（dashscope 目录）的关系：模型同名、协议同源，但 **Token Plan 是独立供应商
 * 条目 + 独立 Key（sk-sp- 前缀）+ 独立域名**，计费走 Credits 订阅抵扣。
 *
 * 当前开放 Token Plan 官方接入页列出的 HappyHorse 1.1 文生、首帧图生与参考图生视频。
 * i2v/r2v 的 `input.media` 请求形态与 Base64 支持按同 endpoint 的 HappyHorse 官方 API
 * 参考实现；Token Plan 文档暂未逐项给出媒体请求示例，故暂不开放 wan3.0-video 的参考模式。
 * wan3.0-video 仍为 beta：Token Plan 官方目录确认支持，但时长范围沿用标准百炼口径，
 * 尚无 Token Plan 专属模型参数表。
 */
export default defineProvider({
  id: 'token-plan',
  label: '阿里云 Token Plan',
  adapter: 'gateway-token-plan',
  auth: {
    env: 'TOKEN_PLAN_KEY',
    label: 'Token Plan 套餐 API Key（订阅页生成）',
    helpUrl: 'https://bailian.console.aliyun.com/cn-beijing/subscription/overview'
  },
  region: 'cn-direct',
  models: [
    /* ---------------- 图片（同步端点 multimodal-generation/generation） ---------------- */
    {
      id: 'token-plan/qwen-image-3.0-pro',
      kind: 'image',
      label: '千问图像 3.0 Pro（Token Plan）',
      remoteModel: 'qwen-image-3.0-pro',
      costHint: 'Credits 抵扣（订阅制；官方「支持的模型」表在列）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },
    {
      id: 'token-plan/wan2.7-image',
      kind: 'image',
      label: '通义万相 2.7 图像生成（Token Plan）',
      remoteModel: 'wan2.7-image',
      costHint: 'Credits 抵扣（订阅制；文生图，一期不含参考图编辑）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },
    {
      id: 'token-plan/wan2.7-image-pro',
      kind: 'image',
      label: '通义万相 2.7 图像生成 Pro（Token Plan）',
      remoteModel: 'wan2.7-image-pro',
      costHint: 'Credits 抵扣（订阅制；文生图，一期不含参考图编辑）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'] }
    },

    /* ---------------- 视频（异步任务制，与标准百炼同端点） ---------------- */
    {
      id: 'token-plan/happyhorse-1.1-t2v',
      kind: 'video',
      label: 'HappyHorse 1.1 文生视频（Token Plan）',
      remoteModel: 'happyhorse-1.1-t2v',
      costHint: 'Credits 抵扣（视频单次消耗高、任务完成后集中结算，建议先短时长试跑）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
      }
    },
    {
      id: 'token-plan/happyhorse-1.1-i2v',
      kind: 'video',
      label: 'HappyHorse 1.1 图生视频（Token Plan）',
      remoteModel: 'happyhorse-1.1-i2v',
      costHint: 'Credits 抵扣（首帧图生；3~15 秒；参考图单文件不超过 20MB）',
      capabilities: {
        durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        refModes: ['i2v_first'],
        refQuota: [{ role: 'first_frame', max: 1 }]
      }
    },
    {
      id: 'token-plan/happyhorse-1.1-r2v',
      kind: 'video',
      label: 'HappyHorse 1.1 参考图生视频（Token Plan）',
      remoteModel: 'happyhorse-1.1-r2v',
      costHint: 'Credits 抵扣（参考生视频；3~15 秒；最多 9 张参考图，每张不超过 20MB）',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
        durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        refModes: ['r2v'],
        refQuota: [{ role: 'reference_image', max: 9 }],
        refTotal: 9
      }
    },
    {
      id: 'token-plan/wan3.0-video',
      kind: 'video',
      label: '通义万相 3.0 视频（Token Plan，文生）',
      remoteModel: 'wan3.0-video',
      costHint: 'Credits 抵扣（单次消耗高、完成后集中结算；时长区间沿用标准百炼口径，待真机核验）',
      status: 'beta',
      capabilities: {
        ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
        durations: [5, 10, 15, 20, 30]
      }
    }
  ]
})
