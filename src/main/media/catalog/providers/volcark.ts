import { defineProvider } from '../define'

/**
 * 火山方舟内置目录（2026-09-22 对照 docs.volcengine.com 官方 API 文档核实，
 * 文档页面当日更新：图片生成 API / 创建视频生成任务 / Seedream·Seedance 教程页）。
 *
 * 模型 id 是稳定承诺（合入后不得改名）；线上模型 ID 带日期后缀，厂商升级时老条目
 * 标 deprecated 保留、新模型加新条目。价格随官方调价漂移，costHint 标「约」。
 * 端点核实记录：
 * - 图片（POST /api/v3/images/generations 同步）：Seedream 5.0 Pro
 *   （doubao-seedream-5-0-pro-260628）、5.0 Flash（doubao-seedream-5-0-flash-260915）、
 *   5.0 Lite（doubao-seedream-5-0-lite-260128）、4.5（doubao-seedream-4-5-251128）；
 * - 视频（POST /api/v3/contents/generations/tasks 异步）：Seedance 2.5
 *   （doubao-seedance-2-5-260628，duration [4,30] 原生有声）、2.0 Fast
 *   （doubao-seedance-2-0-fast-260128）、2.0 Mini（doubao-seedance-2-0-mini-260615）。
 * 老条目 Seedream 4.0 / Seedance 1.0 Lite 标 deprecated 保留。
 * 未入库模型（Seedance i2v 等）经 workspace.json media.userProviders 声明即可，无需改代码。
 */
export default defineProvider({
  id: 'volcark',
  label: '火山方舟',
  adapter: 'gateway-volcark',
  auth: {
    env: 'ARK_KEY',
    label: '火山方舟 API Key',
    helpUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'
  },
  region: 'cn-direct',
  models: [
    /* ---------------- 图片 ---------------- */
    {
      id: 'volcark/seedream-5.0-pro',
      kind: 'image',
      label: 'Seedream 5.0 Pro',
      remoteModel: 'doubao-seedream-5-0-pro-260628',
      costHint: '按张计费（旗舰档，支持图层拆分与交互编辑）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },
    {
      id: 'volcark/seedream-5.0-flash',
      kind: 'image',
      label: 'Seedream 5.0 Flash',
      remoteModel: 'doubao-seedream-5-0-flash-260915',
      costHint: '按张计费（5.0 快速档，支持坐标/框选交互编辑）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },
    {
      id: 'volcark/seedream-5.0-lite',
      kind: 'image',
      label: 'Seedream 5.0 Lite',
      remoteModel: 'doubao-seedream-5-0-lite-260128',
      costHint: '按张计费（5.0 最低价档）',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },
    {
      id: 'volcark/seedream-4.5',
      kind: 'image',
      label: 'Seedream 4.5',
      remoteModel: 'doubao-seedream-4-5-251128',
      costHint: '约 0.2 元/张',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },
    {
      id: 'volcark/seedream-4.0',
      kind: 'image',
      label: 'Seedream 4.0（旧版）',
      remoteModel: 'doubao-seedream-4-0-250828',
      costHint: '约 0.2 元/张',
      status: 'deprecated',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], maxRefImages: 1 }
    },

    /* ---------------- 视频 ---------------- */
    {
      id: 'volcark/seedance-2.5',
      kind: 'video',
      label: 'Seedance 2.5（原生有声）',
      remoteModel: 'doubao-seedance-2-5-260628',
      costHint: '按秒计费（支持 4~30 秒，默认可选 720p/1080p）',
      capabilities: { durations: [5, 10, 15, 30], maxRefImages: 1 }
    },
    {
      id: 'volcark/seedance-2.0-fast',
      kind: 'video',
      label: 'Seedance 2.0 Fast',
      remoteModel: 'doubao-seedance-2-0-fast-260128',
      costHint: '按秒计费（2.0 快速档）',
      capabilities: { durations: [5, 10] }
    },
    {
      id: 'volcark/seedance-2.0-mini',
      kind: 'video',
      label: 'Seedance 2.0 Mini',
      remoteModel: 'doubao-seedance-2-0-mini-260615',
      costHint: '按秒计费（方舟最低价视频档）',
      capabilities: { durations: [5, 10] }
    },
    {
      id: 'volcark/seedance-lite',
      kind: 'video',
      label: 'Seedance 1.0 Lite（旧版）',
      remoteModel: 'doubao-seedance-1-0-lite-t2v-250428',
      costHint: '约 0.6 元/条',
      status: 'deprecated',
      capabilities: { durations: [5, 10] }
    }
  ]
})
