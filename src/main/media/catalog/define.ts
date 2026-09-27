import type { BuiltinProviderDef } from './types'

/**
 * 目录文件的定义辅助：本身是恒等函数，价值在类型收窄——
 * 目录文件获得完整的 TS 校验与自动补全，写错字段名在编辑器里就报错，不用等 CI。
 */
export function defineProvider(def: BuiltinProviderDef): BuiltinProviderDef {
  return def
}
