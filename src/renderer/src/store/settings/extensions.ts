/**
 * 技能与 MCP 服务器配置状态。
 *
 * 两者都挂在 workspace.json 上，随工作区刷新；MCP 运行态是异步收敛的，
 * 这里订阅 mcp:status 事件更新徽章，并用请求序号丢弃过期回包。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { McpServerConfig, McpServerRuntimeInfo, SkillInfo } from '@shared/ipc'
import { hasBridge } from './bridge'

/** 剥掉运行态字段，得到可提交的纯配置 */
function toConfig(list: McpServerRuntimeInfo[]): McpServerConfig[] {
  return list.map(({ status: _s, toolCount: _t, error: _e, ...config }) => config)
}

export function useExtensionsSettingsState() {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerRuntimeInfo[]>([])
  const skillsSequence = useRef(0)
  const mcpSequence = useRef(0)

  /** 拉取技能与 MCP 清单；refreshAll 与 mcp:status 事件共用 */
  const refreshExtensions = useCallback(async () => {
    if (!hasBridge()) return
    const skillsRequest = ++skillsSequence.current
    const mcpRequest = ++mcpSequence.current
    const [skillsResult, mcpResult] = await Promise.all([
      window.huabu.settings.skillsList(),
      window.huabu.settings.mcpStatus()
    ])
    if (skillsRequest === skillsSequence.current && skillsResult.ok) setSkills(skillsResult.value.skills)
    if (mcpRequest === mcpSequence.current && mcpResult.ok) setMcpServers(mcpResult.value.servers)
  }, [])

  // MCP 连接状态是异步收敛的（npx 冷启动可达十几秒）：订阅 mcp:status 拉最新徽章
  useEffect(() => {
    if (!hasBridge()) return
    return window.huabu.settings.onMcpStatus(() => {
      const requestId = ++mcpSequence.current
      void window.huabu.settings.mcpStatus().then((result) => {
        if (requestId === mcpSequence.current && result.ok) setMcpServers(result.value.servers)
      })
    })
  }, [])

  /** 工作区切换时清空清单并让在途请求失效（不清 MCP 运行态，避免界面闪空） */
  const resetExtensions = useCallback(() => {
    skillsSequence.current += 1
    mcpSequence.current += 1
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
            if (!result.ok) void refreshExtensions()
          })
      }
    },
    [skills, refreshExtensions]
  )

  /** 整表提交 MCP 服务器配置（主进程落盘 + 同步连接池，返回最新运行态） */
  const setMcpServersRemote = useCallback(async (servers: McpServerConfig[]): Promise<McpServerRuntimeInfo[] | null> => {
    if (!hasBridge()) return null
    const result = await window.huabu.settings.mcpSet({ servers })
    if (!result.ok) return null
    mcpSequence.current += 1
    setMcpServers(result.value.servers)
    return result.value.servers
  }, [])

  const toggleMcp = useCallback(
    (name: string) => {
      mcpSequence.current += 1
      const next = mcpServers.map((s) => (s.name === name ? { ...s, enabled: !s.enabled } : s))
      setMcpServers(
        next.map((s) =>
          s.name === name ? { ...s, status: s.enabled ? ('starting' as const) : ('disabled' as const) } : s
        )
      )
      void setMcpServersRemote(toConfig(next))
    },
    [mcpServers, setMcpServersRemote]
  )

  /**
   * 新增 MCP 服务器（表单文本 → 结构化配置）。args 按空白分词、env 按行解析 KEY=VALUE。
   * 返回错误文案（名称非法/重复等，主进程校验），成功返回 null。
   */
  const addMcp = useCallback(
    async (server: { name: string; command: string; args: string; env: string }): Promise<string | null> => {
      const name = server.name.trim()
      const command = server.command.trim()
      if (!name) return '名称不能为空'
      if (!command) return '启动命令不能为空'
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return '名称只允许字母/数字/横线/下划线'
      const args = server.args.trim().split(/\s+/).filter(Boolean)
      const env: Record<string, string> = {}
      for (const line of server.env.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) return `环境变量格式应为 KEY=VALUE：${trimmed}`
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
      }
      const result = await setMcpServersRemote([
        ...toConfig(mcpServers),
        { id: `mcp-${name}-${Date.now()}`, name, command, args, ...(Object.keys(env).length > 0 ? { env } : {}), enabled: true }
      ])
      return result ? null : '保存失败（详见主进程日志）'
    },
    [mcpServers, setMcpServersRemote]
  )

  const removeMcp = useCallback(
    (name: string) => {
      mcpSequence.current += 1
      const next = mcpServers.filter((s) => s.name !== name)
      setMcpServers(next)
      void setMcpServersRemote(toConfig(next))
    },
    [mcpServers, setMcpServersRemote]
  )

  const refreshMcp = useCallback(() => {
    void refreshExtensions()
  }, [refreshExtensions])

  return useMemo(
    () => ({
      skills,
      toggleSkill,
      mcpServers,
      toggleMcp,
      addMcp,
      removeMcp,
      refreshMcp,
      refreshExtensions,
      resetExtensions
    }),
    [skills, toggleSkill, mcpServers, toggleMcp, addMcp, removeMcp, refreshMcp, refreshExtensions, resetExtensions]
  )
}

export type ExtensionsSettingsState = ReturnType<typeof useExtensionsSettingsState>
