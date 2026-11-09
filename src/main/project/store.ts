/**
 * 项目结构持久化（`.huabu/project.json`，单工作区一份）。
 *
 * 与 canvas.json 同级、互不侵入：删掉本文件即回到纯画布。
 * 写策略：原子替换（tmp + rename），写失败不留半截文件；读取容错
 * （坏 JSON / 版本不符 → 空结构，并在返回值里带上原因，不静默吞掉）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  EMPTY_PROJECT_FILE,
  type Project,
  type ProjectFile,
  type ProjectNode,
  addNode,
  findNode,
  patchNode,
  removeNode,
  reorderChildren,
} from './model'

export interface LoadResult {
  file: ProjectFile
  /** 读取失败原因（坏 JSON / 版本不符）；成功为 undefined */
  error?: string
}

export class ProjectStore {
  private readonly file: string
  constructor(workspaceDir: string) {
    this.file = join(workspaceDir, '.huabu', 'project.json')
  }

  async load(): Promise<LoadResult> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return { file: { ...EMPTY_PROJECT_FILE, projects: [] } }
    }
    try {
      const parsed = JSON.parse(raw) as ProjectFile
      if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) {
        return { file: { ...EMPTY_PROJECT_FILE, projects: [] }, error: 'project.json 版本不符或结构损坏' }
      }
      return { file: parsed }
    } catch (error) {
      return {
        file: { ...EMPTY_PROJECT_FILE, projects: [] },
        error: `project.json 解析失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /** 原子直写（tmp + rename）。调用方负责串行化（见 enqueue） */
  private async persistDirect(file: ProjectFile): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
    await rename(tmp, this.file)
  }


  /* --------------------------------------------------------- 项目级 */

  async createProject(project: Project): Promise<Project> {
    return this.enqueue(async () => {
      const { file } = await this.load()
      if (file.projects.some((existing) => existing.id === project.id)) {
        throw new Error(`项目 id 已存在：${project.id}`)
      }
      await this.persistDirect({
        ...file,
        projects: [...file.projects, project],
        activeProjectId: file.activeProjectId ?? project.id,
      })
      return project
    })
  }

  async setActiveProject(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      const { file } = await this.load()
      if (!file.projects.some((project) => project.id === projectId)) {
        throw new Error(`项目不存在：${projectId}`)
      }
      await this.persistDirect({ ...file, activeProjectId: projectId })
    })
  }

  async deleteProject(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      const { file } = await this.load()
      const projects = file.projects.filter((project) => project.id !== projectId)
      await this.persistDirect({
        ...file,
        projects,
        activeProjectId: file.activeProjectId === projectId ? (projects[0]?.id ?? null) : file.activeProjectId,
      })
    })
  }

  /** 修改项目元信息（名称/主题色/tagline/项目级提示词/层级定义） */
  async updateProject(
    projectId: string,
    patch: Partial<Pick<Project, 'name' | 'kind' | 'dot' | 'tagline' | 'rootLabel' | 'promptBase' | 'levels'>>
  ): Promise<Project> {
    return this.enqueue(async () => {
      const { file } = await this.load()
      const project = file.projects.find((item) => item.id === projectId)
      if (!project) throw new Error(`项目不存在：${projectId}`)
      const next: Project = { ...project, ...patch }
      await this.persistDirect({
        ...file,
        projects: file.projects.map((item) => (item.id === projectId ? next : item)),
      })
      return next
    })
  }

  /* --------------------------------------------------------- 节点级 */

  /**
   * 读-改-写整体串行化（关键）：只串行 persist 会让并发 addNode 各自读到旧快照，
   * 后写覆盖前写，节点丢失。整段进链才能保证「读到的就是上一次写完的」。
   */
  private mutateChain: Promise<unknown> = Promise.resolve()

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutateChain.then(fn, fn)
    // 失败不阻断后续操作（失败的那次没有落盘）
    this.mutateChain = run.catch(() => undefined)
    return run
  }

  /** 节点变更统一入口：读 → 纯函数改 → 原子写 → 返回改后的项目 */
  private mutateProject(projectId: string, mutate: (project: Project) => Project): Promise<Project> {
    return this.enqueue(async () => {
      const { file } = await this.load()
      const project = file.projects.find((item) => item.id === projectId)
      if (!project) throw new Error(`项目不存在：${projectId}`)
      const next = mutate(project)
      await this.persistDirect({
        ...file,
        projects: file.projects.map((item) => (item.id === projectId ? next : item)),
      })
      return next
    })
  }

  async addNode(projectId: string, node: Omit<ProjectNode, 'order'> & { order?: number }): Promise<Project> {
    return this.mutateProject(projectId, (project) => addNode(project, node))
  }

  async patchNode(
    projectId: string,
    nodeId: string,
    patch: Parameters<typeof patchNode>[2]
  ): Promise<Project> {
    return this.mutateProject(projectId, (project) => {
      if (!findNode(project, nodeId)) throw new Error(`节点不存在：${nodeId}`)
      return patchNode(project, nodeId, patch)
    })
  }

  async removeNode(projectId: string, nodeId: string): Promise<{ project: Project; removedIds: string[] }> {
    let removedIds: string[] = []
    const project = await this.mutateProject(projectId, (current) => {
      const result = removeNode(current, nodeId)
      removedIds = result.removedIds
      return result.project
    })
    return { project, removedIds }
  }

  async reorder(projectId: string, parentId: string | null, orderedIds: string[]): Promise<Project> {
    return this.mutateProject(projectId, (project) => reorderChildren(project, parentId, orderedIds))
  }
}
