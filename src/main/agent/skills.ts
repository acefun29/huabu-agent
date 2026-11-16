/**
 * 工作区技能发现与注入（agentskills.io 规范）的自有实现。
 *
 * ## 为什么要有这个文件
 *
 * 运行时不会自动读取工作区技能：`buildAgentSystemPrompt` 只接收 workspaceDir，
 * 没有技能槽位。技能清单与禁用名单由这里扫描，再由提示词装配显式注入；
 * 否则「技能」只剩设置页展示，对话里完全不生效。
 *
 * ## 扫描与优先级
 *
 * 顺序与 Pi 侧 `create()` 注入时用的 `additionalSkillPaths` 一致，**先来者胜**：
 *
 *   1. `~/.agents/skills`      用户级（与 ZCode 等共享）
 *   2. `<workspace>/.huabu/skills`  工作区级（产品文档指定的位置）
 *   3. 内置 `resources/skills`（随包分发，如 blockout-shot）
 *
 * 内置放在最后，所以工作区/用户级同名技能覆盖内置版——保留开发期的覆盖能力。
 * 不再扫描 `<workspace>/.pi/skills`：那是 pi 专有目录，运行时都换掉了，留着只会
 * 让人以为它还有效。
 *
 * ## 纯函数边界
 *
 * 目录根由调用方注入（`builtinRoots` 走 `resolveBuiltinSkillsRoots()`，那里依赖
 * electron 的 `app`）——本模块不 import electron，因此可以在 node 单测里直接跑。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, relative, resolve, sep } from 'path'

export type SkillSource = 'user' | 'workspace' | 'builtin'

export interface SkillEntry {
  name: string
  description: string
  /** 展示用目录：home 下的用 `~` 缩写，工作区下的用相对路径，内置保持相对 resources */
  dir: string
  source: SkillSource
  /** `SKILL.md` 绝对路径（注入到提示词里，模型据此 read 正文） */
  filePath: string
  /** 校验失败原因（frontmatter 缺 name 等）；带 invalid 的条目**不注入会话** */
  invalid?: string
}

export interface SkillSourceDir {
  dir: string
  source: SkillSource
}

export interface ScanSkillsOptions {
  workspaceDir: string
  /** 用户主目录（默认 os.homedir()；测试可注入） */
  homeDir?: string
  /** 内置技能根（由调用方注入，避免本模块依赖 electron） */
  builtinRoots?: readonly string[]
}

export interface ScanSkillsResult {
  /** 全部条目（含 invalid，设置页要能解释「为什么没生效」） */
  skills: SkillEntry[]
  /** 实际存在并扫描过的目录（调试用） */
  scannedDirs: SkillSourceDir[]
}

/** 扫描顺序即优先级：先来者胜（同名不再覆盖） */
export function defaultSkillSourceDirs(options: ScanSkillsOptions): SkillSourceDir[] {
  const home = options.homeDir ?? homedir()
  return [
    { dir: join(home, '.agents', 'skills'), source: 'user' },
    { dir: join(options.workspaceDir, '.huabu', 'skills'), source: 'workspace' },
    ...(options.builtinRoots ?? []).map((dir) => ({ dir, source: 'builtin' as const }))
  ]
}

/**
 * 解析 `SKILL.md` 的 YAML frontmatter（只认本项目用到的两个键：name / description）。
 *
 * 刻意不引 YAML 库：技能元数据就这两个标量，多引一个解析器既增加攻击面（技能目录
 * 可能来自用户机器）也没必要。支持引号包裹与冒号后空白；其余键忽略。
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string; problem?: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { problem: '缺 frontmatter（文件需以 --- 开头）' }
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return { problem: 'frontmatter 未闭合（缺结尾 ---）' }
  const body = normalized.slice(4, end)
  const fields: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    let value = (match[2] ?? '').trim()
    // 去引号：`name: "x"` 与 `name: x` 等价
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  const name = fields.name?.trim()
  if (!name) return { problem: 'frontmatter 缺 name' }
  return { name, description: fields.description?.trim() ?? '' }
}

/** 展示用目录：home 下缩写成 `~`，工作区下给相对路径，其余原样 */
function displayDir(baseDir: string, workspaceDir: string, home: string): string {
  const abs = resolve(baseDir)
  const homeAbs = resolve(home)
  if (abs === homeAbs) return '~'
  if (abs.startsWith(homeAbs + sep)) return `~${abs.slice(homeAbs.length).replace(/\\/g, '/')}`
  const rel = relative(resolve(workspaceDir), abs)
  if (rel && !rel.startsWith('..')) return rel.replace(/\\/g, '/')
  return baseDir.replace(/\\/g, '/')
}

/**
 * 扫描所有技能目录。目录不存在直接跳过（不是错误）；单个技能读不出来只标 invalid，
 * 不影响其余条目——技能目录是用户机器上的内容，坏一个不能拖垮整张清单。
 */
export function scanSkills(options: ScanSkillsOptions): ScanSkillsResult {
  const home = options.homeDir ?? homedir()
  const candidates = defaultSkillSourceDirs({ ...options, homeDir: home })
  const scannedDirs = candidates.filter((entry) => existsSync(entry.dir))
  const byName = new Map<string, SkillEntry>()

  for (const { dir, source } of scannedDirs) {
    let children: string[]
    try {
      children = readdirSync(dir)
    } catch {
      continue
    }
    // 目录顺序稳定：设置页与注入块不随文件系统顺序抖动（抖了会破坏提示词缓存）
    children.sort()
    for (const child of children) {
      const skillDir = join(dir, child)
      try {
        if (!statSync(skillDir).isDirectory()) continue
      } catch {
        continue
      }
      const filePath = join(skillDir, 'SKILL.md')
      const shown = displayDir(skillDir, options.workspaceDir, home)
      let text: string
      try {
        if (!statSync(filePath).isFile()) continue
        text = readFileSync(filePath, 'utf8')
      } catch {
        // 没有 SKILL.md 的子目录不是技能（技能目录里可以有 templates/ 之类的附属目录）
        continue
      }
      const parsed = parseSkillFrontmatter(text)
      const name = parsed.name ?? child
      if (byName.has(name)) continue // 同名先来者胜
      byName.set(name, {
        name,
        description: parsed.description ?? '',
        dir: shown,
        source,
        filePath,
        ...(parsed.problem ? { invalid: parsed.problem } : {})
      })
    }
  }
  return { skills: [...byName.values()], scannedDirs }
}

/** 设置页的启用态过滤：只有 enabled 且无 invalid 的条目才注入 */
export function selectInjectable(
  skills: readonly SkillEntry[],
  disabled: ReadonlySet<string> = new Set()
): SkillEntry[] {
  return skills.filter((skill) => !skill.invalid && !disabled.has(skill.name))
}

/**
 * 渲染注入系统提示词的 `<available_skills>` 段。
 *
 * 返回空串表示没有可注入的技能（此时调用方不要拼接任何内容，避免留一段空标题）。
 * `location` 给**绝对路径**：模型要靠它去 `read` 技能正文，相对路径在 cwd 不确定时
 * 会读错地方。
 */
export function renderAvailableSkillsBlock(skills: readonly SkillEntry[]): string {
  const injectable = skills.filter((skill) => !skill.invalid)
  if (injectable.length === 0) return ''
  return [
    '<available_skills>',
    ...injectable.map((skill) =>
      [
        '  <skill>',
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        `    <location>${escapeXml(resolve(skill.filePath))}</location>`,
        '  </skill>'
      ].join('\n')
    ),
    '</available_skills>',
    '需要其中某个技能的完整流程时，用 read 打开它的 location；不要凭描述臆测步骤。'
  ].join('\n')
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
