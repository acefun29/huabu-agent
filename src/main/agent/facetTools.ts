import { relative, resolve, sep } from 'path'
import { Type } from 'typebox'
import { loadFacetsIndex, setFileFacetsBulk } from '../assets/facetsIndex'
import {
  BUILTIN_FACET_SCHEMAS,
  coerceFacet,
  facetMatchesPrefix,
  findFacetSchema,
  normalizeFacetKey
} from '../../shared/facets'
import type { ToolDefinitionLike } from './mediaTools'

/**
 * 分级工具（`list_facets` / `set_facets`）—— Agent 读写素材的「位置坐标」。
 *
 * 背景：短剧/漫画/套图生产里，一张图属于「第3集 / 第2场 / 第12镜」。这种归属
 * **不是标签**（标签是扁平交叉检索），也**不是目录**（素材库保持平铺）。
 * 它是文件级元数据，真相在 `.huabu/facets.json`，画布卡片读同一份。
 *
 * 为什么给 Agent 这两个工具：
 * - 用户说「把这几张镜图归档到第2集第1场」时，Agent 应能直接落库，
 *   而不是让用户逐张点开卡片手填；
 * - Agent 自己生成一批分镜时，能顺手打好位置，用户打开画布就知道每张属于哪。
 *
 * 设计约束（与项目其它工具一致）：
 * - 层级名（集/场/镜 vs 话/页/格）由工作区 schema 决定，**工具不假设业务层级**；
 *   写之前先用 list_facets 拿到 schema 与现有值，避免自造层名。
 * - 不可修复的错误（未打开工作区）返回指引文本而不是抛错——抛错会打断整轮。
 * - 越界路径逐条跳过、不整单失败（批量场景里一条坏路径不该废掉整批）。
 */

export interface FacetToolDeps {
  /** 当前工作区根目录（无工作区时工具返回指引文本） */
  currentDir: () => string | null
  /** 当前工作区 schema id（null = 内置默认） */
  schemaId: () => string | null
  /**
   * 写入后通知渲染端刷新（生产传 broadcastAssetChanged）。
   * 注入而非直接 import：让工具本身不依赖 Electron，可在纯 node 环境测试。
   */
  notifyChanged: () => void
}

/** 单条批量上限：与 asset:set-facets 的 IPC 上限保持一致 */
const MAX_ENTRIES = 200

export function assembleFacetTools(deps: FacetToolDeps): ToolDefinitionLike[] {
  const workspaceRoot = (): string | null => deps.currentDir()

  const currentSchema = () => {
    const id = deps.schemaId()
    return findFacetSchema(BUILTIN_FACET_SCHEMAS, id) ?? findFacetSchema(BUILTIN_FACET_SCHEMAS, null)!
  }

  const listFacets: ToolDefinitionLike = {
    name: 'list_facets',
    label: '查看素材分级',
    description:
      '查看当前工作区的素材分级（"这个文件在项目的哪个位置"：第几集/第几场/第几镜，层级名由工作区 schema 决定）。' +
      '返回：可用的层级 schema（每层的名称与写法提示）、每个已分级文件的位置、未分级文件数。' +
      '给素材打位置之前**先调用本工具**，用返回的层名与现有取值保持一致（不要自造层名或写法），再调用 set_facets。' +
      '可选 prefix 参数用于只看某个位置下有哪些文件（如 ["第02集"]）。',
    parameters: Type.Object({
      prefix: Type.Optional(
        Type.Array(Type.String(), {
          description:
            '只列出该位置下的文件，从最粗层开始（如 ["第02集","第1场"]）。省略 = 列出全部。'
        })
      )
    }),
    execute: async (_toolCallId, params) => {
      const root = workspaceRoot()
      if (!root) {
        return {
          content: [{ type: 'text' as const, text: '尚未打开工作区：分级信息存在工作区的 .huabu/facets.json 里，请先让用户打开工作区。' }],
          details: { ok: false }
        }
      }
      const schema = currentSchema()
      const index = loadFacetsIndex(root)
      const prefixRaw = (params as { prefix?: unknown })?.prefix
      const prefix = Array.isArray(prefixRaw)
        ? prefixRaw.map((v) => String(v ?? '').trim()).filter(Boolean)
        : []

      const matched = Object.entries(index)
        .map(([relPath, facet]) => ({ relPath, facet }))
        .filter((entry) => facetMatchesPrefix(entry.facet, prefix))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))

      const schemaLine = `层级 schema：${schema.label} — ${schema.levels
        .map((level, i) => `${i + 1}.${level.title ?? level.label}${level.hint ? `（写法如「${level.hint}」）` : ''}`)
        .join('，')}`

      const rows = matched.slice(0, 120).map((entry) => `- ${entry.relPath} → ${entry.facet.chain.join(' / ')}`)
      const rest = matched.length - rows.length
      const scope = prefix.length > 0 ? `位置「${prefix.join(' / ')}」下` : '工作区里'
      const lines = [
        schemaLine,
        `${scope}已分级 ${matched.length} 个文件${rows.length > 0 ? '：' : '。'}`,
        ...rows,
        ...(rest > 0 ? [`-（另有 ${rest} 个未列出，可用更具体的 prefix 缩小范围）`] : []),
        matched.length === 0
          ? '当前还没有文件分级。需要时用 set_facets 写入（chain 从最粗层开始，可只填到某一层）。'
          : '需要给文件设置/调整位置时调用 set_facets。'
      ]
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: {
          ok: true,
          schemaId: schema.id,
          levels: schema.levels.map((l) => ({ key: l.key, label: l.label, title: l.title, hint: l.hint })),
          graded: matched.length,
          entries: matched.slice(0, 120)
        }
      }
    }
  }

  const setFacets: ToolDefinitionLike = {
    name: 'set_facets',
    label: '设置素材分级',
    description:
      '给工作区里的素材文件设置"位置"（第几集/第几场/第几镜 等，层级名由工作区 schema 决定），也可以一次给多个文件设置同一个位置。' +
      'chain 是从最粗层到最细层的值数组，可以只填到某一层（如只到「场」）；传 null 或空数组 = 清除该文件的分级。' +
      '路径用工作区相对路径（如 assets/images/xxx.png，与 list_facets 返回的形态一致），不要传绝对路径。' +
      '写之前先调用 list_facets 确认层名与现有写法，保持「第02集 / 第2场」这类取值的一致性。' +
      '越界或不存在的路径会被跳过并在结果里报告，不影响其余条目。',
    parameters: Type.Object({
      entries: Type.Array(
        Type.Object({
          relPath: Type.String({ description: '工作区相对路径（如 assets/images/shot-01.png）' }),
          chain: Type.Union([
            Type.Array(Type.String(), { description: '从最粗层到最细层的值（如 ["第02集","第1场"]）' }),
            Type.Null({ description: 'null = 清除该文件的分级' })
          ])
        }),
        { description: `要设置的文件与位置，一次最多 ${MAX_ENTRIES} 条` }
      )
    }),
    execute: async (_toolCallId, params) => {
      const root = workspaceRoot()
      if (!root) {
        return {
          content: [{ type: 'text' as const, text: '尚未打开工作区：分级信息存在工作区的 .huabu/facets.json 里，请先让用户打开工作区。' }],
          details: { ok: false }
        }
      }
      const raw = (params as { entries?: unknown })?.entries
      if (!Array.isArray(raw) || raw.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'entries 不能为空：请给出要设置的文件与位置（relPath + chain）。' }],
          details: { ok: false }
        }
      }
      const schema = currentSchema()
      const rootAbs = resolve(root)
      const accepted: Array<{ relPath: string; facet: ReturnType<typeof coerceFacet> }> = []
      const rejected: string[] = []

      for (const item of raw.slice(0, MAX_ENTRIES)) {
        const relPathRaw = (item as { relPath?: unknown })?.relPath
        if (typeof relPathRaw !== 'string' || !relPathRaw.trim()) {
          rejected.push('（缺少 relPath）')
          continue
        }
        // 路径守卫：与 asset IPC 同一口径——解析后必须仍在工作区内，且不接受绝对路径
        const abs = resolve(rootAbs, relPathRaw)
        if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
          rejected.push(`${relPathRaw}（路径越出工作区）`)
          continue
        }
        const chain = (item as { chain?: unknown })?.chain
        const facet = chain === null ? null : coerceFacet({ chain }, schema)
        accepted.push({
          relPath: normalizeFacetKey(relative(rootAbs, abs)),
          facet
        })
      }

      if (accepted.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `没有可写入的条目：${rejected.join('；') || '全部条目的 relPath 都不合法'}。请用工作区相对路径重试。`
            }
          ],
          details: { ok: false, rejected }
        }
      }

      const result = setFileFacetsBulk(rootAbs, accepted, schema)
      if (result.updated > 0 || result.removed > 0) deps.notifyChanged()

      const summary = [
        `已更新 ${result.updated} 个文件的分级${result.removed > 0 ? `，清除 ${result.removed} 个` : ''}。`,
        ...(rejected.length > 0 ? [`跳过 ${rejected.length} 条：${rejected.slice(0, 10).join('；')}`] : []),
        '画布卡片与筛选条已同步刷新，请基于真实写入结果回复用户。'
      ]
      return {
        content: [{ type: 'text' as const, text: summary.join('\n') }],
        details: {
          ok: true,
          schemaId: schema.id,
          updated: result.updated,
          removed: result.removed,
          rejected
        }
      }
    }
  }

  return [listFacets, setFacets]
}
