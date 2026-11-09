/**
 * 项目结构模型测试（原型 index-projects.html 后端）。
 *
 * 重点验证与原型一致的三条语义：
 * 1. 层级由数据定义（短剧 3 层 / 套图 2 层共用同一套函数）；
 * 2. 状态只有四态（无 review），由产物 + 运行时提示派生；
 * 3. 提示词逐级继承（项目 → L1 → L2 → L3）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DRAMA_LEVELS,
  PROMO_LEVELS,
  ProjectStore,
  addNode,
  childrenOf,
  contextHealth,
  createStarterProject,
  deriveStatus,
  effectivePrompt,
  emptyProject,
  findNode,
  isDescendantOf,
  leafStats,
  patchNode,
  pathOf,
  projectDepth,
  removeNode,
  reorderChildren,
  type Project,
} from '.'

const dirs: string[] = []
function tmpWs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'huabu-project-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄未释放时 best-effort
    }
  }
})

/** 建一个「2 集 × 2 场 × 2 镜」的短剧项目 */
function dramaProject(): Project {
  let project = emptyProject({
    id: 'drama',
    name: '夜行列车',
    kind: '短剧',
    levels: DRAMA_LEVELS,
    rootLabel: '全剧索引',
    promptBase: '冷调 35mm 胶片',
  })
  project = addNode(project, { id: 'ep1', level: 1, parentId: null, title: 'EP01 雨夜进站', fields: { num: 'EP01' }, prompt: '雨夜站台' })
  project = addNode(project, { id: 'ep2', level: 1, parentId: null, title: 'EP02 窗上的字', fields: { num: 'EP02' } })
  project = addNode(project, { id: 'ep1-s1', level: 2, parentId: 'ep1', title: 'S01 站台', fields: { location: '站台' }, prompt: '湿冷反光' })
  project = addNode(project, { id: 'ep1-s2', level: 2, parentId: 'ep1', title: 'S02 车厢', fields: { location: '车厢' } })
  let n = 0
  for (const scene of ['ep1-s1', 'ep1-s2']) {
    for (let i = 1; i <= 2; i += 1) {
      n += 1
      project = addNode(project, {
        id: `${scene}-sh${i}`,
        level: 3,
        parentId: scene,
        title: `SH0${i}`,
        fields: { shotNo: `${n}` },
        ...(i === 1 && scene === 'ep1-s1' ? { assetId: 'asset-1' } : {}),
      })
    }
  }
  return project
}

describe('层级由数据定义', () => {
  it('短剧 3 层 / 套图 2 层，depth 来自 levels.length', () => {
    expect(projectDepth({ levels: DRAMA_LEVELS } as Project)).toBe(3)
    expect(projectDepth({ levels: PROMO_LEVELS } as Project)).toBe(2)
    const promo = createStarterProject({ id: 'p', name: '晨雾', kind: '产品套图' })
    expect(promo.levels.map((l) => l.label)).toEqual(['套图组', '单图'])
    const drama = createStarterProject({ id: 'd', name: '夜行列车', kind: '短剧' })
    expect(drama.levels.map((l) => l.label)).toEqual(['剧集', '场景', '镜头'])
    // 未知类型给单层兜底（数据驱动，不改代码）
    const other = createStarterProject({ id: 'o', name: '其它', kind: '任意' })
    expect(projectDepth(other)).toBe(1)
  })

  it('addNode 校验层级一致性：父为 L1 时子必须是 L2', () => {
    const project = dramaProject()
    expect(() =>
      addNode(project, { id: 'bad', level: 3, parentId: 'ep1', title: 'x', fields: {} })
    ).toThrow(/层级不匹配/)
    expect(() =>
      addNode(project, { id: 'bad2', level: 1, parentId: null, title: 'x', fields: {} })
    ).not.toThrow()
  })

  it('叶子层不能再挂子节点；超过 depth 拒绝', () => {
    const project = dramaProject()
    expect(() =>
      addNode(project, { id: 'x', level: 4, parentId: 'ep1-s1-sh1', title: 'x', fields: {} })
    ).toThrow()
  })

  it('childrenOf 按 order 排序；pathOf 从根到自身', () => {
    const project = dramaProject()
    expect(childrenOf(project, 'ep1').map((n) => n.id)).toEqual(['ep1-s1', 'ep1-s2'])
    expect(pathOf(project, 'ep1-s1-sh1').map((n) => n.id)).toEqual(['ep1', 'ep1-s1', 'ep1-s1-sh1'])
    expect(findNode(project, 'nope')).toBeNull()
  })

  it('isDescendantOf 判断子树', () => {
    const project = dramaProject()
    const leaf = findNode(project, 'ep1-s1-sh1')!
    expect(isDescendantOf(project, leaf, 'ep1')).toBe(true)
    expect(isDescendantOf(project, leaf, 'ep2')).toBe(false)
  })
})

describe('状态派生（只有四态，无 review）', () => {
  it('叶子：有 assetId = done，否则 todo', () => {
    const project = dramaProject()
    expect(deriveStatus(project, findNode(project, 'ep1-s1-sh1')!)).toBe('done')
    expect(deriveStatus(project, findNode(project, 'ep1-s1-sh2')!)).toBe('todo')
  })

  it('运行时提示优先：generating / attention', () => {
    const project = dramaProject()
    const leaf = findNode(project, 'ep1-s1-sh2')!
    expect(deriveStatus(project, leaf, { generating: true })).toBe('generating')
    expect(deriveStatus(project, leaf, { attention: true })).toBe('attention')
    // attention 优先级高于 generating
    expect(deriveStatus(project, leaf, { generating: true, attention: true })).toBe('attention')
  })

  it('容器：子树叶子全完成才 done，部分完成算 generating', () => {
    const project = dramaProject()
    const ep1 = findNode(project, 'ep1')!
    // 4 个叶子只完成 1 个 → generating
    expect(deriveStatus(project, ep1)).toBe('generating')
    const stats = leafStats(project, 'ep1')
    expect(stats).toEqual({ total: 4, done: 1, pct: 25 })
    const empty = findNode(project, 'ep2')!
    expect(deriveStatus(project, empty)).toBe('todo')
    expect(leafStats(project, 'ep2').total).toBe(0)
  })

  it('没有任何 review 态：派生结果只在四态内', () => {
    const project = dramaProject()
    const allowed = new Set(['todo', 'generating', 'done', 'attention'])
    for (const node of project.nodes) {
      expect(allowed.has(deriveStatus(project, node))).toBe(true)
    }
  })
})

describe('提示词逐级继承', () => {
  it('项目 → 剧集 → 场景 逐级拼接，空层跳过', () => {
    const project = dramaProject()
    const result = effectivePrompt(project, 'ep1-s1-sh1')
    expect(result.layers.map((l) => l.level)).toEqual(['project', 'episode', 'scene'])
    expect(result.effective).toBe('冷调 35mm 胶片。雨夜站台。湿冷反光')
    expect(result.ownPrompt).toBe(false)
  })

  it('本层有 prompt 时追加到末尾且 ownPrompt=true', () => {
    const project = patchNode(dramaProject(), 'ep1-s1-sh1', { prompt: '低位仰拍' })
    const result = effectivePrompt(project, 'ep1-s1-sh1')
    expect(result.layers.at(-1)).toMatchObject({ level: 'shot', prompt: '低位仰拍' })
    expect(result.ownPrompt).toBe(true)
    expect(result.effective.endsWith('低位仰拍')).toBe(true)
  })

  it('无项目级 prompt 时链条从 L1 开始', () => {
    const project = { ...dramaProject(), promptBase: undefined }
    const result = effectivePrompt(project, 'ep1')
    expect(result.layers.map((l) => l.level)).toEqual(['episode'])
  })
})

describe('上下文健康（缺参考才停，非人工审批）', () => {
  it('资产存在 → 健康', () => {
    const project = dramaProject()
    const health = contextHealth(project, 'ep1-s1-sh1', new Set(['asset-1']))
    expect(health.ok).toBe(true)
    expect(health.issues).toEqual([])
  })

  it('叶子引用缺失 → missing_asset', () => {
    const project = dramaProject()
    const health = contextHealth(project, 'ep1-s1-sh1', new Set())
    expect(health.ok).toBe(false)
    expect(health.issues[0]?.kind).toBe('missing_asset')
  })

  it('容器：子树任一叶子缺资产也算缺参考', () => {
    const project = dramaProject()
    const health = contextHealth(project, 'ep1', new Set())
    expect(health.ok).toBe(false)
    expect(health.issues.length).toBeGreaterThan(0)
  })
})

describe('结构变更', () => {
  it('patchNode 合并 fields 不丢已有键', () => {
    const project = patchNode(dramaProject(), 'ep1', { fields: { duration: '12:40' } })
    const ep1 = findNode(project, 'ep1')!
    expect(ep1.fields).toMatchObject({ num: 'EP01', duration: '12:40' })
  })

  it('removeNode 级联删除子树并返回全部 id', () => {
    const { project, removedIds } = removeNode(dramaProject(), 'ep1-s1')
    expect(removedIds.sort()).toEqual(['ep1-s1', 'ep1-s1-sh1', 'ep1-s1-sh2'].sort())
    expect(project.nodes.some((n) => n.id === 'ep1-s1')).toBe(false)
    expect(project.nodes.some((n) => n.id === 'ep1-s2')).toBe(true)
  })

  it('reorderChildren 按给定顺序重排', () => {
    const project = reorderChildren(dramaProject(), 'ep1', ['ep1-s2', 'ep1-s1'])
    expect(childrenOf(project, 'ep1').map((n) => n.id)).toEqual(['ep1-s2', 'ep1-s1'])
  })
})

describe('ProjectStore 持久化', () => {
  it('写入 → 读取往返；缺失文件返回空结构', async () => {
    const ws = tmpWs()
    const store = new ProjectStore(ws)
    expect((await store.load()).file.projects).toEqual([])

    await store.createProject(createStarterProject({ id: 'p1', name: '夜行列车', kind: '短剧' }))
    await store.addNode('p1', { id: 'ep1', level: 1, parentId: null, title: 'EP01', fields: {} })
    const reloaded = await new ProjectStore(ws).load()
    expect(reloaded.error).toBeUndefined()
    expect(reloaded.file.activeProjectId).toBe('p1')
    expect(reloaded.file.projects[0]?.nodes.map((n) => n.id)).toEqual(['ep1'])
  })

  it('坏 JSON 容错：返回空结构 + 原因，不抛错', async () => {
    const ws = tmpWs()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(ws, '.huabu'), { recursive: true })
    await writeFile(join(ws, '.huabu', 'project.json'), '{ broken', 'utf8')
    const loaded = await new ProjectStore(ws).load()
    expect(loaded.error).toContain('解析失败')
    expect(loaded.file.projects).toEqual([])
  })

  it('重复项目 id 拒绝；patchNode 不存在的节点报错', async () => {
    const ws = tmpWs()
    const store = new ProjectStore(ws)
    const project = createStarterProject({ id: 'p1', name: 'A', kind: '短剧' })
    await store.createProject(project)
    await expect(store.createProject(project)).rejects.toThrow(/已存在/)
    await expect(store.patchNode('p1', 'ghost', { title: 'x' })).rejects.toThrow(/节点不存在/)
  })

  it('并发 addNode 串行化，不丢节点', async () => {
    const ws = tmpWs()
    const store = new ProjectStore(ws)
    await store.createProject(createStarterProject({ id: 'p1', name: 'A', kind: '短剧' }))
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.addNode('p1', { id: `n${i}`, level: 1, parentId: null, title: `N${i}`, fields: {}, order: i + 1 })
      )
    )
    const { file } = await store.load()
    expect(file.projects[0]?.nodes).toHaveLength(8)
  })

  it('deleteProject 清理并回落 activeProjectId', async () => {
    const ws = tmpWs()
    const store = new ProjectStore(ws)
    await store.createProject(createStarterProject({ id: 'a', name: 'A', kind: '短剧' }))
    await store.createProject(createStarterProject({ id: 'b', name: 'B', kind: '产品套图' }))
    await store.setActiveProject('b')
    await store.deleteProject('b')
    const { file } = await store.load()
    expect(file.projects.map((p) => p.id)).toEqual(['a'])
    expect(file.activeProjectId).toBe('a')
  })
})
