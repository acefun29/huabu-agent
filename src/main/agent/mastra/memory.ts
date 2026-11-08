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
}

const memories = new Map<string, WorkspaceMemoryEntry>()

/** 取（或创建）工作区 Memory；同工作区复用，bindings 表随 memory 一起存活 */
export function workspaceMemory(workspaceDir: string): WorkspaceMemoryEntry {
  const cached = memories.get(workspaceDir)
  if (cached) return cached
  const bindings = new Map<string, OmSessionBinding>()
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
          model: ((ctx: { requestContext?: unknown }) => {
            void ctx
            return resolveOmModel(bindings)
          }) as unknown as AgentConfig['model'],
          observation: {
            messageTokens: 30_000,
            bufferTokens: 0.2,
          },
          reflection: {
            // 反思周期把既有 observation 再压缩：累计 observation 达此 token 才跑
            observationTokens: 40_000,
          },
          // 压缩可观测：四类生命周期钩子 → compaction_* 事件（按 threadId 反查 nodeId）
          hooks: {
            onObservationStart: (info) => {
              const binding = bindings.get(info?.threadId ?? '')
              binding?.broadcast({
                nodeId: binding.nodeId,
                type: 'compaction_start',
                reason: 'threshold',
              })
            },
            onObservationEnd: (result) => {
              const binding = bindings.get(result.threadId ?? '')
              if (!binding) return
              binding.broadcast({
                nodeId: binding.nodeId,
                type: 'compaction_end',
                reason: 'threshold',
                aborted: Boolean(result.error),
                ...(result.error ? { errorMessage: result.error.message } : {}),
                ...(result.usage?.totalTokens
                  ? { estimatedTokensAfter: result.usage.totalTokens }
                  : {}),
              })
            },
            onReflectionStart: (info) => {
              const binding = bindings.get(info?.threadId ?? '')
              binding?.broadcast({
                nodeId: binding.nodeId,
                type: 'compaction_start',
                reason: 'threshold',
              })
            },
            onReflectionEnd: (result) => {
              const binding = bindings.get(result.threadId ?? '')
              if (!binding) return
              binding.broadcast({
                nodeId: binding.nodeId,
                type: 'compaction_end',
                reason: 'threshold',
                aborted: Boolean(result.error),
                ...(result.error ? { errorMessage: result.error.message } : {}),
                ...(result.usage?.totalTokens
                  ? { estimatedTokensAfter: result.usage.totalTokens }
                  : {}),
              })
            },
          },
        },
        // 线程标题自动生成默认关闭：渲染端会话列表仍走 sessionFile 语义（Phase 5 接管）
        generateTitle: false,
      },
    })
  })()
  const entry = { memory, bindings }
  memories.set(workspaceDir, entry)
  memory.catch(() => memories.delete(workspaceDir))
  return entry
}

/**
 * OM 后台 model 解析：取「最近登记且仍活跃」的会话绑定，构造网关模型。
 * 同工作区多会话并行时，OM 的观察范围是 thread 级（scope=thread），但 OM model
 * 是 Memory 构造级单值——按线程查找需要 threadId，OM 的 model 函数上下文只给
 * requestContext（不含 threadId）。因此退化为「该工作区最近创建的会话模型」：
 * 同工作区会话通常同模型，跨模型时以最近会话为准（Phase 2 记录为已知限制）。
 */
function resolveOmModel(bindings: Map<string, OmSessionBinding>) {
  const latest = [...bindings.values()].at(-1)
  if (!latest) {
    throw new Error('observational memory: 该工作区尚无注册会话，无法解析后台模型')
  }
  const ref = latest.modelRef()
  return aiSdkLanguageModel(latest.gateway, {
    providerId: ref.provider.id,
    modelId: ref.model.id,
  })
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
