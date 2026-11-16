/** workspace.json 的持久化结构，以及各段在内存中的规范化形态。 */

import type { FacetSchema } from '../../shared/facets'
import type { MediaProviderType, MediaRatio, ModelCapabilities } from '../../shared/media'
import type { AgentRuntimeKind } from '../agent/runtime'
import type { WorkspaceChatConfig } from '../models/types'

/** 工作区元数据的持久化结构。 */
/** workspace.json 的 media.userProviders 条目（M11；用户自建供应商，文件持久化形态） */
export interface WorkspaceMediaProviderConfig {
  id: string
  /** 必须是已注册的适配器类型；单一声明处在 shared/media.ts */
  type: MediaProviderType
  label?: string
  /** 凭据存储键后缀（safeStorage 存储 media:<authKey>），缺省 = id */
  authKey?: string
  /** 环境变量名（缺省按适配器约定，gateway-dashscope 为 DASHSCOPE_KEY），已录入存储 Key 时优先 */
  authEnv?: string
  /** 网关基址（协议家族适配器用，如 gateway-openai-compat）；缺省 = 适配器官方默认 */
  baseUrl?: string
  /** 认证头风格（gateway-openai-compat 消费的通用协议字段）：bearer | x-api-key；缺省 = bearer */
  authStyle?: 'bearer' | 'x-api-key'
  /**
   * 模型表：键 = 发给网关的模型标识。裸 slug（'wan2.7-image'）或带供应商前缀的
   * 全 id（'dashscope/wan2.7-image'，覆盖/恢复内置模型时用）都合法——合并层按
   * 内置目录同一条规则剥前缀得出实际请求标识（catalog/merge.ts）。
   * kind 必须落在该适配器类型支持的端点族内（越界的模型条目会被清洗层丢弃）。
   */
  models: Record<
    string,
    {
      kind: 'image' | 'video' | 'audio'
      label?: string
      /** 能力元数据（比例/时长档位等，浏览目录「添加」时透传；驱动渲染端参数面板） */
      capabilities?: ModelCapabilities
      /** 一句人话的成本提示，展示在参数面板 */
      costHint?: string
    }
  >
}

/** 对内置模型（按用户可见 id，如 'dashscope/wan2.7-image'）的展示覆盖 */
export interface MediaModelOverride {
  label?: string
}

/**
 * workspace.json 的 media 段。
 *
 * 模型清单的单一事实来源是内置目录（src/main/media/catalog），本段只存**覆盖层**：
 * userProviders（用户自建供应商）、hiddenBuiltin（隐藏的内置模型）、modelOverrides
 * （展示覆盖）。生效清单由 catalog/merge.ts 的 mergeCatalog 运行时合并。
 *
 * 旧字段 `providers` 已改名 `userProviders`：readMeta 读旧写新（读入时迁移），
 * 老工作区无感升级，写入一律用新字段名。
 */
export interface WorkspaceMediaConfig {
  /** 高成本确认闸门：Agent 视频生成工具是否需要确认（M13） */
  confirmVideo?: boolean
  /**
   * Agent 媒体访问模式：full = 直接执行（现状，视频仍受 confirmVideo 约束）；
   * confirm = 变更前确认（所有生成提交前弹确认卡，取代视频对话闸门）。缺省 full。
   */
  accessMode?: 'full' | 'confirm'
  /** Agent 媒体工具使用的供应商；未配置时需要用户选择。 */
  agentProvider?: string
  /**
   * 各 kind 的默认模型，记法统一为 `provider:模型id` 复合串（可跨供应商指定）。
   * 旧版存的裸模型 id 由 shared/mediaResolve 的 matchBareModelId 兼容解析，下次写入自动升级。
   */
  agentModels?: Partial<Record<'image' | 'video' | 'audio', string>>
  userProviders?: WorkspaceMediaProviderConfig[]
  /** 被用户隐藏的内置模型 id（如 'dashscope/wan2.7-image'） */
  hiddenBuiltin?: string[]
  /** 对内置模型的展示覆盖（按用户可见模型 id） */
  modelOverrides?: Record<string, MediaModelOverride>
  /** 产物输出目录（相对工作区根；空/缺省 = .huabu/media） */
  outputDir?: string
  /** 同时进行的生成任务数上限（1..8；缺省 3） */
  concurrency?: number
  /** 新建生成卡片的默认图片比例 */
  defaultRatio?: MediaRatio
  /** 新建生成卡片的默认时长（秒） */
  defaultDuration?: number
  /** 全局默认落库素材库 id（libraries 段的条目 id；空 = 公共库/工作目录兜底） */
  defaultLibraryId?: string
  /** 按媒体大类的默认落库素材库 id（优先级高于全局默认） */
  kindLibraryDefaults?: Partial<Record<'image' | 'video' | 'audio', string>>
}

export interface WorkspaceMetaFile {
  version: 1
  /**
   * @deprecated 旧顶层字段：只出现在 `readMeta` 解析出的 `raw` 里，作为一次性迁移输入。
   * readMeta 的返回值**不含**这两个字段（回填就是双轨），所以任何写入路径都不会再产生它们。
   */
  defaultModel?: string
  /** @deprecated 同 defaultModel：迁移进 chat.hiddenBuiltin，读取后即弃 */
  hiddenModels?: string[]
  /**
   * 聊天模型清单的**覆盖层**（架构计划 §3）：自定义供应商、隐藏项、展示覆盖、默认模型。
   * 内置清单不在这里——那是 src/main/models/catalog 的代码数据，运行时由 mergeChatCatalog 合并。
   * 缺省时从旧字段和 .huabu/models.json 迁移，具体规则见 metadata.ts。
   */
  chat?: WorkspaceChatConfig
  media?: WorkspaceMediaConfig
  /**
   * 工作区技能段（agentskills.io 规范，技能本体在 .huabu/skills/<name>/SKILL.md）：
   * 这里只存禁用名单；清单每次现扫目录（与会话加载同源，防两套解析漂移）。
   */
  skills?: WorkspaceSkillsConfig
  /** 历史运行时字段；当前仅使用 Mastra。 */
  agent?: WorkspaceAgentConfig
  /** 素材分级结构（工作区自定义；决定层级叫什么：集/场/镜 还是任何别的） */
  facets?: WorkspaceFacetsConfig
  /** 素材库映射（新原型同步）：名字 → 工作区内相对路径。公共库首个建库时播种 */
  libraries?: WorkspaceLibrary[]
}

/**
 * workspace.json 的 facets 段：分级结构（工作区自定义，产品不内置任何方案）
 * 与当前生效的那一套。
 */
export interface WorkspaceFacetsConfig {
  /** 当前生效的 schema id；缺省/失效 = 列表第一套 */
  schemaId?: string
  /** 这个工作区定义的全部分级结构（由用户或 Agent 创建） */
  schemas?: FacetSchema[]
}

/** workspace.json 的 skills 段 */
export interface WorkspaceSkillsConfig {
  /** 被禁用的技能名（= SKILL.md frontmatter name = 目录名） */
  disabled?: string[]
}

/** workspace.json 的历史运行时配置，保留用于读取旧工作区。 */
export interface WorkspaceAgentConfig {
  /** pi 是已退役的历史值；当前运行时为 mastra。 */
  runtime?: AgentRuntimeKind
}

/** workspace.json 的 libraries 段条目（素材库 = 名字 → 相对路径的映射，不复制文件） */
export interface WorkspaceLibrary {
  id: string
  name: string
  /** 工作区内相对路径（POSIX 风格，如 素材库/海报产出） */
  path: string
  /** 公共素材库：默认落库的兜底，不可删除 */
  isPublic?: boolean
}

