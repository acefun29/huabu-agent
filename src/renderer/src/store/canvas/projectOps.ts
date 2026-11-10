import type { ProjectSnapshot } from '@shared/ipc'
import type { CanvasState } from '../canvasStore'
import type { StoreSet } from './chatRuntime'
import { BRIDGE_AVAILABLE } from './shared'

/**
 * 项目结构域（架构图 to-be ① 的数据来源）：`project.json` 的渲染端投影。
 *
 * 为什么单独一域：上下文四段装配的「常驻段」要项目身份/层级，「轮换段」要当前 scope 的
 * 子节点。两者都来自 `project:snapshot`，但装配器是纯函数——它只该拿到快照，不该自己发 IPC。
 * 所以快照的拉取、scope 切换、结构变更订阅都收在这里，装配器继续只吃输入。
 *
 * 兜底：任何失败都只是让快照为 null（装配器据此不产出这两段），绝不让对话发送失败——
 * 项目结构是增强上下文，不是发送的前置条件。
 */

export interface ProjectOpsDeps {
  set: StoreSet
  get: () => CanvasState
  showToast: CanvasState['showToast']
}

export function createProjectOps(deps: ProjectOpsDeps) {
  const { set, get } = deps

  /** 拉取当前 scope 的快照（scopeId 缺省 = 根看板） */
  const refreshProject = async (scopeId?: string | null): Promise<void> => {
    if (!BRIDGE_AVAILABLE || !get().workspace) {
      set({ projectSnapshot: null })
      return
    }
    const wanted = scopeId === undefined ? get().projectScopeId : scopeId
    try {
      const result = await window.huabu.project.snapshot(
        wanted ? { scopeId: wanted } : {}
      )
      if (!result.ok) {
        set({ projectSnapshot: null })
        return
      }
      // 主进程对非法 scope 会回落到根：以返回的面包屑末端为准，避免本地 scope 与快照脱节
      const lastCrumb = result.value.breadcrumb.at(-1)
      set({
        projectSnapshot: result.value,
        projectScopeId: lastCrumb?.id ?? null
      })
    } catch {
      set({ projectSnapshot: null })
    }
  }

  /** 切换工作集（轮换段随之变化）：下钻到某容器 / 回到根 */
  const setProjectScope = async (scopeId: string | null): Promise<void> => {
    set({ projectScopeId: scopeId })
    await refreshProject(scopeId)
  }

  return {
    /** 当前 scope 的完整快照（常驻段 + 轮换段的数据来源；null = 无项目/未打开） */
    projectSnapshot: null as ProjectSnapshot | null,
    /** 当前浏览的容器节点 id（null = 根） */
    projectScopeId: null as string | null,
    refreshProject,
    setProjectScope
  }
}
