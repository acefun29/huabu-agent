import { defineProvider } from '../define'

/**
 * 阿里云百炼 Token Plan（订阅制）内置媒体目录
 * （2026-10-25 对照 help.aliyun.com/zh/model-studio 官方文档核实：
 * token-plan-personal-overview 的「支持的模型」表、token-plan-multimodal-gen 的
 * 文生图/文生视频示例端点与请求体）。
 *
 * 与按量百炼（dashscope 目录）的关系：模型同名、协议同源，但 **Token Plan 是独立供应商
 * 条目 + 独立 Key（sk-sp- 前缀）+ 独立域名**，计费走 Credits 订阅抵扣。
 *
 * 一期范围（用户裁决 2026-10-25）：**只收文档已证实的文生图 / 文生视频**。
 * 官方「支持的模型」表里的 happyhorse-1.1-i2v / -r2v 依赖参考素材形态
 * （content {image} / input.media），Token Plan 网关未给示例——不收、适配器 refCaps 全族 none。
 * wan3.0-video 在表内且与 happyhorse 同端点同参数族，但 duration 区间沿用标准百炼口径、
 * 未经真机核验，先挂 beta。注意媒体域的 'beta' 目前只是维护者元数据——merge 只剔除
 * 'deprecated'，渲染端也不读模型级 status——核验敞口由该条 costHint 文案传达给参数面板。
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
        durations: [5, 10, 15]
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
