import React from 'react'
import ReactDOM from 'react-dom/client'
// Web 预览：必须在 App（及其 store）之前导入——store 在模块求值时读 window.huabu。
import './webHarness'
import App from './App'
import { installPerfProbe } from './lib/perfProbe'
import './index.css'

// DEV 下挂 window.__huabuPerf（bench 脚本用）；生产构建内部直接返回
installPerfProbe()

// Web 预览下把渲染异常显示出来（否则 React 吞错后页面一片空白，难以排查）
class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error): void {
    console.error('[render-error]', error)
  }
  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <pre style={{ padding: 16, color: '#b3261e', font: '12px/1.5 ui-monospace', whiteSpace: 'pre-wrap' }}>
          {'渲染失败：' + this.state.error.message + String.fromCharCode(10, 10) + (this.state.error.stack ?? '')}
        </pre>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)
