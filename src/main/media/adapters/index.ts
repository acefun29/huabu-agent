/**
 * 适配器层 barrel：import 副作用完成全部自注册。
 *
 * 新增适配器类型：新建 dashscope.ts 同款文件（实现 MediaProviderAdapter + 末尾
 * registerAdapter）→ 这里加一行 import。ipc.ts 与目录层都不需要改。
 */

import './dashscope'
import './volcark'
import './openaiCompat'
import './minimax'
import './tencent'

export { createAdapters, getAdapterTypes, isRegisteredAdapterType } from './registry'
export type { AdapterDeps, AdapterProviderConfig } from './registry'
