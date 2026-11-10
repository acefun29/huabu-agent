import { relative, resolve, sep } from 'path'
import { Type } from 'typebox'
import { loadFacetsIndex, setFileFacetsBulk } from '../assets/facetsIndex'
import {
  activeFacetSchema,
  coerceFacet,
  facetMatchesPrefix,
  MAX_FACET_SCHEMAS,
  newFacetSchemaId,
  normalizeFacetKey,
  sanitizeFacetSchema,
  type FacetSchema
} from '../../shared/facets'
import type { ToolDefinitionLike } from './mediaTools'

/**
 * 分级工具（`list_facets` / `define_facet_schema` / `delete_facet_schema` / `set_facets`）
 * —— Agent 读写素材的「位置坐标」。
 *
 * 背景：生产流程里一张图属于「第3集 / 第2场 / 第12镜」，漫画里一格属于「第5话 /
 * 第3页 / 第2格」。这种归属**不是标签**（标签是扁平交叉检索），也**不是目录**
 * （素材库保持平铺）。它是文件级元数据，真相在 `.huabu/facets.json`，画布卡片读同一份。
 *
 * 关键设计：**产品不内置任何层级方案**。层级定义（schema）本身是工作区数据，
 * 由使用者或 Agent 按项目需要创建。所以 Agent 拿到的不是「照着 集/场/镜 填」，
 * 而是「先看看这个项目有没有定义结构，没有就按用户说的层级定义一套」。
 *
 * 设计约束（与项目其它工具一致）：
 * - 不可修复的错误（未打开工作区 / 还没结构）返回指引文本而不是抛错——抛错会打断整轮；
 * - 越界路径逐条跳过、不整单失败（批量场景里一条坏路径不该废掉整批）；
 * - 写入前用 list_facets 确认层名与现有取值，避免自造写法。
 */

export interface FacetToolDeps {
  /** 当前工作区根目录（无工作区时工具返回指引文本） */
  currentDir: () => string | null
  /** 工作区定义的全部分级结构（空数组 = 还没定义过） */
  schemas: () => FacetSchema[]
  /** 当前生效结构 id（null = 回落第一套） */
  activeSchemaId: () => string | null
  /** 新建/更新一套结构（按 id upsert；activate = 同时设为生效） */
  saveSchema: (schema: FacetSchema, activate: boolean) => void
  /** 删除一套结构；返回是否真的删掉了 */
  deleteSchema: (id: string) => boolean
  /**
   * 写入后通知渲染端刷新（生产传 broadcastAssetChanged）。
   * 注入而非直接 import：让工具本身不依赖 Electron，可在纯 node 环境测试。
   */
  notifyChanged: () => void
}

/** 单条批量上限：与 asset:set-facets 的 IPC 上限保持一致 */
const MAX_ENTRIES = 200

const NO_WORKSPACE_TEXT =
  '尚未打开工作区：分级信息存在工作区的 .huabu/facets.json 里，请先让用户打开工作区。'

const NO_SCHEMA_TEXT =
  '这个工作区还没有定义分级结构（层级名与深度）。请先按用户说的层级调用 define_facet_schema 定义一套' +
  '（例如「集 / 场 / 镜」），再用 set_facets 写位置；不要假设任何固定层名。'

/** 层定义的紧凑文本：`1.集（写法如「第01集」）` */
function describeLevels(schema: FacetSchema): string {
  return schema.levels
    .map((level, i) => `${i + 1}.${level.title ?? level.label}${level.hint ? `（写法如「${level.hint}」）` : ''}`)
    .join('，')
}

export function assembleFacetTools(deps: FacetToolDeps): ToolDefinitionLike[] {
  const workspaceRoot = (): string | null => deps.currentDir()

  /** 已写入的分级里指向某套结构的文件数（删除结构前告知影响面） */
  const countGradedUnder = (root: string, schemaId: string): number =>
    Object.values(loadFacetsIndex(root)).filter((facet) => facet.schemaId === schemaId).length

  const listFacets: ToolDefinitionLike = {
    name: 'list_facets',
    label: '查看素材分级',
    description:
      '查看当前工作区的分级结构与已分级素材（"这个文件在项目的哪个位置"）。' +
      '返回：工作区定义的全部层级结构（每套的 id、名称、每层层名与写法提示、哪套在生效）、每个已分级文件的位置。' +
      '写位置之前**先调用本工具**：用返回的层名与现有取值保持一致（不要自造层名或写法）。' +
      '若工作区还没有任何结构，返回值会明确说明——此时先用 define_facet_schema 按项目需要定义一套，' +
      '不要假设「集/场/镜」这类固定层名。可选 prefix 参数用于只看某个位置下有哪些文件。',
    parameters: Type.Object({
      prefix: Type.Optional(
        Type.Array(Type.String(), {
          description: '只列出该位置下的文件，从最粗层开始（如 ["第02集","第1场"]）。省略 = 列出全部。'
        })
      )
    }),
    execute: async (_toolCallId, params) => {
      const root = workspaceRoot()
      if (!root) {
        return {
          content: [{ type: 'text' as const, text: NO_WORKSPACE_TEXT }],
          details: { ok: false }
        }
      }
      const schemas = deps.schemas()
      const active = activeFacetSchema(schemas, deps.activeSchemaId())
      const prefixRaw = (params as { prefix?: unknown })?.prefix
      const prefix = Array.isArray(prefixRaw)
        ? prefixRaw.map((v) => String(v ?? '').trim()).filter(Boolean)
        : []

      const index = loadFacetsIndex(root)
      const matched = Object.entries(index)
        .map(([relPath, facet]) => ({ relPath, facet }))
        .filter((entry) => facetMatchesPrefix(entry.facet, prefix))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))

      const rows = matched
        .slice(0, 120)
        .map((entry) => `- ${entry.relPath} → ${entry.facet.chain.join(' / ')}${entry.facet.schemaId ? `（结构 ${entry.facet.schemaId}）` : ''}`)
      const rest = matched.length - rows.length
      const scope = prefix.length > 0 ? `位置「${prefix.join(' / ')}」下` : '工作区里'

      if (schemas.length === 0) {
        const text = [
          '这个工作区还没有任何分级结构（层级名与深度）。',
          matched.length > 0
            ? `（另有 ${matched.length} 个历史分级找不到对应结构，层名不可解析，值仍保留。）`
            : '',
          NO_SCHEMA_TEXT
        ]
          .filter(Boolean)
          .join('\n')
        return {
          content: [{ type: 'text' as const, text }],
          details: { ok: true, schemaId: null, schemas: [], graded: matched.length, entries: matched.slice(0, 120) }
        }
      }

      const schemaLines = schemas.map(
        (s) => `- ${s.id}${s.id === active?.id ? '（当前生效）' : ''} · ${s.label}：${describeLevels(s)}${
          s.description ? ` — ${s.description}` : ''
        }`
      )
      const lines = [
        `分级结构（工作区自定义，共 ${schemas.length} 套）：`,
        ...schemaLines,
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
          schemaId: active?.id ?? null,
          schemas: schemas.map((s) => ({
            id: s.id,
            label: s.label,
            active: s.id === active?.id,
            levels: s.levels.map((l) => ({ key: l.key, label: l.label, title: l.title, hint: l.hint }))
          })),
          graded: matched.length,
          entries: matched.slice(0, 120)
        }
      }
    }
  }

  const defineSchema: ToolDefinitionLike = {
    name: 'define_facet_schema',
    label: '定义分级结构',
    description:
      '为当前工作区**定义一套分级结构**（层级名与深度）。一份结构 = 从粗到细的层级列表，' +
      '比如「集 / 场 / 镜」三层，或「话 / 页 / 格」，或只有一层「批次」。' +
      '产品的分级能力不带任何预置方案——用户说要按什么维度归档，就按他说的层名定义，不要照搬别的项目的层级。' +
      '传 id 表示更新已有结构（改层名/加层），不传则新建（返回新 id）。' +
      'activate 默认 true：保存后立即作为当前生效结构，之后 set_facets 写的值就按这套层名记。' +
      '定义后建议再调 list_facets 确认，然后才写位置。',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '要更新的结构 id；省略 = 新建一套' })),
      label: Type.String({ description: '结构名（给人看的，如「短剧」「分镜表」「章节」）' }),
      description: Type.Optional(Type.String({ description: '一句话说明这套结构怎么用（可省略）' })),
      levels: Type.Array(
        Type.Object({
          key: Type.Optional(
            Type.String({ description: '层的稳定键名（可省略，由名称派生；用于内部引用）' })
          ),
          label: Type.String({ description: '层名，紧凑展示用（如「集」「场」「镜」）' }),
          title: Type.Optional(Type.String({ description: '层全名（如「剧集」「场景」「镜头」）' })),
          hint: Type.Optional(
            Type.String({ description: '写法提示（如「第01集」），帮后续写入保持格式一致' })
          )
        }),
        { description: '从最粗到最细的层级，1–6 层' }
      ),
      activate: Type.Optional(
        Type.Boolean({ description: '保存后是否设为当前生效结构，默认 true' })
      )
    }),
    execute: async (_toolCallId, params) => {
      const root = workspaceRoot()
      if (!root) {
        return { content: [{ type: 'text' as const, text: NO_WORKSPACE_TEXT }], details: { ok: false } }
      }
      const raw = (params ?? {}) as {
        id?: unknown
        label?: unknown
        description?: unknown
        levels?: unknown
        activate?: unknown
      }
      const existing = deps.schemas()
      const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : newFacetSchemaId(existing.map((s) => s.id))
      const schema = sanitizeFacetSchema({
        id,
        label: raw.label,
        description: raw.description,
        levels: raw.levels
      })
      if (!schema) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '结构定义不合法：需要 label 与至少一层有名字的 levels（每层至少给 label）。请补全后重试。'
            }
          ],
          details: { ok: false }
        }
      }
      const isUpdate = existing.some((s) => s.id === schema.id)
      if (!isUpdate && existing.length >= MAX_FACET_SCHEMAS) {
        return {
          content: [{ type: 'text' as const, text: `一个工作区最多 ${MAX_FACET_SCHEMAS} 套分级结构，请先删除不用的。` }],
          details: { ok: false }
        }
      }
      const activate = raw.activate !== false
      deps.saveSchema(schema, activate)
      deps.notifyChanged()

      const after = activeFacetSchema(deps.schemas(), deps.activeSchemaId())
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `${isUpdate ? '已更新' : '已创建'}分级结构「${schema.label}」（id ${schema.id}）：${describeLevels(schema)}。`,
              after?.id === schema.id
                ? '已设为当前生效结构，之后 set_facets 写的位置就按这套层名记录。'
                : `当前生效的是「${after?.label ?? '（无）'}」；需要切换请告知用户或再调用本工具时带 activate。`,
              '建议下一步调用 list_facets 确认，再写位置。'
            ].join('\n')
          }
        ],
        details: {
          ok: true,
          schemaId: schema.id,
          created: !isUpdate,
          active: after?.id === schema.id,
          levels: schema.levels
        }
      }
    }
  }

  const deleteSchema: ToolDefinitionLike = {
    name: 'delete_facet_schema',
    label: '删除分级结构',
    description:
      '删除当前工作区的一套分级结构（层级定义）。**已写入的分级数据不会删**：值仍保留在 facets.json，' +
      '只是失去层名解释（界面上显示为「第N层」）。返回受影响文件数，便于如实告知用户。' +
      '删除不可撤销；如果只是想换层名，优先用 define_facet_schema 改这套结构。',
    parameters: Type.Object({
      id: Type.String({ description: '要删除的结构 id（可从 list_facets 获取）' })
    }),
    execute: async (_toolCallId, params) => {
      const root = workspaceRoot()
      if (!root) {
        return { content: [{ type: 'text' as const, text: NO_WORKSPACE_TEXT }], details: { ok: false } }
      }
      const id = String((params as { id?: unknown })?.id ?? '').trim()
      if (!id) {
        return {
          content: [{ type: 'text' as const, text: '需要 id：请传要删除的结构 id（可从 list_facets 获取）。' }],
          details: { ok: false }
        }
      }
      const target = deps.schemas().find((s) => s.id === id)
      if (!target) {
        return {
          content: [{ type: 'text' as const, text: `没有这个分级结构：${id}。请先调用 list_facets 确认 id。` }],
          details: { ok: false }
        }
      }
      // 先数再删：删完就查不到这条结构的归属了
      const affected = countGradedUnder(root, id)
      deps.deleteSchema(id)
      deps.notifyChanged()
      const after = activeFacetSchema(deps.schemas(), deps.activeSchemaId())
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `已删除分级结构「${target.label}」（${id}）。`,
              affected > 0
                ? `${affected} 个文件的分级仍保留（值不变，层名不再可解析，界面显示为「第N层」）。`
                : '没有文件指向这套结构。',
              after ? `当前生效结构：「${after.label}」。` : '这个工作区现在没有任何分级结构。'
            ].join('\n')
          }
        ],
        details: { ok: true, schemaId: id, affected, schemaIdAfter: after?.id ?? null }
      }
    }
  }

  const setFacets: ToolDefinitionLike = {
    name: 'set_facets',
    label: '设置素材分级',
    description:
      '给工作区里的素材文件设置"位置"（如「第03集 / 第2场 / 第12镜」，层名由工作区分级结构决定），' +
      '也可以一次给多个文件设置同一个位置。' +
      'chain 是从最粗层到最细层的值数组，可以只填到某一层（如只到「场」）；传 null 或空数组 = 清除该文件的分级。' +
      '路径用工作区相对路径（如 assets/images/xxx.png，与 list_facets 返回的形态一致），不要传绝对路径。' +
      '写之前先调用 list_facets 确认当前结构与现有写法；工作区还没有结构时先 define_facet_schema。' +
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
      ),
      schemaId: Type.Optional(
        Type.String({ description: '按哪套结构解释 chain；省略 = 当前生效结构' })
      )
    }),
    execute: async (_toolCallId, params) => {
      const root = workspaceRoot()
      if (!root) {
        return { content: [{ type: 'text' as const, text: NO_WORKSPACE_TEXT }], details: { ok: false } }
      }
      const payload = params as { entries?: unknown; schemaId?: unknown }
      const raw = payload?.entries
      if (!Array.isArray(raw) || raw.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'entries 不能为空：请给出要设置的文件与位置（relPath + chain）。' }],
          details: { ok: false }
        }
      }
      const schemas = deps.schemas()
      const wantedId = typeof payload?.schemaId === 'string' ? payload.schemaId.trim() : ''
      const schema = wantedId
        ? (schemas.find((s) => s.id === wantedId) ?? null)
        : activeFacetSchema(schemas, deps.activeSchemaId())
      if (!schema) {
        return {
          content: [
            {
              type: 'text' as const,
              text: wantedId
                ? `没有这个分级结构：${wantedId}。请先调用 list_facets 确认，或 define_facet_schema 创建。`
                : NO_SCHEMA_TEXT
            }
          ],
          details: { ok: false }
        }
      }

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
        `已按「${schema.label}」更新 ${result.updated} 个文件的分级${result.removed > 0 ? `，清除 ${result.removed} 个` : ''}。`,
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

  return [listFacets, defineSchema, deleteSchema, setFacets]
}
