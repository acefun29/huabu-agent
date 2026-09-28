// 设置面板共用 UI 原子：Toggle / Row / Field / inputCls 与协议下拉 ApiSelect（供各 tab 组件复用）

import type { ReactNode } from 'react'
import { CHAT_API_LABEL, CHAT_MODEL_APIS, type ChatModelApi } from '@shared/chatApi'

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-(--accent)' : 'bg-(--toggle-off)'}`}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  )
}

export function Row({ title, desc, control }: { title: string; desc?: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-(--on-surface)">{title}</div>
        {desc && <div className="mt-0.5 text-xs leading-relaxed text-(--on-surface-muted)">{desc}</div>}
      </div>
      {control}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--on-surface-variant)">{label}</span>
      {children}
    </label>
  )
}

export const inputCls =
  'w-full rounded-lg bg-(--surface-input) px-3 py-1.5 text-[13px] text-(--on-surface) outline-none transition focus:ring-2 focus:ring-(--accent) placeholder:text-(--on-surface-muted)'

/**
 * 协议下拉。选项直接来自 shared/chatApi 的白名单 —— 不在这里再抄一份数组，
 * 否则主进程加第四种协议时这里会静默少一项（与 §2.5 那类"键名对、值不对"同一种错）。
 * allowFollow 时空串=不写模型级 api，跟随供应商。
 */
export function ApiSelect({
  value,
  onChange,
  allowFollow = false,
  testId
}: {
  value: ChatModelApi | ''
  onChange: (next: ChatModelApi | '') => void
  allowFollow?: boolean
  testId?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ChatModelApi | '')}
      className={`${inputCls} cursor-pointer`}
      data-testid={testId}
    >
      {allowFollow && <option value="">跟随供应商（缺省）</option>}
      {CHAT_MODEL_APIS.map((api) => (
        <option key={api} value={api}>
          {api} · {CHAT_API_LABEL[api]}
        </option>
      ))}
    </select>
  )
}
