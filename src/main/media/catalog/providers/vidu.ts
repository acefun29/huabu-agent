import { defineProvider } from '../define'

// 官方模型与接口：https://platform.vidu.cn/docs/model-map
// https://platform.vidu.cn/docs/api-reference/image-generation
// https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/text-to-video
export default defineProvider({
  id: 'vidu', label: 'Vidu 生数科技', adapter: 'gateway-vidu', region: 'cn-direct',
  auth: { env: 'VIDU_KEY', label: 'Vidu API Key', helpUrl: 'https://platform.vidu.cn/' },
  models: [
    { id: 'vidu/viduq2-image', remoteModel: 'viduq2', kind: 'image', label: 'Vidu Q2 图像生成', capabilities: {
      ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'], refModes: ['t2i', 'i2i'], refQuota: [{ role: 'reference_image', max: 7 }]
    } },
    { id: 'vidu/viduq3-turbo-video', remoteModel: 'viduq3-turbo', kind: 'video', label: 'Vidu Q3 Turbo 视频生成', capabilities: {
      ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'], durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      refModes: ['t2v', 'i2v_first', 'i2v_fl', 'r2v'], refQuota: [
        { role: 'first_frame', max: 1 }, { role: 'last_frame', max: 1 }, { role: 'reference_image', max: 7 }
      ]
    } }
  ]
})
