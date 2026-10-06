import type { MediaKind, MediaProviderType } from '../../../shared/media'
import type { MediaProviderAdapter } from '../provider'

/**
 * 适配器注册表：MediaProviderType → 工厂。
 *
 * 消灭 ipc.ts 里「if 链逐个 new」的硬编码工厂：每个适配器文件末尾自注册
 * （`registerAdapter('gateway-dashscope', …)`），adapters/index.ts 只做 barrel import。
 * 新增供应商类型 = 新增一个适配器文件 + barrel 里加一行 import，不触碰 ipc.ts。
 *
 * `MediaProviderType` union 的唯一声明处在 shared/media.ts；这里的 Map 是它的
 * 运行时事实来源（catalog:check 据此校验「类型必须有实现」）。
 */

/** 工厂收到的单个模型配置（合并层产出：用户可见 id 与实际请求标识分离） */
export interface AdapterModelConfig {
  kind: MediaKind
  /** 用户可见/任务账本使用的模型 id */
  id: string
  label?: string
  /** 实际发给网关/厂商的模型标识；缺省 = id */
  requestModel?: string
  /** 以下为目录层能力元数据透传（MediaModelInfo 同名字段，渲染端渐进消费） */
  capabilities?: import('../../../shared/media').ModelCapabilities
  status?: 'stable' | 'beta' | 'deprecated'
  costHint?: string
}

/** 工厂收到的规范化供应商配置（由 catalog/merge.ts 的 mergeCatalog 产出） */
export interface AdapterProviderConfig {
  id: string
  /** 适配器类型（注册表查找键） */
  type: Exclude<MediaProviderType, 'mock'>
  label: string
  /** 来源：builtin 内置目录 / user 用户自建 */
  source: 'builtin' | 'user'
  /** 凭据存储键后缀（safeStorage media:<authKey>），已缺省化为 id */
  authKey: string
  /** 环境变量回退名（已按目录 auth.env / 用户配置缺省化）；缺省 = 不查环境变量 */
  authEnv?: string
  /**
   * 网关基址（需要它的协议家族用，如 gateway-openai-compat 的 {base}/images/generations）；
   * 缺省 = 适配器自带的官方默认地址。内置供应商也可以覆盖（经用户同名配置）
   */
  baseUrl?: string
  /**
   * 认证头风格（部分通用协议用）：bearer = `Authorization: Bearer <key>`，
   * x-api-key = `x-api-key: <key>`。缺省 = 适配器默认（见各适配器注释）
   */
  authStyle?: 'bearer' | 'x-api-key'
  models: AdapterModelConfig[]
}

/** 适配器运行所需的环境依赖（宿主注入，适配器不自取） */
export interface AdapterDeps {
  /** 当前工作区媒体目录绝对路径；未打开工作区时为 null */
  mediaDir: () => string | null
  /** 读某供应商凭据明文（加密存储优先，回退 authEnv 声明的环境变量）。绝不进日志 */
  resolveKey: (auth: { authKey?: string; authEnv?: string }) => Promise<string | undefined>
}

export type AdapterFactory = (deps: AdapterDeps, config: AdapterProviderConfig) => MediaProviderAdapter

/** 适配器自描述元数据（注册时声明，宿主与合并层按此取默认值，不写死厂商约定） */
export interface AdapterMeta {
  /** 用户配置未声明 authEnv 时的默认环境变量名（如 gateway-dashscope → DASHSCOPE_KEY） */
  defaultAuthEnv?: string
}

const registry = new Map<MediaProviderType, AdapterFactory>()
const metaByType = new Map<MediaProviderType, AdapterMeta>()

/** 适配器文件末尾自注册；同类型重复注册直接抛错（启动期就能暴露接线错误） */
export function registerAdapter(type: MediaProviderType, factory: AdapterFactory, meta?: AdapterMeta): void {
  if (registry.has(type)) {
    throw new Error(`适配器类型重复注册：${type}`)
  }
  registry.set(type, factory)
  if (meta) metaByType.set(type, meta)
}

/** 某适配器类型声明过的默认环境变量名；未声明返回 undefined（不做环境变量回退） */
export function adapterDefaultAuthEnv(type: string): string | undefined {
  return metaByType.get(type as MediaProviderType)?.defaultAuthEnv
}

/** 已有实现的适配器类型（运行时事实来源；CI 与配置清洗共用） */
export function getAdapterTypes(): MediaProviderType[] {
  return [...registry.keys()]
}

export function isRegisteredAdapterType(type: string): type is MediaProviderType {
  return registry.has(type as MediaProviderType)
}

/** 按合并清单实例化适配器；未注册的类型在这里显式报错，绝不静默忽略 */
export function createAdapters(providers: readonly AdapterProviderConfig[], deps: AdapterDeps): MediaProviderAdapter[] {
  return providers.map((config) => {
    const factory = registry.get(config.type)
    if (!factory) {
      throw new Error(`适配器类型未注册：${config.type}（provider ${config.id}）`)
    }
    return factory(deps, config)
  })
}
