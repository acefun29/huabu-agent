import type { ChatProviderDef } from '../types'

/**
 * 目录文件的定义辅助：恒等函数，价值在类型收窄——
 * 目录文件获得完整 TS 校验与补全，compat 写错键名（如 `thinkingFormats`）直接编译失败。
 * 这一条不是锦上添花：pi 运行时对未知 compat 键是**静默忽略**的（§2.5 推论1 同类陷阱）。
 */
export function defineProvider(def: ChatProviderDef): ChatProviderDef {
  return def
}
