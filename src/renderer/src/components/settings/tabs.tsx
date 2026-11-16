// 设置面板其余 tab：Skills、外观

import { Moon, Sun } from 'lucide-react'
import { useAppearanceSettings, useSettings } from '../../store/settingsStore'
import { Row, Toggle } from './ui'

/* -------------------------------------------------------------------------- */
/* Skills / 外观                                                              */
/* -------------------------------------------------------------------------- */

const SKILL_EXAMPLE = `---
name: brand-poster
description: 品牌海报生成工作流：读取素材库品牌规范，产出多尺寸海报
---

## 步骤
1. 读取 素材库/品牌规范/ 下的规范文件
2. …`

export function SkillsTab() {
  const { skills, toggleSkill } = useSettings()
  return (
    <div className="space-y-3" data-testid="skills-tab">
      <p className="text-xs leading-relaxed text-(--on-surface-muted)">
        Skills 为 Agent 提供可复用的工作流能力（agentskills.io 规范）。来源有两级：
        用户级 <code className="rounded bg-(--surface-input) px-1">~/.agents/skills/</code>
        （跨工作区共享）与工作区级{' '}
        <code className="rounded bg-(--surface-input) px-1">.huabu/skills/&lt;name&gt;/SKILL.md</code>
        ，启用后随新会话注入系统提示；开关只影响之后新建的会话，已建会话不变。
      </p>
      {skills.length === 0 ? (
        <div className="rounded-2xl bg-(--surface-card) p-4 ring-1 ring-(--outline-soft)">
          <div className="text-[13px] font-medium text-(--on-surface)">还没有加载到任何技能</div>
          <div className="mt-1 text-xs leading-relaxed text-(--on-surface-muted)">
            把技能放到 <code className="rounded bg-(--surface-input) px-1">~/.agents/skills/&lt;name&gt;/</code>
            （用户级）或工作区 <code className="rounded bg-(--surface-input) px-1">.huabu/skills/&lt;name&gt;/</code>，各自包含
            SKILL.md（name 需与目录名一致，小写字母/数字/横线），frontmatter 示例：
          </div>
          <pre className="mt-2 overflow-x-auto rounded-xl bg-(--surface-input) p-3 font-mono text-[11px] leading-relaxed text-(--on-surface-variant)">
            {SKILL_EXAMPLE}
          </pre>
        </div>
      ) : (
        <div className="divide-y divide-(--outline-soft) rounded-2xl bg-(--surface-card) px-4 ring-1 ring-(--outline-soft)">
          {skills.map((s) => (
            <Row
              key={`${s.source}:${s.name}`}
              title={s.name}
              desc={
                <>
                  <span className="block">{s.invalid ? s.invalid : s.description}</span>
                  <span className="mt-0.5 block font-mono text-[10px] opacity-70">{s.dir}</span>
                </>
              }
              control={
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      s.source === 'user'
                        ? 'bg-(--surface-chip) text-(--on-surface-variant)'
                        : 'bg-(--success-bg) text-(--success-text)'
                    }`}
                  >
                    {/* 内置技能（resources/skills，如 blockout-shot）此前不进清单，用户没法停用；
                        现在如实列出来，来源分三档 */}
                    {s.source === 'user' ? '用户级' : s.source === 'builtin' ? '内置' : '工作区'}
                  </span>
                  {s.invalid && (
                    <span className="rounded-full bg-(--danger-bg, rgba(0,0,0,0.06)) px-2 py-0.5 text-[10px] font-medium text-(--danger)">
                      校验失败
                    </span>
                  )}
                  <Toggle checked={s.enabled} onChange={() => toggleSkill(s.name)} />
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function AppearanceTab() {
  const { appearance, setAppearance } = useAppearanceSettings()
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
      <Row
        title="引用链连线"
        desc="显示卡片间的引用链（生成时系统自动形成，只读不可拖拽）；快捷键 Shift+E"
        control={
          <Toggle
            checked={appearance.showReferenceEdges}
            onChange={(v) => setAppearance({ showReferenceEdges: v })}
          />
        }
      />
    </div>
  )
}
