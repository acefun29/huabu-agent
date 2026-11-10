/**
 * 上下文四段装配测试（架构图 to-be ①）。
 *
 * 目标：常驻段（项目索引）/ 轮换段（当前范围）/ 队列段（任务板）/ 注入段（素材库 + 画布）
 * 各自的生成规则、截断、空输入零注入，以及逐段独立的「与上轮一致则折叠」。
 * 这些是纯函数，输入是快照对象——不碰 IPC、不碰 store。
 */

import { describe, expect, it } from 'vitest'
import type { ProjectSnapshot } from '@shared/ipc'
import {
  PROJECT_DIGEST_MAX_ENTITIES,
  QUEUE_DIGEST_MAX_TASKS,
  SCOPE_DIGEST_MAX_NODES,
  buildProjectDigest,
  buildQueueDigest,
  buildScopeDigest,
  collectRoundContext
} from './contextCollector'
import { DIGEST_UNCHANGED_NOTE, PROJECT_DIGEST_HEADER, QUEUE_DIGEST_HEADER, SCOPE_DIGEST_HEADER } from '@shared/injection'

const WS = 'E:/ws'

/** 最小可用快照：两级（集 → 镜），根下 3 个集 */
function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    projects: [
      { id: 'p1', name: '夜行列车', kind: '短剧', summary: '3 集 · 9 镜' },
      { id: 'p2', name: '套图企划', kind: '漫画', summary: '2 话' }
    ],
    activeProjectId: 'p1',
    project: {
      id: 'p1',
      name: '夜行列车',
      kind: '短剧',
      rootLabel: '剧集',
      tagline: '一列永不到站的夜车',
      levels: [
        {
          key: 'episode',
          label: '剧集',
          plural: '集',
          icon: 'layers',
          container: true,
          fields: [{ key: 'num', label: '集数' }],
          cardFields: [],
          detailFields: []
        },
        {
          key: 'shot',
          label: '镜头',
          plural: '镜',
          icon: 'image',
          container: false,
          fields: [{ key: 'shotNo', label: '镜号' }],
          cardFields: [],
          detailFields: []
        }
      ]
    },
    nodes: [
      {
        id: 'ep1',
        level: 1,
        parentId: null,
        title: '第01集',
        order: 1,
        fields: { num: '1' },
        status: 'done',
        stats: { total: 4, done: 4, pct: 100 }
      },
      {
        id: 'ep2',
        level: 1,
        parentId: null,
        title: '第02集',
        order: 2,
        fields: { num: '2' },
        status: 'generating',
        stats: { total: 3, done: 1, pct: 33 }
      },
      {
        id: 'ep3',
        level: 1,
        parentId: null,
        title: '第03集',
        order: 3,
        fields: { num: '3' },
        status: 'todo',
        stats: { total: 2, done: 0, pct: 0 }
      }
    ],
    breadcrumb: [{ id: null, title: '剧集' }],
    promptLayers: [{ level: 'project', label: '夜行列车', prompt: '冷调写实' }],
    ...overrides
  }
}

describe('常驻段（项目索引）', () => {
  it('项目身份 + 层级链 + 其它项目 + 节点索引', () => {
    const text = buildProjectDigest(snapshot())
    expect(text.startsWith(PROJECT_DIGEST_HEADER)).toBe(true)
    expect(text).toContain('夜行列车')
    expect(text).toContain('冷调写实'.slice(0, 0) + '短剧')
    expect(text).toContain('1.剧集（集） → 2.镜头（镜）')
    expect(text).toContain('套图企划')
    expect(text).toContain('ep1 → 第01集')
    expect(text).toContain('完成 4/4')
  })

  it('无项目 / 空快照 ⇒ 空串（零注入）', () => {
    expect(buildProjectDigest(null)).toBe('')
    expect(buildProjectDigest(snapshot({ project: null, nodes: [] }))).toBe('')
  })

  it('节点超过上限 ⇒ 折叠为「另有 N 个节点未列出」', () => {
    const nodes = Array.from({ length: PROJECT_DIGEST_MAX_ENTITIES + 6 }, (_, i) => ({
      id: `n${i}`,
      level: 1,
      parentId: null,
      title: `节点${i}`,
      order: i,
      fields: {},
      status: 'todo' as const
    }))
    const text = buildProjectDigest(snapshot({ nodes }))
    expect(text).toContain('另有 6 个节点未列出')
    const rows = text.split('\n').filter((line) => line.startsWith('  · '))
    expect(rows.length).toBe(PROJECT_DIGEST_MAX_ENTITIES)
  })

  it('不含节点正文/提示词全文（常驻段不该为不在工作集里的内容付费）', () => {
    const withPrompt = snapshot({
      nodes: [
        {
          id: 'ep1',
          level: 1,
          parentId: null,
          title: '第01集',
          order: 1,
          fields: {},
          status: 'todo',
          prompt: '这是一大段不该出现在常驻段里的镜头描述'.repeat(5)
        }
      ]
    })
    const text = buildProjectDigest(withPrompt)
    expect(text).not.toContain('这是一大段不该出现在常驻段里的镜头描述')
  })
})

describe('轮换段（当前范围）', () => {
  it('面包屑 + 层名 + 子节点条目（状态/字段/进度）', () => {
    const text = buildScopeDigest(snapshot())
    expect(text.startsWith(SCOPE_DIGEST_HEADER)).toBe(true)
    expect(text).toContain('剧集 · 剧集层')
    expect(text).toContain('共 3 个子节点')
    expect(text).toContain('ep2｜第02集｜generating｜num=2｜完成 1/3')
  })

  it('无子节点时明确说明', () => {
    const text = buildScopeDigest(snapshot({ nodes: [] }))
    expect(text).toContain('这一层还没有节点')
  })

  it('子节点超过上限 ⇒ 折叠提示用 scope 聚焦', () => {
    const nodes = Array.from({ length: SCOPE_DIGEST_MAX_NODES + 4 }, (_, i) => ({
      id: `s${i}`,
      level: 1,
      parentId: null,
      title: `第${i}集`,
      order: i,
      fields: {},
      status: 'todo' as const
    }))
    const text = buildScopeDigest(snapshot({ nodes }))
    expect(text).toContain('另有 4 个未列出')
  })

  it('无项目 ⇒ 空串', () => {
    expect(buildScopeDigest(null)).toBe('')
  })
})

describe('队列段（任务板）', () => {
  type QueueTask = NonNullable<Parameters<typeof buildQueueDigest>[0]>['tasks'][number]
  const board = (tasks: QueueTask[]) => ({
    tasks,
    runningTaskIds: tasks.filter((task) => task.status === 'active').map((task) => task.taskId)
  })

  it('attention / blocked 逐条列出（带原因与轮次），active 只报数量', () => {
    const text = buildQueueDigest(
      board([
        {
          taskId: 't1',
          status: 'attention',
          scope: '第02集/第3场',
          title: '天台对峙',
          attempts: 2,
          lastReason: '比例不符 16:9'
        },
        { taskId: 't2', status: 'blocked', scope: '第02集/第4场', attempts: 0, lastReason: '缺参考' },
        { taskId: 't3', status: 'active', scope: '第03集/第1场', attempts: 0 },
        { taskId: 't4', status: 'done', scope: '第02集/第1场', attempts: 0 }
      ])
    )
    expect(text.startsWith(QUEUE_DIGEST_HEADER)).toBe(true)
    expect(text).toContain('[待重派] t1')
    expect(text).toContain('已试 2 次')
    expect(text).toContain('比例不符 16:9')
    expect(text).toContain('[受阻] t2')
    expect(text).toContain('执行中 1 个')
    expect(text).toContain('最近完成')
    // active 清单不逐条列出（只有汇总行）
    expect(text).not.toContain('[执行中]')
  })

  it('空任务板 / 无 board ⇒ 空串', () => {
    expect(buildQueueDigest(null)).toBe('')
    expect(buildQueueDigest({ tasks: [], runningTaskIds: [] })).toBe('')
  })

  it('待处理任务超过上限 ⇒ 折叠', () => {
    const tasks = Array.from({ length: QUEUE_DIGEST_MAX_TASKS + 3 }, (_, i) => ({
      taskId: `t${i}`,
      status: 'attention' as const,
      scope: `s${i}`,
      attempts: 1,
      lastReason: 'x'
    }))
    const text = buildQueueDigest(board(tasks))
    expect(text).toContain(`另有 3 个待处理任务`)
  })
})

describe('四段装配：顺序 / 零注入 / 逐段折叠', () => {
  const base = {
    selectedAssetIds: [],
    injectedAssetIds: [],
    nodes: [],
    tempAttachments: [],
    workspaceDir: WS,
    libraries: []
  }

  it('段顺序固定：常驻 → 轮换 → 队列 → 注入', () => {
    const out = collectRoundContext({
      ...base,
      project: snapshot(),
      taskBoard: {
        tasks: [{ taskId: 't1', status: 'attention', scope: 's', attempts: 1, lastReason: 'x' }],
        runningTaskIds: []
      }
    })
    const order = [PROJECT_DIGEST_HEADER, SCOPE_DIGEST_HEADER, QUEUE_DIGEST_HEADER].map((header) =>
      out.contextText.indexOf(header)
    )
    expect(order[0]).toBeGreaterThanOrEqual(0)
    expect(order[1]).toBeGreaterThan(order[0])
    expect(order[2]).toBeGreaterThan(order[1])
    // segments 与拼接一致
    expect(out.contextText).toBe(
      [out.segments.resident, out.segments.rotating, out.segments.queue, out.segments.injected]
        .filter(Boolean)
        .join('\n\n')
    )
  })

  it('全空输入 ⇒ contextText 为空串（零冗余注入）', () => {
    const out = collectRoundContext(base)
    expect(out.contextText).toBe('')
    expect(out.digests).toMatchObject({ project: '', scope: '', queue: '' })
  })

  it('逐段折叠：前两轮一致的项目段/队列段折叠，变化的画布段保留全文', () => {
    const input = {
      ...base,
      project: snapshot(),
      taskBoard: {
        tasks: [{ taskId: 't1', status: 'attention' as const, scope: 's', attempts: 1, lastReason: 'x' }],
        runningTaskIds: []
      },
      nodes: [
        {
          id: 'c1',
          type: 'asset' as const,
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          zIndex: 1,
          data: { name: '封面.png', kind: 'image' as const, storage: 'ws' as const, path: 'assets/images/封面.png' }
        }
      ]
    }
    const first = collectRoundContext(input)
    const second = collectRoundContext({ ...input, previousDigests: first.digests })
    expect(second.contextText).toContain(`${PROJECT_DIGEST_HEADER}${DIGEST_UNCHANGED_NOTE}`)
    expect(second.contextText).toContain(`${QUEUE_DIGEST_HEADER}${DIGEST_UNCHANGED_NOTE}`)
    // digests 出参仍是全文（供下轮比较）
    expect(second.digests.project).toContain('夜行列车')
    expect(second.digests.queue).toContain('t1')
  })

  it('项目结构变化（下钻 scope）⇒ 轮换段换内容，常驻段仍折叠', () => {
    const first = collectRoundContext({ ...base, project: snapshot() })
    const drilled = snapshot({
      nodes: [
        {
          id: 'sh1',
          level: 2,
          parentId: 'ep2',
          title: '第1镜',
          order: 1,
          fields: { shotNo: '1' },
          status: 'done'
        }
      ],
      breadcrumb: [
        { id: null, title: '剧集' },
        { id: 'ep2', title: '第02集' }
      ]
    })
    const second = collectRoundContext({ ...base, project: drilled, previousDigests: first.digests })
    // 面包屑是完整路径（剧集 / 第02集），层名取 scope 节点的下一层 = 镜头
    expect(second.contextText).toContain('剧集 / 第02集 · 镜头层')
    expect(second.contextText).toContain('sh1｜第1镜')
    // 常驻段：节点索引变了（ep1/ep2/ep3 → sh1），所以它是全文而不是占位
    expect(second.contextText).not.toContain(`${PROJECT_DIGEST_HEADER}${DIGEST_UNCHANGED_NOTE}`)
  })
})
