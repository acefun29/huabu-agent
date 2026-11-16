/**
 * Web 端开发 harness（仅浏览器直开时启用，Electron 内不加载）。
 *
 * 目的：前端交互（尤其项目结构视图）在浏览器里秒级验证，不必忍受 Electron 启动。
 * 做法：在 React 挂载前注入 window.huabu 的浏览器实现——内存态 workspace/project API，
 * 其余域给保守空实现（调用即抛「Web 预览不支持」，让缺失能力显式可见而不是静默假成功）。
 *
 * 数据来源：
 * - project：一份内置 demo（短剧 3 层 + 套图 2 层），可增删改，刷新即重置；
 * - 画布/素材库：空（结构视图不依赖它们；自由画布在 Web 下只是空引导）。
 */

import type { Project, ProjectFile, ProjectLevel } from '../../main/project/model'
import { createWebBridgeApi, resolveBridgeConfig } from './webBridgeClient'

const DRAMA_LEVELS: ProjectLevel[] = [
  {
    key: 'episode', label: '剧集', plural: '集', icon: 'layers', container: true,
    fields: [
      { key: 'num', label: '集数' },
      { key: 'duration', label: '时长' },
      { key: 'logline', label: '一句话' },
    ],
    cardFields: ['duration'],
    detailFields: ['num', 'duration', 'logline'],
  },
  {
    key: 'scene', label: '场景', plural: '场', icon: 'file-text', container: true,
    fields: [
      { key: 'location', label: '地点' },
      { key: 'time', label: '时间' },
      { key: 'mood', label: '氛围' },
    ],
    cardFields: ['location', 'time'],
    detailFields: ['location', 'time', 'mood'],
  },
  {
    key: 'shot', label: '镜头', plural: '镜', icon: 'image', container: false,
    fields: [
      { key: 'shotNo', label: '镜号' },
      { key: 'size', label: '景别' },
      { key: 'movement', label: '运镜' },
      { key: 'duration', label: '时长' },
      { key: 'description', label: '描述' },
    ],
    cardFields: ['size', 'duration'],
    detailFields: ['shotNo', 'size', 'movement', 'duration', 'description'],
  },
]

const PROMO_LEVELS: ProjectLevel[] = [
  {
    key: 'set', label: '套图组', plural: '组', icon: 'layers', container: true,
    fields: [{ key: 'ratio', label: '比例' }, { key: 'scene', label: '场景' }],
    cardFields: ['ratio', 'scene'],
    detailFields: ['ratio', 'scene'],
  },
  {
    key: 'image', label: '单图', plural: '图', icon: 'image', container: false,
    fields: [{ key: 'angle', label: '角度' }, { key: 'note', label: '说明' }],
    cardFields: ['angle'],
    detailFields: ['angle', 'note'],
  },
]

/** 演示数据：短剧（2 集 × 2 场 × 2 镜） */
function demoDrama(): Project {
  const nodes: Project['nodes'] = []
  let order = 0
  const EP = [
    { title: 'EP01 雨夜进站', num: 'EP01', duration: '12:40', logline: '末班车进站，她带着一张不属于自己的车票上车。', prompt: '雨夜站台，湿冷反光，末班车进站。', cover: './demo/drama-01.jpg' },
    { title: 'EP02 窗上的字', num: 'EP02', duration: '13:10', logline: '雨水在玻璃上写字，车厢里没有人承认见过她。', prompt: '窗上雨水写字，暖黄与深蓝对照。', cover: './demo/drama-02.jpg' },
  ]
  EP.forEach((ep, ei) => {
    const epId = `ep${ei + 1}`
    nodes.push({
      id: epId, level: 1, parentId: null, title: ep.title, order: ++order,
      fields: { num: ep.num, duration: ep.duration, logline: ep.logline },
      prompt: ep.prompt,
      cover: ep.cover,
    })
    const SC = [
      { title: 'S01 站台', location: '站台', time: '夜', mood: '湿冷压抑', cover: './demo/drama-03.jpg' },
      { title: 'S02 车厢', location: '车厢', time: '深夜', mood: '封闭不安', cover: './demo/drama-04.jpg' },
    ]
    SC.forEach((sc, si) => {
      const scId = `${epId}-s${si + 1}`
      nodes.push({
        id: scId, level: 2, parentId: epId, title: sc.title, order: si + 1,
        fields: { location: sc.location, time: sc.time, mood: sc.mood },
        cover: sc.cover,
        ...(si === 0 ? { prompt: '低照度，玻璃反光，浅景深。' } : {}),
      })
      const SH = [
        { size: '全景', movement: '固定', duration: '4s', description: '雨幕下的站台空镜，远处列车灯扫过。' },
        { size: '特写', movement: '慢推', duration: '3s', description: '她握紧车票的手，指节发白。' },
      ]
      SH.forEach((sh, hi) => {
        // 前三个镜头有产物（模拟已生成），其余待生成
        const done = ei === 0 && si <= 1 && hi === 0
        nodes.push({
          id: `${scId}-sh${hi + 1}`,
          level: 3,
          parentId: scId,
          title: `SH0${hi + 1} ${sh.size}`,
          order: hi + 1,
          fields: {
            shotNo: `${ep.num}-S${si + 1}-SH${hi + 1}`,
            size: sh.size,
            movement: sh.movement,
            duration: sh.duration,
            description: sh.description,
          },
          ...(done ? { assetId: `asset-${ei}${si}${hi}` } : {}),
        })
      })
    })
  })
  return {
    id: 'drama',
    name: '夜行列车',
    kind: '短剧',
    dot: '#547a72',
    tagline: '末班夜行列车，一个丢了名字的女人，和一张不该出现的车票。',
    rootLabel: '全剧索引',
    promptBase: '夜行列车：冷调 35mm 胶片，青橙对比，低照度，克制表演，雨与玻璃。',
    levels: DRAMA_LEVELS,
    nodes,
  }
}

/** 演示数据：套图（3 组 × 1–2 图） */
function demoPromo(): Project {
  const nodes: Project['nodes'] = []
  const SETS = [
    { title: 'A 晨光', ratio: '1:1', scene: '窗台', images: ['正面', '45°'], cover: './demo/still-01.jpg' },
    { title: 'B 器物', ratio: '4:5', scene: '桌面', images: ['俯拍'], cover: './demo/still-02.jpg' },
    { title: 'C 余韵', ratio: '3:2', scene: '织物', images: ['特写'], cover: './demo/still-03.jpg' },
  ]
  SETS.forEach((set, si) => {
    const setId = `set${si + 1}`
    nodes.push({ id: setId, level: 1, parentId: null, title: set.title, order: si + 1, fields: { ratio: set.ratio, scene: set.scene }, cover: set.cover })
    set.images.forEach((angle, ii) => {
      nodes.push({
        id: `${setId}-i${ii + 1}`,
        level: 2,
        parentId: setId,
        title: `${set.title}-${ii + 1}`,
        order: ii + 1,
        fields: { angle, note: '柔和窗光，哑光陶瓷' },
        ...(si === 0 ? { assetId: `promo-${si}-${ii}` } : {}),
      })
    })
  })
  return {
    id: 'promo',
    name: '晨雾',
    kind: '产品套图',
    dot: '#8a7255',
    tagline: '晨雾 · 器物香氛 2026 春夏，一组被窗光晒暖的静物。',
    rootLabel: '套图索引',
    promptBase: '晨雾：暖米色，洞石，哑光陶瓷，柔和窗光，低饱和，编辑感。',
    levels: PROMO_LEVELS,
    nodes,
  }
}

/** 内存态 project 数据（含派生查询，逻辑与主进程 model.ts 保持一致） */
class WebProjectHarness {
  private file: ProjectFile = { version: 1, activeProjectId: 'drama', projects: [demoDrama(), demoPromo()] }
  private listeners = new Set<() => void>()

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  private project(id?: string | null): Project | undefined {
    return this.file.projects.find((p) => p.id === (id ?? this.file.activeProjectId))
  }

  private depth(p: Project): number {
    return p.levels.length
  }
  private children(p: Project, parentId: string | null): Project['nodes'] {
    return p.nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.order - b.order)
  }
  private find(p: Project, id: string | null | undefined): Project['nodes'][number] | undefined {
    return id ? p.nodes.find((n) => n.id === id) : undefined
  }
  private chain(p: Project, id: string): Project['nodes'] {
    const out: Project['nodes'] = []
    let node = this.find(p, id)
    while (node) {
      out.unshift(node)
      node = node.parentId ? this.find(p, node.parentId) : undefined
    }
    return out
  }
  private isDesc(p: Project, node: Project['nodes'][number], ancestorId: string): boolean {
    let parent = node.parentId
    while (parent) {
      if (parent === ancestorId) return true
      parent = this.find(p, parent)?.parentId ?? null
    }
    return false
  }
  private leafStats(p: Project, id: string): { total: number; done: number; pct: number } {
    const depth = this.depth(p)
    const leaves = p.nodes.filter((n) => n.level === depth && (n.id === id || this.isDesc(p, n, id)))
    const done = leaves.filter((n) => n.assetId).length
    return { total: leaves.length, done, pct: leaves.length ? Math.round((done / leaves.length) * 100) : 0 }
  }
  private status(p: Project, node: Project['nodes'][number]): 'todo' | 'generating' | 'done' | 'attention' {
    if (node.level < this.depth(p)) {
      const stats = this.leafStats(p, node.id)
      if (stats.total > 0 && stats.done === stats.total) return 'done'
      return stats.done > 0 ? 'generating' : 'todo'
    }
    return node.assetId ? 'done' : 'todo'
  }
  private summary(p: Project): string {
    const parts: string[] = []
    for (let level = 1; level <= this.depth(p); level += 1) {
      const count = p.nodes.filter((n) => n.level === level).length
      if (count > 0) parts.push(`${count} ${p.levels[level - 1]?.plural ?? '项'}`)
    }
    return parts.join(' · ') || '空'
  }

  snapshot(request: { scopeId?: string | null }): unknown {
    const p = this.project()
    const projects = this.file.projects.map((item) => ({
      id: item.id, name: item.name, kind: item.kind, dot: item.dot, summary: this.summary(item),
    }))
    if (!p) {
      return { ok: true, value: { projects, activeProjectId: this.file.activeProjectId, project: null, nodes: [], breadcrumb: [], promptLayers: [] } }
    }
    const depth = this.depth(p)
    const requested = this.find(p, request.scopeId ?? null)
    const scope = requested && requested.level < depth ? requested : null
    const nodes = this.children(p, scope?.id ?? null).map((node) => {
      const showStats = node.level < depth
      return {
        id: node.id, level: node.level, parentId: node.parentId, title: node.title,
        ...(node.subtitle ? { subtitle: node.subtitle } : {}),
        order: node.order, fields: node.fields, status: this.status(p, node),
        ...(node.assetId ? { assetId: node.assetId } : {}),
        ...(node.cover ? { cover: node.cover } : {}),
        ...(node.prompt ? { prompt: node.prompt } : {}),
        ...(showStats ? { stats: this.leafStats(p, node.id) } : {}),
      }
    })
    const chain = scope ? this.chain(p, scope.id) : []
    return {
      ok: true,
      value: {
        projects,
        activeProjectId: this.file.activeProjectId,
        project: {
          id: p.id, name: p.name, kind: p.kind, rootLabel: p.rootLabel,
          ...(p.dot ? { dot: p.dot } : {}), ...(p.tagline ? { tagline: p.tagline } : {}),
          ...(p.promptBase ? { promptBase: p.promptBase } : {}),
          levels: p.levels,
        },
        nodes,
        breadcrumb: [{ id: null, title: p.rootLabel }, ...chain.map((n) => ({ id: n.id, title: n.title }))],
        promptLayers: scope
          ? this.effectivePrompt(p, scope.id)
          : p.promptBase?.trim() ? [{ level: 'project', label: p.name, prompt: p.promptBase.trim() }] : [],
      },
    }
  }

  private effectivePrompt(p: Project, nodeId: string): { level: string; label: string; prompt: string }[] {
    const layers: { level: string; label: string; prompt: string }[] = []
    if (p.promptBase?.trim()) layers.push({ level: 'project', label: p.name, prompt: p.promptBase.trim() })
    for (const node of this.chain(p, nodeId)) {
      const prompt = node.prompt?.trim()
      if (!prompt) continue
      layers.push({ level: p.levels[node.level - 1]?.key ?? `l${node.level}`, label: node.title, prompt })
    }
    return layers
  }

  create(request: { name: string; kind?: string; id?: string }): unknown {
    const id = request.id ?? `proj-${Date.now().toString(36)}`
    const kind = request.kind ?? '短剧'
    const levels = kind === '产品套图' ? PROMO_LEVELS : kind === '短剧' ? DRAMA_LEVELS : [{ key: 'item', label: '条目', plural: '项', icon: 'image', container: false, fields: [{ key: 'note', label: '说明' }], cardFields: ['note'], detailFields: ['note'] }]
    this.file.projects.push({
      id, name: request.name, kind, levels, nodes: [],
      rootLabel: kind === '产品套图' ? '套图索引' : kind === '短剧' ? '全剧索引' : '索引',
    })
    this.file.activeProjectId = id
    this.emit()
    return { ok: true, value: { id, name: request.name, kind } }
  }

  activate(projectId: string): unknown {
    if (this.file.projects.some((p) => p.id === projectId)) this.file.activeProjectId = projectId
    this.emit()
    return { ok: true, value: undefined }
  }

  delete(projectId: string): unknown {
    this.file.projects = this.file.projects.filter((p) => p.id !== projectId)
    if (this.file.activeProjectId === projectId) this.file.activeProjectId = this.file.projects[0]?.id ?? null
    this.emit()
    return { ok: true, value: undefined }
  }

  update(projectId: string, patch: Record<string, unknown>): unknown {
    const p = this.file.projects.find((item) => item.id === projectId)
    if (p) Object.assign(p, patch)
    this.emit()
    return { ok: true, value: { id: projectId } }
  }

  addNode(projectId: string, node: Record<string, unknown>): unknown {
    const p = this.file.projects.find((item) => item.id === projectId)
    if (!p) return { ok: false, code: 'unknown', error: '项目不存在' }
    const parentId = (node.parentId as string | null) ?? null
    const parent = this.find(p, parentId)
    const level = parent ? parent.level + 1 : 1
    if (level > this.depth(p)) return { ok: false, code: 'unknown', error: '层级越界' }
    const siblings = this.children(p, parentId)
    p.nodes.push({
      id: (node.id as string) ?? `n-${Date.now().toString(36)}`,
      level, parentId, title: (node.title as string) ?? '新节点',
      order: (node.order as number) ?? (siblings.at(-1)?.order ?? 0) + 1,
      fields: (node.fields as Record<string, string>) ?? {},
      ...(node.prompt ? { prompt: node.prompt as string } : {}),
    })
    this.emit()
    return { ok: true, value: { nodes: p.nodes.length } }
  }

  patchNode(projectId: string, nodeId: string, patch: Record<string, unknown>): unknown {
    const p = this.file.projects.find((item) => item.id === projectId)
    const node = p ? this.find(p, nodeId) : undefined
    if (!p || !node) return { ok: false, code: 'unknown', error: '节点不存在' }
    Object.assign(node, patch)
    if (patch.fields) node.fields = { ...node.fields, ...(patch.fields as Record<string, string>) }
    this.emit()
    return { ok: true, value: undefined }
  }

  removeNode(projectId: string, nodeId: string): unknown {
    const p = this.file.projects.find((item) => item.id === projectId)
    if (!p) return { ok: false, code: 'unknown', error: '项目不存在' }
    const removed = new Set([nodeId])
    let changed = true
    while (changed) {
      changed = false
      for (const n of p.nodes) {
        if (n.parentId && removed.has(n.parentId) && !removed.has(n.id)) {
          removed.add(n.id)
          changed = true
        }
      }
    }
    p.nodes = p.nodes.filter((n) => !removed.has(n.id))
    this.emit()
    return { ok: true, value: { removedIds: [...removed] } }
  }

  reorder(projectId: string, parentId: string | null, orderedIds: string[]): unknown {
    const p = this.file.projects.find((item) => item.id === projectId)
    if (p) {
      const rank = new Map(orderedIds.map((id, i) => [id, i + 1]))
      p.nodes = p.nodes.map((n) => (n.parentId === parentId && rank.has(n.id) ? { ...n, order: rank.get(n.id)! } : n))
    }
    this.emit()
    return { ok: true, value: undefined }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** 浏览器下最小可用的 workspace 快照（让 App 过 WorkspaceGate） */

/** 演示素材（覆盖 类型/状态/标签/素材库 四类属性，用于验证画布分类筛选） */
function demoCanvasSnapshot(): unknown {
  const mk = (
    id: string,
    x: number,
    y: number,
    data: Record<string, unknown>
  ): Record<string, unknown> => ({
    id,
    type: 'asset',
    x,
    y,
    width: 260,
    height: 250,
    zIndex: 1,
    data,
  })
  return {
    version: 3,
    savedAt: new Date().toISOString(),
    meta: { activeSessionId: null, sessions: [] },
    nodes: [
      mk('n1', 80, 80, {
        name: '对峙-首帧-16x9.png',
        kind: 'image',
        storage: 'workspace',
        path: 'assets/images/对峙-首帧-16x9.png',
        libraryId: 'lib-images',
        tags: ['主视觉', '已定稿'],
        mime: 'image/png',
        bytes: 1153000,
        meta: './demo/drama-01.jpg',
      }),
      mk('n2', 380, 80, {
        name: '对峙-高位-16x9.png',
        kind: 'image',
        storage: 'workspace',
        path: 'assets/images/对峙-高位-16x9.png',
        libraryId: 'lib-images',
        tags: ['主视觉'],
        mime: 'image/png',
        bytes: 1048000,
        meta: './demo/drama-02.jpg',
      }),
      mk('n3', 680, 80, {
        name: '双兽对峙-01.mp4',
        kind: 'video',
        storage: 'workspace',
        path: 'assets/video/双兽对峙-01.mp4',
        libraryId: 'lib-video',
        tags: ['成片'],
        mime: 'video/mp4',
        bytes: 4613000,
        meta: './demo/drama-03.jpg',
      }),
      mk('n4', 80, 380, {
        name: 'tiger-cub-poster-猫版.png',
        kind: 'image',
        storage: 'workspace',
        path: 'assets/images/tiger-cub-poster-猫版.png',
        libraryId: 'lib-images',
        tags: ['海报'],
        mime: 'image/png',
        bytes: 1022000,
        meta: './demo/still-01.jpg',
      }),
      // 无产物（待生成）：状态筛选用
      mk('n5', 380, 380, {
        name: '待生成 · 第 3 场分镜',
        kind: 'image',
        libraryId: 'lib-images',
        tags: ['待办'],
      }),
    ],
  }
}

/** workspace:state 的真实形状是 { workspace, recents }（不是 ChatResult 包装） */
const webWorkspaceState = {
  workspace: { path: '/web-preview/brand-campaign', name: 'brand-campaign' },
  recents: [{ path: '/web-preview/brand-campaign', name: 'brand-campaign' }],
}

/**
 * 安装浏览器版 window.huabu。
 * 只在没有预注入（非 Electron）时生效；Electron 内 preload 已注入，跳过。
 */
export function installWebHarness(): void {
  const global = window as unknown as { huabu?: Record<string, unknown> }
  if (global.huabu) return

  // 浏览器环境标记（不含 Electron 窗口 chrome）：标题栏据此隐藏窗口控制按钮，
  // 无论连真后端还是跑 demo 都一样——最小化/关闭在浏览器里没有意义。
  ;(globalThis as unknown as { __HUABU_BROWSER__?: boolean }).__HUABU_BROWSER__ = true

  // 优先：真后端桥（main 以 HUABU_WEB_BRIDGE=1 / --headless 启动时，URL 带 ?bridge=&token=）
  // 此时 window.huabu 与 Electron preload 同形状，业务代码零改动，操作的是真实数据。
  const bridgeConfig = resolveBridgeConfig()
  if (bridgeConfig) {
    global.huabu = createWebBridgeApi(bridgeConfig) as unknown as Record<string, unknown>
    console.info(
      `[web-bridge] 已连接真后端 http://127.0.0.1:${bridgeConfig.port}（对话/模型/素材库均为真实数据）`
    )
    return
  }

  console.info('[web-harness] 未检测到 ?bridge= 参数：使用内置 demo 数据（仅画布样式可看）')
  // 只有 demo 模式才是「预览」：真后端模式下设置面板等应当正常工作
  ;(globalThis as unknown as { __HUABU_WEB_PREVIEW__?: boolean }).__HUABU_WEB_PREVIEW__ = true

  const project = new WebProjectHarness()

  /**
   * 未实现方法的安全默认。**必须返回 Promise**——渲染端几乎全部走 .then/await。
   * 订阅类（onXxx）同步返回取消函数；其余异步返回空成功值。
   */
  const safeDefault = (path: string) => (): unknown => {
    const method = path.split('.').pop() ?? ''
    if (/^on[A-Z]/.test(method)) return () => undefined
    return Promise.resolve(
      /^(state|list|status|jobs|providers|skills|adapterKinds)/i.test(method)
        ? { ok: true, value: [], recents: [], cancelled: true }
        : { ok: true, value: undefined }
    )
  }

  /** project 域的真实实现（其余域走 Proxy 默认） */
  const projectApi = {
    snapshot: async (request?: unknown) => project.snapshot((request ?? {}) as { scopeId?: string | null }),
    create: async (request: unknown) => project.create(request as { name: string; kind?: string; id?: string }),
    activate: async (projectId: string) => project.activate(projectId),
    delete: async (projectId: string) => project.delete(projectId),
    update: async (projectId: string, patch: Record<string, unknown>) => project.update(projectId, patch),
    addNode: async (projectId: string, node: Record<string, unknown>) => project.addNode(projectId, node),
    patchNode: async (projectId: string, nodeId: string, patch: Record<string, unknown>) =>
      project.patchNode(projectId, nodeId, patch),
    removeNode: async (projectId: string, nodeId: string) => project.removeNode(projectId, nodeId),
    reorder: async (projectId: string, parentId: string | null, orderedIds: string[]) =>
      project.reorder(projectId, parentId, orderedIds),
    onChanged: (listener: () => void) => project.onChanged(listener),
  }

  /** workspace 特例：state 要返回可用工作区，否则停在 WorkspaceGate */
  const workspaceApi = {
    state: async () => webWorkspaceState,
    files: async () => ({ ok: true, value: [] }),
    saveCanvas: async () => ({ ok: true, value: undefined }),
    loadCanvas: async () => ({ ok: true, value: demoCanvasSnapshot() }),
    reveal: async () => undefined,
    setDefaultModel: async () => ({ ok: true, value: undefined }),
    deleteWorkspaces: async () => ({ ok: true, value: undefined }),
  }

  /** 其余域：按真实返回形状给空值（否则页面各 store 读 .libraries/.providers 会崩） */
  const assetApi = {
    libraries: async () => ({
      ok: true,
      value: {
        libraries: [
          { id: 'lib-images', name: '图片素材', relPath: 'assets/images' },
          { id: 'lib-video', name: '视频素材', relPath: 'assets/video' },
        ],
        inboxDir: 'assets/inbox',
      },
    }),
    list: async () => ({ ok: true, value: { entries: [] } }),
    tags: async () => ({ ok: true, value: { tags: {} } }),
    import: async () => ({ ok: true, value: { imported: [], skipped: [] } }),
    'import-canvas': async () => ({ ok: true, value: { imported: [], skipped: [] } }),
    'import-temp': async () => ({ ok: true, value: { imported: [], skipped: [] } }),
    transfer: async () => ({ ok: true, value: undefined }),
    rename: async () => ({ ok: true, value: undefined }),
    remove: async () => ({ ok: true, value: undefined }),
    onChanged: () => () => undefined,
  }

  const settingsApi = {
    modelsList: async () => ({ ok: true, value: { models: [], configuredProviders: [] } }),
    chatProviders: async () => ({ ok: true, value: { providers: [], credentialsHint: '' } }),
    mediaStatus: async () => ({
      ok: true,
      value: {
        accessMode: 'full' as const,
        config: { providers: {}, defaultModels: {}, accessMode: 'full' },
        confirmVideo: false,
      },
    }),
    skillsList: async () => ({ ok: true, value: { skills: [] } }),
  }

  const mediaApi = {
    providers: async () => ({ ok: true, value: [] }),
    adapterKinds: async () => ({ ok: true, value: [] }),
    jobs: async () => ({ ok: true, value: [] }),
    
    pathForFile: async () => null,
    onJobEvent: () => () => undefined,
    onConfirmRequest: () => () => undefined,
    onConfirmResolved: () => () => undefined,
    generate: async () => ({ ok: false, code: 'unknown', error: 'Web 预览不生成媒体' }),
  }

  const chatApi = {
    runtime: async () => ({
      ok: true,
      value: { ready: false, error: 'Web 预览不连 Agent', models: [], configuredProviders: [] },
    }),
    history: async () => ({ ok: true, value: { nodeId: '', sessionFile: '', messages: [] } }),
    contextUsage: async () => ({ ok: true, value: { tokens: null, contextWindow: null, percent: null } }),
    dispose: async () => ({ ok: true, value: undefined }),
    onEvent: () => () => undefined,
    create: async () => ({ ok: false, code: 'host_not_ready', error: 'Web 预览不连 Agent' }),
    prompt: async () => ({ ok: false, code: 'host_not_ready', error: 'Web 预览不连 Agent' }),
    steer: async () => ({ ok: false, code: 'host_not_ready', error: 'Web 预览不连 Agent' }),
    abort: async () => ({ ok: true, value: undefined }),
    compact: async () => ({ ok: false, code: 'unknown', error: 'Web 预览不压缩' }),
    fork: async () => ({ ok: false, code: 'unknown', error: 'Web 预览不 fork' }),
  }

  const domainOverrides: Record<string, Record<string, unknown>> = {
    project: projectApi as unknown as Record<string, unknown>,
    workspace: workspaceApi as unknown as Record<string, unknown>,
    asset: assetApi as unknown as Record<string, unknown>,
    settings: settingsApi as unknown as Record<string, unknown>,
    media: mediaApi as unknown as Record<string, unknown>,
    chat: chatApi as unknown as Record<string, unknown>,
  }

  /** 一层域级 Proxy：已知方法取 override，未知方法走 safeDefault */
  const domainProxy = (domain: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'then') return undefined
          const override = domainOverrides[domain]?.[prop]
          if (typeof override === 'function') return override
          return safeDefault(`huabu.${domain}.${prop}`)
        },
        has: () => true,
      }
    )

  const huabuProxy = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'then') return undefined
        if (prop === 'ping') return async () => 'pong'
        if (prop === 'version') return async () => ({ electron: 'web', node: 'web', chrome: navigator.userAgent, app: 'web-preview' })
        if (prop === 'onEvent') return () => () => undefined
        return domainProxy(prop)
      },
      has: () => true,
    }
  )

  // 素材路径 → demo 图片（浏览器无 huabu-media:// 协议）
  ;(globalThis as unknown as { __HUABU_DEMO_SRC__?: Record<string, string> }).__HUABU_DEMO_SRC__ = {
    'assets/images/对峙-首帧-16x9.png': './demo/drama-01.jpg',
    'assets/images/对峙-高位-16x9.png': './demo/drama-02.jpg',
    'assets/video/双兽对峙-01.mp4': './demo/drama-03.jpg',
    'assets/images/tiger-cub-poster-猫版.png': './demo/still-01.jpg',
  }
  global.huabu = huabuProxy as Record<string, unknown>
  console.info('[web-harness] 浏览器预览模式：project 域走内存 demo 数据，其余能力受限')
}

// 副作用导入即安装（main.tsx 把它放在 App 之前，保证 store 求值前 window.huabu 已就位）
installWebHarness()
