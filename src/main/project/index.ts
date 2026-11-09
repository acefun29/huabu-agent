/**
 * 项目结构模块（原型 index-projects.html 的后端实现）。
 *
 * 纯增量能力：层级只存在于 `.huabu/project.json`，素材库与文件路径零改动；
 * 叶子节点通过 assetId 引用已有素材，不复制文件。
 */

export * from './model'
export { ProjectStore } from './store'
export type { LoadResult } from './store'
export { emptyProject, DRAMA_LEVELS, PROMO_LEVELS, createStarterProject } from './templates'
