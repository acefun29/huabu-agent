import { lazy, Suspense, useEffect, useState } from 'react'
import { SettingsProvider } from './store/settingsStore'
import { CanvasProvider, useCanvasStore } from './store/canvasStore'
import { TitleBar } from './components/TitleBar'
import { CanvasWorkspace } from './components/CanvasWorkspace'
import { SessionSidebar } from './components/SessionSidebar'
import { ChatPanel, type RightPage } from './components/ChatPanel'
import { Toast } from './components/Toast'
import { ConfirmDialog } from './components/ConfirmDialog'
import { useFacetSchemaUi } from './store/facetSchemaUi'
import { WorkspaceGate } from './components/WorkspaceGate'
import { MediaConfigGate } from './components/MediaConfigGate'

// 重组件按需加载：均为命名导出且只在自身 store 状态开启时显示，
// lazy 化后首屏不必解析这些模块（内部 perfProbe 计数不受影响）
const SettingsPanel = lazy(() => import('./components/SettingsPanel').then((m) => ({ default: m.SettingsPanel })))
const MediaViewer = lazy(() => import('./components/MediaViewer').then((m) => ({ default: m.MediaViewer })))
const FacetSchemaEditor = lazy(() =>
  import('./components/canvas/FacetSchemaEditor').then((m) => ({ default: m.FacetSchemaEditor }))
)

/**
 * 应用根组件：设置 Provider → 画布 Provider → 自绘标题栏 + 满屏画布 + 悬浮 chrome。
 * 标题栏（窗口控制 + 工作区切换）常驻所有页面；右侧面板（对话 / 素材库两个互斥页面）
 * 与最右侧图标栏都是浮层，画布属于整个工作区；未打开工作区时显示工作区选择页。
 */
/** 是否为浏览器预览（webHarness 打的标记；Electron 内不存在） */
const isWebPreview =
  typeof globalThis !== 'undefined' &&
  Boolean((globalThis as unknown as { __HUABU_WEB_PREVIEW__?: boolean }).__HUABU_WEB_PREVIEW__)

function WorkspaceBody() {
  const booted = useCanvasStore((s) => s.booted)
  const workspace = useCanvasStore((s) => s.workspace)
  /** 右侧栏当前页（对话 / 素材库，互斥，原型 .right-page）；记在 localStorage */
  const [rightPage, setRightPage] = useState<RightPage>(() => {
    try {
      return localStorage.getItem('huabu.rightPage') === 'library' ? 'library' : 'chat'
    } catch {
      return 'chat'
    }
  })
  /** 右侧栏收起态（原型 right-collapsed）：图标栏再点当前页 = 收起，画布全宽 */
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem('huabu.rightPage', rightPage)
    } catch {
      // 隐私模式：本次会话有效即可
    }
  }, [rightPage])

  /** 图标栏点击：同页 = 开合切换，异页 = 切页并展开（原型 toggleRightPage） */
  const onPageChange = (next: RightPage): void => {
    if (next === rightPage) {
      setCollapsed((v) => !v)
      return
    }
    setRightPage(next)
    setCollapsed(false)
  }

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
   * 布局（原型 index-projects.html）：画布**占满整个工作区**，右侧面板与图标栏
   * 都是覆盖在画布之上的浮层 —— 切换/调宽右侧栏不改变画布视口，卡片位置不会漂。
   *   - 右侧面板：对话 / 素材库两个互斥页面，左边缘可拖拽调宽；点图标栏当前页可收起
   *   - 图标栏：最右侧 48px 通栏，切换页面 + 清空画布 + 设置
   *
   * 定位：容器不用 padding 让位（absolute 子元素会相对 border box 定位而钻到
   * 标题栏底下），改成各子元素自己 top-11。
   */
  return (
    <div className="relative h-full w-full overflow-hidden">
      <CanvasWorkspace />
      <ChatPanel page={rightPage} collapsed={collapsed} />
      <SessionSidebar page={rightPage} collapsed={collapsed} onPageChange={onPageChange} />
    </div>
  )
}

/** 分级结构编辑弹窗的挂载点：面板内的滚动容器会裁切弹窗，所以放在根节点 */
function FacetSchemaEditorHost() {
  const editor = useFacetSchemaUi((s) => s.editor)
  if (!editor) return null
  return (
    <Suspense fallback={null}>
      <FacetSchemaEditor
        schema={editor.schema}
        onClose={() => useFacetSchemaUi.getState().closeEditor()}
      />
    </Suspense>
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
        <FacetSchemaEditorHost />
        <Suspense fallback={null}>
          <MediaViewer />
        </Suspense>
        <Toast />
      </CanvasProvider>
    </SettingsProvider>
  )
}
