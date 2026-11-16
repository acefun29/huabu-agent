/**
 * 工作区级 Mastra Memory 工厂（Phase 2：working memory + 上下文预算 + observational memory）。
 *
 * - working memory：结构化模板（计划 §8.1），pin 字段由模型经 update_working_memory 维护，
 *   system message 注入；scope=thread。
 * - 上下文预算：TokenLimiterProcessor 挂在 Agent inputProcessors（runtime.ts，按会话
 *   contextWindow 派生）。
 * - observational memory（计划 §8.2）：旧对话压缩成 observation，原文可 recall 回查。
 *   **model 矛盾的解法**：Memory 按工作区单例，但 OM 后台 Observer/Reflector 需要具体
 *   model——用动态函数形态（OM 的 model 支持函数），每次解析时读「该线程所属会话的
 *   当前 modelRef」，经同一自有 ModelGateway 构造 aiSdkLanguageModel，供应商唯一入口
 *   不变（计划 §7.7）。
 * - 压缩可观测（计划 §2-7）：config 级 onObservationStart/End + onReflectionStart/End
 *   钩子桥接为 compaction_start/compaction_end ChatEvent，按 threadId 反查 nodeId。
 */

import type { Memory } from '@mastra/memory'
import type { AgentConfig } from '@mastra/core/agent'
import type { ModelRef } from '../../models/manager'
import type { ChatEvent } from '../../../shared/ipc'
import { aiSdkLanguageModel } from './modelGateway'
import type { ModelGateway } from './modelGateway'
import { mastraStorageFor } from './storage'
import { MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import { CUSTOM_COMPACTION_INSTRUCTIONS } from '../compactionInstructions'

/** working memory 模板：pin 字段固定（模型只填值），防裁剪丢失关键状态（计划 §8.2） */
const WORKING_MEMORY_TEMPLATE = `# 工作记忆

## 当前范围
- （当前讨论的画布节点/场景，未知则写"未指定"）

## 进行中的任务
- （用户最近交办的事项与状态）

## 用户偏好
- （表达过的稳定偏好：风格、语言、称呼等）

## 当前引用
- （本轮上下文里活跃的资产引用摘要：id + 角色，不写文件内容）
`

/** OM 压缩事件桥：threadId → nodeId（runtime 注册会话时写入） */
export interface OmEventBridge {
  /** 该工作区的会话登记表：threadId → { nodeId, broadcast, modelRef, gateway } */
  lookup(threadId: string | undefined): OmSessionBinding | undefined
}

export interface OmSessionBinding {
  nodeId: string
  broadcast(event: ChatEvent): void
  /** 会话当前模型（setModel 后可变，OM 每次解析时现读） */
  modelRef(): ModelRef
  gateway: ModelGateway
}

interface WorkspaceMemoryEntry {
  memory: Promise<Memory>
  /** 会话绑定登记表（threadId → binding），OM 的 model 函数与事件钩子共用 */
  bindings: Map<string, OmSessionBinding>
  /**
   * 正在被「手动压缩」的线程（B9）。
   *
   * OM 的四个钩子拿不到触发原因（只有 thread/usage），所以钩子只能一律报
   * `reason:'threshold'`，UI 就把用户主动点的 `/compact` 误标成「自动压缩」。
   * 压缩入口在调用 observe 前置入、结束后移除，钩子据此报真实原因。
   */
  manualCompactions: Set<string>
}

const memories = new Map<string, WorkspaceMemoryEntry>()

/** 取（或创建）工作区 Memory；同工作区复用，bindings 表随 memory 一起存活 */
export function workspaceMemory(workspaceDir: string): WorkspaceMemoryEntry {
  const cached = memories.get(workspaceDir)
  if (cached) return cached
  const bindings = new Map<string, OmSessionBinding>()
  const manualCompactions = new Set<string>()
  const memory = (async () => {
    const { Memory } = await import('@mastra/memory')
    const storage = await mastraStorageFor(workspaceDir)
    return new Memory({
      storage,
      options: {
        lastMessages: 50,
        workingMemory: {
          enabled: true,
          template: WORKING_MEMORY_TEMPLATE,
          scope: 'thread',
        },
        // observational memory：阈值按目录模型上下文宽松取值（Phase 0 校准点见文档）；
        // 异步缓冲默认开启——达到 messageTokens 时缓冲 observation 立即激活（不阻塞主轮）
        observationalMemory: {
          // 动态 model：按线程所属会话的当前 modelRef 现算，走同一 ModelGateway
          model: ((ctx: { requestContext?: unknown }) =>
            resolveOmModel(bindings, ctx?.requestContext)) as unknown as AgentConfig['model'],
          observation: {
            messageTokens: 30_000,
            bufferTokens: 0.2,
            // 创作场景的压缩指令（B1 的根因）：OM 默认摘要会丢掉产物路径、提示词参数、
            // 版本决策与审美约束——那正是这个产品里最值钱的上下文。Pi 侧只把这份指令
            // 用给手动 /compact（自动压缩用 SDK 默认提示词）；这边挂在 observer/reflector
            // 的系统提示上，自动与手动都吃得到。
            instruction: CUSTOM_COMPACTION_INSTRUCTIONS,
          },
          reflection: {
            // 反思周期把既有 observation 再压缩：累计 observation 达此 token 才跑
            observationTokens: 40_000,
            instruction: CUSTOM_COMPACTION_INSTRUCTIONS,
          },
          // 压缩可观测：四类生命周期钩子 → compaction_* 事件（按 threadId 反查 nodeId）。
          // 触发原因（manual / threshold）由 manualCompactions 判定，见 B9 的说明（B9）。
          hooks: {
            onObservationStart: (info) => {
              const threadId = info?.threadId ?? ''
              const binding = bindings.get(threadId)
              binding?.broadcast({
                nodeId: binding.nodeId,
                type: 'compaction_start',
                reason: manualCompactions.has(threadId) ? 'manual' : 'threshold',
              })
            },
            onObservationEnd: (result) => {
              const threadId = result.threadId ?? ''
              const binding = bindings.get(threadId)
              if (!binding) return
              binding.broadcast({
                nodeId: binding.nodeId,
                type: 'compaction_end',
                reason: manualCompactions.has(threadId) ? 'manual' : 'threshold',
                aborted: Boolean(result.error),
                ...(result.error ? { errorMessage: result.error.message } : {}),
                // 刻意**不**发 estimatedTokensAfter（B3）：这里能拿到的只有 OM 后台
                // 观察/反思调用自身的 usage.totalTokens，而该字段的语义是「压缩后的
                // 上下文 token 数」。往一个承诺水位的字段里塞后台调用量比不给更糟——
                // 水位是给用户判断「还能聊多久」的，错数字会直接误导。
                // 真正的压缩后水位要等下一轮响应，由 context_usage 事件给出。
              })
            },
            onReflectionStart: (info) => {
              const threadId = info?.threadId ?? ''
              const binding = bindings.get(threadId)
              binding?.broadcast({
                nodeId: binding.nodeId,
                type: 'compaction_start',
                reason: manualCompactions.has(threadId) ? 'manual' : 'threshold',
              })
            },
            onReflectionEnd: (result) => {
              const threadId = result.threadId ?? ''
              const binding = bindings.get(threadId)
              if (!binding) return
              binding.broadcast({
                nodeId: binding.nodeId,
                type: 'compaction_end',
                reason: manualCompactions.has(threadId) ? 'manual' : 'threshold',
                aborted: Boolean(result.error),
                ...(result.error ? { errorMessage: result.error.message } : {}),
              })
            },
          },
        },
        // 线程标题自动生成默认关闭：渲染端会话列表仍走 sessionFile 语义（Phase 5 接管）
        generateTitle: false,
      },
    })
  })()
  const entry = { memory, bindings, manualCompactions }
  memories.set(workspaceDir, entry)
  memory.catch(() => memories.delete(workspaceDir))
  return entry
}

/**
 * 把一段 OM 调用标记为「手动压缩」（B9），结束后自动解除。
 * UI 据此把分隔条标成用户主动触发，而不是自动阈值压缩。
 */
export async function withManualCompaction<T>(
  workspaceDir: string,
  threadId: string,
  fn: () => Promise<T>
): Promise<T> {
  const entry = workspaceMemory(workspaceDir)
  entry.manualCompactions.add(threadId)
  try {
    return await fn()
  } finally {
    entry.manualCompactions.delete(threadId)
  }
}

/** OM 内部 observer agent 的身份后缀形态：`<被观测线程>-<agentId>` */
let omFallbackWarned = false

/**
 * OM 后台 model 解析（A17）。
 *
 * 历史行为：取「最近登记的会话」的模型。同工作区跨模型开会话时，A 会话的压缩会
 * 用 B 会话的模型——而 OM 的观察范围其实是 thread 级（scope=thread），这本该不成立。
 *
 * 现在先按线程精确路由：Mastra 在观测/反思时会把握察线程的 id 放进 requestContext
 * 的保留键 `MASTRA_THREAD_ID_KEY`（见 vendor 的 internal-request-context.ts），
 * model 函数能拿到它。命中就用该会话自己的模型。
 *
 * 仍有两条回落路径（如实保留，不假装已经解决）：
 * 1. 内部 observer/reflector agent 会把身份改写成 `<线程>-<agentId>`——按「最长前缀
 *    匹配的已登记线程」还原；
 * 2. 两者都没命中（例如解析发生在会话登记之前）——回落到「最近登记会话」，并打一条
 *    一次性告警，让这条限制在日志里可见而不是静默。
 */
function resolveOmModel(bindings: Map<string, OmSessionBinding>, requestContext: unknown) {
  const rawThreadId = readReservedThreadId(requestContext)
  const matched = rawThreadId ? matchOmBinding(bindings, rawThreadId) : undefined
  const chosen = matched ?? [...bindings.values()].at(-1)
  if (!chosen) {
    throw new Error('observational memory: 该工作区尚无注册会话，无法解析后台模型')
  }
  if (!matched) warnOmModelFallback(rawThreadId)
  const ref = chosen.modelRef()
  return aiSdkLanguageModel(chosen.gateway, {
    providerId: ref.provider.id,
    modelId: ref.model.id,
  })
}

/** 从 requestContext 的保留键读线程 id（duck typing：不 import vendor 内部实现） */
function readReservedThreadId(requestContext: unknown): string | undefined {
  if (!requestContext || typeof requestContext !== 'object') return undefined
  const get = (requestContext as { get?: (key: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    const value = get.call(requestContext, MASTRA_THREAD_ID_KEY)
    return typeof value === 'string' && value ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 精确命中优先；否则找「最长且以 `-` 分隔的已登记线程」还原内部 agent 身份。
 * 导出只为一个回归测试（A17 的路由规则不能悄悄退化成「永远取最近」）。
 */
export function matchOmBinding<T extends { nodeId: string }>(
  bindings: Map<string, T>,
  threadId: string
): T | undefined {
  const exact = bindings.get(threadId)
  if (exact) return exact
  let best: T | undefined
  let bestLength = 0
  for (const [key, binding] of bindings) {
    if (key.length > bestLength && threadId.startsWith(`${key}-`)) {
      best = binding
      bestLength = key.length
    }
  }
  return best
}

function warnOmModelFallback(threadId: string | undefined): void {
  if (omFallbackWarned) return
  omFallbackWarned = true
  console.warn(
    `[mastra-memory] OM 后台模型未能按线程路由（requestContext 里的 threadId=${
      threadId ?? '缺失'
    }），回落为「最近登记会话」的模型。同工作区跨模型会话并行时，压缩可能用到另一个会话的模型（A17 的已知残留限制）。`
  )
}

/** 会话登记：runtime.create 时写入（threadId→nodeId 反查 + OM 模型来源） */
export function registerOmBinding(workspaceDir: string, threadId: string, binding: OmSessionBinding): void {
  workspaceMemory(workspaceDir).bindings.set(threadId, binding)
}

export function unregisterOmBinding(workspaceDir: string, threadId: string): void {
  workspaceMemory(workspaceDir).bindings.delete(threadId)
}

/** 工作区 Memory（Phase 1 兼容入口） */
export function mastraMemoryFor(workspaceDir: string): Promise<Memory> {
  return workspaceMemory(workspaceDir).memory
}
