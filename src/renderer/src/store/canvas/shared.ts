import type {
  CanvasNode,
  MediaKind
} from '../../types'
import { isAgentAvailable } from '../../lib/agent'
import type { useSettings } from '../settingsStore'

/**
 * 画布四域（会话/节点/生成任务/素材库）之间的共享常量、纯函数与模块级可变状态。
 *
 * 拆分约定（T8）：域实现放同目录的 chatRuntime / jobRuntime / nodeOps / libraryOps，
 * 各域经显式 deps 注入拿 store 的 set/get 与内部工具；**只有这里允许放跨域可变量**
 —— 之前散在 store 顶层的 ref 群（旧 Provider 时代）集中收拢，谁在用一目了然。
 */

/** 内置「画布素材」合成库的固定 id（主进程 listLibraries 用同名值；落库链做 kind 映射） */
export const BUILTIN_LIBRARY = 'builtin-assets'

export const MEDIA_EXT: Record<MediaKind, string> = { image: 'png', video: 'mp4', audio: 'mp3' }
export const MEDIA_LABEL: Record<MediaKind, string> = { image: '图片', video: '视频', audio: '音频' }

/** 拖拽载荷 MIME：素材库文件 → 画布 = 钉一张引用卡片 */
export const LIBRARY_ASSET_MIME = 'application/x-huabu-library-asset'
/** 拖拽载荷 MIME：画布卡片 → 会话输入框 = 批量引用（JSON id 数组；会话侧只把绝对路径传给 Agent） */
export const ASSET_IDS_MIME = 'application/x-huabu-assets'
/** 遗留单卡通道（载荷 = 节点 id 字符串）：仍被生成卡加参考、输入框单卡注入消费，勿新增使用 */
export const LEGACY_ASSET_MIME = 'application/x-huabu-asset'

/** 纯浏览器打开 dev server（无 window.huabu）时的提示 */
export const BRIDGE_UNAVAILABLE = 'IPC 未联通：请在 Electron 窗口内使用（浏览器里没有 Agent 运行时）'

export const BRIDGE_AVAILABLE = isAgentAvailable()

/** settings 仍是 Context：由 CanvasProvider 每次渲染把最新实例写进来，供 store action 跨域调用 */
export type SettingsApi = ReturnType<typeof useSettings>
export const settingsBridgeRef: { current: SettingsApi | null } = { current: null }

/** 画布空白处的默认落点（新节点按画布节点数错开） */
export function spawnOffset(nodes: CanvasNode[]): number {
  return (nodes.length % 6) * 28
}

export function newNodeId(): string {
  return crypto.randomUUID()
}

/** 全局 z 序计数器：任何新建/置顶/撤销都从它取层，保证新卡片永远在最上 */
export const zCounter = { current: 10 }

/** jobId → 卡片 nodeId（只有仍在跑的任务，其卡片才持有 jobId） */
export function buildJobCardIndex(nodes: CanvasNode[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const node of nodes) {
    const jobId = node.data.gen?.jobId
    if (jobId) index.set(jobId, node.id)
  }
  return index
}

/**
 * jobId → 承接卡片的 nodeId。媒体事件去重的同步事实源：
 * zustand 的 set 同步执行，patchGenByJob 的 handled 标志立即生效；
 * 索引仍在（scan 结果可能滞后于状态提交，索引命中同样算「已有卡片承接」）。
 */
export const jobCardIndex = new Map<string, string>()

/** 事件里的工具参数类型守卫（write 工具钉产物卡片用） */
export function toolArgString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
