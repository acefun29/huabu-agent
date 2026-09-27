import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import { assetSrc } from '../lib/media'
import type { AssetData, GenerateVersion } from '../types'

/**
 * 媒体查看器：图片放大查看、视频/音频真实播放（补齐「媒体只有缩略图」的缺口）。
 * 文件经 huabu-media:// 协议流式供给（视频/音频拖进度条依赖主进程的 Range 支持）。
 */
export function MediaViewer() {
  const viewer = useCanvasStore((s) => s.viewer)
  const node = useCanvasStore((s) => (s.viewer ? (s.nodes.find((n) => n.id === s.viewer!.nodeId) ?? null) : null))
  const closeViewer = useCanvasStore.getState().closeViewer

  useEffect(() => {
    if (!viewer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeViewer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer, closeViewer])

  if (!viewer || !node) return null
  const data = node.data as AssetData
  const gen = data.gen
  const version: GenerateVersion | undefined =
    gen?.versions.find((v) => v.id === gen.activeVersionId) ?? gen?.versions[0]
  const src = version ? assetSrc(version) : assetSrc(data)
  if (!src) return null

  return (
    <div
      data-testid="media-viewer"
      onClick={closeViewer}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/70 p-8 backdrop-blur-sm"
    >
      <button
        onClick={closeViewer}
        className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white/90 transition-colors hover:bg-white/20"
        title="关闭（Esc）"
      >
        <X size={18} />
      </button>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[82vh] max-w-[86vw] flex-col items-center gap-2">
        {data.kind === 'image' && (
          <img
            data-testid="viewer-image"
            src={src}
            alt={data.name}
            className="viewer-image max-h-[74vh] max-w-[86vw] rounded-xl object-contain shadow-2xl"
          />
        )}
        {data.kind === 'video' && (
          <video
            data-testid="viewer-video"
            src={src}
            controls
            autoPlay
            className="max-h-[74vh] max-w-[86vw] rounded-xl shadow-2xl"
          />
        )}
        {data.kind === 'audio' && (
          <div className="flex w-[420px] max-w-[86vw] flex-col items-center gap-4 rounded-2xl bg-(--surface-card) px-8 py-10 shadow-2xl">
            <div className="flex h-full w-full items-end justify-center gap-1 px-2 pb-2 pt-1">
              {[0.35, 0.7, 0.5, 0.95, 0.6, 0.8, 0.42, 0.88, 0.55, 0.3, 0.72, 0.6].map((h, i) => (
                <div key={i} className="w-[4px] rounded-full bg-(--accent) opacity-60" style={{ height: `${h * 56}px` }} />
              ))}
            </div>
            <div className="text-[13px] font-medium text-(--on-surface)">{data.name}</div>
            <audio data-testid="viewer-audio" src={src} controls autoPlay className="w-full" />
          </div>
        )}
        <div className="max-w-full truncate font-mono text-[11px] text-white/60">
          {version?.path ?? data.path}
          {version?.prompt ? ` · ${version.prompt.slice(0, 60)}` : ''}
        </div>
      </div>
    </div>
  )
}
