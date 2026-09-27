import type { MediaKind, MediaProviderType } from '../../../shared/media'

/**
 * 内置媒体模型目录的类型（catalog 架构 §3.1）。
 *
 * 目录文件（providers/*.ts）是随应用发布的**代码数据**：模型清单的单一事实来源，
 * workspace.json 只存覆盖层（userProviders/hiddenBuiltin/modelOverrides），运行时由
 * merge.ts 合并。社区加模型 = 新增/修改一个目录文件里的纯数据对象（PR 友好北极星）。
 *
 * 兼容性铁律：模型 `id` 合入后不得改名——用户配置与 Agent 默认都引用它；
 * 厂商升级时老模型标 deprecated 保留，新模型加新条目。
 */

/** 单个内置模型定义（目录文件里的纯数据） */
export interface BuiltinModelDef {
  /** 面向用户的稳定 id，合入后不得改名（用户配置会引用它），如 'fal/veo3.1' */
  id: string
  kind: MediaKind
  label: string
  /** 实际发给网关/厂商的模型路径，如 'fal-ai/veo3'；缺省 = id 去掉 provider 前缀 */
  remoteModel?: string
  /** 能力元数据：驱动渲染端参数面板 */
  capabilities?: import('../../../shared/media').ModelCapabilities
  /** 生命周期：beta 显示标记；deprecated 不出现在新建入口、老任务仍可回放 */
  status?: 'stable' | 'beta' | 'deprecated'
  /** 适配器特有的抽取/行为微调，如 fal 的 resultKey */
  adapterHints?: Record<string, unknown>
  /** 一句人话的成本提示（'约 $0.4/秒'），展示在参数面板，帮助用户避坑 */
  costHint?: string
}

/** 凭据约定：设置页据此自动渲染 Key 录入框与帮助链接 */
export interface BuiltinProviderAuth {
  /** 凭据存储键后缀（safeStorage media:<key>）；缺省 = 使用 provider id */
  key?: string
  /** 环境变量回退名，符合 <VENDOR>_KEY 命名约定（如 FAL_KEY） */
  env: string
  /** Key 录入框的展示名（'fal.ai API Key'） */
  label: string
  /** 申请/管理 Key 的官方入口 */
  helpUrl: string
}

/** 单个内置供应商定义（一个供应商一个目录文件） */
export interface BuiltinProviderDef {
  /** 用户可见的稳定 id（'fal' | 'elevenlabs' | …），与用户自建供应商同一命名空间 */
  id: string
  label: string
  /** 适配器类型，必须在 adapters/registry 里已注册（catalog:check 校验） */
  adapter: Exclude<MediaProviderType, 'mock'>
  auth: BuiltinProviderAuth
  /** 网络区域提示：设置页展示连通性预期 */
  region?: 'global' | 'cn-direct'
  models: BuiltinModelDef[]
}

/**
 * 全量浏览目录条目（设置页「浏览完整模型库」的数据源，data/*.ts 自动生成）。
 *
 * 与生效清单（mergeCatalog）分离：不参与解析、不进 media:providers，只在用户
 * 点「添加」时把该条目落成 workspace.json media.userProviders 里的一个模型。
 */
export interface CatalogBrowseModel {
  /** 发给网关的标识（predict 协议即 endpoint，如 'veo-4-text-to-video'） */
  id: string
  kind: MediaKind
  label: string
  /** 上游提供方名（Google / OpenAI / Kling…），浏览列表展示用 */
  provider?: string
  capabilities?: import('../../../shared/media').ModelCapabilities
  /** 除 prompt 外的额外必填参数；非空时 UI 提示「生成可能失败」（提交链路只带 prompt/比例/时长/参考图） */
  needsExtra?: string[]
}
