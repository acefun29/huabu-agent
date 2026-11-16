/**
 * 推理模型的「支持的思考档位」多选：勾选的档位会话里才可选，请求只发这些值。
 * 场景：网关对 reasoning_effort 的取值各不相同（报错会给出支持列表，如
 * 「Supported types are xhigh, medium, and low」），按报错勾上对应档位即可。
 */

import { Check } from 'lucide-react'
import type { ThinkingLevelName } from '@shared/ipc'
import { THINKING_LEVEL_LABEL } from '@shared/ipc'
import { Field } from '../ui'
import { EFFORT_LEVELS } from './shared'

export function ThinkingLevelsField({
  value,
  onChange,
}: {
  value: ThinkingLevelName[]
  onChange: (next: ThinkingLevelName[]) => void
}) {
  return (
    <Field label="支持的思考档位（网关不认的档位会报错，按报错勾选；会话档位菜单只显示勾选项）">
      <div className="flex flex-wrap gap-1.5">
        {EFFORT_LEVELS.map((level) => {
          const active = value.includes(level)
          return (
            <button
              key={level}
              type="button"
              onClick={() => onChange(active ? value.filter((l) => l !== level) : [...value, level])}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-colors ${
                active
                  ? 'bg-(--surface-chip) text-(--on-surface) ring-1 ring-(--accent)'
                  : 'bg-(--surface-input) text-(--on-surface-muted) hover:bg-(--outline-soft)'
              }`}
            >
              {active && <Check size={12} className="text-(--accent)" />}
              {THINKING_LEVEL_LABEL[level]}
            </button>
          )
        })}
      </div>
    </Field>
  )
}
