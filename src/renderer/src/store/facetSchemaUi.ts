/**
 * 分级结构编辑弹窗的开合状态（文件级 store）。
 *
 * 为什么单独一个 store：入口在右侧素材库面板里，弹窗挂在 App 根部（面板的滚动
 * 容器会裁切弹窗）。两边只需要共享「编辑哪一套」这一个值，不值得拉进 canvasStore
 * 那种大状态里。
 */

import { create } from 'zustand'
import type { FacetSchema } from '@shared/facets'

interface FacetSchemaUiState {
  /** 当前打开的编辑器：`{ schema }` 表示编辑已有（null = 新建）；closed 时整体为 null */
  editor: { schema: FacetSchema | null } | null
  /** 打开：`schema` 省略/为 null = 新建 */
  openEditor: (schema?: FacetSchema | null) => void
  closeEditor: () => void
}

export const useFacetSchemaUi = create<FacetSchemaUiState>()((set) => ({
  editor: null,
  openEditor: (schema) => set({ editor: { schema: schema ?? null } }),
  closeEditor: () => set({ editor: null })
}))
