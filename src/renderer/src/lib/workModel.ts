/**
 * 工作项的展示模型。
 *
 * 面板只回答一件事：**现在在做什么**。
 * 所以这里只保留 `doing` / `todo` 两种——已完成和已放弃不进面板。
 */
import type { WorkArtifactView, WorkTaskView, SuperAgentWorkStateView } from '@shared/ipc'

export interface WorkItem {
  id: string
  title: string
  brief: string
  lane: string
  status: 'doing' | 'todo'
  /** 按产出顺序排列的产物；最后一个是当前版 */
  artifacts: WorkArtifactView[]
}

export interface WorkGroups {
  doing: WorkItem[]
  todo: WorkItem[]
}

function toItem(task: WorkTaskView, byId: Map<string, WorkArtifactView>): WorkItem | null {
  if (task.status !== 'doing' && task.status !== 'todo') return null
  const artifacts = task.artifacts
    .map((id) => byId.get(id))
    .filter((artifact): artifact is WorkArtifactView => Boolean(artifact))
  return {
    id: task.id,
    title: task.title,
    brief: task.brief,
    lane: task.lane,
    status: task.status,
    artifacts
  }
}

/** 投影 → 面板分组。已完成 / 已放弃在这一步就被丢掉，下游拿不到 */
export function buildWorkGroups(state: SuperAgentWorkStateView | null | undefined): WorkGroups {
  if (!state) return { doing: [], todo: [] }
  const byId = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]))
  const doing: WorkItem[] = []
  const todo: WorkItem[] = []
  for (const task of state.tasks) {
    const item = toItem(task, byId)
    if (!item) continue
    if (item.status === 'doing') doing.push(item)
    else todo.push(item)
  }
  return { doing, todo }
}

/** 画布上能显示成卡片的产物（图 / 视频 / 音频） */
export function visualArtifacts(item: WorkItem): WorkArtifactView[] {
  return item.artifacts.filter((artifact) => artifact.kind !== 'text')
}

/** 画布没有卡片的那部分产物（文本） */
export function textArtifacts(item: WorkItem): WorkArtifactView[] {
  return item.artifacts.filter((artifact) => artifact.kind === 'text')
}
