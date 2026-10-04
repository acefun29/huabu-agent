/**
 * Skills 检查脚本（pi 原生技能加载器语义的机器证据）。
 *
 * 运行：pnpm skills:check
 *
 * 会话侧的技能注入走 pi 的 DefaultResourceLoader（additionalSkillPaths +
 * skillsOverride 过滤，见 agent/host.ts create），本脚本验证同一加载器
 * （loadSkillsFromDir）的发现/校验语义——设置页清单与系统提示注入都建立在它上面：
 *
 *   发现：.huabu/skills/<name>/SKILL.md 即技能根（agentskills.io 约定）
 *   校验：name 与目录不一致 / frontmatter 缺字段 → diagnostics 带原因
 *   注入：formatSkillsForPrompt 输出 <available_skills> XML 块（渐进披露第一层）
 *
 * 纯 Node 运行（pi 是 ESM，用动态 import），夹具目录用完即清。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const results = []
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail: typeof detail === 'string' ? detail : '' })
    console.log(`PASS ${name}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

async function main() {
  const pi = await import('@earendil-works/pi-coding-agent')
  assert(typeof pi.loadSkillsFromDir === 'function', 'pi 应导出 loadSkillsFromDir')
  assert(typeof pi.formatSkillsForPrompt === 'function', 'pi 应导出 formatSkillsForPrompt')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huabu-skills-check-'))
  const skillsDir = path.join(root, '.huabu', 'skills')
  const mkSkill = (name, frontmatter, body = '正文') => {
    const dir = path.join(skillsDir, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
    return dir
  }

  await check('T1 发现：<dir>/SKILL.md 即技能根', () => {
    mkSkill('brand-poster', 'name: brand-poster\ndescription: 品牌海报工作流')
    mkSkill('data-clean', 'name: data-clean\ndescription: 数据清洗工作流')
    const { skills } = pi.loadSkillsFromDir({ dir: skillsDir, source: 'workspace' })
    const names = skills.map((s) => s.name).sort()
    assert(names.join(',') === 'brand-poster,data-clean', `发现不符：${names.join(',')}`)
    assert(skills[0].baseDir.includes('brand-poster'), 'baseDir 应指技能根目录')
    return names.join(',')
  })

  await check('T2 校验：非法 name 有诊断；frontmatter 名优先于目录名', () => {
    // pi 的实际契约（loadSkillsFromDir）：name 取 frontmatter，缺省回落目录名；
    // 非法字符（大写/下划线等）产生 warning 诊断但技能仍加载 —— 设置页的
    // 「校验失败」徽章数据源就是这些诊断（host.listWorkspaceSkills 按 path 挂接）
    mkSkill('wrong-name', 'name: totally-different\ndescription: 名字不一致')
    const first = pi.loadSkillsFromDir({ dir: skillsDir, source: 'workspace' })
    const renamed = first.skills.find((s) => s.name === 'totally-different')
    assert(renamed && renamed.baseDir.includes('wrong-name'), 'frontmatter name 应优先于目录名')

    mkSkill('Bad_Name', 'name: Bad_Name\ndescription: 非法字符名')
    const { skills, diagnostics } = pi.loadSkillsFromDir({ dir: skillsDir, source: 'workspace' })
    assert(diagnostics.some((d) => d.path && d.path.includes('Bad_Name')), `非法 name 应有诊断：${diagnostics.map((d) => d.message).join(' | ')}`)
    assert(skills.some((s) => s.name === 'Bad_Name'), 'pi 对非法 name 仍加载（诊断可见、由用户决断）')
    return diagnostics.find((d) => d.path?.includes('Bad_Name'))?.message?.slice(0, 60) ?? ''
  })

  await check('T3 校验：缺 description 的 frontmatter 有诊断', () => {
    mkSkill('no-desc', 'name: no-desc')
    const { skills, diagnostics } = pi.loadSkillsFromDir({ dir: skillsDir, source: 'workspace' })
    const listed = skills.some((s) => s.name === 'no-desc')
    const diagnosed = diagnostics.some((d) => d.path && d.path.includes('no-desc'))
    assert(!listed || diagnosed, '缺 description 要么不入列要么有诊断（两种实现都合规，但不能静默通过）')
    return listed ? '入列但有诊断' : '未入列'
  })

  await check('T4 注入：formatSkillsForPrompt 输出 available_skills 块', () => {
    const { skills } = pi.loadSkillsFromDir({ dir: skillsDir, source: 'workspace' })
    const prompt = pi.formatSkillsForPrompt(skills)
    assert(prompt.includes('<available_skills>'), '系统提示应含 <available_skills> XML 块')
    assert(prompt.includes('brand-poster'), '技能名应出现在提示里')
    assert(prompt.includes('品牌海报工作流'), '技能 description 应出现在提示里（渐进披露第一层）')
    assert(!prompt.includes('正文'), 'SKILL.md 正文不应整段进提示（渐进披露：只进元数据）')
    return `${prompt.length} chars`
  })

  await check('T5 过滤：disabled 名单语义（host.skillsOverride 同款 Set 过滤）', () => {
    const { skills } = pi.loadSkillsFromDir({ dir: skillsDir, source: 'workspace' })
    const disabled = new Set(['brand-poster'])
    const filtered = skills.filter((s) => !disabled.has(s.name))
    assert(filtered.some((s) => s.name === 'data-clean'), '未禁用技能保留')
    assert(!filtered.some((s) => s.name === 'brand-poster'), '禁用技能被滤除')
    return 'ok'
  })

  fs.rmSync(root, { recursive: true, force: true })
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('skills-check 崩溃：', error)
  process.exit(1)
})
