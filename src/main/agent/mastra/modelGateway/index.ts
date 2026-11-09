/**
 * 自有 ModelGateway 组装点（Mastra 迁移计划 v1.2 §5.5/§7.7）。
 *
 * 唯一模型入口：Mastra Agent / expert 只能拿到这里暴露的 model handle，
 * provider 解析、鉴权、能力声明、abort 都在网关内；供应商数据源是现有
 * `ChatModelManager.registrations()`（目录 + overlay + credentials）。
 * 模型 HTTP 调用经 providers.ts 直达三种协议端点，**零 pi 依赖**。
 */

import type { ModelGateway } from './types'
import { ModelGatewayImpl, type GatewayOptions } from './backend'

export type { GatewayOptions } from './backend'
export { aiSdkLanguageModel } from './languageModel'
export * from './types'

/** 网关实例：会话生命周期内复用，registrations() 每次调用取最新目录/凭据 */
export function createModelGateway(options: GatewayOptions): ModelGateway {
  return new ModelGatewayImpl(options)
}
