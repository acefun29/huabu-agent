import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  Check,
  Cpu,
  FileCode,
  FileText,
  FolderOpen,
  History,
  Image as ImageIcon,
  Library as LibraryIcon,
  Loader2,
  Maximize2,
  Paperclip,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  StickyNote,
  Tag as TagIcon,
  Timer,
  Video,
  X,
  AudioLines,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { useCanvasStore } from '../store/canvasStore'
import { useSettings } from '../store/settingsStore'
import { ASSET_IDS_MIME, MEDIA_LABEL } from '../store/canvasStore'
import { bumpRender } from '../lib/perfProbe'
import { CARD_THUMB_SIZE, assetSrc, formatBytes } from '../lib/media'
import { KIND_LABEL, type AssetData, type AssetKind, type CanvasNode, type GenerateVersion, type MediaKind } from '../types'
import {
  DEFAULT_MEDIA_DURATION_S,
  MEDIA_RATIOS,
  MEDIA_ROLE_KIND,
  normalizeMediaCaps
} from '@shared/media'
import type { MediaRefRole } from '@shared/media'
import { shortModelLabel } from '@shared/mediaResolve'
import { ChipSelect, MenuGroup, MenuItem, MenuNote } from './Dropdown'
import { Collapse } from './Collapse'
import { MediaConnectionHandle } from './canvas/MediaConnectionHandle'
import {
  ChainControls,
  MediaReferenceInputs,
  VersionDetailPanel,
  hasReferenceDrag,
  parseReferencePayload
} from './canvas/MediaReferenceInputs'

/** 模型未声明能力时的兜底选项（目录里的模型都带 capabilities，这份只为用户自建模型兜底） */
const FALLBACK_DURATIONS = [3, 5, 10, 15]

/** 比例的图形符号：按真实宽高比画一个小方框，比纯文字更快辨认 */
function RatioGlyph({ ratio, size = 14 }: { ratio: string; size?: number }) {
  const [w, h] = ratio.split(':').map(Number)
  const long = Math.max(w, h)
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <span
        className="rounded-[2px] border-[1.5px] border-current"
        style={{ width: (size * w) / long, height: (size * h) / long }}
      />
    </span>
  )
}

/** 模型复合 id（provider:model）去掉供应商前缀（分组标题已经写了供应商） */
function shortModelId(composite: string) {
  const parts = composite.split(':')
  return parts.length > 1 ? parts.slice(1).join(':') : composite
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  idle: { label: '待生成', cls: 'bg-(--surface-chip) text-(--on-surface-variant)' },
  queued: { label: '排队中', cls: 'bg-(--surface-chip) text-(--on-surface-variant)' },
  running: { label: '生成中', cls: 'bg-(--active-tint) text-(--accent)' },
  succeeded: { label: '已完成', cls: 'bg-(--success-bg) text-(--success-text)' },
  failed: { label: '失败', cls: 'bg-(--surface-chip) text-(--danger)' },
}

export function kindIcon(kind: AssetKind, size = 13) {
  if (kind === 'image') return <ImageIcon size={size} />
  if (kind === 'video') return <Video size={size} />
  if (kind === 'audio') return <AudioLines size={size} />
  if (kind === 'doc') return <FileText size={size} />
  return <FileCode size={size} />
}

/**
 * 文件卡片：工作目录内真实文件的引用，按 kind（图片/视频/音频/文档/代码/其他）呈现。
 * 带 gen 状态时同时是媒体生成的执行单元（生成中/有生成历史），点击它进入生成模式。
 */
export const AssetNode = memo(function AssetNode({ node }: { node: CanvasNode }) {
  bumpRender('node')
  const data = node.data as AssetData
  return data.gen ? <GeneratingAssetCard node={node} data={data} /> : <PlainAssetCard node={node} data={data} />
})

/**
 * 引用拖拽句柄：按住可拖到两处——生成卡片上加为参考（垫图 / 首帧），底部输入框注入上下文。
 * 图标用回形针（与 Composer 附件按钮同款）而不是 grip 六点：grip 读作"画布内平移"，
 * 回形针才读作"把这张卡片作为附件/引用挂过去"。
 * 已有多项选中时整批拖走（ASSET_IDS_MIME），输入框收到后把全部选中项引用进会话（只传绝对路径）。
 */
function ContextDragHandle({
  nodeId,
  batchIds,
  title,
}: {
  nodeId: string
  batchIds?: string[]
  title: string
}) {
  return (
    <div
      draggable
      data-testid="context-drag-handle"
      onDragStart={(e) => {
        e.stopPropagation()
        // 单卡拖拽保留旧 MIME（生成卡片参考等目标仍在用）
        e.dataTransfer.setData('application/x-huabu-asset', nodeId)
        if (batchIds && batchIds.length > 0) {
          e.dataTransfer.setData(ASSET_IDS_MIME, JSON.stringify(batchIds))
        }
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onClick={(e) => e.stopPropagation()}
      className="cursor-grab rounded-full bg-(--glass) p-1.5 text-(--on-surface-variant) shadow-sm backdrop-blur transition-colors hover:bg-(--surface-card)"
      title={title}
    >
      <Paperclip size={12} />
    </div>
  )
}

/** 在文件管理器中显示工作区内的文件 */
function revealInFileManager(relPath: string, showToast: (m: string) => void): void {
  if (!window.huabu?.workspace) {
    showToast('当前环境不支持打开文件管理器')
    return
  }
  void window.huabu.workspace.reveal(relPath).then((result) => {
    showToast(result.ok ? `已在文件管理器中显示 ${relPath}` : `打开失败：${result.error}`)
  })
}

/** md/txt（笔记）或 code 文档卡才读文本；media 形态产物与外部文件不在此列 */
function isTextDoc(data: AssetData): boolean {
  return (
    (data.kind === 'doc' || data.kind === 'code') &&
    data.storage === 'ws' &&
    Boolean(data.path)
  )
}

/** md/txt 笔记卡（可编辑保存）；code 只读展示 */
function isEditableDoc(data: AssetData): boolean {
  return data.kind === 'doc' && /\.(md|txt)$/i.test(data.name) && isTextDoc(data)
}

/**
 * 文档卡的文本内容（懒加载一次，随 path 变化重读；nonce 供保存成功后强制刷新）。
 * 读 workspace:read-file（主进程有白名单与 512KB 截断）；失败静默回退骨架预览。
 */
function useDocText(data: AssetData, nonce = 0): string | null {
  const want = isTextDoc(data)
  const [text, setText] = useState<string | null>(null)
  const lastPath = useRef<string | null>(null)
  useEffect(() => {
    if (!want || !data.path || !window.huabu?.workspace) return
    let alive = true
    // 换文件才清空回骨架；nonce 刷新（保存后）保留旧文本直到新内容到达，避免闪骨架
    if (lastPath.current !== data.path) setText(null)
    lastPath.current = data.path
    void window.huabu.workspace.readFile(data.path).then((result) => {
      if (alive && result.ok) setText(result.value.text)
    })
    return () => {
      alive = false
    }
  }, [want, data.path, nonce])
  return want ? text : null
}

/**
 * 标签胶囊行：媒体卡嵌在选中信息浮层（深色渐变）里，文本卡并入名称底栏——
 * 自身不做定位与底色。单选可增删（写 .huabu/tags.json，同一文件的多张卡同步），
 * 多选只读。添加标签 = 独占一行的全宽输入框（回车添加 / Esc 取消 / 失焦提交），
 * 带全量标签建议（datalist）。tone 决定配色（深色底=白色半透明胶囊）。
 */
function TagRow({
  node,
  data,
  single,
  tone = 'dark',
}: {
  node: CanvasNode
  data: AssetData
  single: boolean
  tone?: 'dark' | 'light'
}) {
  const setNodeTags = useCanvasStore((s) => s.setNodeTags)
  const showToast = useCanvasStore((s) => s.showToast)
  const [inputOpen, setInputOpen] = useState(false)
  const [input, setInput] = useState('')
  const tags = data.tags ?? []
  const dark = tone === 'dark'
  const allTags = useMemo(() => {
    const seen = new Set<string>()
    for (const n of useCanvasStore.getState().nodes) for (const t of n.data.tags ?? []) seen.add(t)
    return [...seen].sort((a, b) => a.localeCompare(b))
    // 建议清单只在打开输入框那一刻现算（避免订阅整棵 nodes 树）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputOpen])

  const addTag = () => {
    const t = input.trim().replace(/^#/, '')
    setInput('')
    setInputOpen(false)
    if (!t) return
    if (tags.includes(t)) {
      showToast(`已有标签「${t}」`)
      return
    }
    void setNodeTags(node.id, [...tags, t])
  }

  return (
    <div
      className="mt-1.5 flex max-h-[72px] flex-wrap items-center gap-1 overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <TagIcon size={10} className={`shrink-0 ${dark ? 'text-white/70' : 'text-(--on-surface-muted)'}`} />
      {tags.map((t) => (
        <span
          key={t}
          className={`flex items-center gap-0.5 rounded-full py-0.5 pl-1.5 pr-1 text-[10px] font-medium ${
            dark ? 'bg-white/20 text-white' : 'bg-(--active-tint) text-(--accent)'
          }`}
          title={single ? '标签（点 × 移除）' : '标签'}
        >
          {t}
          {single && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                void setNodeTags(node.id, tags.filter((x) => x !== t))
              }}
              className={`rounded-full p-px transition-colors ${
                dark ? 'hover:bg-white/40' : 'hover:bg-(--accent) hover:text-white'
              }`}
              title="移除标签"
            >
              <X size={9} />
            </button>
          )}
        </span>
      ))}
      {single && !inputOpen && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            setInputOpen(true)
          }}
          className={`flex items-center gap-0.5 rounded-full border border-dashed px-1.5 py-0.5 text-[10px] transition-colors ${
            dark
              ? 'border-white/50 text-white/85 hover:border-white hover:text-white'
              : 'border-(--outline) text-(--on-surface-muted) hover:border-(--accent) hover:text-(--accent)'
          }`}
          title="添加标签"
        >
          <Plus size={9} />
          标签
        </button>
      )}
      {inputOpen && (
        <input
          autoFocus
          value={input}
          list="huabu-all-tags"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) addTag()
            if (e.key === 'Escape') {
              setInput('')
              setInputOpen(false)
            }
          }}
          onBlur={addTag}
          placeholder="新标签，回车添加"
          className={`w-24 rounded-full px-2 py-0.5 text-[10.5px] outline-none ring-1 transition-colors ${
            dark
              ? // 必须不透明：半透明深底会让媒体画面从胶囊里透出来（亮背景在两个圆角上
                // 形成月牙状发白）。静止无描边，聚焦提亮一档 + 淡环
                'bg-neutral-800 text-white ring-transparent placeholder:text-white/45 focus:bg-neutral-700 focus:ring-white/30'
              : 'bg-(--surface-input) text-(--on-surface) ring-(--accent)/40 placeholder:text-(--on-surface-muted) focus:ring-(--accent)/70'
          }`}
        />
      )}
      {!single && tags.length === 0 && (
        <span className={`text-[10px] ${dark ? 'text-white/60' : 'text-(--on-surface-muted)'}`}>无标签</span>
      )}
      <datalist id="huabu-all-tags">
        {allTags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  )
}

/**
 * 普通文件卡片：点击选中/取消（递给助手当参考），可多选；双击放大查看。
 * 媒体卡（图/视/音）走画框式沉浸：静置不显示任何文字，悬停浮出名称，选中后
 * 名称与标签同在一张底部深色渐变浮层里；文本卡保留名称底栏（名字即身份），
 * 选中后浮层只承载标签。
 */
const PlainAssetCard = memo(function PlainAssetCard({ node, data }: { node: CanvasNode; data: AssetData }) {
  // 只订自己的选中布尔：框选时只有选中态翻盘的卡片重渲染
  const selected = useCanvasStore((s) => s.selectedAssetIds.includes(node.id))
  const { toggleAssetSelected, showToast, openViewer, updateNode } = useCanvasStore.getState()
  const selectedCount = useCanvasStore((s) => (selected ? s.selectedAssetIds.length : 0))
  const src = assetSrc(data, CARD_THUMB_SIZE)
  const [previewBroken, setPreviewBroken] = useState(false)
  const viewable = data.kind === 'image' || data.kind === 'video' || data.kind === 'audio'
  /** 保存成功后 +1：驱动 useDocText 重读文件，卡片展示立即反映新内容 */
  const [docNonce, setDocNonce] = useState(0)
  const docText = useDocText(data, docNonce)
  const editable = isEditableDoc(data)
  const isMd = /\.md$/i.test(data.name)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // 换卡片（memo 复用实例）时收起编辑态
  useEffect(() => {
    setEditing(false)
  }, [node.id])

  const startEdit = () => {
    setDraft(docText ?? '')
    setEditing(true)
  }
  const commitEdit = async () => {
    if (!data.path) return
    setSaving(true)
    const result = await window.huabu.workspace.writeFile(data.path, draft)
    setSaving(false)
    if (!result.ok) {
      showToast(`保存失败：${result.error}`)
      return
    }
    setDocNonce((n) => n + 1)
    setEditing(false)
    updateNode(node.id, { data: { ...data, meta: `${draft.split('\n').length} 行` } })
    showToast(`已保存「${data.name}」（${isMd ? 'md 笔记' : '文本'}）`)
  }

  return (
    <div
      data-testid="asset-node"
      data-selected={selected ? 'true' : 'false'}
      onClick={() => toggleAssetSelected(node.id)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (src && viewable) openViewer(node.id)
      }}
      className={`group relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-2xl bg-(--surface-card) transition-shadow transform-gpu ${
        selected ? 'bg-(--active-tint) shadow-md' : 'shadow-sm hover:shadow-md'
      }`}
    >
      {selected && (
        <>
          <div className="node-ring-overlay" />
          <div className="absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-(--accent) text-white shadow-sm">
            <Check size={12} strokeWidth={3} />
          </div>
        </>
      )}
      {/* 悬浮操作：沉浸式隐藏——悬停或选中才浮现；隐藏时连点穿（pointer-events-none），
          不可见按钮截胡点击会出现「点了没反应」的错觉 */}
      <div
        className={`absolute right-2 top-2 z-10 flex items-center gap-1 transition-opacity duration-150 ${
          selected
            ? 'opacity-100'
            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
        }`}
      >
        {editable && !editing && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              startEdit()
            }}
            className="rounded-full bg-(--glass) p-1.5 text-(--on-surface-variant) shadow-sm backdrop-blur transition-colors hover:bg-(--surface-card)"
            title={`编辑${isMd ? '笔记（md）' : '文本'}`}
          >
            <PenLine size={12} />
          </button>
        )}
        {src && viewable && (
          <button
            data-testid="open-viewer"
            onClick={(e) => {
              e.stopPropagation()
              openViewer(node.id)
            }}
            className="rounded-full bg-(--glass) p-1.5 text-(--on-surface-variant) shadow-sm backdrop-blur transition-colors hover:bg-(--surface-card)"
            title={data.kind === 'image' ? '放大查看' : '播放'}
          >
            {data.kind === 'image' ? <Maximize2 size={12} /> : <Play size={12} />}
          </button>
        )}
        {data.path && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              revealInFileManager(data.path!, showToast)
            }}
            className="rounded-full bg-(--glass) p-1.5 text-(--on-surface-variant) shadow-sm backdrop-blur transition-colors hover:bg-(--surface-card)"
            title={`在文件管理器中打开：${data.path}`}
          >
            <FolderOpen size={12} />
          </button>
        )}
        <ContextDragHandle
          nodeId={node.id}
          batchIds={selected ? useCanvasStore.getState().selectedAssetIds : [node.id]}
          title={
            selected && selectedCount > 1
              ? '拖到生成卡片上加为参考；拖到对话框整批作为上下文；拖到左侧素材库 = 整批归档'
              : '拖到生成卡片上加为参考；拖到对话框作为上下文；拖到左侧素材库 = 移动归档'
          }
        />
      </div>

      {/* 参考连接把手：媒体卡（图/视/音）才能被其他生成卡引用，框内左缘垂直居中，悬停/选中浮现 */}
      {viewable && (
        <MediaConnectionHandle
          nodeId={node.id}
          title="拖到生成卡片的参考槽位加为参考素材；拖到空白画布可搭生成链"
          className={`absolute left-2 top-1/2 z-10 -translate-y-1/2 transition-opacity duration-150 ${
            selected ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
          }`}
        />
      )}

      <div className="relative min-h-0 flex-1 bg-(--surface-input)">
        {data.kind === 'image' && src && !previewBroken && (
          <img
            src={src}
            alt={data.name}
            draggable={false}
            decoding="async"
            onError={() => setPreviewBroken(true)}
            className="h-full w-full object-cover"
          />
        )}
        {data.kind === 'video' && (
          <div className="relative flex h-full w-full items-center justify-center bg-gradient-to-br from-[#2b2f36] to-[#454a54]">
            {/* 真首帧：走缩略图管线（Windows 系统缩略图可出视频首帧；失败/不支持时协议回退原文件，
                <img> 解码视频字节必失败 → onError 退回渐变占位，体验不劣化） */}
            {src && !previewBroken && (
              <img
                src={src}
                alt={data.name}
                draggable={false}
                decoding="async"
                onError={() => setPreviewBroken(true)}
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
            <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/90 shadow">
              <Play size={16} className="ml-0.5 text-[#1f1f1f]" />
            </div>
          </div>
        )}
        {(data.kind === 'code' || data.kind === 'doc') &&
          (editing ? (
            <div
              className="note-editor flex h-full w-full flex-col"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Escape') setEditing(false)
                }}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed text-(--on-surface) outline-none"
                placeholder="用 markdown 记录…（Esc 取消）"
              />
              <div className="flex shrink-0 items-center justify-between border-t border-(--outline-soft) px-2 py-1.5">
                <span className="text-[10px] text-(--on-surface-muted)">
                  {draft.split('\n').length} 行 · {isMd ? 'md' : 'txt'}
                </span>
                <span className="flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing(false)
                    }}
                    className="rounded-full px-2 py-0.5 text-[11px] text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
                  >
                    取消
                  </button>
                  <button
                    data-testid="note-save"
                    onClick={(e) => {
                      e.stopPropagation()
                      void commitEdit()
                    }}
                    disabled={saving}
                    className="rounded-full bg-(--accent) px-2.5 py-0.5 text-[11px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                  >
                    {saving ? '保存中…' : '保存'}
                  </button>
                </span>
              </div>
            </div>
          ) : docText !== null ? (
            <div className="markdown-body h-full w-full overflow-hidden px-3 py-2 text-[11px] leading-relaxed text-(--on-surface)">
              {isMd ? (
                <ReactMarkdown>{docText}</ReactMarkdown>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-(--on-surface-variant)">
                  {docText}
                </pre>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-(--surface-input) to-transparent" />
            </div>
          ) : (
            <div className="flex h-full w-full flex-col justify-center gap-1.5 px-4 font-mono text-[10px] leading-none text-(--on-surface-muted)">
              <div className="h-1.5 w-3/4 rounded bg-(--skeleton)" />
              <div className="h-1.5 w-1/2 rounded bg-(--skeleton)" />
              <div className="h-1.5 w-2/3 rounded bg-(--skeleton)" />
              <div className="h-1.5 w-1/3 rounded bg-(--skeleton)" />
              <div className="h-1.5 w-3/5 rounded bg-(--skeleton)" />
            </div>
          ))}
        {data.kind === 'audio' && (
          <div className="flex h-full w-full items-end justify-center gap-1 px-4 pb-5 pt-4">
            {[0.35, 0.7, 0.5, 0.95, 0.6, 0.8, 0.42, 0.88, 0.55, 0.3, 0.72, 0.6, 0.45, 0.82, 0.38].map((h, i) => (
              <div key={i} className="w-[3px] rounded-full bg-(--accent) opacity-60" style={{ height: `${h * 100}%` }} />
            ))}
          </div>
        )}
      </div>

      {/* 选中信息浮层：所有卡型统一「画框式沉浸」——静置零文字，悬停浮出名称行，选中后
          名称与标签同在这层里。媒体卡深色渐变压在画面上，文本卡用卡面渐变压在正文上；
          编辑态（文本卡）整体卸载，把整卡让给编辑器。z-[5]：压住媒体、让位于 z-10 的选中描边。 */}
      {!editing && (
        <div
          data-testid="asset-info-scrim"
          className={`absolute inset-x-0 bottom-0 z-[5] rounded-b-2xl transition-opacity duration-200 motion-reduce:transition-none ${
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <div
            className={`rounded-b-2xl ${
              viewable
                ? 'bg-gradient-to-t from-black/70 via-black/40 to-transparent px-2.5 pb-2 pt-7 text-white'
                : 'bg-gradient-to-t from-(--surface-input) via-(--surface-input)/90 to-transparent px-3 pb-2 pt-7'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className={`shrink-0 ${viewable ? 'text-white/80' : 'text-(--accent)'}`}>
                {viewable
                  ? kindIcon(data.kind, 12)
                  : isEditableDoc(data) && isMd
                    ? <StickyNote size={13} />
                    : kindIcon(data.kind)}
              </span>
              <span className="min-w-0 truncate text-[12px] font-medium" title={viewable ? (data.path ?? data.name) : data.name}>
                {data.name}
              </span>
              <span className={`ml-auto shrink-0 text-[10px] ${viewable ? 'text-white/70' : 'text-(--on-surface-muted)'}`}>
                {formatBytes(data.bytes) || data.meta || KIND_LABEL[data.kind]}
              </span>
            </div>
            {data.path && !viewable && (
              <div className="mt-0.5 truncate pl-[21px] font-mono text-[10px] text-(--on-surface-muted)" title={data.path}>
                {data.path}
              </div>
            )}
            {/* 标签随选中平滑展开（高度生长 + 内容淡入），浮层不再瞬间撑高一截 */}
            <Collapse open={selected}>
              <div
                className={`transition-opacity duration-150 motion-reduce:transition-none ${
                  selected ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <TagRow node={node} data={data} single={selectedCount === 1} tone={viewable ? undefined : 'light'} />
              </div>
            </Collapse>
          </div>
        </div>
      )}
    </div>
  )
})

/**
 * 带生成状态的文件卡片：媒体制作的执行单元，自成一套「生成控制台」。
 * 提示词直接写在卡片上（回显上次提示词，可改一个字再生成），参数与参考也在卡片上调。
 * 交互控制元素带 .gen-no-drag，避免和画布节点拖拽冲突。
 */
const GeneratingAssetCard = memo(function GeneratingAssetCard({ node, data }: { node: CanvasNode; data: AssetData }) {
  // 高频字段走精确订阅：激活布尔 + 链内占用（都返回原始布尔，未波及本卡不重渲染）
  const active = useCanvasStore((s) => s.activeGenerateId === node.id)
  const gen = data.gen!
  const kind = data.kind as MediaKind
  /** 链运行中且本卡尚未完成：禁用单独重跑入口，避免链任务和手动任务叠在同一卡上 */
  const chainHoldsMe = useCanvasStore((s) => {
    const c = s.chainRun
    return Boolean(c && c.status === 'running' && c.nodeIds.includes(node.id) && !c.completedNodeIds.includes(node.id))
  })
  const {
    setActiveGenerate,
    updateNode,
    updateGenerate,
    addGenerateRef,
    submitGeneration,
    resolveOutputLibrary,
    showToast,
    openViewer
  } = useCanvasStore.getState()
  const { mediaProviders, resolveMediaModel } = useSettings()
  const [dropOver, setDropOver] = useState(false)
  /** 整卡 drop 命中多个合法角色时挂起的来源 id，由 MediaReferenceInputs 渲染明确角色菜单 */
  const [pendingDropSource, setPendingDropSource] = useState<string | null>(null)
  /** 版本详情折叠区（回放该版本真实输入，不把当前配置当历史事实） */
  const [detailOpen, setDetailOpen] = useState(false)
  const [previewBroken, setPreviewBroken] = useState(false)
  /** 卡片内联提示词：回显上次提示词，可直接编辑后提交新一行版本 */
  const [prompt, setPrompt] = useState(gen.prompt)
  /** 参数下拉：同一时刻只开一个 */
  const [openMenu, setOpenMenu] = useState<null | 'ratio' | 'duration' | 'model' | 'library'>(null)

  const busy = gen.status === 'queued' || gen.status === 'running'
  const activeVersion: GenerateVersion | undefined =
    gen.versions.find((v) => v.id === gen.activeVersionId) ?? gen.versions[0]
  const status = STATUS_META[gen.status] ?? STATUS_META.idle
  const versionSrc = activeVersion ? assetSrc(activeVersion, CARD_THUMB_SIZE) : null
  /** 落库下拉与默认链的输入（卡片手动 > 类型默认 > 全局默认 > 公共库） */
  const libraries = useCanvasStore((s) => s.libraries)
  const defaultLib = resolveOutputLibrary(kind)
  const resolvedModel = resolveMediaModel(kind, gen.params.model)
  /** 当前生效模型的能力（比例/时长档位驱动参数菜单；适配器已把目录 capabilities 透传到清单） */
  const resolvedModelInfo = resolvedModel
    ? mediaProviders.find((p) => p.id === resolvedModel.provider)?.models.find((m) => m.id === resolvedModel.model)
    : undefined
  const resolvedCapabilities = resolvedModelInfo?.capabilities
  const resolvedCostHint = resolvedModelInfo?.costHint
  const ratioOptions = resolvedCapabilities?.ratios?.length ? resolvedCapabilities.ratios : MEDIA_RATIOS
  const durationOptions = resolvedCapabilities?.durations?.length ? resolvedCapabilities.durations : FALLBACK_DURATIONS

  // 提交后 store 内的 prompt 才变化；外部变化（如撤销恢复）时同步回显，正在输入时不打扰
  useEffect(() => {
    setPrompt(gen.prompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen.prompt, node.id])

  // 换卡片或开始生成时，残留的参数面板要收起
  useEffect(() => setOpenMenu(null), [node.id, busy])

  const submitPrompt = () => {
    const t = prompt.trim()
    // 链占用本卡（等待/运行中）时不再接受手动提交，避免与链任务叠加
    if (!t || busy || chainHoldsMe) return
    setOpenMenu(null)
    void submitGeneration(node.id, t)
  }

  /** 模型按供应商分组（复合 id = provider:model）：分组标题已是供应商名，条目里不再重复前缀 */
  const modelGroups = useMemo(
    () =>
      mediaProviders
        .map((p) => ({
          id: p.id,
          name: p.label,
          models: p.models
            .filter((m) => m.kind === kind)
            .map((m) => ({
              composite: `${p.id}:${m.id}`,
              label: m.label ?? m.id,
              costHint: m.costHint
            })),
        }))
        .filter((g) => g.models.length > 0),
    [mediaProviders, kind]
  )

  /**
   * 参考配额与角色：判据与主进程闸门同源（normalizeMediaCaps 从同一份能力声明派生），
   * 卡片只做"这条素材在这个模型里当什么"的即时可见性，权威判定仍在提交时。
   * 槽位渲染与引用管理在 MediaReferenceInputs；这里只保留整卡 drop 的合法角色判定。
   */
  const refCaps = normalizeMediaCaps(resolvedCapabilities, kind)
  /** 某大类素材在该模型里可担当的角色（整卡 drop 据此决定直接加还是弹角色菜单） */
  const rolesForAssetKind = (assetKind: MediaKind): MediaRefRole[] =>
    (Object.keys(refCaps.quota) as MediaRefRole[]).filter(
      (role) => MEDIA_ROLE_KIND[role] === assetKind && (refCaps.quota[role] ?? 0) > 0
    )

  const patchParams = (patch: Partial<typeof gen.params>) =>
    updateGenerate(node.id, { params: { ...gen.params, ...patch } })

  /** 切换版本：卡片同步指向该版本对应的文件 */
  const switchVersion = (next: GenerateVersion) => {
    updateNode(node.id, {
      data: {
        ...data,
        name: next.name,
        storage: next.storage,
        path: next.path,
        mime: next.mime,
        bytes: next.bytes,
        gen: { ...gen, activeVersionId: next.id },
      },
    })
    setPreviewBroken(false)
  }

  /** 整卡 drop：一种合法角色直接加；多种交给 MediaReferenceInputs 的角色菜单；零种说明原因 */
  const onCardDrop = (sourceId: string) => {
    const sourceNode = useCanvasStore.getState().nodesById.get(sourceId)
    const sourceKind = sourceNode?.data.kind
    if (sourceKind !== 'image' && sourceKind !== 'video' && sourceKind !== 'audio') {
      showToast('文档/代码等文件不能作为媒体生成的参考素材')
      return
    }
    const legal = rolesForAssetKind(sourceKind)
    if (legal.length === 1) {
      addGenerateRef(node.id, sourceId, legal[0])
    } else if (legal.length === 0) {
      showToast(`当前模型不接受${KIND_LABEL[sourceKind]}参考（可在模型菜单换支持参考的模型）`)
    } else {
      setPendingDropSource(sourceId)
    }
  }

  return (
    <div
      data-testid="gen-node"
      data-status={gen.status}
      data-gen-drop-target={node.id}
      onClick={() => setActiveGenerate(node.id)}
      onDragOver={(e) => {
        // dragover 只读 types 判通道（HTML5 此刻 getData 为空），drop 才读载荷
        if (hasReferenceDrag(e.dataTransfer.types)) {
          e.preventDefault()
          setDropOver(true)
        }
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        if (!hasReferenceDrag(e.dataTransfer.types)) return
        e.preventDefault()
        // 本卡已处理（槽位 drop 会先 stopPropagation 走不到这里），不让画布根重复接手
        e.stopPropagation()
        setDropOver(false)
        const sourceId = parseReferencePayload(e.dataTransfer)
        if (sourceId && sourceId !== node.id) onCardDrop(sourceId)
      }}
      className={`relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-2xl bg-(--surface-card) transition-shadow ${
        dropOver || active ? 'shadow-md' : 'shadow-sm hover:shadow-md'
      }`}
    >
      {(dropOver || active) && <div className="node-ring-overlay" />}
      {/* 头部：文件名 + 状态 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-(--outline-soft) px-3 py-2">
        <span className="shrink-0 text-(--accent)">{kindIcon(kind)}</span>
        <span className="truncate text-[13px] font-semibold" title={data.name}>
          {data.name}
        </span>
        {busy && <Loader2 size={12} className="shrink-0 animate-spin text-(--accent)" />}
        <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${status.cls}`}>
          {gen.status === 'running' ? `${status.label} ${Math.round(gen.progress * 100)}%` : status.label}
        </span>
        {/* 无产物/生成中也能当参考源（搭链时上游往往还没结果），把手常驻头部 */}
        <MediaConnectionHandle
          nodeId={node.id}
          title="把本卡拖到其他生成卡上当参考（尚无结果也可先搭生成链）；拖到空白画布 = 接到链上"
        />
        <ContextDragHandle nodeId={node.id} title="拖到对话框递给助手；拖到左侧素材库 = 移动归档（回喂对话）" />
      </div>

      {/* 预览 / 进度 / 空态 / 失败重试 */}
      <div className="relative min-h-0 flex-1 bg-(--surface-input)">
        {busy ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-(--skeleton)">
              <div
                className="h-full rounded-full bg-(--accent) transition-all duration-500"
                style={{ width: `${Math.max(8, gen.progress * 100)}%` }}
              />
            </div>
            <div className="text-[11px] text-(--on-surface-muted)">
              {gen.status === 'queued' ? '排队中，等待并发额度…' : `${KIND_LABEL[kind]}生成中，产物将写入工作目录`}
            </div>
          </div>
        ) : gen.status === 'failed' ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
            <X size={20} className="text-(--danger)" />
            <div className="line-clamp-4 text-[11px] leading-relaxed break-all text-(--danger)">
              {gen.error ?? '生成失败'}
            </div>
            {gen.prompt && (
              <button
                data-testid="retry-generate"
                onClick={(e) => {
                  e.stopPropagation()
                  void submitGeneration(node.id, gen.prompt)
                }}
                className="flex items-center gap-1 rounded-full bg-(--surface-chip) px-3 py-1 text-[11px] font-medium transition-colors hover:bg-(--surface-hover)"
              >
                <RefreshCw size={11} />
                重试
              </button>
            )}
          </div>
        ) : activeVersion ? (
          <div className="flex h-full w-full flex-col">
            <div className="relative min-h-0 flex-1">
              {kind === 'audio' ? (
                <div className="flex h-full w-full items-end justify-center gap-1 px-4 pb-5 pt-4">
                  {[0.3, 0.65, 0.45, 0.9, 0.55, 0.8, 0.4, 0.95, 0.5, 0.72, 0.35, 0.85, 0.6].map((h, i) => (
                    <div
                      key={i}
                      className="w-[3px] rounded-full bg-(--accent) opacity-60"
                      style={{ height: `${h * 100}%` }}
                    />
                  ))}
                </div>
              ) : (
                <>
                  {versionSrc && !previewBroken ? (
                    <img
                      src={versionSrc}
                      alt={activeVersion.prompt}
                      draggable={false}
                      decoding="async"
                      onError={() => setPreviewBroken(true)}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center px-4 text-center text-[11px] text-(--on-surface-muted)">
                      预览不可用（文件可能已被移动）
                    </div>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      openViewer(node.id)
                    }}
                    className="absolute right-2 top-2 rounded-full bg-(--glass) p-1.5 text-(--on-surface-variant) shadow-sm backdrop-blur transition-colors hover:bg-(--surface-card)"
                    title={kind === 'image' ? '放大查看' : '播放'}
                  >
                    {kind === 'image' ? <Maximize2 size={12} /> : <Play size={12} />}
                  </button>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-(--outline-soft) px-3 py-1.5">
              <span className="truncate font-mono text-[10px] text-(--on-surface-muted)" title={activeVersion.path}>
                {activeVersion.path}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {gen.versions.length > 1 && (
                  <button
                    data-testid="switch-version"
                    onClick={(e) => {
                      e.stopPropagation()
                      const i = gen.versions.findIndex((v) => v.id === activeVersion.id)
                      switchVersion(gen.versions[(i + 1) % gen.versions.length])
                    }}
                    disabled={busy}
                    className="gen-no-drag shrink-0 rounded-full bg-(--surface-chip) px-2 py-0.5 text-[10px] text-(--on-surface-variant) transition-colors hover:bg-(--surface-hover) disabled:cursor-not-allowed disabled:opacity-40"
                    title={busy ? '生成中不可切换版本' : '切换版本对比'}
                  >
                    v{gen.versions.findIndex((v) => v.id === activeVersion.id) + 1}/{gen.versions.length}
                  </button>
                )}
                <button
                  data-testid="version-detail-toggle"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDetailOpen((v) => !v)
                  }}
                  className={`gen-no-drag flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                    detailOpen
                      ? 'bg-(--active-tint) text-(--accent)'
                      : 'bg-(--surface-chip) text-(--on-surface-variant) hover:bg-(--surface-hover)'
                  }`}
                  title="回放该版本生成时实际使用的提示词、模型、参数与参考（未记录的旧版本会如实说明）"
                >
                  <History size={10} />
                  详情
                </button>
              </span>
            </div>
            <Collapse open={detailOpen}>
              <div className="border-t border-(--outline-soft) bg-(--surface-input)/40" onClick={(e) => e.stopPropagation()}>
                <VersionDetailPanel version={activeVersion} />
              </div>
            </Collapse>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-(--active-tint) text-(--accent)">
              {kindIcon(kind, 18)}
            </span>
            <div className="text-[12px] font-medium text-(--on-surface-variant)">描述想要的{MEDIA_LABEL[kind]}</div>
            <div className="flex items-center gap-1 text-[10.5px] text-(--on-surface-muted)">
              <ArrowDown size={11} />
              在下方输入框填写提示词，Enter 生成
            </div>
          </div>
        )}
      </div>

      {/* 生成操作台：提示词为主角，参数收进工具条，参考以 chip 挂在输入框内 */}
      <div
        className="gen-no-drag shrink-0 border-t border-(--outline-soft) px-3 py-2.5"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`rounded-xl bg-(--surface-input) px-2.5 pb-1.5 pt-2 transition-shadow focus-within:bg-(--surface-card) ${
            dropOver ? 'ring-2 ring-(--accent)' : 'ring-1 ring-(--outline-soft) focus-within:ring-2 focus-within:ring-(--accent)/50'
          }`}
        >
          {/* 参考输入区：角色槽位/配额、引用条目、新鲜度提示与多角色菜单（数据订阅在组件内部） */}
          <MediaReferenceInputs
            node={node}
            gen={gen}
            refCaps={refCaps}
            pendingSourceId={pendingDropSource}
            onClearPending={() => setPendingDropSource(null)}
          />

          <div className="flex items-end gap-2">
            <textarea
              rows={2}
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // 输入法组词过程中的回车不触发提交
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  e.stopPropagation()
                  submitPrompt()
                }
              }}
              placeholder={busy ? `${KIND_LABEL[kind]}生成中…` : `描述要生成的${KIND_LABEL[kind]}…`}
              className="max-h-24 min-h-[40px] flex-1 resize-none bg-transparent py-1 text-[12px] leading-relaxed outline-none placeholder:text-(--on-surface-muted) disabled:opacity-60"
            />
            <button
              data-testid="regenerate"
              onClick={(e) => {
                e.stopPropagation()
                submitPrompt()
              }}
              disabled={busy || chainHoldsMe || !prompt.trim()}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-(--fab-bg) text-(--fab-text) shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
              title={chainHoldsMe ? '生成链正在运行本卡，结束后可单独重跑' : `生成${KIND_LABEL[kind]}（Enter）`}
            >
              <Sparkles size={14} />
            </button>
          </div>

          {/* 工具条：低频参数收进来，不再单独占区块 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-(--outline-soft) pt-1.5">
            {kind === 'image' ? (
              <ChipSelect
                icon={<RatioGlyph ratio={gen.params.ratio ?? '1:1'} size={13} />}
                label={gen.params.ratio ?? '自动'}
                title={gen.params.ratio ? '图片比例' : '比例：自动（跟随参考图/模型默认）'}
                open={openMenu === 'ratio'}
                onOpenChange={(v) => setOpenMenu(v ? 'ratio' : null)}
              >
                {(close) => (
                  <>
                    <MenuGroup label="比例" first />
                    <div className="grid grid-cols-2 gap-0.5">
                      {ratioOptions.map((r) => (
                        <MenuItem
                          key={r}
                          icon={<RatioGlyph ratio={r} size={15} />}
                          label={r}
                          selected={gen.params.ratio === r}
                          onClick={() => {
                            patchParams({ ratio: r })
                            close()
                          }}
                        />
                      ))}
                    </div>
                    {/* 不声明比例：图生图/首帧视频里让出图比例跟随素材（官方 adaptive 语义） */}
                    <MenuItem
                      label="自动（随参考图）"
                      hint="不向模型声明比例"
                      selected={!gen.params.ratio}
                      onClick={() => {
                        patchParams({ ratio: undefined })
                        close()
                      }}
                    />
                  </>
                )}
              </ChipSelect>
            ) : (
              <ChipSelect
                icon={<Timer size={11} />}
                label={`${gen.params.durationSeconds ?? DEFAULT_MEDIA_DURATION_S}s`}
                title="时长"
                open={openMenu === 'duration'}
                onOpenChange={(v) => setOpenMenu(v ? 'duration' : null)}
                minWidth={120}
              >
                {(close) => (
                  <>
                    <MenuGroup label="时长" first />
                    {durationOptions.map((d) => (
                      <MenuItem
                        key={d}
                        label={`${d} 秒`}
                        hint={d >= 10 ? '较慢' : undefined}
                        selected={(gen.params.durationSeconds ?? DEFAULT_MEDIA_DURATION_S) === d}
                        onClick={() => {
                          patchParams({ durationSeconds: d })
                          close()
                        }}
                      />
                    ))}
                  </>
                )}
              </ChipSelect>
            )}

            <ChipSelect
              icon={<Cpu size={11} />}
              label={gen.params.model ?? `默认 · ${resolvedModel ? `${resolvedModel.provider} · ${shortModelLabel(resolvedModel.provider, resolvedModel.model)}` : '默认模型未选择'}`}
              title={`${gen.params.model ? `已指定模型：${gen.params.model}` : '使用设置里的默认模型（未选择时该卡片无法生成，去「设置 → 媒体生成」配置）'}${resolvedCostHint ? `\n成本：${resolvedCostHint}` : ''}`}
              overridden={Boolean(gen.params.model)}
              open={openMenu === 'model'}
              onOpenChange={(v) => setOpenMenu(v ? 'model' : null)}
              minWidth={248}
            >
              {(close) => (
                <>
                  <MenuGroup label="模型" first />
                  <MenuItem
                    icon={<Sparkles size={12} />}
                    label="跟随默认"
                    hint={resolvedModel ? `${resolvedModel.provider} · ${shortModelLabel(resolvedModel.provider, resolvedModel.model)}` : '默认模型未选择'}
                    selected={!gen.params.model}
                    onClick={() => {
                      patchParams({ model: undefined })
                      close()
                    }}
                  />
                  {modelGroups.map((g) => (
                    <div key={g.id}>
                      <MenuGroup label={g.name} />
                      {g.models.map((m) => (
                        <MenuItem
                          key={m.composite}
                          label={m.label}
                          hint={m.costHint ?? shortModelId(m.composite)}
                          selected={gen.params.model === m.composite}
                          onClick={() => {
                            patchParams({ model: m.composite })
                            close()
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </>
              )}
            </ChipSelect>

            <ChipSelect
              icon={<LibraryIcon size={11} />}
              label={gen.params.libraryId ? (libraries.find((l) => l.id === gen.params.libraryId)?.name ?? '未知库') : (defaultLib?.name ?? '未指定')}
              title={gen.params.libraryId ? '已指定落库位置' : '跟随默认落库'}
              overridden={Boolean(gen.params.libraryId)}
              open={openMenu === 'library'}
              onOpenChange={(v) => setOpenMenu(v ? 'library' : null)}
              minWidth={200}
            >
              {(close) => (
                <>
                  <MenuGroup label="产物落库" first />
                  <MenuItem
                    icon={<FolderOpen size={12} />}
                    label="跟随默认"
                    hint={defaultLib?.name}
                    selected={!gen.params.libraryId}
                    onClick={() => {
                      patchParams({ libraryId: undefined })
                      close()
                    }}
                  />
                  {libraries.map((l) => (
                    <MenuItem
                      key={l.id}
                      icon={<LibraryIcon size={12} />}
                      label={l.name}
                      hint={l.builtin ? '按类型归类' : l.isPublic ? '公共' : undefined}
                      selected={gen.params.libraryId === l.id}
                      onClick={() => {
                        patchParams({ libraryId: l.id })
                        close()
                      }}
                    />
                  ))}
                  <MenuNote>未指定时按「类型默认 → 全局默认 → 公共库 → 画布素材」依次兜底</MenuNote>
                </>
              )}
            </ChipSelect>

            {/* 生成链：运行到此 / 本卡链状态 / 取消（链运行期间入口停用防误触重跑） */}
            <span className="ml-auto flex items-center gap-1">
              <ChainControls nodeId={node.id} prompt={prompt} busy={busy} />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
})
