import { defineProvider } from '../define'

// https://docs.platform.pai.video/9405190m0
export default defineProvider({
  id: 'pixverse', label: '拍我 AI', adapter: 'gateway-pixverse', region: 'cn-direct',
  auth: { env: 'PIXVERSE_KEY', label: '拍我 AI API Key', helpUrl: 'https://platform.pai.video/' },
  models: ['v6', 'c1'].map((model) => ({
    id: `pixverse/${model}`, remoteModel: model, kind: 'video' as const, label: `拍我 AI ${model} 视频`,
    capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'] as const,
      durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      refModes: ['t2v', 'i2v_first', 'i2v_fl'] as const,
      refQuota: [{ role: 'first_frame' as const, max: 1 }, { role: 'last_frame' as const, max: 1 }] }
  })).map((model) => ({ ...model, capabilities: { ...model.capabilities, ratios: [...model.capabilities.ratios], refModes: [...model.capabilities.refModes] } }))
})
