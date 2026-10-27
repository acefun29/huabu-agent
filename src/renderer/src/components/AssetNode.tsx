import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  FileCode,
  FileText,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Paperclip,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  StickyNote,
  Tag as TagIcon,
  Video,
  X,
  AudioLines,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { useCanvasStore } from '../store/canvasStore'
import { ASSET_IDS_MIME } from '../store/canvasStore'
import { bumpRender } from '../lib/perfProbe'
import { CARD_THUMB_SIZE, assetSrc, formatBytes } from '../lib/media'
import { KIND_LABEL, type AssetData, type AssetKind, type CanvasNode } from '../types'
import { Collapse } from './Collapse'

/**
 * 统一媒体卡：产物即媒体卡（没有独立的"生成卡片"形态）。生成信息存在卡片
 * versions 里（每版一份 inputs 定格快照），生成运行态（进度/失败）来自内存
 * jobStates。引用链由生成事实自动派生（边图层投影），卡片上没有任何建链控件。
 */

export function kindIcon(kind: AssetKind, size = 13) {
  if (kind === 'image') return <ImageIcon size={size} />
  if (kind === 'video') return <Video size={size} />
  if (kind === 'audio') return <AudioLines size={size} />
  if (kind === 'doc') return <FileText size={size} />
  return <FileCode size={size} />
}

export const AssetNode = memo(function AssetNode({ node }: { node: CanvasNode }) {
  bumpRender('node')
  const data = node.data as AssetData
  return <UnifiedAssetCard node={node} data={data} />
})

/**
 * 引用拖拽句柄：按住拖到两处——底部输入框注入上下文、左侧素材库归档。
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
 * 统一文件卡片：点击选中/取消（递给助手当参考），可多选；双击放大查看。
 * 媒体卡（图/视/音）走画框式沉浸：静置不显示任何文字，悬停浮出名称，选中后
 * 名称与标签同在一张底部深色渐变浮层里；文本卡保留名称底栏（名字即身份）。
 *
 * 生成相关都是卡片的「状态」而非形态：versions 有历史 → 底部出现版本条与详情
 * （回放该版本真实输入 + 血脉链 + 再次生成入口）；jobStates 有运行态 → 进度/
 * 失败条。没有独立的生成卡片渲染分支。
 */
const UnifiedAssetCard = memo(function UnifiedAssetCard({ node, data }: { node: CanvasNode; data: AssetData }) {
  // 只订自己的选中布尔：框选时只有选中态翻盘的卡片重渲染
  const selected = useCanvasStore((s) => s.selectedAssetIds.includes(node.id))
  const { toggleAssetSelected, showToast, openViewer, updateNode } = useCanvasStore.getState()
  const selectedCount = useCanvasStore((s) => (selected ? s.selectedAssetIds.length : 0))
  // 生成运行态（内存）：进度/失败条；引用不存在时不订阅触发重渲染
  const runtime = useCanvasStore((s) => s.jobStates[node.id])
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

  const busy = runtime?.status === 'queued' || runtime?.status === 'running'
  const failed = runtime?.status === 'failed'
  /** 无文件的失败占位卡：整卡让给错误展示（有文件的卡只在底条报错，画面照常） */
  const failedPlaceholder = Boolean(failed && !data.path)

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
      data-status={runtime?.status ?? 'idle'}
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
        {viewable && (
          <button
            data-testid="card-info"
            onClick={(e) => {
              e.stopPropagation()
              useCanvasStore.getState().openCardInspector(node.id)
            }}
            className={`rounded-full bg-(--glass) p-1.5 shadow-sm backdrop-blur transition-colors hover:bg-(--surface-card) ${
              (data.versions?.length ?? 0) > 0 ? 'text-(--accent)' : 'text-(--on-surface-variant)'
            }`}
            title={
              (data.versions?.length ?? 0) > 0
                ? '血脉与提示词：这张卡从哪来（生成链图）+ 当前版本的生成输入'
                : '卡片信息（导入素材无生成记录）'
            }
          >
            <GitBranch size={12} />
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
              ? '拖到对话框整批作为上下文；拖到左侧素材库 = 整批归档'
              : '拖到对话框作为上下文；拖到左侧素材库 = 移动归档'
          }
        />
      </div>

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
            {/* Play 圆钮只在有产物文件时渲染：生成中/失败占位卡没有可播放的内容，
                白圆叠在居中的 spinner/错误文案上会把它吞掉 */}
            {src && (
              <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/90 shadow">
                <Play size={16} className="ml-0.5 text-[#1f1f1f]" />
              </div>
            )}
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
        {/* 生成中占位（无产物文件）：居中 spinner；进度在底条 */}
        {busy && !src && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Loader2 size={18} className="animate-spin text-(--accent)" />
            <span className="text-[10.5px] text-(--on-surface-muted)">{KIND_LABEL[data.kind]}生成中</span>
          </div>
        )}
        {/* 无文件的失败占位卡：整卡错误态（重试 / 移除占位卡） */}
        {failedPlaceholder && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <X size={20} className="text-(--danger)" />
            <div className="line-clamp-4 text-[11px] leading-relaxed break-all text-(--danger)">
              {runtime?.error ?? '生成失败'}
            </div>
            <div className="flex items-center gap-1.5">
              {data.pendingJob?.inputs && (
                <button
                  data-testid="retry-generate"
                  onClick={(e) => {
                    e.stopPropagation()
                    void useCanvasStore.getState().retryGeneration(node.id)
                  }}
                  className="flex items-center gap-1 rounded-full bg-(--surface-chip) px-3 py-1 text-[11px] font-medium transition-colors hover:bg-(--surface-hover)"
                >
                  <RefreshCw size={11} />
                  重试
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  useCanvasStore.getState().requestRemoveNode(node.id)
                }}
                className="flex items-center gap-1 rounded-full bg-(--surface-chip) px-3 py-1 text-[11px] text-(--on-surface-variant) transition-colors hover:bg-(--surface-hover)"
              >
                <X size={11} />
                移除占位卡
              </button>
            </div>
          </div>
        )}

        {/* 选中信息浮层：所有卡型统一「画框式沉浸」——静置零文字，悬停浮出名称行，选中后
            名称与标签同在这层里。挂在媒体区内（不遮底部版本条）；媒体卡深色渐变压在画面上，
            文本卡用卡面渐变压在正文上；编辑态（文本卡）整体卸载。z-[5]：压住媒体、让位于 z-10 的选中描边。 */}
        {!editing && !failedPlaceholder && !(busy && !src) && (
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

      {/* 生成状态条：只在在途/失败（有文件）这种瞬时状态出现；静置的媒体卡零附加
          （版本切换、提示词详情、血脉图都收进「卡片检视」浮层，经悬停工具条进入）。 */}
      {(busy || failed) && !failedPlaceholder && (
        <div
          className="gen-no-drag shrink-0 border-t border-(--outline-soft) px-2.5 py-1.5"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {busy ? (
            <div className="flex flex-col gap-1">
              <div className="h-1 w-full overflow-hidden rounded-full bg-(--skeleton)">
                <div
                  className="h-full rounded-full bg-(--accent) transition-all duration-500"
                  style={{ width: `${Math.max(8, (runtime?.progress ?? 0) * 100)}%` }}
                />
              </div>
              <div className="text-[10px] text-(--on-surface-muted)">
                {runtime?.status === 'queued' ? '排队中，等待并发额度…' : `${KIND_LABEL[data.kind]}生成中 ${Math.round((runtime?.progress ?? 0) * 100)}%`}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-(--danger)" title={runtime?.error}>
                {runtime?.error ?? '生成失败'}
              </span>
              {data.pendingJob?.inputs && (
                <button
                  data-testid="retry-generate"
                  onClick={(e) => {
                    e.stopPropagation()
                    void useCanvasStore.getState().retryGeneration(node.id)
                  }}
                  className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-(--surface-chip) px-2 py-0.5 text-[10.5px] font-medium transition-colors hover:bg-(--surface-hover)"
                >
                  <RefreshCw size={10} />
                  重试
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
