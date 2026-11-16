import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileTools } from './fileTools'

/**
 * `patch`：局部修改（施工计划 §5 点名的工具）。
 *
 * 存在的理由：`studio.md` 每轮注入、有字符上限，改一行用 `write` 要整篇重输——
 * 费 token，还有抄漏原文的风险。patch 只要求给出改动的那一段。
 *
 * 断言重点在**不做出歧义修改**：找不到、命中多处，都必须拒绝而不是猜。
 */

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄未释放时留给系统清理
    }
  }
})

function workspace(files: Record<string, string> = {}): { dir: string; tools: ReturnType<typeof createFileTools> } {
  const dir = mkdtempSync(join(tmpdir(), 'huabu-patch-'))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return { dir, tools: createFileTools({ currentDir: () => dir }) }
}

function toolOf(tools: ReturnType<typeof createFileTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name)
  if (!tool) throw new Error(`没有工具 ${name}`)
  return tool
}

async function run(
  tools: ReturnType<typeof createFileTools>,
  name: string,
  params: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> {
  const result = await toolOf(tools, name).execute('c1', params, undefined, undefined, {})
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return { text, isError: result.isError === true }
}

describe('patch', () => {
  it('唯一命中的一段被替换，其余原样', async () => {
    const { dir, tools } = workspace({ '.huabu/memory/studio.md': '# 记忆\n\n- 暖色\n- 16:9\n' })
    const result = await run(tools, 'patch', {
      path: '.huabu/memory/studio.md',
      oldText: '- 16:9',
      newText: '- 16:9，不出现字幕'
    })
    expect(result.isError).toBe(false)
    expect(readFileSync(join(dir, '.huabu/memory/studio.md'), 'utf8')).toBe(
      '# 记忆\n\n- 暖色\n- 16:9，不出现字幕\n'
    )
  })

  it('newText 为空串 = 删除这一段', async () => {
    const { dir, tools } = workspace({ 'story/a.md': '第一行\n第二行\n第三行\n' })
    await run(tools, 'patch', { path: 'story/a.md', oldText: '第二行\n', newText: '' })
    expect(readFileSync(join(dir, 'story/a.md'), 'utf8')).toBe('第一行\n第三行\n')
  })

  it('找不到原文 → 拒绝，文件不动', async () => {
    const { dir, tools } = workspace({ 'a.md': 'hello\n' })
    const result = await run(tools, 'patch', { path: 'a.md', oldText: 'nope', newText: 'x' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('找不到')
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('hello\n')
  })

  it('命中多处 → 拒绝（不猜改哪一处）', async () => {
    const { dir, tools } = workspace({ 'a.md': 'x\nx\n' })
    const result = await run(tools, 'patch', { path: 'a.md', oldText: 'x', newText: 'y' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('多次')
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('x\nx\n')
  })

  it('文件不存在 → 提示用 write 新建', async () => {
    const { tools } = workspace()
    const result = await run(tools, 'patch', { path: 'new.md', oldText: 'a', newText: 'b' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('write')
  })

  it('oldText 为空 → 拒绝（不整篇覆盖）', async () => {
    const { tools } = workspace({ 'a.md': 'x' })
    const result = await run(tools, 'patch', { path: 'a.md', oldText: '', newText: 'y' })
    expect(result.isError).toBe(true)
  })

  it('越出工作区 → 拒绝', async () => {
    const { tools } = workspace()
    const result = await run(tools, 'patch', { path: '../escape.md', oldText: 'a', newText: 'b' })
    expect(result.isError).toBe(true)
  })

  it('越出写区 → 拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'huabu-patch-lane-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'a.md'), 'x', 'utf8')
    const tools = createFileTools({ currentDir: () => dir, allowedPrefixes: () => ['story'] })
    const result = await run(tools, 'patch', { path: 'a.md', oldText: 'x', newText: 'y' })
    expect(result.isError).toBe(true)
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('x')
  })
})
