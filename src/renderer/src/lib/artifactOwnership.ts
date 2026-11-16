/**
 * 产物归属：工作区相对路径 → 「哪次交付、第几版」。
 *
 * 画布卡片只知道自己的文件路径；journal 投影只知道产物 id 和路径。
 * 两边靠路径对上，卡片才能显示 `V-02 · 第 2 版`。
 *
 * 序号来自产物在该任务 `artifacts[]` 里的位置，也就是 `artifact.recorded` 的事件顺序——
 * 是事实，不是判断。
 */
import type { WorkArtifactView, WorkTaskView } from '@shared/ipc'

export interface ArtifactOwner {
  taskId: string
  title: string
  /** 第几版，从 1 开始 */
  index: number
}

/**
 * 同一路径被多个任务产出过时，后写的任务胜出（与 journal 的追加语义一致）。
 * 这种情况本身说明两次交付写了同一个文件，属于用户该知道的事，不是这里的错误。
 */
export function buildOwnership(
  tasks: readonly WorkTaskView[],
  artifacts: readonly WorkArtifactView[]
): Map<string, ArtifactOwner> {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const owners = new Map<string, ArtifactOwner>()
  for (const task of tasks) {
    task.artifacts.forEach((artifactId, position) => {
      const artifact = byId.get(artifactId)
      if (!artifact) return
      owners.set(artifact.path, { taskId: task.id, title: task.title, index: position + 1 })
    })
  }
  return owners
}
