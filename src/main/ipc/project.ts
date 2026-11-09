/**
 * project 域 IPC（原型 index-projects.html 的后端接口）。
 *
 * 覆盖通道：project:snapshot / create / activate / delete / update /
 * add-node / patch-node / remove-node / reorder，事件 project:changed。
 *
 * 设计要点：
 * - 快照一次取全（项目列表 + 当前项目 schema + 当前 scope 子节点 + 面包屑 + 提示词链），
 *   渲染端不做多次往返，也不重复实现层级逻辑（层级由数据定义，前端只渲染）；
 * - 结构真相在 `.huabu/project.json`，与 canvas.json 并列互不侵入；
 * - 运行态（任务在跑/验收失败）由渲染端作为 hint 传入，结构文件不随任务状态频繁重写。
 */

import { ipcMain } from 'electron'
import {
  IpcChannel,
  type ChatResult,
  type ProjectNodeView,
  type ProjectSnapshot,
  type ProjectSnapshotRequest
} from '../../shared/ipc'
import {
  ProjectStore,
  childrenOf,
  createStarterProject,
  deriveStatus,
  effectivePrompt,
  findNode,
  leafStats,
  pathOf,
  projectDepth,
  type Project,
  type ProjectFile
} from '../project'
import type { IpcContext } from './shared'
import { invalidPayload, isNonEmptyString } from './shared'

/** 每个工作区一个 store（随工作区切换重建；轻量，无缓存漂移风险） */
const stores = new Map<string, ProjectStore>()

function storeFor(dir: string): ProjectStore {
  let store = stores.get(dir)
  if (!store) {
    store = new ProjectStore(dir)
    stores.set(dir, store)
  }
  return store
}

/** 项目摘要（pill 上显示，如「4 集 · 12 场 · 48 镜」） */
function summaryOf(project: Project): string {
  const depth = projectDepth(project)
  const parts: string[] = []
  for (let level = 1; level <= depth; level += 1) {
    const count = project.nodes.filter((node) => node.level === level).length
    if (count === 0) continue
    const def = project.levels[level - 1]
    parts.push(`${count} ${def?.plural ?? `L${level}`}`)
  }
  return parts.length ? parts.join(' · ') : '空'
}

/** 节点 → 快照视图（派生状态 + 容器进度） */
function toNodeView(
  project: Project,
  node: Project['nodes'][number],
  runtime: ProjectSnapshotRequest['runtime']
): ProjectNodeView {
  const depth = projectDepth(project)
  const hint = runtime?.[node.id] ?? {}
  return {
    id: node.id,
    level: node.level,
    parentId: node.parentId,
    title: node.title,
    ...(node.subtitle ? { subtitle: node.subtitle } : {}),
    order: node.order,
    fields: node.fields,
    status: deriveStatus(project, node, hint),
    ...(node.assetId ? { assetId: node.assetId } : {}),
    ...(node.cover ? { cover: node.cover } : {}),
    ...(node.prompt ? { prompt: node.prompt } : {}),
    ...(node.level < depth ? { stats: leafStats(project, node.id) } : {}),
  }
}

function buildSnapshot(file: ProjectFile, scopeId: string | null, request: ProjectSnapshotRequest): ProjectSnapshot {
  const project = file.projects.find((item) => item.id === file.activeProjectId) ?? null
  if (!project) {
    return {
      projects: file.projects.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        ...(item.dot ? { dot: item.dot } : {}),
        summary: summaryOf(item),
      })),
      activeProjectId: file.activeProjectId,
      project: null,
      nodes: [],
      breadcrumb: [],
      promptLayers: [],
    }
  }
  const depth = projectDepth(project)
  // scope 校验：不存在的/id 属于别的项目 → 回落到根（避免越界读）
  const scope = scopeId && findNode(project, scopeId)?.level && findNode(project, scopeId)!.level < depth
    ? findNode(project, scopeId)
    : null
  const nodes = childrenOf(project, scope?.id ?? null).map((node) =>
    toNodeView(project, node, request.runtime)
  )
  const chain = scope ? pathOf(project, scope.id) : []
  const layers = scope
    ? effectivePrompt(project, scope.id).layers
    : project.promptBase?.trim()
      ? [{ level: 'project', label: project.name, prompt: project.promptBase.trim() }]
      : []
  return {
    projects: file.projects.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      ...(item.dot ? { dot: item.dot } : {}),
      summary: summaryOf(item),
    })),
    activeProjectId: file.activeProjectId,
    project: {
      id: project.id,
      name: project.name,
      kind: project.kind,
      rootLabel: project.rootLabel,
      ...(project.dot ? { dot: project.dot } : {}),
      ...(project.tagline ? { tagline: project.tagline } : {}),
      ...(project.promptBase ? { promptBase: project.promptBase } : {}),
      levels: project.levels,
    },
    nodes,
    breadcrumb: [
      { id: null, title: project.rootLabel },
      ...chain.map((node) => ({ id: node.id, title: node.title })),
    ],
    promptLayers: layers,
  }
}

export function registerProjectIpc(ctx: IpcContext): void {
  const { currentDir } = ctx

  /** 统一入口：取当前工作区 store，或返回明确的「未打开工作区」失败 */
  const withStore = async <T>(
    fn: (store: ProjectStore) => Promise<ChatResult<T>>
  ): Promise<ChatResult<T>> => {
    const dir = currentDir()
    if (!dir) return { ok: false, code: 'cwd_rejected', error: '尚未打开工作区' }
    try {
      return await fn(storeFor(dir))
    } catch (error) {
      return {
        ok: false,
        code: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const broadcastChanged = (): void => {
    ctx.broadcastProjectChanged()
  }

  ipcMain.handle(IpcChannel.ProjectSnapshot, (_event, payload: unknown) =>
    withStore(async (store) => {
      const request = (payload ?? {}) as ProjectSnapshotRequest
      const { file, error } = await store.load()
      const snapshot = buildSnapshot(file, request.scopeId ?? null, request)
      return { ok: true, value: error ? { ...snapshot, error } : snapshot }
    })
  )

  ipcMain.handle(IpcChannel.ProjectCreate, (_event, payload: unknown) => {
    const request = payload as { id?: unknown; name?: unknown; kind?: unknown } | null
    if (!isNonEmptyString(request?.name)) return invalidPayload('project:create 需要 name')
    const id = isNonEmptyString(request.id) ? request.id : `proj-${Date.now().toString(36)}`
    const kind = isNonEmptyString(request.kind) ? request.kind : '短剧'
    return withStore(async (store) => {
      const project = await store.createProject(createStarterProject({ id, name: request.name as string, kind }))
      await store.setActiveProject(project.id)
      broadcastChanged()
      return { ok: true, value: { id: project.id, name: project.name, kind: project.kind } }
    })
  })

  ipcMain.handle(IpcChannel.ProjectActivate, (_event, payload: unknown) => {
    const request = payload as { projectId?: unknown } | null
    if (!isNonEmptyString(request?.projectId)) return invalidPayload('project:activate 需要 projectId')
    return withStore(async (store) => {
      await store.setActiveProject(request.projectId as string)
      broadcastChanged()
      return { ok: true, value: undefined }
    })
  })

  ipcMain.handle(IpcChannel.ProjectDelete, (_event, payload: unknown) => {
    const request = payload as { projectId?: unknown } | null
    if (!isNonEmptyString(request?.projectId)) return invalidPayload('project:delete 需要 projectId')
    return withStore(async (store) => {
      await store.deleteProject(request.projectId as string)
      broadcastChanged()
      return { ok: true, value: undefined }
    })
  })

  ipcMain.handle(IpcChannel.ProjectUpdate, (_event, payload: unknown) => {
    const request = payload as
      | { projectId?: unknown; patch?: Record<string, unknown> }
      | null
    if (!isNonEmptyString(request?.projectId)) return invalidPayload('project:update 需要 projectId')
    if (!request.patch || typeof request.patch !== 'object') return invalidPayload('project:update 需要 patch')
    return withStore(async (store) => {
      const project = await store.updateProject(request.projectId as string, request.patch as never)
      broadcastChanged()
      return { ok: true, value: { id: project.id, name: project.name } }
    })
  })

  ipcMain.handle(IpcChannel.ProjectAddNode, (_event, payload: unknown) => {
    const request = payload as
      | { projectId?: unknown; node?: Record<string, unknown> }
      | null
    if (!isNonEmptyString(request?.projectId)) return invalidPayload('project:add-node 需要 projectId')
    if (!request.node || typeof request.node !== 'object') return invalidPayload('project:add-node 需要 node')
    return withStore(async (store) => {
      const project = await store.addNode(request.projectId as string, request.node as never)
      broadcastChanged()
      return { ok: true, value: { nodes: project.nodes.length } }
    })
  })

  ipcMain.handle(IpcChannel.ProjectPatchNode, (_event, payload: unknown) => {
    const request = payload as
      | { projectId?: unknown; nodeId?: unknown; patch?: Record<string, unknown> }
      | null
    if (!isNonEmptyString(request?.projectId)) return invalidPayload('project:patch-node 需要 projectId')
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('project:patch-node 需要 nodeId')
    if (!request.patch || typeof request.patch !== 'object') return invalidPayload('project:patch-node 需要 patch')
    return withStore(async (store) => {
      await store.patchNode(request.projectId as string, request.nodeId as string, request.patch as never)
      broadcastChanged()
      return { ok: true, value: undefined }
    })
  })

  ipcMain.handle(IpcChannel.ProjectRemoveNode, (_event, payload: unknown) => {
    const request = payload as { projectId?: unknown; nodeId?: unknown } | null
    if (!isNonEmptyString(request?.projectId)) return invalidPayload('project:remove-node 需要 projectId')
    if (!isNonEmptyString(request?.nodeId)) return invalidPayload('project:remove-node 需要 nodeId')
    return withStore(async (store) => {
      const { removedIds } = await store.removeNode(request.projectId as string, request.nodeId as string)
      broadcastChanged()
      return { ok: true, value: { removedIds } }
    })
  })

  ipcMain.handle(IpcChannel.ProjectReorder, (_event, payload: unknown) => {
    const request = payload as
      | { projectId?: unknown; parentId?: unknown; orderedIds?: unknown }
      | null
    if (!isNonEmptyString(request?.projectId)) return invalidPayload('project:reorder 需要 projectId')
    if (!Array.isArray(request.orderedIds)) return invalidPayload('project:reorder 需要 orderedIds')
    const parentId = request.parentId === null || request.parentId === undefined
      ? null
      : isNonEmptyString(request.parentId)
        ? (request.parentId as string)
        : undefined
    if (parentId === undefined) return invalidPayload('project:reorder parentId 非法')
    return withStore(async (store) => {
      await store.reorder(request.projectId as string, parentId, request.orderedIds as string[])
      broadcastChanged()
      return { ok: true, value: undefined }
    })
  })
}
