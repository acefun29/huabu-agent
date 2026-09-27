import type {
  ChatCreateInfo,
  ChatErrorCode,
  ChatEvent
} from '../../../shared/ipc'

/**
 * 会话桥：渲染端与主进程 AgentHost 之间的唯一通信封装。
 *
 * M1 版本是一段假流式占位（用于在没有 Agent 的情况下验证 UI 路径），M3 起换成真实 IPC。
 * 本文件只做通信与生命周期，**不做任何状态归约** —— 事件到消息列表的转换在
 * lib/chatStream.ts 里，那里是纯函数，便于单独排查。
 *
 * 一个 ChatBridge 对应一个画布节点（即一个 Pi 会话）。
 */

/** window.huabu 是否存在。纯浏览器打开 dev server 时为 false，此时会话能力整体降级 */
export function isAgentAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.huabu?.chat)
}

export interface ChatBridgeOptions {
  nodeId: string
  /** 主进程推来的事件，已按 nodeId 过滤 */
  onEvent: (event: ChatEvent) => void
  /** 会话创建成功后回传实际选中的模型与工作目录 */
  onBound?: (info: ChatCreateInfo) => void
  /** 请求被主进程拒绝（ChatResult.ok === false） */
  onFailure?: (code: ChatErrorCode, message: string) => void
}

export class ChatBridge {
  private created = false
  private creating: Promise<boolean> | null = null
  private readonly unsubscribe: (() => void) | null

  constructor(private readonly options: ChatBridgeOptions) {
    // 订阅放在构造期而不是首次发问时：会话可能在 UI 就绪前就有事件（例如恢复历史）
    this.unsubscribe = isAgentAvailable()
      ? window.huabu.chat.onChatEvent(options.nodeId, (event) => options.onEvent(event))
      : null
  }

  private reject(action: string): boolean {
    if (!isAgentAvailable()) {
      this.options.onFailure?.(
        'host_not_ready',
        `${action} 失败：当前环境没有 Agent 运行时（window.huabu 不存在）。请在 Electron 窗口内使用，而不是浏览器。`
      )
      return false
    }
    return true
  }

  /**
   * 惰性创建会话：首次发问时才在主进程构造 Pi 会话。
   *
   * 不在节点 mount 时创建，因为用户可能建了一排节点却只跟其中一个说话，
   * 而每个会话都会占用一个 SessionManager 与一份 JSONL 文件。
   * 并发调用共享同一个 promise，避免重复创建被主进程以 session_exists 拒绝。
   *
   * `sessionFile`（M5 扩展）：画布恢复时传入已有 JSONL 文件重绑历史会话，
   * 主进程会校验路径必须位于当前工作区 .huabu/sessions/ 内。
   *
   * `thinkingLevel`：初始思考档位（THINKING_LEVELS 之一），随 create 请求生效，
   * pi 按模型能力 clamp 后经 onBound 回传实际值。
   */
  ensureCreated(modelId?: string, sessionFile?: string, thinkingLevel?: string): Promise<boolean> {
    if (this.created) return Promise.resolve(true)
    if (this.creating) return this.creating
    if (!isAgentAvailable()) {
      this.reject('创建会话')
      return Promise.resolve(false)
    }

    this.creating = window.huabu.chat
      .create({
        nodeId: this.options.nodeId,
        ...(modelId ? { modelId } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {})
      })
      .then((result) => {
        if (!result.ok) {
          this.options.onFailure?.(result.code, result.error)
          return false
        }
        this.created = true
        this.options.onBound?.(result.value)
        return true
      })
      .catch((error: unknown) => {
        this.options.onFailure?.('unknown', `创建会话时发生异常：${String(error)}`)
        return false
      })
      .finally(() => {
        this.creating = null
      })

    return this.creating
  }

  /**
   * 发问。
   *
   * 返回 true 只表示主进程已受理；真实结果一律通过 onEvent 表达
   * （模型调用失败会以 stopReason='error' + errorMessage 的定稿消息回来，而不是让这里 reject）。
   */
  async send(text: string): Promise<boolean> {
    if (!this.reject('发问')) return false
    const ready = await this.ensureCreated()
    if (!ready) return false

    try {
      const result = await window.huabu.chat.prompt({
        nodeId: this.options.nodeId,
        text
      })
      if (!result.ok) {
        this.options.onFailure?.(result.code, result.error)
        return false
      }
      return true
    } catch (error) {
      this.options.onFailure?.('unknown', `发问时发生异常：${String(error)}`)
      return false
    }
  }

  /** 生成中插话引导（DoD 第 7 条）。不打断当前流，会在下一次模型调用前生效 */
  async steer(text: string): Promise<boolean> {
    if (!this.reject('插话')) return false
    try {
      const result = await window.huabu.chat.steer({ nodeId: this.options.nodeId, text })
      if (!result.ok) {
        this.options.onFailure?.(result.code, result.error)
        return false
      }
      return true
    } catch (error) {
      this.options.onFailure?.('unknown', `插话时发生异常：${String(error)}`)
      return false
    }
  }

  /** 中止当前生成；会话随后可继续使用 */
  async stop(): Promise<void> {
    if (!isAgentAvailable() || !this.created) return
    try {
      await window.huabu.chat.abort({ nodeId: this.options.nodeId })
    } catch (error) {
      this.options.onFailure?.('unknown', `中止时发生异常：${String(error)}`)
    }
  }

  /**
   * 手动压缩上下文（T2）。调用方负责 running 门控（SDK 会先 abort 且不续跑被打断
   * 的 turn）；这里补一道「会话从未创建」的拦截。压缩进度经 compaction_start/end
   * 事件回到 onEvent，返回值只表达指令是否被受理。
   */
  async compact(): Promise<boolean> {
    if (!isAgentAvailable()) {
      this.options.onFailure?.('host_not_ready', '压缩失败：当前环境没有 Agent 运行时。')
      return false
    }
    if (!this.created) {
      this.options.onFailure?.('session_missing', '会话尚未开始对话，无需压缩。')
      return false
    }
    try {
      const result = await window.huabu.chat.compact({ nodeId: this.options.nodeId })
      if (!result.ok) {
        this.options.onFailure?.(result.code, result.error)
        return false
      }
      return true
    } catch (error) {
      this.options.onFailure?.('unknown', `压缩时发生异常：${String(error)}`)
      return false
    }
  }

  /** 会话中途换模型；返回 null = 调用失败（onFailure 已回调） */
  async setModel(modelId: string): Promise<{ modelId: string; thinkingLevel: string; thinkingLevels: string[] } | null> {
    if (!this.reject('切换模型') || !this.created) return null
    try {
      const result = await window.huabu.chat.setModel({ nodeId: this.options.nodeId, modelId })
      if (!result.ok) {
        this.options.onFailure?.(result.code, result.error)
        return null
      }
      return result.value
    } catch (error) {
      this.options.onFailure?.('unknown', `切换模型时发生异常：${String(error)}`)
      return null
    }
  }

  /** 会话中途设置思考档位；返回 clamp 后实际档位，null = 失败 */
  async setThinking(thinkingLevel: string): Promise<string | null> {
    if (!this.reject('设置思考档位') || !this.created) return null
    try {
      const result = await window.huabu.chat.setThinking({ nodeId: this.options.nodeId, thinkingLevel })
      if (!result.ok) {
        this.options.onFailure?.(result.code, result.error)
        return null
      }
      return result.value.thinkingLevel
    } catch (error) {
      this.options.onFailure?.('unknown', `设置思考档位时发生异常：${String(error)}`)
      return null
    }
  }

  /**
   * 释放：取消事件订阅并通知主进程 dispose。
   *
   * 节点卸载时必须调用，否则主进程仍持有 Pi 会话、事件继续往已销毁的组件推
   * （开发计划 M3 审查要点第 1 条：抽查生命周期无泄漏路径）。
   * 通知主进程是 fire-and-forget：组件已经在卸载，等不到也不该等结果。
   */
  dispose(): void {
    this.unsubscribe?.()
    if (!isAgentAvailable() || !this.created) return
    this.created = false
    void window.huabu.chat
      .dispose({ nodeId: this.options.nodeId })
      .catch((error: unknown) => {
        console.warn('[chat-bridge] 通知主进程释放会话失败', error)
      })
  }
}
