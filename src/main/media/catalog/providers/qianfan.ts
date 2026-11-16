import { defineProvider } from '../define'

const firstFrame = { durations: [5], refModes: ['i2v_first'] as const, refQuota: [{ role: 'first_frame' as const, max: 1 }] }
export default defineProvider({
  id: 'qianfan', label: '百度千帆', adapter: 'gateway-qianfan', region: 'cn-direct',
  auth: { env: 'QIANFAN_KEY', label: '百度千帆 API Key', helpUrl: 'https://console.bce.baidu.com/qianfan/' },
  models: [
    { id: 'qianfan/musesteamer-air-image', kind: 'image', label: 'MuseSteamer Air 图像', remoteModel: 'musesteamer-air-image',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], refModes: ['t2i'] } },
    { id: 'qianfan/musesteamer-2.1-turbo-i2v', kind: 'video', label: 'MuseSteamer 2.1 Turbo 图生视频', remoteModel: 'musesteamer-2.1-turbo-i2v', capabilities: { ...firstFrame, refModes: [...firstFrame.refModes] } },
    { id: 'qianfan/musesteamer-2.1-lite-i2v', kind: 'video', label: 'MuseSteamer 2.1 Lite 图生视频', remoteModel: 'musesteamer-2.1-lite-i2v', capabilities: { ...firstFrame, refModes: [...firstFrame.refModes] } },
    { id: 'qianfan/musesteamer-2.0-turbo-i2v-audio', kind: 'video', label: 'MuseSteamer 2.0 有声图生视频', remoteModel: 'musesteamer-2.0-turbo-i2v-audio', capabilities: { ...firstFrame, durations: [5, 10], refModes: [...firstFrame.refModes] } }
  ]
})
