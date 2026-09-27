import { FolderKanban, FolderOpen, Plus, Image as ImageIcon } from 'lucide-react'
import { useState } from 'react'
import { useCanvasStore } from '../store/canvasStore'

/** 工作区选择页：尚未打开任何工作区时显示（工作区 = 真实目录 = 独立画布） */
export function WorkspaceGate() {
  const recents = useCanvasStore((s) => s.recents)
  const bridgeAvailable = useCanvasStore((s) => s.bridgeAvailable)
  const { openWorkspace, openDirDialog, createWorkspace } = useCanvasStore.getState()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const submitNew = () => {
    const n = name.trim()
    if (!n) return
    void createWorkspace(n)
    setName('')
    setCreating(false)
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-8 bg-(--surface) px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <img src="./huabu-logo.svg" alt="huabu" className="brand-logo h-9 w-auto select-none" draggable={false} />
        <p className="max-w-md text-[13px] leading-relaxed text-(--on-surface-muted)">
          选择一个目录作为工作区开始。所有素材、对话与生成产物都真实存放在这个目录里，
          画布上的卡片只是它们的「图钉」——一个工作区一块独立画布。
        </p>
        {!bridgeAvailable && (
          <p className="max-w-md rounded-xl bg-(--danger)/5 px-4 py-2 text-[12px] text-(--danger)">
            未检测到本地运行时（window.huabu 不存在）：当前是纯浏览器环境，请在 Electron 窗口内使用。
          </p>
        )}
      </div>

      <div className="flex w-full max-w-md flex-col gap-2">
        {recents.length > 0 && (
          <div className="px-1 text-[10px] font-semibold tracking-wider text-(--on-surface-muted) uppercase">
            最近打开
          </div>
        )}
        {recents.map((r) => (
          <button
            key={r.path}
            onClick={() => void openWorkspace(r.path)}
            className="flex items-center gap-3 rounded-2xl bg-(--surface-card) px-4 py-3 text-left shadow-sm ring-1 ring-(--outline-soft) transition-shadow hover:shadow-md"
          >
            <FolderKanban size={16} className="shrink-0 text-(--accent)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-(--on-surface)">{r.name}</span>
              <span className="block truncate font-mono text-[10px] text-(--on-surface-muted)">{r.path}</span>
            </span>
          </button>
        ))}

        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void openDirDialog()}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-(--fab-bg) px-4 py-2.5 text-[13px] font-medium text-(--fab-text) transition-opacity hover:opacity-90"
          >
            <FolderOpen size={14} />
            打开目录…
          </button>
          <button
            onClick={() => setCreating((v) => !v)}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-(--surface-card) px-4 py-2.5 text-[13px] font-medium text-(--on-surface) ring-1 ring-(--outline-soft) transition-colors hover:bg-(--outline-soft)"
          >
            <Plus size={14} />
            新建工作区
          </button>
        </div>

        {creating && (
          <div className="mt-1 flex items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNew()
                if (e.key === 'Escape') setCreating(false)
              }}
              placeholder="工作区名称（将创建同名子目录）"
              className="min-w-0 flex-1 rounded-xl bg-(--surface-input) px-3 py-2 text-[13px] text-(--on-surface) outline-none placeholder:text-(--on-surface-muted)"
            />
            <button
              onClick={submitNew}
              className="rounded-xl bg-(--fab-bg) px-3.5 py-2 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90"
            >
              创建
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-(--on-surface-muted)">
        <ImageIcon size={11} />
        支持导入图片 / 视频 / 音频 / 文档 / 代码，一切以文件为准
      </div>
    </div>
  )
}
