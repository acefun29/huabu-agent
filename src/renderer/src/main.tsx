import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installPerfProbe } from './lib/perfProbe'
import './index.css'

// DEV 下挂 window.__huabuPerf（bench 脚本用）；生产构建内部直接返回
installPerfProbe()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
