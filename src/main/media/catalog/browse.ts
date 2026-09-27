import type { CatalogBrowseModel } from './types'

/**
 * 全量浏览目录（设置页「浏览完整模型库」的数据源）。
 *
 * 与生效清单（mergeCatalog）严格分离：这里的数据不参与解析、不进 media:providers，
 * 只在用户点「添加」时落成 workspace.json media.userProviders 里的一个模型条目。
 *
 * 新增一个可浏览的供应商目录 = 在 data/ 放一个生成的数据模块 + 在下面的表里登记一行。
 *
 * TODO(Backlog「媒体 catalog browse 实装」)：BROWSE_SOURCES 自 MuAPI 目录随 42db3cf
 * 移除后一直为空表 —— 所有供应商都返回空数组，设置页的「浏览完整模型库」入口
 * 因此整体隐藏（MediaCatalogBrowser 对空清单 return null）。实装前这里的代码
 * 与渲染端组件都是**可达但恒空**的死面；要么填数据，要么连组件一起删。
 */
const BROWSE_SOURCES: Record<string, readonly CatalogBrowseModel[]> = {}

/** 该供应商的可浏览全量目录；没有目录的供应商返回空数组（设置页据此隐藏入口） */
export function browseCatalog(providerId: string): readonly CatalogBrowseModel[] {
  return BROWSE_SOURCES[providerId] ?? []
}
