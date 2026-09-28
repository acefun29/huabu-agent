// 设置面板其余 tab：使用引导、Skills、MCP、Agent 接入、外观（GESTURES / CopyButton 为内部辅助，不导出）

import { useState } from 'react'
import { Check, CirclePlay, Copy, Moon, Plus, Sun, Trash2 } from 'lucide-react'
import { useSettings, useSettingsUi, type McpServer } from '../../store/settingsStore'
import { useCanvasStore } from '../../store/canvasStore'
import type { MessageAttachment } from '../../types'
import { buildAgentSystemPrompt, buildReferencePayload } from '../../harness/prompt'
import { Field, Row, Toggle, inputCls } from './ui'

/* -------------------------------------------------------------------------- */
/* 使用引导（分步演示入口：面向使用者的操作讲解）                                */
/* -------------------------------------------------------------------------- */

const GESTURES: { gesture: string; desc: string }[] = [
  { gesture: '滚轮', desc: '以鼠标为中心缩放画布' },
  { gesture: '空格 + 拖动 / 中键拖动', desc: '平移画布' },
  { gesture: '左键拖动空白处', desc: '框选卡片（Shift 可追加选择）' },
  { gesture: '双击图片卡片', desc: '放大查看（视频 / 音频为播放）' },
  { gesture: '右键', desc: '看当前对象的全部操作：生成、引用、导入等' },
]

export function GuideTab() {
  const openGuide = useCanvasStore.getState().openGuide
  const { closeSettings } = useSettingsUi()
  return (
    <div className="space-y-4" data-testid="guide-tab">
      <p className="text-xs leading-relaxed text-(--on-surface-muted)">
        分步演示会逐块高亮界面并讲解玩法：画布 → 素材卡片 → 批量操作 → 工作区 →
        会话 → 素材库 → 对话 → 设置。演示过程中不影响已有内容，随时按 Esc 退出；
        之后可随时回到这里重看。
      </p>

      <button
        data-testid="start-guide"
        onClick={() => {
          closeSettings()
          openGuide()
        }}
        className="flex items-center gap-2 rounded-full bg-(--fab-bg) px-5 py-2 text-[13px] font-medium text-(--fab-text) transition hover:opacity-90"
      >
        <CirclePlay size={15} />
        开始演示
      </button>

      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="mb-2 text-[13px] font-semibold text-(--on-surface)">画布快捷操作速查</div>
        <div className="divide-y divide-(--outline-soft)">
          {GESTURES.map((g) => (
            <div key={g.gesture} className="flex items-baseline gap-3 py-2">
              <span className="w-44 shrink-0 text-[12px] font-medium text-(--on-surface)">{g.gesture}</span>
              <span className="text-[12px] text-(--on-surface-muted)">{g.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Skills / MCP / 外观                                                         */
/* -------------------------------------------------------------------------- */

export function SkillsTab() {
  const { skills, toggleSkill } = useSettings()
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-(--on-surface-muted)">
        Skills 为 Agent 提供可复用的工作流能力。工作区级 Skill 从{' '}
        <code className="rounded bg-(--surface-input) px-1">.huabu/skills/</code> 目录加载，仅对当前工作区生效。
        （此页为配置陈列，开关暂不影响运行行为。）
      </p>
      <div className="divide-y divide-(--outline-soft) rounded-2xl bg-(--surface-card) px-4 ring-1 ring-(--outline-soft)">
        {skills.map((s) => (
          <Row
            key={s.id}
            title={s.name}
            desc={s.description}
            control={
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    s.source === 'builtin'
                      ? 'bg-(--surface-chip) text-(--on-surface-variant)'
                      : 'bg-(--success-bg) text-(--success-text)'
                  }`}
                >
                  {s.source === 'builtin' ? '内置' : '工作区'}
                </span>
                <Toggle checked={s.enabled} onChange={() => toggleSkill(s.id)} />
              </div>
            }
          />
        ))}
      </div>
    </div>
  )
}

export function McpTab() {
  const { mcpServers, toggleMcp, removeMcp, addMcp } = useSettings()
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')

  const submit = () => {
    if (!name.trim() || !command.trim()) return
    addMcp({ name: name.trim(), command: command.trim(), args: args.trim() } satisfies Omit<McpServer, 'id' | 'enabled'>)
    setName('')
    setCommand('')
    setArgs('')
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-(--on-surface-muted)">
        MCP 服务器经桥接层接入 Agent，工具名自动加前缀{' '}
        <code className="rounded bg-(--surface-input) px-1">mcp_&lt;server&gt;_</code>
        ，写操作默认需确认。配置格式对齐 Claude Desktop。（此页为配置陈列，开关暂不影响运行行为。）
      </p>
      <div className="space-y-2">
        {mcpServers.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-2xl bg-(--surface-card) px-4 py-3 ring-1 ring-(--outline-soft)"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-(--on-surface)">{s.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    s.enabled
                      ? 'bg-(--success-bg) text-(--success-text)'
                      : 'bg-(--surface-input) text-(--on-surface-muted)'
                  }`}
                >
                  {s.enabled ? '已启用' : '未启用'}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-(--on-surface-muted)">
                {s.command} {s.args}
              </div>
            </div>
            <button
              onClick={() => removeMcp(s.id)}
              className="rounded-full p-1.5 text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft) hover:text-(--danger)"
              title="删除"
            >
              <Trash2 size={13} />
            </button>
            <Toggle checked={s.enabled} onChange={() => toggleMcp(s.id)} />
          </div>
        ))}
      </div>
      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="mb-2 text-[13px] font-medium text-(--on-surface)">添加 MCP 服务器</div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="名称">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" className={inputCls} />
          </Field>
          <Field label="命令">
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className={inputCls} />
          </Field>
          <Field label="参数">
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @scope/pkg ." className={inputCls} />
          </Field>
        </div>
        <button
          onClick={submit}
          disabled={!name.trim() || !command.trim()}
          className="mt-3 flex items-center gap-1 rounded-full bg-(--fab-bg) px-3.5 py-1.5 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90 disabled:opacity-30"
        >
          <Plus size={13} />
          添加
        </button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Agent 接入（给后端/Agent 看的契约预览：系统提示词 + 引用载荷）               */
/* -------------------------------------------------------------------------- */

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      data-testid="agent-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          /* 剪贴板不可用时忽略 */
        }
      }}
      className="flex shrink-0 items-center gap-1 rounded-full bg-(--surface-chip) px-2.5 py-1 text-[11px] font-medium text-(--on-surface-variant) transition-colors hover:bg-(--surface-hover)"
      title={`复制${label}`}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}

export function AgentTab() {
  const workspace = useCanvasStore((s) => s.workspace)
  const workspaceDir = workspace?.path ?? '<工作区目录>'
  const systemPrompt = buildAgentSystemPrompt(workspaceDir)
  const payloadExample = buildReferencePayload([
    {
      id: 'example-1',
      name: '概念图.png',
      kind: 'image',
      absPath: `${workspaceDir.replace(/\/+$/, '')}/assets/images/概念图.png`,
      origin: 'workspace-asset',
    },
    {
      id: 'example-2',
      name: '需求说明.md',
      kind: 'doc',
      absPath: `${workspaceDir.replace(/\/+$/, '')}/docs/需求说明.md`,
      origin: 'workspace-asset',
    },
  ] satisfies MessageAttachment[])

  return (
    <div className="space-y-4" data-testid="agent-tab">
      <p className="text-xs leading-relaxed text-(--on-surface-muted)">
        这里展示的是渲染端与 Agent 运行时之间的真实契约（非陈列）：会话创建时主进程把下面的系统提示词经 Pi
        的 appendSystemPrompt 注入；引用素材只把绝对路径列表拼进用户消息，文件内容不进上下文，由 Agent
        按路径自行读取。
      </p>

      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-(--on-surface)">系统提示词（自动生成）</div>
            <div className="mt-0.5 text-[11px] text-(--on-surface-muted)">
              由素材分类表生成，随工作区目录注入；源码 src/shared/prompt.ts
            </div>
          </div>
          <CopyButton text={systemPrompt} label="系统提示词" />
        </div>
        <pre
          data-testid="agent-system-prompt"
          className="selectable max-h-72 overflow-auto rounded-xl bg-(--surface-input) p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-(--on-surface-variant)"
        >
          {systemPrompt}
        </pre>
      </div>

      <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-semibold text-(--on-surface)">引用载荷示例（拼在用户消息末尾）</div>
            <div className="mt-0.5 text-[11px] text-(--on-surface-muted)">
              每条一个绝对路径；工作区素材与临时上传（inbox）共用这一格式
            </div>
          </div>
          <CopyButton text={payloadExample} label="载荷示例" />
        </div>
        <pre
          data-testid="agent-payload-example"
          className="selectable max-h-56 overflow-auto rounded-xl bg-(--surface-input) p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-(--on-surface-variant)"
        >
          {payloadExample}
        </pre>
      </div>

      <div className="rounded-2xl bg-(--surface-card) p-4 text-[12px] leading-relaxed text-(--on-surface-muted) ring-1 ring-(--outline-soft)">
        <div className="mb-1 text-[13px] font-semibold text-(--on-surface)">接线对照</div>
        系统提示词注入：src/main/agent/host.ts（DefaultResourceLoader + appendSystemPrompt）·
        载荷拼接：canvasStore.sendMessage → buildReferencePayload ·
        素材分类单一事实来源：src/renderer/src/harness/assetCategories.ts
      </div>
    </div>
  )
}

export function AppearanceTab() {
  const { appearance, setAppearance } = useSettings()
  const themes = [
    { key: 'light' as const, label: '浅色', icon: <Sun size={13} /> },
    { key: 'dark' as const, label: '深色', icon: <Moon size={13} /> },
  ]
  return (
    <div className="divide-y divide-(--outline-soft)">
      <div className="py-3">
        <div className="text-[13px] font-medium text-(--on-surface)">主题</div>
        <div className="mt-0.5 text-xs text-(--on-surface-muted)">切换浅色 / 深色界面外观，即时生效并记住选择</div>
        <div className="mt-3 inline-flex rounded-full bg-(--surface-input) p-1">
          {themes.map((t) => (
            <button
              key={t.key}
              onClick={() => setAppearance({ theme: t.key })}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-medium transition ${
                appearance.theme === t.key
                  ? 'bg-(--surface-card) text-(--on-surface) shadow-sm'
                  : 'text-(--on-surface-variant) hover:text-(--on-surface)'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <Row
        title="画布点阵网格"
        desc="在画布背景显示细点阵，关闭后为纯净底色"
        control={<Toggle checked={appearance.showGrid} onChange={(v) => setAppearance({ showGrid: v })} />}
      />
    </div>
  )
}
