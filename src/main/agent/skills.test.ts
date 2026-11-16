import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  defaultSkillSourceDirs,
  parseSkillFrontmatter,
  renderAvailableSkillsBlock,
  scanSkills,
  selectInjectable
} from './skills'

/**
 * 技能发现与注入（全量去 pi 后由我们自持）。
 *
 * 重点三件：frontmatter 解析的容错、扫描优先级（工作区覆盖内置、用户级优先）、
 * 以及注入块只含可注入条目（invalid 与 disabled 不能进系统提示词）。
 */

const dirs: string[] = []
function tmpDir(prefix = 'huabu-skills-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 句柄未释放时 best-effort */
    }
  }
})

function putSkill(root: string, dirName: string, frontmatter: string): void {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `${frontmatter}\n\n# 正文\n`, 'utf8')
}

describe('SKILL.md frontmatter 解析', () => {
  it('正常形态：name + description', () => {
    expect(parseSkillFrontmatter('---\nname: blockout-shot\ndescription: 白模预演\n---\n正文')).toEqual({
      name: 'blockout-shot',
      description: '白模预演'
    })
  })

  it('支持引号包裹与 CRLF / BOM', () => {
    const parsed = parseSkillFrontmatter('\uFEFF---\r\nname: "quoted"\r\ndescription: \'单引号\'\r\n---\r\n正文')
    expect(parsed).toMatchObject({ name: 'quoted', description: '单引号' })
  })

  it('缺 frontmatter / 未闭合 / 缺 name 都给出可读原因', () => {
    expect(parseSkillFrontmatter('# 没有 frontmatter').problem).toContain('缺 frontmatter')
    expect(parseSkillFrontmatter('---\nname: x\n').problem).toContain('未闭合')
    expect(parseSkillFrontmatter('---\ndescription: 只有描述\n---\n').problem).toContain('缺 name')
  })
})

describe('扫描与优先级', () => {
  it('用户级 → 工作区级 → 内置：先来者胜，工作区同名覆盖内置', () => {
    const home = tmpDir('huabu-home-')
    const ws = tmpDir()
    const builtin = tmpDir('huabu-builtin-')

    putSkill(join(home, '.agents', 'skills'), 'shared', '---\nname: shared\ndescription: 用户级版本\n---')
    putSkill(join(ws, '.huabu', 'skills'), 'shared', '---\nname: shared\ndescription: 工作区版本\n---')
    putSkill(join(ws, '.huabu', 'skills'), 'local', '---\nname: local\ndescription: 工作区独有\n---')
    putSkill(builtin, 'blockout-shot', '---\nname: blockout-shot\ndescription: 内置版\n---')
    // 工作区用同名技能覆盖内置版
    putSkill(join(ws, '.huabu', 'skills'), 'blockout-shot', '---\nname: blockout-shot\ndescription: 覆盖版\n---')

    const { skills, scannedDirs } = scanSkills({ workspaceDir: ws, homeDir: home, builtinRoots: [builtin] })
    expect(scannedDirs.map((entry) => entry.source)).toEqual(['user', 'workspace', 'builtin'])
    const byName = new Map(skills.map((skill) => [skill.name, skill]))
    // 用户级排在扫描链最前 → 同名时赢
    expect(byName.get('shared')?.description).toBe('用户级版本')
    expect(byName.get('local')?.description).toBe('工作区独有')
    // 内置被工作区覆盖
    expect(byName.get('blockout-shot')?.description).toBe('覆盖版')
    expect(byName.get('blockout-shot')?.source).toBe('workspace')
  })

  it('内置技能在没有任何覆盖时照样被发现（blockout 依赖它）', () => {
    const home = tmpDir('huabu-home-')
    const ws = tmpDir()
    const builtin = tmpDir('huabu-builtin-')
    putSkill(builtin, 'blockout-shot', '---\nname: blockout-shot\ndescription: 内置版\n---')

    const skills = scanSkills({ workspaceDir: ws, homeDir: home, builtinRoots: [builtin] }).skills
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'blockout-shot', source: 'builtin' })
    expect(skills[0]?.filePath).toBe(join(builtin, 'blockout-shot', 'SKILL.md'))
  })

  it('没有 SKILL.md 的子目录不算技能；frontmatter 坏掉的标 invalid 但仍列出', () => {
    const home = tmpDir('huabu-home-')
    const ws = tmpDir()
    const root = join(ws, '.huabu', 'skills')
    mkdirSync(join(root, 'templates-only'), { recursive: true })
    mkdirSync(join(root, 'broken'), { recursive: true })
    writeFileSync(join(root, 'broken', 'SKILL.md'), '# 没有 frontmatter', 'utf8')

    const skills = scanSkills({ workspaceDir: ws, homeDir: home }).skills
    expect(skills.map((skill) => skill.name)).toEqual(['broken'])
    expect(skills[0]?.invalid).toContain('缺 frontmatter')
  })

  it('目录不存在不报错（不是错误，只是没有技能）', () => {
    const home = tmpDir('huabu-home-')
    const ws = tmpDir()
    expect(scanSkills({ workspaceDir: ws, homeDir: home })).toEqual({ skills: [], scannedDirs: [] })
    expect(defaultSkillSourceDirs({ workspaceDir: ws, homeDir: home })[0]?.dir).toBe(join(home, '.agents', 'skills'))
  })
})

describe('注入块', () => {
  const skill = (name: string, description: string, extra: Record<string, unknown> = {}) => ({
    name,
    description,
    dir: name,
    source: 'workspace' as const,
    filePath: `/ws/.huabu/skills/${name}/SKILL.md`,
    ...extra
  })

  it('没有可注入条目时返回空串（不留空标题段）', () => {
    expect(renderAvailableSkillsBlock([])).toBe('')
    expect(renderAvailableSkillsBlock([skill('broken', '', { invalid: '缺 name' })])).toBe('')
  })

  it('含 name/description/绝对 location，且提示用 read 打开正文', () => {
    const block = renderAvailableSkillsBlock([skill('blockout-shot', '白模预演')])
    expect(block).toContain('<available_skills>')
    expect(block).toContain('<name>blockout-shot</name>')
    expect(block).toContain('<description>白模预演</description>')
    expect(block).toContain('SKILL.md</location>')
    expect(block).toContain('用 read 打开它的 location')
  })

  it('XML 转义：description 里的尖括号不会破坏结构', () => {
    const block = renderAvailableSkillsBlock([skill('x', '用 <tag> & 符号')])
    expect(block).toContain('用 &lt;tag&gt; &amp; 符号')
    // 未转义的原样不应出现（除结构标签外）
    expect(block).not.toContain('<tag>')
  })

  it('disabled 与 invalid 都不进注入块', () => {
    const all = [skill('keep', 'a'), skill('gone', 'b'), skill('bad', 'c', { invalid: '缺 name' })]
    const injectable = selectInjectable(all, new Set(['gone']))
    expect(injectable.map((s) => s.name)).toEqual(['keep'])
    expect(renderAvailableSkillsBlock(injectable)).toContain('<name>keep</name>')
  })
})
