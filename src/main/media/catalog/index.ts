import type { BuiltinProviderDef } from './types'
import fal from './providers/fal'
import dashscope from './providers/dashscope'
import volcark from './providers/volcark'
import openai from './providers/openai'

/**
 * 内置媒体模型目录（catalog 架构 §2 目录层）。
 *
 * 一个供应商一个文件放 providers/ 下，在此汇入 BUILTIN_PROVIDERS；运行时由
 * merge.ts 与 workspace.json 的覆盖层（userProviders/hiddenBuiltin/modelOverrides）
 * 合并出生效清单。社区加模型 = 新增/修改一个目录文件里的纯数据对象（PR 友好北极星）。
 *
 * 提交前跑 `pnpm catalog:check`（CI 亦跑）：id 唯一、kind 合法、适配器类型存在、
 * auth.env 命名约定、能力档位升序、逐供应商 dry-run 实例化。
 */

export const BUILTIN_PROVIDERS: BuiltinProviderDef[] = [fal, dashscope, volcark, openai]

export { defineProvider } from './define'
export type { BuiltinModelDef, BuiltinProviderAuth, BuiltinProviderDef, CatalogBrowseModel } from './types'
export { browseCatalog } from './browse'
export { mergeCatalog, sanitizeCapabilities, sanitizeUserProvider, sanitizeUserProviders, PROVIDER_ID_PATTERN, MODEL_ID_PATTERN } from './merge'
