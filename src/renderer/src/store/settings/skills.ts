/**
 * 工作区技能状态：清单扫描与启用开关。
 *
 * 技能清单挂在当前工作区上，切换工作区时清空并用请求序号丢弃在途旧回包。
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { SkillInfo } from '@shared/ipc'
import { hasBridge } from './bridge'

export function useSkillsSettingsState() {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const skillsSequence = useRef(0)

  /** 拉取当前工作区技能清单（refreshAll 与失败回滚共用） */
  const refreshSkills = useCallback(async () => {
    if (!hasBridge()) return
    const request = ++skillsSequence.current
    const result = await window.huabu.settings.skillsList()
    if (request === skillsSequence.current && result.ok) setSkills(result.value.skills)
  }, [])

  /** 工作区切换时清空清单并让在途请求失效 */
  const resetSkills = useCallback(() => {
    skillsSequence.current += 1
    setSkills([])
  }, [])

  /**
   * 技能开关：乐观更新 + 整表提交 disabled 名单（主进程写 workspace.json）。
   * IPC 在 updater 外触发——updater 会被 StrictMode 双调用，副作用放里面会双发。
   */
  const toggleSkill = useCallback(
    (name: string) => {
      skillsSequence.current += 1
      const next = skills.map((s) => (s.name === name ? { ...s, enabled: !s.enabled } : s))
      setSkills(next)
      if (hasBridge()) {
        void window.huabu.settings
          .skillsSetDisabled({ disabled: next.filter((s) => !s.enabled).map((s) => s.name) })
          .then((result) => {
            if (!result.ok) void refreshSkills()
          })
      }
    },
    [skills, refreshSkills]
  )

  return useMemo(
    () => ({ skills, toggleSkill, refreshSkills, resetSkills }),
    [skills, toggleSkill, refreshSkills, resetSkills]
  )
}

export type SkillsSettingsState = ReturnType<typeof useSkillsSettingsState>
