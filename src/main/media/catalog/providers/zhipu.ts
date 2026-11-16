import { defineProvider } from '../define'

export default defineProvider({
  id: 'zhipu-media', label: '智谱媒体', adapter: 'gateway-zhipu-media', region: 'cn-direct',
  auth: { env: 'ZHIPU_MEDIA_KEY', label: '智谱 API Key', helpUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  models: [
    { id: 'zhipu-media/glm-image', remoteModel: 'glm-image', kind: 'image', label: 'GLM-Image',
      capabilities: { ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], refModes: ['t2i'] } },
    { id: 'zhipu-media/cogvideox-3', remoteModel: 'cogvideox-3', kind: 'video', label: 'CogVideoX-3',
      capabilities: { ratios: ['1:1', '9:16', '16:9'], durations: [5, 10], refModes: ['t2v', 'i2v_first', 'i2v_fl'],
        refQuota: [{ role: 'first_frame', max: 1 }, { role: 'last_frame', max: 1 }] } }
  ]
})
