/**
 * 工作区模型目录与凭据服务——**不依赖 pi**。
 *
 * ## 为什么从 AgentHost 里剥出来
 *
 * `AgentHost` 的所有模型/凭据方法都先走 `runtimeFor()`，而那条路径要先
 * `await import(pi)` 成功。后果是：pi 一旦加载失败（没装包、包损坏、ESM 解析异常），
 * **设置页的模型清单、Key 录入、媒体 Key 全部一起失效**，尽管这些能力一点都不需要 pi。
 *
 * 默认运行时刻已经是 Mastra，这个耦合就成了真正的单点：它让「把 pi 从 package.json
 * 摘掉」在物理上做不到。本文件把它拆开——凭据存储 + 模型目录 + 一次性迁移，
 * 三个都只需要 fs 与 safeStorage。
 *
 * ## 刻意不做的事
 *
 * 不碰会话、不碰 pi 的 `ModelRuntime`、不做 provider 连通性自检（`testProvider` 要发真
 * 请求给供应商，依赖 pi 的 auth 快照，留在 host 里，随 pi 一起删）。
 *
 * ## 为什么凭据工厂由外部注入
 *
 * `SafeStorageCredentialStore` 走 electron 的 `safeStorage`，一旦本模块静态 import 它，
 * 这个文件就再也不能在 node 单测里加载（同一个坑在 `mastra/runtime.ts` 踩过一次）。
 * 工厂从主进程传入，测试里换成 `InMemoryCredentialStore` 即可完整覆盖目录逻辑。
 */

import type { CredentialStore } from './contracts'
import type {
  ChatErrorCode,
  ChatModelOption,
  ChatResult,
  ChatRuntimeInfo,
  ProviderAuthInfo,
  ProviderTestResult,
  SettingsProvidersInfo
} from '../../shared/ipc'
import { THINKING_LEVELS } from '../../shared/ipc'
import { ChatModelManager } from '../models/manager'
import { applyCredentialMoves } from '../models/migrate'
import { readChatConfig, readChatMigrationPlan, writeChatSegment } from '../workspace/store'
import { createModelGateway } from './mastra/modelGateway'

/**
 * 凭据存储（含可选的 huabu 扩展）。
 *
 * `describe()` 是 SafeStorage 实现提供的状态提示（加密是否可用等），不属于 pi 的
 * `CredentialStore` 契约；内存实现可以不给。
 */
export interface WorkspaceCredentialStore extends CredentialStore {
  describe?(): string
}

export type CredentialsFactory = (workspaceDir: string) => Promise<WorkspaceCredentialStore>

export interface WorkspaceModelsDeps {
  /** 按工作区产出凭据存储（生产：safeStorage 加密文件；测试：内存实现） */
  createCredentials: CredentialsFactory
  /** 迁移日志出口（默认 console）；测试里可静音 */
  log?: (message: string) => void
}

/** 管理器凭据来源 → IPC 契约里的来源串（沿用 pi 时代的取值，渲染端不用改） */
export function authSourceOf(source: 'stored' | 'env' | 'none'): string {
  return source === 'stored' ? 'workspace-store' : source === 'env' ? 'environment' : 'none'
}

/**
 * 模型支持的思考档位：非推理 → 空；目录无显式映射 → 全部六档；有映射 → 只取非 null 档位。
 *
 * off 刻意排除：会话层只在 minimal..max 内工作，'off' 只是 wire 层 thinkingLevelMap 的
 * 映射键，传进去会被 clamp 到最低档，造成「以为关了」的误导。
 */
export function deriveThinkingLevels(model: {
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null> | undefined
}): string[] {
  if (!model.reasoning) return []
  const map = model.thinkingLevelMap
  if (!map || Object.keys(map).length === 0) return THINKING_LEVELS.filter((level) => level !== 'off')
  return THINKING_LEVELS.filter((level) => level !== 'off' && map[level] !== null)
}

/** 把异常收敛成一句可展示的文本，且绝不带上堆栈里可能出现的密钥 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error')
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

function fail<T>(code: ChatErrorCode, error: string): ChatResult<T> {
  return { ok: false, code, error }
}

function ok<T>(value: T): ChatResult<T> {
  return { ok: true, value }
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

/** 连通性自检的请求超时：卡住比失败更糟，超时按失败报 */
export const PROVIDER_PROBE_TIMEOUT_MS = 20_000

/** 设置页「模型管理」的一行（含被隐藏的内置模型与用户自建模型） */
export interface ManagedModelView {
  id: string
  name: string
  source: 'builtin' | 'custom'
  hidden: boolean
  edited: boolean
  reasoning: boolean
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
  thinkingLevels?: string[]
}

export class WorkspaceModels {
  /** 工作区目录 → 凭据存储（凭据保热：切换工作区不销毁） */
  private readonly credentials = new Map<string, WorkspaceCredentialStore>()
  /** 已完成一次性迁移的工作区（迁移本身幂等，这里只是省重复读盘） */
  private readonly migrated = new Set<string>()

  constructor(private readonly deps: WorkspaceModelsDeps) {}

  private log(message: string): void {
    ;(this.deps.log ?? ((text: string) => console.log(text)))(message)
  }

  /**
   * 取（或创建）工作区凭据存储；首次创建时落地一次性迁移。
   *
   * 迁移失败不阻断：内联旧键还能被 `readChatConfig` 读到，下次启动再搬一次即可。
   */
  async credentialsFor(workspaceDir: string): Promise<WorkspaceCredentialStore> {
    const existing = this.credentials.get(workspaceDir)
    if (existing && this.migrated.has(workspaceDir)) return existing
    const store = existing ?? (await this.deps.createCredentials(workspaceDir))
    this.credentials.set(workspaceDir, store)
    if (!this.migrated.has(workspaceDir)) {
      this.migrated.add(workspaceDir)
      await this.landChatMigration(workspaceDir, store)
    }
    return store
  }

  /**
   * 一次性迁移落地：搬旧键凭据 + 把算好的 `chat` 段写进 workspace.json。
   *
   * 搬运有失败时**不写** chat 段：旧键还在原地，下次启动再搬一遍即可；写死了就等于
   * 把这条唯一的迁移路径关掉，用户的旧 Key 会永久留在没人读的地方。
   */
  private async landChatMigration(workspaceDir: string, credentials: CredentialStore): Promise<void> {
    try {
      const plan = readChatMigrationPlan(workspaceDir)
      if (!plan) return
      const moves = await applyCredentialMoves(credentials, plan.credentialMoves)
      if (moves.moved.length + moves.skipped.length + moves.failed.length > 0) {
        // 只报 provider id：日志里永远不出现密钥内容
        this.log(
          `[workspace-models] 凭据搬运 moved=${moves.moved.join(',') || '-'} ` +
            `skipped=${moves.skipped.join(',') || '-'} failed=${moves.failed.join(',') || '-'}`
        )
      }
      if (moves.failed.length === 0) writeChatSegment(workspaceDir, plan.config)
      else this.log('[workspace-models] 凭据搬运有失败项，chat 段暂不落盘（下次启动重试）')
    } catch (error) {
      this.log(`[workspace-models] 一次性迁移失败（下次启动重试）：${describeError(error)}`)
    }
  }

  /**
   * 该工作区的管理器（清单唯一来源）。每次现算不缓存：覆盖层是几 KB 的 JSON，
   * 而「缓存 + 忘记失效」恰好是这次重构要消灭的那类 bug。
   */
  async managerFor(workspaceDir: string): Promise<ChatModelManager> {
    return new ChatModelManager({
      credentials: await this.credentialsFor(workspaceDir),
      config: readChatConfig(workspaceDir)
    })
  }

  /**
   * 运行时状态与模型清单（下拉用）。清单来自管理器（被删除的模型本就不在其中），
   * 返回不含任何密钥内容。
   *
   * 这里 `ready` 的含义是「目录可用」，不再取决于 pi 是否加载成功——正是本模块存在的理由。
   */
  async runtimeInfo(workspaceDir: string): Promise<ChatResult<ChatRuntimeInfo>> {
    try {
      const manager = await this.managerFor(workspaceDir)
      const authByProvider = new Map(
        (await manager.statuses()).map((s) => [s.id, { configured: s.configured, authSource: s.authSource }])
      )
      const configured = [...authByProvider].filter(([, a]) => a.configured).map(([id]) => id)
      const models: ChatModelOption[] = manager.providers().flatMap((provider) => {
        const auth = authByProvider.get(provider.id)
        return provider.models.map((model) => {
          const option: ChatModelOption = {
            id: `${provider.id}/${model.id}`,
            provider: provider.id,
            model: model.id,
            authConfigured: auth?.configured === true,
            reasoning: model.reasoning === true,
            thinkingLevels: deriveThinkingLevels(model)
          }
          option.authSource = authSourceOf(auth?.authSource ?? 'none')
          option.authLabel = provider.auth.label
          return option
        })
      })
      // 已配置凭据的排在前面，用户在下拉里第一眼看到的就是能用的（组内保持目录顺序）
      models.sort((a, b) => Number(b.authConfigured) - Number(a.authConfigured))
      return ok<ChatRuntimeInfo>({ ready: true, models, configuredProviders: configured })
    } catch (error) {
      return ok<ChatRuntimeInfo>({
        ready: false,
        error: `读取模型目录失败：${describeError(error)}`,
        models: [],
        configuredProviders: []
      })
    }
  }

  /**
   * 录入 API Key：只写加密存储。
   *
   * 旧实现写完要「重注册进 pi 的 ModelRuntime」，因为 pi 的认证快照在 create 时固化。
   * 现在清单每次由管理器现算（目录唯一来源），写完即生效，不需要重注册，也就不需要 pi。
   */
  async setApiKey(workspaceDir: string, providerId: string, apiKey: string): Promise<ChatResult> {
    const trimmed = apiKey.trim()
    if (!trimmed) return fail('unknown', 'API Key 不能为空')
    if (!PROVIDER_ID_PATTERN.test(providerId)) return fail('unknown', `providerId 不合法：${providerId}`)
    try {
      const credentials = await this.credentialsFor(workspaceDir)
      await credentials.modify(providerId, async () => ({ type: 'api_key', key: trimmed }))
      this.log(`[workspace-models] setApiKey provider=${providerId}（已加密落盘，明文不进日志）`)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `保存凭据失败：${describeError(error)}`)
    }
  }

  async removeApiKey(workspaceDir: string, providerId: string): Promise<ChatResult> {
    try {
      const credentials = await this.credentialsFor(workspaceDir)
      await credentials.delete(providerId)
      this.log(`[workspace-models] removeApiKey provider=${providerId}`)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `删除凭据失败：${describeError(error)}`)
    }
  }

  /**
   * provider 连通性自检：先看凭据，再对第一个模型发一次最小请求。
   *
   * 这里**不再经过 pi**：原实现读 pi 的 `checkAuth` 快照并让 pi 发请求，而 pi 一坏这个
   * 按钮就跟着坏（同 `deps` 里的模型目录）。改用自有模型网关——就是 Mastra 会话发请求
   * 用的同一条链路，所以「自检通过」与「会话能发出去」是同一件事，不会自检出假阳性。
   */
  async testProvider(workspaceDir: string, providerId: string): Promise<ChatResult<ProviderTestResult>> {
    const result: ProviderTestResult = { providerId, authOk: false, requestOk: false, message: '' }
    let manager: ChatModelManager
    try {
      manager = await this.managerFor(workspaceDir)
    } catch (error) {
      return { ok: false, code: 'unknown', error: `读取模型目录失败：${describeError(error)}` }
    }
    const provider = manager.providers().find((entry) => entry.id === providerId)
    if (!provider) return fail('model_unavailable', `供应商不在清单里：${providerId}`)
    const status = (await manager.statuses()).find((entry) => entry.id === providerId)
    result.authOk = status?.configured === true
    result.authSource = authSourceOf(status?.authSource ?? 'none')
    result.authType = 'api_key'
    if (!result.authOk) {
      result.message = '该 provider 未配置凭据。请先在设置面板录入 API Key。'
      return ok(result)
    }
    const model = provider.models[0]
    if (!model) {
      result.message = '该供应商下没有可用模型（可能全被隐藏了）。'
      return ok(result)
    }

    const gateway = createModelGateway({ registrations: () => manager.registrations() })
    const controller = new AbortController()
    // 自检要给人用：卡住 20 秒比失败更糟，超时按失败报
    const timer = setTimeout(() => controller.abort(), PROVIDER_PROBE_TIMEOUT_MS)
    try {
      const stream = gateway.stream(
        {
          runId: `probe-${providerId}-${Date.now().toString(36)}`,
          ref: { providerId, modelId: model.id },
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          maxOutputTokens: 8
        },
        controller.signal
      )
      for await (const part of stream) {
        if (part.type === 'error') {
          result.message = part.message || `请求失败（${part.code}）`
          return ok(result)
        }
        if (part.type === 'text-delta' || part.type === 'finish') {
          result.requestOk = true
          result.message = `连接正常（${providerId}/${model.id}）`
          return ok(result)
        }
      }
      // 流正常结束但没有任何分片：认证与服务可达，模型没说话
      result.requestOk = true
      result.message = `连接正常（${providerId}/${model.id} 无输出）`
      return ok(result)
    } catch (error) {
      const aborted = controller.signal.aborted
      result.message = aborted
        ? `请求超时（${Math.round(PROVIDER_PROBE_TIMEOUT_MS / 1000)} 秒）`
        : `请求失败：${describeError(error)}`
      return ok(result)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 凭据存储状态提示（加密可用性等），设置页直接展示；实现不提供则为空串 */
  async credentialsHint(workspaceDir: string): Promise<string> {
    try {
      const credentials = await this.credentialsFor(workspaceDir)
      return credentials.describe?.() ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 供应商认证状态清单（设置页的凭据面板）。与 `runtimeInfo` 同一数据源，
   * 同样**不需要 pi**——原先这条路径要先成功加载 pi，否则设置页会显示空清单。
   */
  async providersInfo(workspaceDir: string): Promise<ChatResult<SettingsProvidersInfo>> {
    try {
      const manager = await this.managerFor(workspaceDir)
      const statuses = await manager.statuses()
      const providers: ProviderAuthInfo[] = statuses.map((status) => ({
        id: status.id,
        name: status.label,
        authConfigured: status.configured,
        authSource: authSourceOf(status.authSource),
        authLabel: status.authLabel,
        modelCount: status.modelCount,
        api: status.api
      }))
      // 已配置凭据的排前面，组内保持目录顺序（目录顺序=我们希望的推荐顺序）
      providers.sort((a, b) => Number(b.authConfigured) - Number(a.authConfigured))
      return ok<SettingsProvidersInfo>({
        providers,
        credentialsHint: await this.credentialsHint(workspaceDir)
      })
    } catch (error) {
      return { ok: false, code: 'unknown', error: `读取供应商清单失败：${describeError(error)}` }
    }
  }

  /**
   * 供应商下全部模型（含被用户删除的）与编辑状态合并视图。
   * 数据源＝管理器 inventory()，"是否隐藏/是否改过"与注册用的是同一份覆盖层。
   */
  async managedModels(workspaceDir: string, providerId: string): Promise<ChatResult<ManagedModelView[]>> {
    try {
      const manager = await this.managerFor(workspaceDir)
      const inventory = manager.inventory(providerId)
      if (!inventory) return fail('model_unavailable', `供应商不在清单里：${providerId}`)
      return ok(
        inventory.map(({ model, hidden, edited }) => ({
          id: model.id,
          name: model.label,
          source: (model.source === 'user' ? 'custom' : 'builtin') as 'builtin' | 'custom',
          hidden,
          edited,
          reasoning: model.reasoning === true,
          ...(model.input ? { input: model.input } : {}),
          ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
          ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
          thinkingLevels: deriveThinkingLevels(model)
        }))
      )
    } catch (error) {
      return { ok: false, code: 'unknown', error: `读取模型清单失败：${describeError(error)}` }
    }
  }

  /* ---------------- 媒体 provider 凭据（键名加 media: 前缀隔离） ---------------- */

  /** 读某媒体 provider 的凭据明文。只应在主进程内使用，绝不进 IPC 载荷 */
  async getMediaKey(workspaceDir: string, providerId: string): Promise<string | undefined> {
    try {
      const credentials = await this.credentialsFor(workspaceDir)
      const credential = await credentials.read(`media:${providerId}`)
      return credential?.type === 'api_key' ? credential.key : undefined
    } catch {
      return undefined
    }
  }

  async hasMediaKey(workspaceDir: string, providerId: string): Promise<boolean> {
    try {
      const credentials = await this.credentialsFor(workspaceDir)
      return Boolean(await credentials.read(`media:${providerId}`))
    } catch {
      return false
    }
  }

  async setMediaKey(workspaceDir: string, providerId: string, apiKey: string): Promise<ChatResult> {
    const trimmed = apiKey.trim()
    if (!trimmed) return fail('unknown', 'API Key 不能为空')
    if (!PROVIDER_ID_PATTERN.test(providerId)) return fail('unknown', `providerId 不合法：${providerId}`)
    try {
      const credentials = await this.credentialsFor(workspaceDir)
      await credentials.modify(`media:${providerId}`, async () => ({ type: 'api_key', key: trimmed }))
      this.log(`[workspace-models] setMediaKey provider=${providerId}（已加密落盘）`)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `保存媒体凭据失败：${describeError(error)}`)
    }
  }

  async removeMediaKey(workspaceDir: string, providerId: string): Promise<ChatResult> {
    try {
      const credentials = await this.credentialsFor(workspaceDir)
      await credentials.delete(`media:${providerId}`)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `删除媒体凭据失败：${describeError(error)}`)
    }
  }
}
