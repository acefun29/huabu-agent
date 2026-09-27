import { AlertTriangle } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'

/** 删除/清空前的确认框（应用逻辑.md：删除的确认与撤销是操作闭环的基本功） */
export function ConfirmDialog() {
  const confirm = useCanvasStore((s) => s.confirm)
  const dismissConfirm = useCanvasStore.getState().dismissConfirm
  if (!confirm) return null

  return (
    <div
      data-testid="confirm-dialog"
      onClick={dismissConfirm}
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/25 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="ctx-menu w-full max-w-md rounded-2xl bg-(--surface-card) p-5 shadow-2xl ring-1 ring-(--outline)"
      >
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              confirm.danger ? 'bg-(--danger)/10 text-(--danger)' : 'bg-(--active-tint) text-(--accent)'
            }`}
          >
            <AlertTriangle size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-(--on-surface)">{confirm.title}</div>
            <div className="mt-1.5 text-[12px] leading-relaxed text-(--on-surface-muted)">{confirm.body}</div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={dismissConfirm}
            className="rounded-full bg-(--surface-chip) px-4 py-1.5 text-[12px] font-medium text-(--on-surface) transition-colors hover:bg-(--surface-hover)"
          >
            取消
          </button>
          <button
            data-testid="confirm-accept"
            onClick={() => {
              confirm.onConfirm()
              dismissConfirm()
            }}
            className={`rounded-full px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 ${
              confirm.danger ? 'bg-(--danger)' : 'bg-(--accent)'
            }`}
          >
            {confirm.confirmLabel ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
