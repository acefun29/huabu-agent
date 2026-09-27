/**
 * 素材分类与路径契约（真实实现版，对应原型 src/harness/assetCategories.ts）。
 *
 * 分类表的单一事实来源在 src/shared/assets.ts（主进程归档与渲染端共用），
 * 本文件只做再导出与路径约定说明。原型的 @backend 标注已逐条落地：
 *
 * - @backend(workspace-dir)：工作区绝对路径由主进程 workspace:state 提供
 *   （canvasStore 的 workspace.path），不再写死；
 * - @backend(temp-inbox)：临时文件由主进程复制到 userData/inbox/<日期>/<uuid>-<名>
 *   （asset:import-temp），只回传绝对路径；
 * - @backend(asset-map)：拖入画布的文件按 ASSET_CATEGORIES 复制到 <工作区>/assets/<子目录>/
 *   （asset:import-canvas，main/assets/manager.ts），重名加时间戳；
 * - @backend(abs-path)：workspaceAbs 用真实工作区目录拼接，统一 '/' 分隔。
 */
export {
  ASSET_CATEGORIES,
  OTHER_CATEGORY,
  CODE_EXTS,
  categorizeFileName,
  dedupeName,
  normalizePath,
  workspaceAbs,
  assetAbsPath,
  MEDIA_ROOT_REL,
  type AssetCategory,
  type AssetKindName
} from '@shared/assets'
