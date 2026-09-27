import { lazy, Suspense } from 'react'
import { SettingsProvider } from './store/settingsStore'
import { CanvasProvider, useCanvasStore } from './store/canvasStore'
import { TitleBar } from './components/TitleBar'
import { CanvasWorkspace } from './components/CanvasWorkspace'
import { SessionSidebar } from './components/SessionSidebar'
import { ChatDock } from './components/ChatDock'
import { Toast } from './components/Toast'
import { ConfirmDialog } from './components/ConfirmDialog'
import { WorkspaceGate } from './components/WorkspaceGate'

// 重组件按需加载：均为命名导出且只在自身 store 状态开启时显示，
// lazy 化后首屏不必解析这些模块（内部 perfProbe 计数不受影响）
const GuideTour = lazy(() => import('./components/GuideTour').then((m) => ({ default: m.GuideTour })))
const SettingsPanel = lazy(() => import('./components/SettingsPanel').then((m) => ({ default: m.SettingsPanel })))
const MediaViewer = lazy(() => import('./components/MediaViewer').then((m) => ({ default: m.MediaViewer })))

/**
 * 应用根组件：设置 Provider → 画布 Provider → 自绘标题栏 + 满屏画布 + 悬浮 chrome。
 * 标题栏（窗口控制 + 工作区切换）常驻所有页面；左侧图标栏（会话/素材库/清空画布/设置）
 * 与底部对话坞都是浮层，画布属于整个工作区；未打开工作区时显示工作区选择页。
 * 分步演示的入口收在 设置 → 使用引导。
 */
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

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* 画布整体让出自绘标题栏的高度，画布内部几何（框选/拖拽）按容器实测计算 */}
      <div className="absolute inset-x-0 bottom-0 top-11">
        <CanvasWorkspace />
      </div>
      <SessionSidebar />
      <ChatDock />
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
          <Suspense fallback={null}>
            <GuideTour />
          </Suspense>
        </div>
        <Suspense fallback={null}>
          <SettingsPanel />
        </Suspense>
        <ConfirmDialog />
        <Suspense fallback={null}>
          <MediaViewer />
        </Suspense>
        <Toast />
      </CanvasProvider>
    </SettingsProvider>
  )
}
