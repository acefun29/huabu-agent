import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

/**
 * 自绘标题栏：frame:false 之后替代 Windows 原生标题栏。
 * 整条是拖拽区（.titlebar-drag，双击最大化/还原由系统处理），
 * 左侧承载原 TopBar 的 logo 与工作区切换，右侧是窗口控制按钮；
 * 观感走 --chrome-bg 令牌 + 底部 --outline 细分隔线，不带投影，深浅主题自动跟随。
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    void window.huabu.window.isMaximized().then((value) => {
      if (alive) setMaximized(value)
    })
    return window.huabu.window.onStateChange((state) => setMaximized(state.maximized))
  }, [])

  const winBtn =
    'titlebar-nodrag flex h-8 w-10 items-center justify-center rounded-lg text-(--on-surface-variant) transition-colors'

  return (
    <header className="titlebar-drag fixed inset-x-0 top-0 z-[80] flex h-11 shrink-0 items-center border-b border-(--outline) bg-(--chrome-bg)">
      <div data-tour="topbar" className="flex min-w-0 items-center gap-3 px-3">
        <img
          src="./huabu-logo.svg"
          alt="huabu"
          draggable={false}
          className="titlebar-nodrag brand-logo h-[22px] w-auto shrink-0 select-none"
        />
        <div className="titlebar-nodrag min-w-0">
          <WorkspaceSwitcher />
        </div>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-0.5 pr-2">
        <button
          type="button"
          aria-label="最小化"
          className={`${winBtn} hover:bg-(--surface-hover) hover:text-(--on-surface)`}
          onClick={() => void window.huabu.window.minimize()}
        >
          <Minus size={15} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label={maximized ? '还原' : '最大化'}
          className={`${winBtn} hover:bg-(--surface-hover) hover:text-(--on-surface)`}
          onClick={() => void window.huabu.window.toggleMaximize()}
        >
          {maximized ? <Copy size={12} strokeWidth={1.75} /> : <Square size={12} strokeWidth={1.75} />}
        </button>
        <button
          type="button"
          aria-label="关闭"
          className={`${winBtn} hover:bg-(--danger) hover:text-(--surface-card)`}
          onClick={() => void window.huabu.window.close()}
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  )
}
