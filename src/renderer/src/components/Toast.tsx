import { useCanvasStore } from '../store/canvasStore'

/** 轻提示条：导入 / 提交生成 / 生成完成 / 拦截重复提交等反馈，可带撤销动作 */
export function Toast() {
  const toast = useCanvasStore((s) => s.toast)
  if (!toast) return null
  return (
    <div className="ctx-menu pointer-events-auto fixed bottom-28 left-1/2 z-50 flex max-w-[76vw] -translate-x-1/2 items-center gap-2 rounded-full bg-(--fab-bg) px-4 py-2 text-[12px] text-(--fab-text) shadow-lg">
      <span className="truncate">{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button
          onClick={() => {
            toast.onAction?.()
          }}
          className="shrink-0 rounded-full bg-white/15 px-2.5 py-0.5 font-medium transition-colors hover:bg-white/25"
        >
          {toast.actionLabel}
        </button>
      )}
    </div>
  )
}
