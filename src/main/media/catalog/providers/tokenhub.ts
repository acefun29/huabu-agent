import { defineProvider } from '../define'

export default defineProvider({
  id: 'tokenhub', label: '腾讯 TokenHub', adapter: 'gateway-tokenhub', region: 'cn-direct',
  auth: { env: 'TOKENHUB_KEY', label: 'TokenHub API Key', helpUrl: 'https://console.cloud.tencent.com/tokenhub/api-key' },
  models: [
    { id: 'tokenhub/hy-image-v3.5-preview', remoteModel: 'hy-image-v3.5-preview', kind: 'image', label: '混元 Image 3.5 Preview', status: 'beta',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], refModes: ['t2i', 'i2i'], refQuota: [{ role: 'reference_image', max: 20 }] } },
    ...['wand-vega-image-lite', 'wand-vega-image-flash', 'wand-vega-image-pro', 'wand-vega-image-1.5-pro'].map((name) => ({
      id: `tokenhub/${name}`, remoteModel: name, kind: 'image' as const, label: name,
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'] as ('1:1' | '3:4' | '4:3' | '9:16' | '16:9' | '21:9')[],
        refModes: ['t2i', 'i2i'] as ('t2i' | 'i2i')[], refQuota: [{ role: 'reference_image' as const, max: 10 }] }
    })),
    ...['pixverse-video-v6.0', 'pixverse-video-c1'].map((name) => ({
      id: `tokenhub/${name}`, remoteModel: name, kind: 'video' as const, label: name,
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'] as ('1:1' | '3:4' | '4:3' | '9:16' | '16:9' | '21:9')[],
        durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        refModes: ['t2v', 'i2v_first', 'i2v_fl', 'r2v'] as ('t2v' | 'i2v_first' | 'i2v_fl' | 'r2v')[],
        refQuota: [{ role: 'first_frame' as const, max: 1 }, { role: 'last_frame' as const, max: 1 }, { role: 'reference_image' as const, max: 7 }] }
    })),
    { id: 'tokenhub/kling-video-v4', remoteModel: 'kling-video-v4', kind: 'video', label: '可灵 Video V4',
      capabilities: { ratios: ['1:1', '9:16', '16:9', '21:9'], durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 25, 30],
        refModes: ['t2v', 'i2v_first', 'i2v_fl'], refQuota: [{ role: 'first_frame', max: 1 }, { role: 'last_frame', max: 1 }] } },
    { id: 'tokenhub/kling-video-v4-flash', remoteModel: 'kling-video-v4-flash', kind: 'video', label: '可灵 Video V4 Flash',
      capabilities: { ratios: ['1:1', '9:16', '16:9', '21:9'], durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20],
        refModes: ['t2v', 'i2v_first'], refQuota: [{ role: 'first_frame', max: 1 }] } }
  ]
})
