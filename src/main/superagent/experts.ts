/**
 * 专家池（架构图 to-be ② 的「专家」列）。
 *
 * 一个专家 = 一份指令追加 + 一个工具面 + 一个（可选的）常驻线程。
 * 专家本身不带任何业务状态：任务状态在 journal，产物在版本槽，专家只是「谁来干」。
 *
 * 首版内置两个薄核心：
 * - `expert-visual`：视觉专家，挂媒体工具（generate_image / generate_video / read_media / 视频理解）；
 * - `expert-exec`：执行专家，不挂生成工具，只做文本类产物（提示词、分镜表、脚本）。
 *
 * 未知 expert id 一律回落到默认专家，并把回落事实写进返回值——
 * 派单失败不该是「静默换人」，但也不该因为拼错一个 id 就把任务废掉。
 */

export interface ExpertDefinition {
  id: string
  /** 显示名（UI 像素头像旁的名字） */
  label: string
  /** 一句话角色说明（给人和主 Agent 看） */
  role: string
  /** 常驻 = 独立长生命周期线程；否则按任务创建、完事即弃 */
  resident: boolean
  /** 追加到信封指令末尾的专家专属规则（可空） */
  instructions: string
  /**
   * 工具面：'media' = 挂媒体生成 + 读媒体工具；'none' = 只有文本回执能力。
   * 后续接入其它工具集时在此扩展（白名单式，不做「全部工具」）。
   */
  tools: 'media' | 'none'
  /** 优先承担的产物类型（派单未显式给 expert 时按任务内容猜） */
  favors: Array<'image' | 'video' | 'audio' | 'text'>
}

export const DEFAULT_EXPERT_ID = 'expert-visual'

const VISUAL: ExpertDefinition = {
  id: 'expert-visual',
  label: '视觉专家',
  role: '按信封生成图片/视频产物，负责画面一致性',
  resident: false,
  tools: 'media',
  favors: ['image', 'video'],
  instructions: [
    '你是视觉专家：用 generate_image / generate_video 真正产出画面，不靠文字描述代替生成。',
    '生成前先 read_media 看参考素材的实际内容；参考里明确出现的角色/场景必须按参考来，不要臆造。',
    '一次只做当前任务这一条产物；需要多张就分多次调用，不要一次塞多个 prompt。',
    '产物落到 lane 内后，按「回执」章节输出唯一一行 JSON（path 用生成工具返回的真实路径）。'
  ].join('\n')
}

const EXEC: ExpertDefinition = {
  id: 'expert-exec',
  label: '执行专家',
  role: '产出文本类结果（分镜表、提示词、脚本段落）',
  resident: false,
  tools: 'none',
  favors: ['text'],
  instructions: [
    '你是执行专家：产出的是文本制品（分镜表、提示词、脚本段落），不生成画面，也没有文件写入工具。',
    '把文本产物直接写在回答正文里；最后的回执 JSON 仍必须给出 path（lane 内的建议落盘路径）与 format=md，',
    '由主 Agent 决定是否落盘。kind 填 text。',
    '不要声称已经写了文件——你只产出文本与回执。'
  ].join('\n')
}

export const EXPERT_REGISTRY: readonly ExpertDefinition[] = [VISUAL, EXEC]

/** 全部专家（UI 专家池清单用；顺序即展示顺序） */
export function listExperts(): ExpertDefinition[] {
  return [...EXPERT_REGISTRY]
}

export function findExpert(id: string | undefined): ExpertDefinition | undefined {
  if (!id) return undefined
  return EXPERT_REGISTRY.find((expert) => expert.id === id.trim())
}

/**
 * 解析派单专家：显式 id 命中即用；未命中/未指定时回落到默认专家。
 * `fellBack` 让调用方能把「拼错的 id 被换人」这件事实写进 journal，而不是静默。
 */
export function resolveExpert(id: string | undefined): { expert: ExpertDefinition; fellBack: boolean } {
  const hit = findExpert(id)
  if (hit) return { expert: hit, fellBack: false }
  return { expert: VISUAL, fellBack: Boolean(id && id.trim()) }
}
