import { lazy, Suspense } from 'react'
import { SettingsProvider } from './store/settingsStore'
import { CanvasProvider, useCanvasStore } from './store/canvasStore'
import { TitleBar } from './components/TitleBar'
import { CanvasWorkspace } from './components/CanvasWorkspace'
import { SessionSidebar } from './components/SessionSidebar'
import { ChatPanel } from './components/ChatPanel'
import { Toast } from './components/Toast'
import { ConfirmDialog } from './components/ConfirmDialog'
import { WorkspaceGate } from './components/WorkspaceGate'
import { MediaConfigGate } from './components/MediaConfigGate'

// 重组件按需加载：均为命名导出且只在自身 store 状态开启时显示，
// lazy 化后首屏不必解析这些模块（内部 perfProbe 计数不受影响）
const SettingsPanel = lazy(() => import('./components/SettingsPanel').then((m) => ({ default: m.SettingsPanel })))
const MediaViewer = lazy(() => import('./components/MediaViewer').then((m) => ({ default: m.MediaViewer })))

/**
 * 应用根组件：设置 Provider → 画布 Provider → 自绘标题栏 + 满屏画布 + 悬浮 chrome。
 * 标题栏（窗口控制 + 工作区切换）常驻所有页面；左侧图标栏（会话/素材库/清空画布/设置）
 * 与底部对话坞都是浮层，画布属于整个工作区；未打开工作区时显示工作区选择页。
 */
/** 是否为浏览器预览（webHarness 打的标记；Electron 内不存在） */
const isWebPreview =
  typeof globalThis !== 'undefined' &&
  Boolean((globalThis as unknown as { __HUABU_WEB_PREVIEW__?: boolean }).__HUABU_WEB_PREVIEW__)

function WorkspaceBody() {
  const booted = useCanvasStore((s) => s.booted)
  const workspace = useCanvasStore((s) => s.workspace)

  if (!booted) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-(--surface)">
        <div className="flex flex-col items-center gap-3">
          <img src="./huabu-logo.svg" alt="huabu" className="brand-logo h-8 w-auto opacity-60" draggable={false} />
          <div className="text-[12px] text-(--on-surface-muted)">正在恢复上次工作区…</div>
        </div>
      </div>
    )
  }

  if (!workspace) return <WorkspaceGate />

  /**
   * 布局（原型 index-projects.html）：画布**占满整个工作区**，右侧对话栏与图标栏
   * 都是覆盖在画布之上的浮层 —— 打开/调宽对话栏不改变画布视口，卡片位置不会漂。
   *   - 对话栏：右侧，左边缘可拖拽调宽（ChatPanel 自己管宽度）
   *   - 图标栏：最右侧 48px 竖条（素材库/会话/清空/设置），浮层面板向左展开
   *
   * 定位：不用 padding 让位（absolute 子元素会相对 border box 定位而钻到标题栏底下），
   * 改成子元素各自 top-11，画布本身也用 top-11 起算。
   */
  return (
    <div className="relative h-full w-full overflow-hidden">
      <CanvasWorkspace />
      <ChatPanel />
      <SessionSidebar />
    </div>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <CanvasProvider>
        <div className="h-full w-full overflow-hidden bg-(--surface) text-(--on-surface)">
          <TitleBar />
          <WorkspaceBody />
          {/* Web 预览：媒体配置引导依赖真实 provider 数据，跳过以免误弹设置页 */}
      {isWebPreview ? null : <MediaConfigGate />}
        </div>
        {isWebPreview ? null : (
          <Suspense fallback={null}>
            <SettingsPanel />
          </Suspense>
        )}
        <ConfirmDialog />
        <Suspense fallback={null}>
          <MediaViewer />
        </Suspense>
        <Toast />
      </CanvasProvider>
    </SettingsProvider>
  )
}
