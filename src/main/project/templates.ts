/**
 * 项目模板（原型 DRAMA_LEVELS / PROMO_LEVELS）。
 *
 * 层级定义是**数据**，不是代码分支：短剧 3 层与套图 2 层走同一套渲染与状态逻辑。
 * 新建项目时从这里取一份 levels；之后用户/Agent 可自由改（存在 project.json 里）。
 */

import type { Project, ProjectLevel } from './model'

/** 短剧：剧集 → 场景 → 镜头（原型 DRAMA_LEVELS 原样） */
export const DRAMA_LEVELS: ProjectLevel[] = [
  {
    key: 'episode',
    label: '剧集',
    plural: '集',
    icon: 'layers',
    container: true,
    fields: [
      { key: 'num', label: '集数' },
      { key: 'duration', label: '时长' },
      { key: 'logline', label: '一句话' },
    ],
    cardFields: ['duration'],
    detailFields: ['num', 'duration', 'logline'],
  },
  {
    key: 'scene',
    label: '场景',
    plural: '场',
    icon: 'file-text',
    container: true,
    fields: [
      { key: 'location', label: '地点' },
      { key: 'time', label: '时间' },
      { key: 'mood', label: '氛围' },
    ],
    cardFields: ['location', 'time'],
    detailFields: ['location', 'time', 'mood'],
  },
  {
    key: 'shot',
    label: '镜头',
    plural: '镜',
    icon: 'image',
    container: false,
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

/** 产品套图：套图组 → 单图（原型 PROMO_LEVELS 原样） */
export const PROMO_LEVELS: ProjectLevel[] = [
  {
    key: 'set',
    label: '套图组',
    plural: '组',
    icon: 'layers',
    container: true,
    fields: [
      { key: 'ratio', label: '比例' },
      { key: 'scene', label: '场景' },
    ],
    cardFields: ['ratio', 'scene'],
    detailFields: ['ratio', 'scene'],
  },
  {
    key: 'image',
    label: '单图',
    plural: '图',
    icon: 'image',
    container: false,
    fields: [
      { key: 'angle', label: '角度' },
      { key: 'note', label: '说明' },
    ],
    cardFields: ['angle'],
    detailFields: ['angle', 'note'],
  },
]

/** 空项目骨架 */
export function emptyProject(params: {
  id: string
  name: string
  kind: string
  levels: ProjectLevel[]
  rootLabel: string
  dot?: string
  tagline?: string
  promptBase?: string
}): Project {
  return {
    id: params.id,
    name: params.name,
    kind: params.kind,
    levels: params.levels,
    rootLabel: params.rootLabel,
    nodes: [],
    ...(params.dot ? { dot: params.dot } : {}),
    ...(params.tagline ? { tagline: params.tagline } : {}),
    ...(params.promptBase ? { promptBase: params.promptBase } : {}),
  }
}

/**
 * 新建项目的默认骨架：只建层级定义，不预置任何节点（画布保持空）。
 * kind 决定用哪套层级；其它值给一份单层「条目」兜底（数据驱动，无需改代码）。
 */
export function createStarterProject(params: { id: string; name: string; kind?: string }): Project {
  const kind = params.kind ?? '短剧'
  if (kind === '产品套图') {
    return emptyProject({
      id: params.id,
      name: params.name,
      kind,
      levels: PROMO_LEVELS,
      rootLabel: '套图索引',
      dot: '#8a7255',
    })
  }
  if (kind === '短剧') {
    return emptyProject({
      id: params.id,
      name: params.name,
      kind,
      levels: DRAMA_LEVELS,
      rootLabel: '全剧索引',
      dot: '#547a72',
    })
  }
  return emptyProject({
    id: params.id,
    name: params.name,
    kind,
    levels: [
      {
        key: 'item',
        label: '条目',
        plural: '项',
        icon: 'image',
        container: false,
        fields: [{ key: 'note', label: '说明' }],
        cardFields: ['note'],
        detailFields: ['note'],
      },
    ],
    rootLabel: '索引',
  })
}
