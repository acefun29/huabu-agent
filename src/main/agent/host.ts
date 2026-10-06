import type {
  AgentSession,
  ModelRuntime
} from '@earendil-works/pi-coding-agent'
import { createReadStream, existsSync } from 'fs'
import { stat } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, relative } from 'path'
import { createInterface as createLineReader } from 'readline'
import type {
  ChatContextBreakdownInfo,
  ChatContextUsage,
  ChatCreateInfo,
  ChatCreateRequest,
  ChatEvent,
  ChatErrorCode,
  ChatForkRequest,
  ChatForkResult,
  ChatHistoryInfo,
  ChatModelOption,
  ChatNodeRequest,
  ChatPromptRequest,
  ChatResult,
  ChatRuntimeInfo,
  ChatSetModelRequest,
  ChatSetModelResult,
  ChatSetThinkingRequest,
  ChatSetThinkingResult,
  ChatSteerRequest,
  ProviderAuthInfo,
  ProviderTestResult,
  SettingsProvidersInfo
} from '../../shared/ipc'
// THINKING_LEVELS 是运行时常量（档位校验与派生用），不能混进上面的 import type 块
import { THINKING_LEVELS } from '../../shared/ipc'
import { EventTranslator, toContextUsageEvent } from './serialize'
import { CUSTOM_COMPACTION_INSTRUCTIONS } from './compaction'
import { evictAllImages } from './contextEviction'
import { computeContextBreakdown } from './breakdown'
import { buildSessionHistory, type BuiltHistory, type HistoryImageSlot } from './history'
import { makeHistoryThumbnail } from './historyThumbs'
import { SafeStorageCredentialStore } from './credentials'
import {
  getCredentialsFile,
  readChatConfig,
  readChatMigrationPlan,
  writeChatSegment
} from '../workspace/store'
import { applyCredentialMoves } from '../models/migrate'
import { ChatModelManager } from '../models/manager'
import { resolveSessionCwd, resolveSessionFile, getSessionDir } from './workspace'
import { buildAgentSystemPrompt } from '../../shared/prompt'

/**
 * AgentHost：主进程内的 Pi 运行时宿主。
 *
 * 四个不可动摇的约束（依据 docs/m3-spike.md 实测结论）：
 * 1. pi 是纯 ESM 且不提供 require 入口，只能用 `await import()` 加载，因此 init 是异步的；
 *    本文件顶部的 pi 相关导入全部是 `import type`，编译后擦除，不产生运行时 require。
 * 2. 模型必须显式选定，不能依赖 pi 的默认模型 —— 本机实测默认模型刚好指向一个凭据无效的 provider。
 * 3. 工具默认关闭。`createAgentSession` 不传 tools 时会启用 read/bash/edit/write，
 *    等于把「改用户文件」和「执行任意命令」的能力交给模型。M3 只放开只读 + 写入的白名单，
 *    bash / edit 留到 M6 接上工作区信任策略（pi 的 ProjectTrustStore）之后再开。
 * 4.（M9 扩展）ModelRuntime 不再是全局单例：按工作区创建（凭据按工作区隔离），
 *    切换工作区时旧工作区的全部会话必须 dispose（生命周期与工作区绑定）。
 * 5.（T5 起）模型清单的唯一来源是 `main/models` 管理器：pi 以 `modelsPath:null` 创建，
 *    随后逐家 `registerProvider` 注入我们的目录+覆盖层。**不要再用 runtime.getProviders()
 *    枚举**——那会把 pi 自带的 40 家内置供应商重新引进来。
 */

const PI_PACKAGE = '@earendil-works/pi-coding-agent'

/**
 * M3 放开的工具白名单。
 * 已经 scripts/m3-tool-probe.cjs 实测：ls / read / write 三者可用，
 * 事件为 tool_execution_start → tool_execution_end（无 update），write 真实落盘。
 * M13 起媒体生成工具经 customTools 注入（见 mediaTools.ts），不在此列。
 */
const TOOL_ALLOWLIST = ['ls', 'read', 'write']

/** 回放缩略图的每会话上限（风险登记：base64 过 IPC 的体积防护），超出退化为 chip */
const HISTORY_IMAGE_LIMIT = 24

/* 会话 JSONL 的体积分层防护（readSessionHistory）：单行可达数 MB、整文件数十 MB 的
 * base64 图块会让同步全读冻结主进程，故设硬顶拒绝 + 软顶跳行两道闸 */
/** 硬顶：文件超过 64MB 直接拒绝加载，不读入内存 */
const SESSION_FILE_HARD_LIMIT = 64 * 1024 * 1024
/** 软顶：文件在 24MB~64MB 之间照常加载，但启用单行长度过滤 */
const SESSION_FILE_SOFT_LIMIT = 24 * 1024 * 1024
/** 单行过滤阈值：正常消息/工具行远小于此，超长行必是 base64 图块 */
const SESSION_LINE_LIMIT = 512 * 1024

type PiModule = typeof import('@earendil-works/pi-coding-agent')
/** 从 ModelRuntime 的方法签名里提取 Model 类型，避免直接依赖 pi-ai 的运行时导出 */
type PiModel = NonNullable<ReturnType<ModelRuntime['getModel']>>

/** 一个工作区的 Pi 运行时：ModelRuntime + 加密凭据存储，生命周期与工作区绑定 */
interface WorkspaceRuntime {
  workspaceDir: string
  modelRuntime: ModelRuntime
  credentials: SafeStorageCredentialStore
}

interface SessionEntry {
  nodeId: string
  session: AgentSession
  unsubscribe: () => void
  translator: EventTranslator
  cwd: string
  modelId: string
  sessionFile?: string
}

function fail<T>(code: ChatErrorCode, error: string): ChatResult<T> {
  return { ok: false, code, error }
}

function ok<T>(value: T): ChatResult<T> {
  return { ok: true, value }
}

/** 管理器凭据来源 → IPC 契约里的来源串（沿用 pi 时代的取值，渲染端不用改） */
function piAuthSource(source: 'stored' | 'env' | 'none'): string {
  return source === 'stored' ? 'workspace-store' : source === 'env' ? 'environment' : 'none'
}

/** 把异常收敛成一句可展示的文本，且绝不带上堆栈里可能出现的密钥 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error')
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

/** 模型支持的思考档位（THINKING_LEVELS 顺序子集，不含 off）：非推理 → 空；目录无显式映射 → 全部六档（pi 会按模型能力 clamp，会话建好以 set-model 返回为准）；有映射 → 只取非 null 的显式档位。
 *  off 刻意排除：pi 会话层（setThinkingLevel/getAvailableThinkingLevels）只在 minimal..max 内工作，
 *  'off' 只是 wire 层 thinkingLevelMap 的映射键，传入会被 clamp 到最低档造成"以为关了"的误导 */
function deriveThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> | undefined }): string[] {
  if (!model.reasoning) return []
  const map = model.thinkingLevelMap as Record<string, string | null> | undefined
  if (!map || Object.keys(map).length === 0) return THINKING_LEVELS.filter((level) => level !== 'off')
  return THINKING_LEVELS.filter((level) => level !== 'off' && map[level] !== null)
}

export class AgentHost {
  private pi: PiModule | null = null
  private initError: string | null = null
  private initPromise: Promise<void> | null = null
  private readonly sessions = new Map<string, SessionEntry>()
  /** 工作区目录 -> 运行时。切换工作区不销毁运行时（凭据保热），只销毁会话 */
  private readonly runtimes = new Map<string, WorkspaceRuntime>()

  /**
   * @param emit 事件出口。host 不直接持有 webContents，由调用方（ipc.ts）决定往哪些窗口发，
   *             这样本类不依赖 electron，也便于将来把事件转发到日志或测试探针。
   */
  constructor(private readonly emit: (event: ChatEvent) => void) {}

  /** 幂等初始化：并发调用共享同一个 promise */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit()
    }
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    try {
      // 必须是动态 import。改成 require 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED
      const pi = await import(PI_PACKAGE)
      this.pi = pi
      console.log(`[agent-host] pi ${pi.VERSION} 已加载（ModelRuntime 按工作区懒创建）`)
    } catch (error) {
      this.initError = describeError(error)
      console.error(`[agent-host] 初始化失败：${this.initError}`)
    }
  }

  /**
   * 取（或创建）某工作区的运行时。
   *
   * ModelRuntime.create 的 credentials 指向 safeStorage 加密的按工作区文件：
   * 应用内录入的 Key 无需重启即可被 pi 读到（凭据在 create 时就接好），
   * 且与其它工作区、与全局 ~/.pi/agent 完全隔离。
   *
   * 清单侧只做一件事：`modelsPath:null` 关掉 pi 的 models.json 通道，随后由
   * `applyRegistrations` 把我们的目录逐家注进去。pi 自带的其它内置 provider 仍在其
   * 注册表里，但**我们不枚举它**（枚举口全在管理器），因此它们对 UI 与选模链都不存在。
   */
  async runtimeFor(workspaceDir: string): Promise<ChatResult<WorkspaceRuntime>> {
    await this.init()
    if (!this.pi || this.initError) {
      return fail('host_not_ready', `Agent 运行时初始化失败：${this.initError ?? '尚未就绪'}`)
    }
    const existing = this.runtimes.get(workspaceDir)
    if (existing) return ok(existing)

    const credentials = SafeStorageCredentialStore.forWorkspace(getCredentialsFile(workspaceDir))
    try {
      await this.landChatMigration(workspaceDir, credentials)
      const modelRuntime = await this.pi.ModelRuntime.create({
        credentials,
        modelsPath: null,
        // 不联网刷目录：清单变化由我们重注册驱动，pi 自己拉会再引进一个不可审计的数据源
        refreshOnCreate: false,
        allowModelNetwork: false
      })
      const entry: WorkspaceRuntime = { workspaceDir, modelRuntime, credentials }
      this.runtimes.set(workspaceDir, entry)
      await this.applyRegistrations(entry)
      const runtimeError = modelRuntime.getError()
      if (runtimeError) {
        console.warn(
          `[agent-host] 工作区 ${workspaceDir} ModelRuntime 报告异常（仍可继续）：${runtimeError}`
        )
      }
      console.log(`[agent-host] 工作区运行时就绪 ${workspaceDir}`)
      return ok(entry)
    } catch (error) {
      return fail('host_not_ready', `创建工作区模型运行时失败：${describeError(error)}`)
    }
  }

  /**
   * 一次性迁移落地：搬旧键凭据 + 把算好的 `chat` 段写进 workspace.json。
   *
   * 搬运有失败时**不写** chat 段：旧键还在原地，下次启动再搬一遍即可；写死了就等于
   * 把这条唯一的迁移路径关掉，用户的旧 Key 会永久留在没人读的地方。
   * notes 由 readChatConfig 一侧统一打印一次（见 workspace/store 的 migrationNotesPrinted），
   * 这里不重复刷屏。
   */
  private async landChatMigration(
    workspaceDir: string,
    credentials: SafeStorageCredentialStore
  ): Promise<void> {
    const plan = readChatMigrationPlan(workspaceDir)
    if (!plan) return
    const moves = await applyCredentialMoves(credentials, plan.credentialMoves)
    if (moves.moved.length + moves.skipped.length + moves.failed.length > 0) {
      // 只报 provider id：日志里永远不出现密钥内容
      console.log(
        `[agent-host] 凭据搬运 moved=${moves.moved.join(',') || '-'} ` +
          `skipped=${moves.skipped.join(',') || '-'} failed=${moves.failed.join(',') || '-'}`
      )
    }
    if (moves.failed.length === 0) writeChatSegment(workspaceDir, plan.config)
    else console.warn('[agent-host] 凭据搬运有失败项，chat 段暂不落盘（下次启动重试）')
  }

  /**
   * 该工作区的管理器（清单唯一来源）。每次现算不缓存：覆盖层是几 KB 的 JSON，
   * 而"缓存 + 忘记失效"恰好是这次重构要消灭的那类 bug。
   */
  private modelManager(entry: WorkspaceRuntime): ChatModelManager {
    return new ChatModelManager({
      credentials: entry.credentials,
      config: readChatConfig(entry.workspaceDir)
    })
  }

  /**
   * 把管理器算出的清单注册进运行时。
   *
   * 同 id 注册是整体替换（S2 实测），所以 Key 变更、模型增删改只需再调一次本方法，
   * 不必重建 ModelRuntime——这是 T5 删掉 recreateRuntime 的依据。
   */
  private async applyRegistrations(entry: WorkspaceRuntime): Promise<void> {
    for (const { providerId, payload } of await this.modelManager(entry).registrations()) {
      entry.modelRuntime.registerProvider(providerId, payload)
    }
  }

  /** 是否具备创建会话的条件；不满足时返回错误描述，由调用方包成各自的 ChatResult */
  private async ensureReady(
    workspaceDir: string
  ): Promise<{ code: ChatErrorCode; error: string } | null> {
    const runtime = await this.runtimeFor(workspaceDir)
    return runtime.ok ? null : runtime
  }

  /** 已配置凭据的 provider id（顺序=目录顺序）。认证状态直读管理器，不经 pi 的认证快照 */
  private async configuredIds(manager: ChatModelManager): Promise<string[]> {
    return (await manager.statuses()).filter((s) => s.configured).map((s) => s.id)
  }

  /**
   * 选模型。
   *
   * 优先级：显式 modelId > 工作区默认模型 > 第一个「所属 provider 已配置凭据」的可用模型。
   * 清单与凭据状态都来自管理器（决策 1：唯一枚举源），pi 只负责按 id 交出 Model 对象发请求。
   *
   * 默认模型定位不到时**静默走回退链**（旧实现靠 DEFAULT_HIDDEN_MODELS 做这件事）：
   * 指向退役模型或被用户删掉的模型都是既成事实，报一次错不会让用户好过一点，
   * 重选后覆盖写入即可。只有显式指定的 modelId 定位不到才报错——那是调用方的意图，不能替他改。
   */
  private async pickModel(
    entry: WorkspaceRuntime,
    manager: ChatModelManager,
    modelId?: string,
    fallbackModelId?: string
  ): Promise<{ model: PiModel; id: string } | { code: ChatErrorCode; error: string }> {
    const resolve = (providerId: string, id: string): PiModel | undefined =>
      entry.modelRuntime.getModel(providerId, id)

    const explicit = modelId?.trim()
    if (explicit) {
      const slash = explicit.indexOf('/')
      if (slash <= 0 || slash === explicit.length - 1) {
        return { code: 'model_unavailable', error: `modelId 格式应为 provider/model，收到：${explicit}` }
      }
      if (!manager.find(explicit)) {
        return {
          code: 'model_unavailable',
          error: manager.isHidden(explicit)
            ? `模型已被删除：${explicit}（可在设置的模型管理里恢复）`
            : `模型不可用：${explicit}`
        }
      }
      const model = resolve(explicit.slice(0, slash), explicit.slice(slash + 1))
      if (!model) {
        return { code: 'model_unavailable', error: `模型在清单里但未注册进运行时（内部错误）：${explicit}` }
      }
      return { model, id: explicit }
    }

    const fallback = fallbackModelId?.trim()
    if (fallback && manager.find(fallback)) {
      const slash = fallback.indexOf('/')
      const model = resolve(fallback.slice(0, slash), fallback.slice(slash + 1))
      if (model) return { model, id: fallback }
    }

    const configured = new Set(await this.configuredIds(manager))
    if (configured.size === 0) {
      return {
        code: 'no_credentials',
        error:
          '没有已配置凭据的模型提供方。请在设置面板录入 API Key（应用内即可，无需环境变量与重启）。'
      }
    }
    for (const provider of manager.providers()) {
      if (!configured.has(provider.id)) continue
      const first = provider.models[0]
      if (!first) continue
      const model = resolve(provider.id, first.id)
      if (model) return { model, id: `${provider.id}/${first.id}` }
    }
    return {
      code: 'model_unavailable',
      error: `已配置凭据的 provider（${[...configured].join('、')}）下没有可用模型`
    }
  }

  /** 运行时状态与模型清单（下拉用）。清单来自管理器（被删除的模型本就不在其中），返回不含任何密钥内容 */
  async runtime(workspaceDir: string): Promise<ChatResult<ChatRuntimeInfo>> {
    const runtimeResult = await this.runtimeFor(workspaceDir)
    if (!runtimeResult.ok) {
      return ok<ChatRuntimeInfo>({
        ready: false,
        error: runtimeResult.error,
        models: [],
        configuredProviders: []
      })
    }
    const entry = runtimeResult.value
    const manager = this.modelManager(entry)
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
        option.authSource = piAuthSource(auth?.authSource ?? 'none')
        option.authLabel = provider.auth.label
        return option
      })
    })

    // 已配置凭据的排在前面，用户在下拉里第一眼看到的就是能用的（组内保持目录顺序）
    models.sort((a, b) => Number(b.authConfigured) - Number(a.authConfigured))
    return ok<ChatRuntimeInfo>({ ready: true, models, configuredProviders: configured })
  }

  /** create 的宿主侧上下文：当前工作区、默认模型与（可选的）Agent 媒体工具 */
  async create(
    request: ChatCreateRequest,
    context?: {
      currentDir: string | null
      defaultModel?: string
      /** M13：媒体生成工具（generate_image/video/audio），随会话注入 */
      customTools?: import('./mediaTools').ToolDefinitionLike[]
      /** 工作区 skills.disabled 名单（settings:skills-set-disabled 写入）；这些技能不进新会话系统提示 */
      disabledSkills?: string[]
    }
  ): Promise<ChatResult<ChatCreateInfo>> {
    const cwdResult = resolveSessionCwd(request.cwd, context?.currentDir ?? null)
    if (!cwdResult.ok) return fail('cwd_rejected', cwdResult.error)
    const cwd = cwdResult.cwd

    const notReady = await this.ensureReady(cwd)
    if (notReady) return fail(notReady.code, notReady.error)
    const runtimeEntry = await this.runtimeFor(cwd)
    if (!runtimeEntry.ok) return fail(runtimeEntry.code, runtimeEntry.error)

    const nodeId = request.nodeId
    if (!nodeId) return fail('unknown', 'create 缺少 nodeId')
    if (this.sessions.has(nodeId)) {
      return fail('session_exists', `节点已绑定会话：${nodeId}`)
    }

    // 重绑已有会话：sessionFile 必须位于当前工作区的 .huabu/sessions/ 内（防渲染端伪造路径）
    let sessionFile: string | undefined
    if (request.sessionFile) {
      const fileResult = resolveSessionFile(request.sessionFile, cwd)
      if (!fileResult.ok) return fail('cwd_rejected', fileResult.error)
      sessionFile = fileResult.sessionFile
    }

    const picked = await this.pickModel(
      runtimeEntry.value,
      this.modelManager(runtimeEntry.value),
      request.modelId,
      context?.defaultModel
    )
    if ('code' in picked) return fail(picked.code, picked.error)

    // pi 的 clamp 只折「模型不支持的档位」，不管拼错的字符串，所以创建入口先挡一道
    //（'off' 一并拒绝：pi 会话层没有关思考的表达，传入会被 clamp 成最低档造成误导）
    if (
      request.thinkingLevel &&
      (!(THINKING_LEVELS as readonly string[]).includes(request.thinkingLevel) || request.thinkingLevel === 'off')
    ) {
      return fail('unknown', 'thinkingLevel 非法：' + request.thinkingLevel)
    }

    const pi = this.pi as PiModule
    try {
      const sessionManager = pi.SessionManager.create(cwd, getSessionDir(cwd))
      if (sessionFile) sessionManager.setSessionFile(sessionFile)

      // @backend(prompt)：工作区/素材库目录约定 + 路径引用契约随会话注入。
      // pi 只在 resourceLoader 缺省时自建并 reload；显式提供时 reload 是调用方责任
      // （sdk.ts：resourceLoader || (new DefaultResourceLoader(...), await reload())）。
      const settingsManager = pi.SettingsManager.create(cwd, pi.getAgentDir())
      // 工作区技能（agentskills.io 规范）：.huabu/skills/ 交给 pi 原生加载器发现与
      // 系统提示注入（<available_skills> XML）；disabledSkills 名单经 skillsOverride 过滤。
      // 加载器与设置页 listSkills 同源（loadSkillsFromDir），不存在两套解析。
      // 用户级技能目录 ~/.agents/skills（与 ZCode 共享）也一并注入；pi 原生默认目录
      // （agentDir/skills 与 cwd/.pi/skills）由加载器自行扫描，无需在这里给。
      const disabledSkills = new Set(context?.disabledSkills ?? [])
      const extraSkillPaths = [join(homedir(), '.agents', 'skills'), join(cwd, '.huabu', 'skills')].filter(
        (dir) => existsSync(dir)
      )
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd,
        agentDir: pi.getAgentDir(),
        settingsManager,
        appendSystemPrompt: [buildAgentSystemPrompt(cwd)],
        ...(extraSkillPaths.length > 0 ? { additionalSkillPaths: extraSkillPaths } : {}),
        ...(extraSkillPaths.length > 0 && disabledSkills.size > 0
          ? {
              skillsOverride: (base: { skills: Array<{ name: string }> }) => ({
                ...base,
                skills: base.skills.filter((skill) => !disabledSkills.has(skill.name))
              }) as never
            }
          : {})
      })
      await resourceLoader.reload()

      const { session } = await pi.createAgentSession({
        cwd,
        modelRuntime: runtimeEntry.value.modelRuntime,
        model: picked.model,
        // 初始思考档位；pi 会按模型能力 clamp（ThinkingLevel 是 pi 的枚举串，这里收窄不过类型关）。
        // 新会话未指定时显式给 pi 内置默认 medium：pi 否则会读机器全局默认
        // （~/.pi/agent/settings.json 的 defaultThinkingLevel，与其他 pi 系工具共用，
        // 实机出现过 "max" → clamp 成 high → 网关拒收），huabu 的会话默认不该被它劫持。
        // 重绑旧会话不传：让 pi 从会话历史恢复该会话上次的档位
        ...(request.thinkingLevel
          ? { thinkingLevel: request.thinkingLevel as never }
          : request.sessionFile
            ? {}
            : { thinkingLevel: 'medium' as never }),
        // 会话 JSONL 落到工作区的 .huabu/sessions/，与开发计划 3.4 的目录约定一致
        sessionManager,
        settingsManager,
        resourceLoader,
        // 白名单而非默认集：不给 bash / edit。
        // 实测：customTools 必须同时在 tools 白名单里列名，否则不会激活（tools 过滤一切工具）
        tools: [
          ...TOOL_ALLOWLIST,
          ...(context?.customTools ?? []).map((tool) => tool.name)
        ],
        // M13：媒体生成工具（generate_image/video/audio），提交即返回不阻塞 turn
        ...(context?.customTools && context.customTools.length > 0
          ? { customTools: context.customTools as never[] }
          : {})
      })

      const boundFile = sessionManager.getSessionFile() ?? sessionFile
      this.registerSession(nodeId, session, cwd, picked.id, boundFile)

      // 历史图片淘汰（执行点二，image-context-eviction-plan.md）：createAgentSession
      // 已把 JSONL 历史装进 agent.state.messages，base64 图块原样回内存，重启/重绑后
      // 立即淘汰一轮，规则与发问前一致（结果幂等）
      const evictedOnLoad = evictAllImages(session.agent.state.messages)
      if (evictedOnLoad > 0) {
        console.log(`[agent-host] 历史图片淘汰 nodeId=${nodeId} evicted=${evictedOnLoad}`)
      }

      const info: ChatCreateInfo = {
        nodeId,
        modelId: picked.id,
        thinkingLevel: session.thinkingLevel,
        cwd,
        activeTools: session.getActiveToolNames()
      }
      if (session.sessionId) info.sessionId = session.sessionId
      if (boundFile) info.sessionFile = boundFile

      // 水位初值：create 完成即推一次（重绑历史会话时立刻可见，不等第一轮响应）
      const initialUsage = toContextUsageEvent(nodeId, session.getContextUsage())
      if (initialUsage) this.emit(initialUsage)

      console.log(
        `[agent-host] create nodeId=${nodeId} model=${picked.id} cwd=${cwd} resume=${
          sessionFile ? 'yes' : 'no'
        } tools=${info.activeTools.join(',')}`
      )
      return ok(info)
    } catch (error) {
      const message = describeError(error)
      // 认证类失败要能与「链路故障」区分开，否则 UI 只会显示一句无操作的错误
      const code: ChatErrorCode = /auth|api key|credential|401/i.test(message)
        ? 'no_credentials'
        : 'unknown'
      console.error(`[agent-host] create 失败 nodeId=${nodeId}：${message}`)
      return fail(code, `创建会话失败：${message}`)
    }
  }

  /**
   * 全量技能清单（settings:skills-list 数据源）：pi 未加载完成时返回空表
   * （应用启动竞态下设置页拿到的就是"暂无技能"，下次刷新恢复）。
   * 扫描顺序与会话加载一致（先来者优先，同名不重复）：pi 原生用户目录 →
   * ~/.agents/skills（与 ZCode 共享）→ 工作区 .pi/skills → 工作区 .huabu/skills。
   * 直接用 pi 的 loadSkillsFromDir——与 create() 会话注入同一条加载路径。
   */
  listSkills(workspaceDir: string): {
    skills: Array<{ name: string; description: string; dir: string; source: 'user' | 'workspace'; invalid?: string }>
    piReady: boolean
  } {
    const pi = this.pi
    if (!pi) return { skills: [], piReady: false }
    const home = homedir()
    // 注：先声明再 filter——上下文类型不穿透方法调用的接收者，链式写法会把 'user' 放宽成 string
    const skillSourceDirs: Array<{ dir: string; source: 'user' | 'workspace' }> = [
      { dir: join(pi.getAgentDir(), 'skills'), source: 'user' },
      { dir: join(home, '.agents', 'skills'), source: 'user' },
      { dir: join(workspaceDir, '.pi', 'skills'), source: 'workspace' },
      { dir: join(workspaceDir, '.huabu', 'skills'), source: 'workspace' }
    ]
    const sources = skillSourceDirs.filter((entry) => existsSync(entry.dir))
    if (sources.length === 0) return { skills: [], piReady: true }

    type Entry = { name: string; description: string; dir: string; source: 'user' | 'workspace'; invalid?: string }
    const byPath = new Map<string, Entry>()
    const byName = new Map<string, Entry>()
    const displayDir = (baseDir: string): string =>
      (baseDir.startsWith(home) ? baseDir.slice(home.length).replace(/\\/g, '/') : relative(workspaceDir, baseDir).replace(/\\/g, '/'))

    for (const { dir, source } of sources) {
      const { skills, diagnostics } = pi.loadSkillsFromDir({ dir, source })
      for (const skill of skills) {
        if (byName.has(skill.name)) continue // 同名技能先来者优先，与会话侧合并语义一致
        const entry: Entry = {
          name: skill.name,
          description: skill.description ?? '',
          dir: displayDir(skill.baseDir),
          source
        }
        byPath.set(skill.filePath, entry)
        byName.set(skill.name, entry)
      }
      // 诊断挂回：已加载条目补 invalid 原因；没加载出来的（frontmatter 缺字段等）
      // 合成为占位条目，设置页才看得见「为什么我的技能没生效」
      for (const diagnostic of diagnostics) {
        if (!diagnostic.path) continue
        const existing = byPath.get(diagnostic.path)
        if (existing) {
          if (!existing.invalid) existing.invalid = diagnostic.message
          continue
        }
        const normalized = diagnostic.path.replace(/\\/g, '/')
        if (!normalized.startsWith(dir.replace(/\\/g, '/'))) continue
        const dirName = normalized.slice(dir.replace(/\\/g, '/').length + 1).split('/')[0]
        if (!dirName) continue
        const entry: Entry = {
          name: dirName,
          description: '',
          dir: displayDir(join(dir, dirName)),
          source,
          invalid: diagnostic.message
        }
        byPath.set(diagnostic.path, entry)
        if (!byName.has(entry.name)) byName.set(entry.name, entry)
      }
    }
    return { skills: [...byName.values()], piReady: true }
  }

  /** 登记会话：订阅事件 → 翻译 → emit，并放进按 nodeId 索引的注册表 */
  private registerSession(
    nodeId: string,
    session: AgentSession,
    cwd: string,
    modelId: string,
    sessionFile?: string
  ): SessionEntry {
    const translator = new EventTranslator(nodeId)
    const unsubscribe = session.subscribe((event) => {
      let events: ChatEvent[] = []
      try {
        events = translator.translate(event)
      } catch (error) {
        console.error(`[agent-host] 事件翻译失败（已跳过该事件）：${describeError(error)}`)
        return
      }
      for (const payload of events) this.emit(payload)
      // 水位推送挂钩（计划 T1）：整轮结束 / 压缩结束后现读一次 getContextUsage。
      // 推送为主，渲染端不猜时机；压缩后 tokens=null 如实透传（UI 显示"—"）。
      if (event.type === 'agent_end' || event.type === 'compaction_end') {
        const usageEvent = toContextUsageEvent(nodeId, session.getContextUsage())
        if (usageEvent) this.emit(usageEvent)
      }
    })
    const entry: SessionEntry = { nodeId, session, cwd, modelId, sessionFile, unsubscribe, translator }
    this.sessions.set(nodeId, entry)
    return entry
  }

  /**
   * 读取会话 JSONL 的历史（画布恢复时回放展示）。
   *
   * 为什么由主进程读而不是渲染端：文件在工作区磁盘上，渲染端无 Node 能力；
   * 结构化解析（blocks / 图片缩略 / 压缩分界 / inContext 标记）在 agent/history.ts
   * 纯函数层完成，pi 的 buildContextEntries 在这里注入——本方法因此改为 async
   * （pi 模块必须先经 await import 装载）。
   *
   * 图片防护（风险登记）：base64 原图块不出主进程。这里把 history.ts 登记的
   * 图片槽位经 nativeImage 缩到 ≤256px JPEG 后回填；每会话超过 24 张的部分
   * 退化为带源路径的 chip。
   */
  async history(request: ChatNodeRequest): Promise<ChatResult<ChatHistoryInfo>> {
    const entry = this.sessions.get(request.nodeId)
    const sessionFile = entry?.sessionFile
    if (!sessionFile) return fail('session_missing', `节点没有已持久化的会话文件：${request.nodeId}`)
    return this.readSessionHistory(sessionFile, request.nodeId)
  }

  /** 按文件读历史（不要求节点仍存活，画布恢复时节点尚未 create） */
  async readSessionHistory(sessionFile: string, nodeId: string): Promise<ChatResult<ChatHistoryInfo>> {
    if (!existsSync(sessionFile)) {
      return fail('session_missing', `会话文件不存在：${sessionFile}`)
    }
    let entries: unknown[]
    try {
      // 先 stat 拿大小再异步读：JSONL 里可能塞 base64 图块（单行可达数 MB、整文件数十 MB），
      // 同步全读会让主进程在画布恢复时每个节点冻结数秒
      const stats = await stat(sessionFile)
      if (stats.size > SESSION_FILE_HARD_LIMIT) {
        return fail('session_too_large', `会话文件超过 64MB，跳过加载：${sessionFile}`)
      }
      // 软顶之上启用单行过滤：正常消息/工具行远小于 512KB，超长行必是 base64 图块
      const skipOversizeLines = stats.size > SESSION_FILE_SOFT_LIMIT
      // 流式逐行读：24~64MB 的文件不再以整段字符串驻留内存。readline 迭代器对已缓冲的
      // 行会在微任务里连发（不回事件循环），故每 1000 行 setImmediate 让出一次——
      // 大文件解析期间聊天 delta / 任务事件得以穿插处理，而不是冻结主进程
      entries = []
      let skippedOversize = 0
      let lineCount = 0
      const stream = createReadStream(sessionFile, { encoding: 'utf8' })
      try {
        const lines = createLineReader({ input: stream })
        for await (const line of lines) {
          lineCount += 1
          if (lineCount % 1000 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
          // 长度过滤放在 trim 之前：超长行先跳过，省去对大字符串 trim 的复制开销
          if (skipOversizeLines && line.length >= SESSION_LINE_LIMIT) {
            skippedOversize += 1
            continue
          }
          if (!line.trim()) continue
          try {
            entries.push(JSON.parse(line) as unknown)
          } catch {
            continue // 坏行跳过，与旧实现一致：回放尽力而为
          }
        }
      } finally {
        // 正常读完时流已自然结束，destroy 是无害兜底；中途出错（文件被删/占用）时靠它
        // 释放 fd 防泄漏。错误本身经 for await 抛出，落进外层 catch 统一转 fail
        stream.destroy()
      }
      if (skippedOversize > 0) {
        console.warn(
          `[agent-host] ${sessionFile} 超过软顶（24MB），已跳过 ${skippedOversize} 条 ≥512KB 的超长行（多为 base64 图块）`
        )
      }
    } catch (error) {
      return fail('unknown', `读取会话历史失败：${describeError(error)}`)
    }
    await this.init()
    const pi = this.pi
    if (!pi) return fail('host_not_ready', `Agent 运行时未就绪，无法解析会话结构：${this.initError ?? ''}`)

    let built: BuiltHistory
    try {
      built = buildSessionHistory(entries, (list) => pi.buildContextEntries(list as never[]))
    } catch (error) {
      return fail('unknown', `解析会话历史失败：${describeError(error)}`)
    }

    // 图片缩略：槽位逐一回填；超上限或解码失败 → chip（带源路径）
    const messages = built.messages
    built.images.forEach((slot, index) => {
      const target = messages[slot.messageIndex]
      if (!target) return
      const image = index < HISTORY_IMAGE_LIMIT ? thumbnailSlot(slot) : { label: slot.label }
      if (slot.toolCallId) {
        const block = target.blocks?.find(
          (candidate) => candidate.kind === 'tool' && candidate.toolCall.id === slot.toolCallId
        )
        if (block?.kind === 'tool') (block.toolCall.images ??= []).push(image)
      } else {
        ;(target.images ??= []).push(image)
      }
    })

    return ok({ nodeId, sessionFile, messages })
  }

  /* ---------------------------------------------------------------------- */
  /* 上下文可见性域（水位 / 压缩 / 分布 / 分叉）                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * 当前上下文水位（计划 T1）。getContextUsage 原样透传：
   * tokens=null 是压缩后待下一轮响应的真实语义，UI 显示"—"而非假数字；
   * 会话没绑模型（尚未发问）时 contextWindow 也为 null。
   */
  contextUsage(nodeId: string): ChatResult<ChatContextUsage> {
    const entry = this.sessions.get(nodeId)
    if (!entry) return fail('session_missing', `节点未绑定会话：${nodeId}`)
    const usage = entry.session.getContextUsage()
    if (!usage) return ok({ tokens: null, contextWindow: null, percent: null })
    return ok({ tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent })
  }

  /**
   * 手动压缩（计划 T2）。门控在渲染端（running 时禁用）——SDK 语义是 compact 会先
   * abort 当前 agent 操作且不续跑被打断的 turn，不能放给用户误点，主进程不重复兜底。
   * 进度与结果经 compaction_start/end 事件推送，返回值只表达「指令是否受理」。
   */
  async compact(request: ChatNodeRequest): Promise<ChatResult> {
    const entry = this.sessions.get(request.nodeId)
    if (!entry) return fail('session_missing', `节点未绑定会话：${request.nodeId}`)
    try {
      await entry.session.compact(CUSTOM_COMPACTION_INSTRUCTIONS)
      console.log(`[agent-host] compact nodeId=${request.nodeId}`)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `压缩上下文失败：${describeError(error)}`)
    }
  }

  /**
   * 上下文分布明细（计划 T3）：当前分支、压缩后视图的分桶估算。
   * 估算口径见 agent/breakdown.ts；percent 与桶占比都是估算值，UI 必须注明。
   */
  contextBreakdown(nodeId: string): ChatResult<ChatContextBreakdownInfo> {
    const entry = this.sessions.get(nodeId)
    if (!entry) return fail('session_missing', `节点未绑定会话：${nodeId}`)
    const pi = this.pi
    if (!pi) return fail('host_not_ready', 'Agent 运行时未就绪')
    try {
      const usage = entry.session.getContextUsage()
      const breakdown = computeContextBreakdown(
        entry.session.sessionManager.buildContextEntries() as unknown[],
        // pi 的签名收 AgentMessage/Usage，本模块口径是 unknown（纯函数可注入）：
        // 调用点窄化，deps 保持宽松
        {
          estimateTokens: (message) => pi.estimateTokens(message as Parameters<typeof pi.estimateTokens>[0]),
          calculateContextTokens: (usage2) =>
            pi.calculateContextTokens(usage2 as Parameters<typeof pi.calculateContextTokens>[0])
        },
        usage?.contextWindow ?? null
      )
      return ok(breakdown)
    } catch (error) {
      return fail('unknown', `统计上下文分布失败：${describeError(error)}`)
    }
  }

  /**
   * 原生文件级分叉（计划 T5）：SessionManager.forkFrom 全量拷贝源 JSONL
   * （含 base64 图块与工具上下文），新文件 header 记 parentSession。
   * 源会话未发问过（无 sessionFile）→ session_missing，渲染端退回「复制空历史」。
   */
  async forkSession(
    request: ChatForkRequest,
    workspaceDir: string | null
  ): Promise<ChatResult<ChatForkResult>> {
    await this.init()
    if (!this.pi || this.initError) {
      return fail('host_not_ready', `Agent 运行时初始化失败：${this.initError ?? '尚未就绪'}`)
    }
    if (!workspaceDir) return fail('cwd_rejected', '尚未打开工作区，无法定位会话文件')
    // 与重绑同一条校验路径：文件必须位于当前工作区 .huabu/sessions/ 内且真实存在
    const resolved = resolveSessionFile(request.sessionFile, workspaceDir)
    if (!resolved.ok) return fail('session_missing', resolved.error)
    try {
      const forked = this.pi.SessionManager.forkFrom(
        resolved.sessionFile,
        workspaceDir,
        getSessionDir(workspaceDir)
      )
      const sessionFile = forked.getSessionFile()
      if (!sessionFile) return fail('unknown', '分叉完成但未取得新会话文件路径')
      console.log(`[agent-host] fork nodeId=${request.nodeId} ${resolved.sessionFile} → ${sessionFile}`)
      return ok({ nodeId: request.nodeId, sessionFile })
    } catch (error) {
      return fail('unknown', `分叉会话失败：${describeError(error)}`)
    }
  }

  /* ---------------------------------------------------------------------- */
  /* settings 域（M9）                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * 聊天 provider 清单与认证状态（设置页）。绝不返回密钥内容。
   *
   * 认证状态改由管理器直读加密存储（不再问 pi 的 `getProviderAuthStatus`）：后者读的是
   * create 时固化的快照，而 T5 之后我们不重建运行时，快照语义与本来的两步写入一起作废。
   */
  async chatProviders(workspaceDir: string): Promise<ChatResult<SettingsProvidersInfo>> {
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) {
      return ok<SettingsProvidersInfo>({
        providers: [],
        credentialsHint: ''
      })
    }
    const entry = runtimeEntry.value
    const manager = this.modelManager(entry)
    const statuses = await manager.statuses()
    const providers: ProviderAuthInfo[] = statuses.map((status) => ({
      id: status.id,
      name: status.label,
      authConfigured: status.configured,
      authSource: piAuthSource(status.authSource),
      authLabel: status.authLabel,
      modelCount: status.modelCount,
      api: status.api
    }))
    // 已配置凭据的排前面，组内保持目录顺序（目录顺序=我们希望的推荐顺序）
    providers.sort((a, b) => Number(b.authConfigured) - Number(a.authConfigured))
    return ok<SettingsProvidersInfo>({ providers, credentialsHint: entry.credentials.describe() })
  }

  /**
   * 当前会话绑定的对话模型是否支持图片输入（M13 多模态结果回传的开关，T7 也用它）。
   * 会话不存在或模型不在清单里时返回 undefined，调用方按"不支持"处理。
   *
   * 查管理器而不是 pi 的 Model 对象：能力元数据的定义权已经收回目录，
   * 运行时那份只是注册后的副本（且注册有先后窗口）。
   */
  sessionModelSupportsImages(nodeId: string): boolean | undefined {
    const session = this.sessions.get(nodeId)
    if (!session) return undefined
    const entry = this.runtimes.get(session.cwd)
    if (!entry) return undefined
    return this.modelManager(entry).find(session.modelId)?.model.input.includes('image')
  }

  /** 会话中途换模型：pi session.setModel + 登记表同步；返回换后模型与 clamp 出的实际档位 */
  async setModel(request: ChatSetModelRequest): Promise<ChatResult<ChatSetModelResult>> {
    const entry = this.sessions.get(request.nodeId)
    if (!entry) return fail('session_missing', `会话不存在：${request.nodeId}`)
    const runtimeEntry = this.runtimes.get(entry.cwd)
    if (!runtimeEntry) return fail('host_not_ready', '运行时未就绪')
    // 与 pickModel 同一条解析链：管理器校验存在性，运行时交出 pi 的 Model 对象（目录条目不是 Model）
    const picked = await this.pickModel(runtimeEntry, this.modelManager(runtimeEntry), request.modelId)
    if ('code' in picked) return fail(picked.code, picked.error)
    try {
      const previousLevel = entry.session.thinkingLevel
      await entry.session.setModel(picked.model)
      // pi 的 setModel 用「全局默认档位」覆盖会话当前档位（_getThinkingLevelForModelSwitch：
      // per-model 设置 → settingsManager.getDefaultThinkingLevel()，兜底才是当前值）——
      // 全局文件与其他 pi 系工具共用，实机出现过 max→clamp 成 high 的劫持。用户在会话里
      // 选的档位应当跟随会话：这里显式回设，setThinkingLevel 会按新模型 clamp 到最近支持档
      entry.session.setThinkingLevel(previousLevel as never)
      entry.modelId = picked.id
      return ok({
        modelId: picked.id,
        thinkingLevel: entry.session.thinkingLevel,
        thinkingLevels: entry.session.getAvailableThinkingLevels()
      })
    } catch (error) {
      return fail('unknown', `切换模型失败：${describeError(error)}`)
    }
  }

  /** 会话中途设置思考档位（pi 会按模型能力 clamp；返回实际生效档位） */
  setThinking(request: ChatSetThinkingRequest): ChatResult<ChatSetThinkingResult> {
    const entry = this.sessions.get(request.nodeId)
    if (!entry) return fail('session_missing', `会话不存在：${request.nodeId}`)
    // 非法档位（含 'off'，pi 会话层无此表达）静默落回 medium：pi 的 clamp 只折模型能力，不兜底拼错的字符串
    const level =
      request.thinkingLevel !== 'off' && (THINKING_LEVELS as readonly string[]).includes(request.thinkingLevel)
      ? request.thinkingLevel
      : 'medium'
    entry.session.setThinkingLevel(level as never)
    return ok({ thinkingLevel: entry.session.thinkingLevel })
  }

  /**
   * 覆盖层/凭据变更后重注册（T5 起这是唯一的生效路径，取代旧的 recreateRuntime）。
   *
   * 同 id 注册整体替换清单（S2 实测），所以"改了不生效"只剩一种可能：忘了调这里。
   * 活跃会话继续用它们创建时拿到的 Model 引用，新会话即用新清单——不需要重启、也不销毁凭据缓存。
   */
  async refreshModels(workspaceDir: string): Promise<ChatResult> {
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) return fail(runtimeEntry.code, runtimeEntry.error)
    try {
      await this.applyRegistrations(runtimeEntry.value)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `重新注册模型清单失败：${describeError(error)}`)
    }
  }

  /**
   * 录入 API Key：写加密存储 → 重注册。
   *
   * 旧实现还要"重建运行时"，是因为 pi 的认证快照在 create 时固化、而注册入参里的 apiKey
   * 才是权威来源；现在清单每次由管理器现算并重新注进去，重建运行时已无必要（S4 实测）。
   * 明文 Key 只在主进程内存里过一遍，日志只报 provider id。
   */
  async setApiKey(workspaceDir: string, providerId: string, apiKey: string): Promise<ChatResult> {
    const trimmed = apiKey.trim()
    if (!trimmed) return fail('unknown', 'API Key 不能为空')
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(providerId)) return fail('unknown', `providerId 不合法：${providerId}`)
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) return fail(runtimeEntry.code, runtimeEntry.error)
    try {
      await runtimeEntry.value.credentials.modify(providerId, async () => ({ type: 'api_key', key: trimmed }))
    } catch (error) {
      return fail('unknown', `保存凭据失败：${describeError(error)}`)
    }
    const refreshed = await this.refreshModels(workspaceDir)
    if (!refreshed.ok) return refreshed
    console.log(`[agent-host] setApiKey provider=${providerId}（已加密落盘并重注册，明文不进日志）`)
    return ok(undefined)
  }

  /** 删除已存凭据：同 setApiKey 的两步逻辑（写存储 → 重注册） */
  async removeApiKey(workspaceDir: string, providerId: string): Promise<ChatResult> {
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) return fail(runtimeEntry.code, runtimeEntry.error)
    try {
      await runtimeEntry.value.credentials.delete(providerId)
    } catch (error) {
      return fail('unknown', `删除凭据失败：${describeError(error)}`)
    }
    const refreshed = await this.refreshModels(workspaceDir)
    if (!refreshed.ok) return refreshed
    console.log(`[agent-host] removeApiKey provider=${providerId}`)
    return ok(undefined)
  }

  /**
   * 模型管理清单：供应商下全部模型（含被用户删除的）与编辑状态合并视图。
   * 数据源＝管理器 inventory()，"是否隐藏/是否改过"与注册用的是同一份覆盖层，不再有第二处真相。
   */
  async managedModels(
    workspaceDir: string,
    providerId: string
  ): Promise<
    ChatResult<
      Array<{
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
      }>
    >
  > {
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) return fail(runtimeEntry.code, runtimeEntry.error)
    const inventory = this.modelManager(runtimeEntry.value).inventory(providerId)
    if (!inventory) return fail('model_unavailable', `供应商不在清单里：${providerId}`)
    return ok(
      inventory.map(({ model, hidden, edited }) => ({
        id: model.id,
        name: model.label,
        source: model.source === 'user' ? ('custom' as const) : ('builtin' as const),
        hidden,
        edited,
        reasoning: model.reasoning,
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.reasoning ? { thinkingLevels: deriveThinkingLevels(model) } : {})
      }))
    )
  }

  /* ---------------------------------------------------------------------- */
  /* 媒体 provider 凭据（M11）。与聊天凭据同一加密存储，键名加 media: 前缀隔离  */
  /* ---------------------------------------------------------------------- */

  /** 读某媒体 provider 的凭据明文。只应在主进程内使用（防腐层内部），绝不进 IPC 载荷 */
  async getMediaKey(workspaceDir: string, providerId: string): Promise<string | undefined> {
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) return undefined
    const credential = await runtimeEntry.value.credentials.read(`media:${providerId}`)
    return credential?.type === 'api_key' ? credential.key : undefined
  }

  async hasMediaKey(workspaceDir: string, providerId: string): Promise<boolean> {
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) return false
    const credential = await runtimeEntry.value.credentials.read(`media:${providerId}`)
    return Boolean(credential)
  }

  async setMediaKey(workspaceDir: string, providerId: string, apiKey: string): Promise<ChatResult> {
    const trimmed = apiKey.trim()
    if (!trimmed) return fail('unknown', 'API Key 不能为空')
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(providerId)) return fail('unknown', `providerId 不合法：${providerId}`)
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) return fail(runtimeEntry.code, runtimeEntry.error)
    try {
      await runtimeEntry.value.credentials.modify(`media:${providerId}`, async () => ({
        type: 'api_key',
        key: trimmed
      }))
      console.log(`[agent-host] setMediaKey provider=${providerId}（已加密落盘）`)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `保存媒体凭据失败：${describeError(error)}`)
    }
  }

  async removeMediaKey(workspaceDir: string, providerId: string): Promise<ChatResult> {
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) return fail(runtimeEntry.code, runtimeEntry.error)
    try {
      await runtimeEntry.value.credentials.delete(`media:${providerId}`)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', `删除媒体凭据失败：${describeError(error)}`)
    }
  }

  /** 该工作区的凭据存储（供媒体编排层读取网关 Key） */
  async credentialsFor(workspaceDir: string): Promise<SafeStorageCredentialStore | null> {
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    return runtimeEntry.ok ? runtimeEntry.value.credentials : null
  }

  /**
   * provider 连通性自检：先查认证状态，再对第一个模型发一个最小请求。
   * 填错 Key 时这里给出明确错误（M9 DoD 第 5 条）。
   */
  async testProvider(workspaceDir: string, providerId: string): Promise<ChatResult<ProviderTestResult>> {
    const runtimeEntry = await this.runtimeFor(workspaceDir)
    if (!runtimeEntry.ok) return fail(runtimeEntry.code, runtimeEntry.error)
    const runtime = runtimeEntry.value.modelRuntime
    const result: ProviderTestResult = {
      providerId,
      authOk: false,
      requestOk: false,
      message: ''
    }
    try {
      const check = await runtime.checkAuth(providerId)
      if (!check) {
        result.message = '该 provider 未配置凭据。请先在设置面板录入 API Key。'
        return ok(result)
      }
      result.authOk = true
      result.authType = check.type
      result.authSource = check.source

      const models = runtime.getModels(providerId)
      if (models.length === 0) {
        result.requestOk = true
        result.message = '凭据已配置，但该 provider 没有静态模型清单，跳过最小请求。'
        return ok(result)
      }
      const model = models[0]
      // 最小请求：1 token 问候。失败的常见形态（401/429/网络）都会在 message 里给出可操作信息
      const reply = await withTimeout(
        runtime.completeSimple(model, {
          messages: [{ role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() }]
        }),
        30_000
      )
      const errorText = (reply as { errorMessage?: string } | undefined)?.errorMessage
      if (errorText) {
        result.message = `认证通过但请求失败：${errorText.slice(0, 300)}`
        return ok(result)
      }
      result.requestOk = true
      result.message = `连通正常（${model.provider}/${model.id}）`
      return ok(result)
    } catch (error) {
      result.message = `诊断失败：${describeError(error)}`
      return ok(result)
    }
  }

  async prompt(request: ChatPromptRequest): Promise<ChatResult> {
    const entry = this.sessions.get(request.nodeId)
    if (!entry) return fail('session_missing', `节点未绑定会话：${request.nodeId}`)

    const text = request.text?.trim()
    if (!text) return fail('unknown', '发问内容不能为空')

    // pi 的 prompt() 在流式期间会抛错，提前拦住，给 UI 一个明确的 busy 语义
    if (entry.session.isStreaming) {
      return fail('busy', '会话正在生成中，请先中止或等待本轮结束')
    }

    try {
      // 历史图片淘汰（执行点一，image-context-eviction-plan.md）：此刻本轮新消息尚未
      // 进入列表，历史里的图全部换成路径锚点；本轮 agentic 流程中产生的图全程真图，
      // 下一轮发问前才被淘汰。必须原地改写——整体重赋值会与 pi 内部引用脱钩
      const evicted = evictAllImages(entry.session.agent.state.messages)
      if (evicted > 0) {
        console.log(`[agent-host] 历史图片淘汰 nodeId=${entry.nodeId} evicted=${evicted}`)
      }
      // 不 await：让事件流驱动 UI。失败经 host_error + agent_end(stopReason='error') 表达
      void Promise.resolve(entry.session.prompt(text)).catch((error) => {
        console.error(`[agent-host] prompt 失败 nodeId=${entry.nodeId}：${describeError(error)}`)
        this.emit({
          nodeId: entry.nodeId,
          type: 'host_error',
          code: 'model_call_failed',
          message: describeError(error)
        })
      })
      return ok(undefined)
    } catch (error) {
      return fail('model_call_failed', describeError(error))
    }
  }

  async steer(request: ChatSteerRequest): Promise<ChatResult> {
    const entry = this.sessions.get(request.nodeId)
    if (!entry) return fail('session_missing', `节点未绑定会话：${request.nodeId}`)
    const text = request.text?.trim()
    if (!text) return fail('unknown', '插话内容不能为空')

    try {
      void Promise.resolve(entry.session.steer(text)).catch((error) => {
        console.error(`[agent-host] steer 失败 nodeId=${entry.nodeId}：${describeError(error)}`)
        this.emit({
          nodeId: entry.nodeId,
          type: 'host_error',
          code: 'unknown',
          message: describeError(error)
        })
      })
      return ok(undefined)
    } catch (error) {
      return fail('unknown', describeError(error))
    }
  }

  async abort(request: ChatNodeRequest): Promise<ChatResult> {
    const entry = this.sessions.get(request.nodeId)
    if (!entry) return fail('session_missing', `节点未绑定会话：${request.nodeId}`)
    try {
      // abort() 会等 agent 变为 idle；会话随后可继续使用（DoD 第 2 条）
      await entry.session.abort()
      console.log(`[agent-host] abort nodeId=${request.nodeId}`)
      return ok(undefined)
    } catch (error) {
      return fail('unknown', describeError(error))
    }
  }

  /**
   * 解绑并释放会话。
   *
   * 每一步都独立 try：即使 abort 或 dispose 抛错，也必须把监听器摘掉并移出注册表，
   * 否则节点已删而事件仍在往渲染进程推，形成泄漏（开发计划 M3 审查要点第 1 条）。
   */
  async dispose(request: ChatNodeRequest): Promise<ChatResult> {
    const nodeId = request.nodeId
    const entry = this.sessions.get(nodeId)
    if (!entry) {
      // 幂等：重复 dispose 不算错误，渲染端卸载时可能触发多次
      return ok(undefined)
    }
    await this.disposeEntry(entry)
    // DoD 第 5 条要求主进程日志能确认 dispose 已发生
    console.log(`[agent-host] dispose nodeId=${nodeId} 剩余会话=${this.sessions.size}`)
    return ok(undefined)
  }

  private async disposeEntry(entry: SessionEntry): Promise<void> {
    // 先移出注册表，避免释放过程中的并发调用又拿到这个 entry
    this.sessions.delete(entry.nodeId)
    if (entry.session.isStreaming) {
      try {
        await entry.session.abort()
      } catch (error) {
        console.warn(`[agent-host] dispose 时 abort 失败 nodeId=${entry.nodeId}：${describeError(error)}`)
      }
    }
    try {
      entry.unsubscribe()
    } catch (error) {
      console.warn(`[agent-host] dispose 时 unsubscribe 失败 nodeId=${entry.nodeId}：${describeError(error)}`)
    }
    try {
      entry.session.dispose()
    } catch (error) {
      console.warn(`[agent-host] dispose 时 session.dispose 失败 nodeId=${entry.nodeId}：${describeError(error)}`)
    }
  }

  /**
   * 释放某个工作区目录下的全部会话（切换工作区时调用）。
   * 返回释放数，供主进程日志与 M5 DoD 的 dispose 证据使用。
   */
  async disposeWorkspace(workspaceDir: string): Promise<number> {
    // 不能用 startsWith('workspaceDir + /') 前缀匹配：Windows 上会话 cwd 是反斜杠路径，
    // 'E:\ws\sub'.startsWith('E:\ws/') 恒为 false，子目录会话会漏释放，故走 isWithinDir
    const targets = [...this.sessions.values()].filter(
      (entry) => entry.cwd === workspaceDir || isWithinDir(workspaceDir, entry.cwd)
    )
    for (const entry of targets) {
      await this.disposeEntry(entry)
    }
    if (targets.length > 0) {
      console.log(
        `[agent-host] disposeWorkspace ${workspaceDir}：释放 ${targets.length} 个会话，剩余 ${this.sessions.size}`
      )
    }
    return targets.length
  }

  /**
   * 同步释放全部会话，供进程退出路径使用。
   *
   * 跳过 `abort()`：那是个会等 agent 变为 idle 的异步调用，
   * 而进程马上就不存在了，await 它既没意义（在飞的 HTTP 请求随进程终止而断）
   * 也做不到（will-quit 里无法阻塞等待）。这里只保证不留悬挂的事件监听器：
   * Pi 的 `unsubscribe()` 与 `session.dispose()` 都是同步的。
   * 会话内容不会丢：Pi 在 message_end 时就已经把消息写入 JSONL。
   */
  disposeAllSync(): void {
    for (const [nodeId, entry] of this.sessions) {
      try {
        entry.unsubscribe()
      } catch (error) {
        console.warn(`[agent-host] 退出清理 unsubscribe 失败 nodeId=${nodeId}：${describeError(error)}`)
      }
      try {
        entry.session.dispose()
      } catch (error) {
        console.warn(`[agent-host] 退出清理 dispose 失败 nodeId=${nodeId}：${describeError(error)}`)
      }
    }
    if (this.sessions.size > 0) {
      console.log(`[agent-host] 退出清理：已释放 ${this.sessions.size} 个会话`)
    }
    this.sessions.clear()
  }

  /** 当前活跃会话数，供自检与调试 */
  get sessionCount(): number {
    return this.sessions.size
  }
}

/** 给 Promise 加超时，诊断请求不能无限等 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * 判断 child 是否严格位于 parent 目录之内（不含 parent 自身，相等由调用方 === 兜底）。
 *
 * 为什么不用 startsWith 前缀匹配：Windows 上路径分隔符是反斜杠，
 * 'E:\ws\sub'.startsWith('E:\ws/') 恒为 false。path.relative(parent, child)
 * 在 child 越出 parent 时以 '..' 开头；Windows 跨盘符时直接返回绝对路径——
 * 这两种都视为不在其内，相等时 relative 返回 ''，同样不算"在其内"。
 *
 * win32 下先把两侧归一小写再 relative：Windows 路径大小写不敏感，
 * 而 path.win32.relative 的组件比较却是大小写敏感的（仅盘符除外），上游传入
 * 'E:\WS' 与 'E:\ws\sub' 会得到以 '..' 开头的 rel 而漏判——disposeWorkspace
 * 就会漏释放大小写漂移的子目录会话。posix 文件系统大小写敏感，保持原行为。
 */
function isWithinDir(parent: string, child: string): boolean {
  const normalize = (dir: string): string => (process.platform === 'win32' ? dir.toLowerCase() : dir)
  const rel = relative(normalize(parent), normalize(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 缩略一个图片槽位；解码失败退化为 chip（带源路径），不丢占位 */
function thumbnailSlot(slot: HistoryImageSlot): { thumbBase64: string } | { label: string } {
  const thumb = makeHistoryThumbnail(slot.data)
  return thumb ? { thumbBase64: thumb } : { label: slot.label }
}
