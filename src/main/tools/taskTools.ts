/**
 * 任务工具（施工计划 v4 §10 第 5 步）。
 *
 * 模型和「任务」这个原子的全部接触面，就这几个动作：
 *
 *   create_task  开一个任务 → 立刻开工（work.created + work.started）
 *   start_task   继续一个退回待办的任务（同一个 taskId，work.started）
 *   finish_task  收工（有产物 → done；没产出 → 回到 todo）
 *   drop_task    放弃
 *   list_tasks   看现在有哪些任务
 *
 * 刻意**没有**：批准、驳回、验收、评分。判定是动作（模型看图 / 用户看图），
 * 不满意就再产出一版——那条路径不需要任何工具（§12 责任边界）。
 *
 * 参数在**写进 journal 之前**先校验一遍：非法任务绝不能进事实源，
 * 否则回放时只能记进 ignored，事实源被污染。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '../agent/contracts'
import { createTask, type TaskKind } from '../core/task'
import type { WorkEventType } from '../store/tasks'
import type { WorkState } from '../store/tasks'

const NO_WORKSPACE_TEXT = '尚未打开工作区，无法管理任务。请先在画布上打开或新建一个工作区。'

const STATUS_LABEL: Record<string, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  dropped: '已放弃'
}

const KIND_LABEL: Record<string, string> = {
  image: '图片',
  video: '视频',
  text: '文本'
}

export interface TaskToolDeps {
  currentDir: () => string | null
  /** 追加一条任务事实（宿主接到 WorkspaceJournal） */
  append: (type: WorkEventType, taskId: string, payload?: Record<string, unknown>) => Promise<void>
  /** 读当前状态（journal 投影后） */
  load: () => Promise<WorkState>
  /** 生成任务 id（模型也可以自己指定，如 V-02） */
  newTaskId: () => string
  /** 开工/继续：宿主把任务绑定到当前会话（产物归属靠它，见 loop/sessionTask.ts） */
  onTaskStarted?: (taskId: string) => void
  /** 收工/放弃：解除会话绑定 */
  onTaskClosed?: (taskId: string) => void
}

function ok(text: string, details: Record<string, unknown> = {}): {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
} {
  return { content: [{ type: 'text', text }], details: { ok: true, ...details } }
}

function err(text: string, details: Record<string, unknown> = {}): {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
  isError: true
} {
  return { content: [{ type: 'text', text }], details: { ok: false, ...details }, isError: true }
}

export function assembleTaskTools(deps: TaskToolDeps): ToolDefinition[] {
  const createTaskTool: ToolDefinition = {
    name: 'create_task',
    label: '开一个任务',
    description:
      '开一个任务并立刻开工。任务 = 一次交付：说清要做什么（brief），以及产物写到哪个目录（lane）。\n' +
      '什么时候用：要产出一个文件（图、视频、文本）之前先开任务。一次任务只对应一个交付物，' +
      '要做三样东西就开三个任务。\n' +
      'lane 必须是你这次要写的目录（如 assets/visual、story）；写到 lane 之外的文件不会成为本任务的产物。\n' +
      '开完会返回 taskId，收工时用它调 finish_task。',
    parameters: Type.Object({
      title: Type.String({ description: '任务标题，一句话，如「主视觉 6 张」' }),
      brief: Type.String({
        description: '要做什么。把用户的原话与验收要求都写进来，这是给执行时的自己看的说明'
      }),
      lane: Type.String({ description: '产物可写目录，工作区相对路径，如 assets/visual' }),
      kind: Type.String({ description: '产物类型：image / video / text' }),
      id: Type.Optional(Type.String({ description: '可选任务号，如 V-02；不填自动生成' }))
    }),
    execute: async (_toolCallId, params) => {
      const dir = deps.currentDir()
      if (!dir) return err(NO_WORKSPACE_TEXT)
      const raw = (params ?? {}) as Record<string, unknown>
      const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
      const taskId = (typeof raw.id === 'string' && raw.id.trim()) || deps.newTaskId()

      // 先按原子规则建一遍（校验 title/brief/lane/kind），通过后才落事实源
      try {
        createTask(
          {
            title: typeof raw.title === 'string' ? raw.title : '',
            brief: typeof raw.brief === 'string' ? raw.brief : '',
            lane: typeof raw.lane === 'string' ? raw.lane : '',
            kind: kind as TaskKind
          },
          { id: taskId, createdAt: new Date().toISOString() }
        )
      } catch (error) {
        return err(`任务没开成：${error instanceof Error ? error.message : String(error)}`)
      }

      const state = await deps.load()
      if (state.tasks.some((task) => task.id === taskId)) {
        return err(`任务号 ${taskId} 已被占用，换一个或让它自动生成。`)
      }

      await deps.append('work.created', taskId, {
        title: String(raw.title).trim(),
        brief: String(raw.brief).trim(),
        lane: String(raw.lane).trim(),
        kind
      })
      await deps.append('work.started', taskId)
      deps.onTaskStarted?.(taskId)
      return ok(
        `已开工：${taskId}（${KIND_LABEL[kind] ?? kind}，写区 ${String(raw.lane).trim()}/）。` +
          `产出后调 finish_task（taskId=${taskId}）收工。`,
        { taskId }
      )
    }
  }

  /**
   * 继续一个退回待办的任务。
   *
   * 为什么需要它：finish_task 在零产出时把任务放回 todo（不伪造完成），
   * 但 create_task 拒绝既有 id、界面上只有「放弃」——任务就此卡住、没有回程。
   * 这里直接复用 core/task 的 startTask 迁移：只补一条 work.started 事实，
   * 不产生第二条创建事实，任务号与写区都不变；终态仍不可重开。
   */
  const startTaskTool: ToolDefinition = {
    name: 'start_task',
    label: '继续任务',
    description:
      '把一个退回待办的任务重新开工，沿用原来的 taskId 与写区。\n' +
      '什么时候用：finish_task 说「这一轮没有产出，已回到待办」，而你还要接着做——用它，不要用 create_task 重开新任务。\n' +
      '已完成或已放弃的任务不能重开。',
    parameters: Type.Object({
      taskId: Type.String({ description: '要继续的任务号（list_tasks 可查）' })
    }),
    execute: async (_toolCallId, params) => {
      const dir = deps.currentDir()
      if (!dir) return err(NO_WORKSPACE_TEXT)
      const taskId = String((params as { taskId?: unknown } | null)?.taskId ?? '').trim()
      if (!taskId) return err('需要 taskId：先用 list_tasks 看现有任务。')

      const state = await deps.load()
      const task = state.tasks.find((entry) => entry.id === taskId)
      if (!task) return err(`没有任务 ${taskId}。先用 list_tasks 看现有任务。`)
      if (task.status === 'doing') {
        return ok(`任务 ${taskId} 已经在做（写区 ${task.lane}/），直接继续产出即可。`, {
          taskId,
          status: 'doing',
          lane: task.lane
        })
      }
      if (task.status === 'done' || task.status === 'dropped') {
        return err(
          `任务 ${taskId} 已是「${STATUS_LABEL[task.status]}」，不能重开。要改方向请用 create_task 开一个新任务。`
        )
      }

      await deps.append('work.started', taskId)
      deps.onTaskStarted?.(taskId)
      return ok(
        `任务 ${taskId} 已重新开工（${KIND_LABEL[task.kind] ?? task.kind}，写区 ${task.lane}/）。` +
          '产出后用 finish_task 收工。',
        { taskId, status: 'doing', lane: task.lane, kind: task.kind }
      )
    }
  }

  const finishTaskTool: ToolDefinition = {
    name: 'finish_task',
    label: '收工',
    description:
      '结束一个正在做的任务。有产物就算完成；这一轮什么都没产出，任务会回到待办，等你下次再做。\n' +
      '调之前先看一眼自己产出的东西对不对——不满意就再产出一版（旧版会留着，可以随时翻回去），' +
      '满意了再收工。',
    parameters: Type.Object({
      taskId: Type.String({ description: '要收工的任务号' })
    }),
    execute: async (_toolCallId, params) => {
      const dir = deps.currentDir()
      if (!dir) return err(NO_WORKSPACE_TEXT)
      const taskId = String((params as { taskId?: unknown } | null)?.taskId ?? '').trim()
      if (!taskId) return err('需要 taskId：先用 list_tasks 看现在有哪些任务。')

      const state = await deps.load()
      const task = state.tasks.find((entry) => entry.id === taskId)
      if (!task) return err(`没有任务 ${taskId}。先用 list_tasks 看现在有哪些任务。`)
      if (task.status === 'done') return ok(`任务 ${taskId} 已经完成了。`, { taskId, status: 'done' })
      if (task.status === 'dropped') return err(`任务 ${taskId} 已放弃，不能再收工。`)
      if (task.status !== 'doing') {
        return err(`任务 ${taskId} 还是「${STATUS_LABEL[task.status] ?? task.status}」，没有在做的任务可以收工。`)
      }

      await deps.append('work.finished', taskId)
      deps.onTaskClosed?.(taskId)
      const produced = task.artifacts.length
      return produced > 0
        ? ok(`任务 ${taskId} 完成（共产出 ${produced} 个版本）。`, { taskId, status: 'done', versions: produced })
        : ok(
            `任务 ${taskId} 这一轮没有产出，已回到待办（不算完成）。需要的话再开工继续。`,
            { taskId, status: 'todo', versions: 0 }
          )
    }
  }

  const dropTaskTool: ToolDefinition = {
    name: 'drop_task',
    label: '放弃任务',
    description:
      '放弃一个不再需要的任务（方向变了、用户说不用做了、开错了）。\n' +
      '放弃是终态：任务不会消失，仍能在列表里看到，但不再算"正在做"。\n' +
      '已经完成的任务不能放弃——那是既成事实，要推翻只能开一个新任务。\n' +
      '什么时候用：用户改主意、需求作废、或者你发现这个任务从一开始就不该开。',
    parameters: Type.Object({
      taskId: Type.String({ description: '要放弃的任务号' })
    }),
    execute: async (_toolCallId, params) => {
      const dir = deps.currentDir()
      if (!dir) return err(NO_WORKSPACE_TEXT)
      const taskId = String((params as { taskId?: unknown } | null)?.taskId ?? '').trim()
      if (!taskId) return err('需要 taskId：先用 list_tasks 看现在有哪些任务。')

      const state = await deps.load()
      const task = state.tasks.find((entry) => entry.id === taskId)
      if (!task) return err(`没有任务 ${taskId}。先用 list_tasks 看现在有哪些任务。`)
      if (task.status === 'dropped') return ok(`任务 ${taskId} 已经放弃过了。`, { taskId, status: 'dropped' })
      if (task.status === 'done') {
        return err(`任务 ${taskId} 已完成，不能放弃。要改方向请开一个新任务。`)
      }

      await deps.append('work.dropped', taskId)
      deps.onTaskClosed?.(taskId)
      return ok(
        `任务 ${taskId} 已放弃。${task.artifacts.length > 0 ? `（它留下过 ${task.artifacts.length} 个版本，仍在。）` : ''}`,
        { taskId, status: 'dropped' }
      )
    }
  }

  const listTasksTool: ToolDefinition = {
    name: 'list_tasks',
    label: '看任务',
    description:
      '列出当前工作区的任务：id、状态、标题、写区、已产出几个版本。\n' +
      '用户问「做到哪了」时用它回答；收工前不确定 taskId 也用它。',
    parameters: Type.Object({}),
    execute: async () => {
      const dir = deps.currentDir()
      if (!dir) return err(NO_WORKSPACE_TEXT)
      const state = await deps.load()
      // 投影里被忽略的事件要说一声：否则模型会以为状态是干净的
      const ignoredNote =
        state.ignored.length > 0 ? `（有 ${state.ignored.length} 条历史记录无法应用，已跳过。）` : ''
      if (state.tasks.length === 0) {
        return ok(
          ['还没有任务。要产出东西之前先用 create_task 开一个。', ignoredNote].filter(Boolean).join('\n')
        )
      }

      const lines = [`任务共 ${state.tasks.length} 个：`]
      for (const task of state.tasks) {
        const versions = task.artifacts.length
        lines.push(
          [
            `- ${task.id} [${STATUS_LABEL[task.status] ?? task.status}]`,
            `「${task.title}」`,
            `写区 ${task.lane}/`,
            versions > 0 ? `已产出 ${versions} 个版本` : '还没有产物'
          ].join(' · ')
        )
      }
      if (ignoredNote) lines.push(ignoredNote)
      return ok(lines.join('\n'), { tasks: state.tasks, ignored: state.ignored.length })
    }
  }

  return [createTaskTool, startTaskTool, finishTaskTool, dropTaskTool, listTasksTool]
}
