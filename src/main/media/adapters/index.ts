/**
 * 适配器层 barrel：import 副作用完成全部自注册。
 *
 * 新增适配器类型：新建 fal.ts 同款文件（实现 MediaProviderAdapter + 末尾
 * registerAdapter）→ 这里加一行 import。ipc.ts 与目录层都不需要改。
 */

import './fal'
import './dashscope'
import './volcark'
import './openaiCompat'

export {
  adapterDefaultAuthEnv,
  createAdapters,
  getAdapterTypes,
  isRegisteredAdapterType,
  registerAdapter
} from './registry'
export type { AdapterDeps, AdapterFactory, AdapterModelConfig, AdapterProviderConfig } from './registry'
export { FalGatewayProvider } from './fal'
export { DashScopeProvider } from './dashscope'
export { VolcArkProvider } from './volcark'
export { OpenAICompatProvider } from './openaiCompat'
