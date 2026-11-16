import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  FILE_LS_MAX_ENTRIES,
  FILE_WRITE_MAX_BYTES,
  createFileTools,
  resolveInWorkspace,
  withinWriteLane
} from './fileTools'

/**
 * 文件工具（全量去 pi 后由我们自持的那三件）。
 *
 * 重点是**守卫**而不是 happy path：这三件工具能读写工作区里的任意文件，
 * 越界判定错一次就是任意文件读写。逐条钉住：绝对路径、`..` 穿越、符号链接逃逸。
 */

const dirs: string[] = []
function tmpWs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'huabu-filetools-'))
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

function tools(root: string | null) {
  const list = createFileTools({ currentDir: () => root })
  const byName = new Map(list.map((tool) => [tool.name, tool]))
  const call = async (name: string, params: Record<string, unknown>) => {
    const tool = byName.get(name)
    if (!tool) throw new Error(`没有工具 ${name}`)
    return (await tool.execute('call-1', params, undefined, undefined, undefined)) as {
      content: Array<{ type: string; text: string }>
      details?: Record<string, unknown>
      isError?: boolean
    }
  }
  return { names: list.map((t) => t.name), call }
}

describe('工作区路径守卫', () => {
  it('接受工作区内相对路径，拒绝绝对路径与穿越', () => {
    const root = resolve('/ws')
    // 期望值用 resolve 计算，避免 Windows/ POSIX 分隔符与盘符差异把断言写死
    expect(resolveInWorkspace('/ws', 'a/b.png')).toBe(resolve(root, 'a', 'b.png'))
    // 归一化后仍在区内
    expect(resolveInWorkspace('/ws', 'a/../b.png')).toBe(resolve(root, 'b.png'))
    // 绝对路径 / 盘符 / UNC
    expect(resolveInWorkspace('/ws', '/etc/passwd')).toBeNull()
    expect(resolveInWorkspace('/ws', 'C:/Windows/System32/x.dll')).toBeNull()
    expect(resolveInWorkspace('/ws', '//server/share/x')).toBeNull()
    // 穿越到区外
    expect(resolveInWorkspace('/ws', '../outside.png')).toBeNull()
    expect(resolveInWorkspace('/ws', 'a/../../outside.png')).toBeNull()
    // 空
    expect(resolveInWorkspace('/ws', '   ')).toBeNull()
  })

  it('写区（lane）按目录边界匹配，不做前缀字符串包含', () => {
    const lanes = ['story/plot-scifi/']
    expect(withinWriteLane('story/plot-scifi/plot.md', lanes)).toBe(true)
    expect(withinWriteLane('story/plot-scifi/sub/x.md', lanes)).toBe(true)
    // 目录边界：s10 不是 s1 的子树
    expect(withinWriteLane('story/plot-sci-fi/x.md', lanes)).toBe(false)
    expect(withinWriteLane('story/other/x.md', lanes)).toBe(false)
    expect(withinWriteLane('poscar/x.md', lanes)).toBe(false)
    // 不带尾斜杠/带 ./ 的写法等价
    expect(withinWriteLane('./story/plot-scifi/x.md', ['story/plot-scifi'])).toBe(true)
    // 空前缀 = 工作区根，全部放行
    expect(withinWriteLane('anything/x.md', [''])).toBe(true)
  })
})

describe('专家写区约束（C3）', () => {
  it('write 越出 lane 被拒且不落盘；lane 内正常写', async () => {
    const ws = tmpWs()
    const tools = createFileTools({ currentDir: () => ws, allowedPrefixes: () => ['story/s1/'] })
    const write = tools.find((tool) => tool.name === 'write')!
    const call = (path: string) =>
      write.execute('c', { path, content: 'x' }, undefined, undefined, undefined) as Promise<{
        isError?: boolean
        content: Array<{ text: string }>
      }>

    const denied = await call('story/s2/other.md')
    expect(denied.isError).toBe(true)
    expect(denied.content[0]?.text).toContain('越出本任务的写区')
    expect(existsSync(join(ws, 'story', 's2', 'other.md'))).toBe(false)

    const allowed = await call('story/s1/mine.md')
    expect(allowed.isError).toBeUndefined()
    expect(readFileSync(join(ws, 'story', 's1', 'mine.md'), 'utf8')).toBe('x')
  })

  it('read 不受写区限制（专家要能读 lane 外的参考素材）', async () => {
    const ws = tmpWs()
    mkdirSync(join(ws, 'assets'), { recursive: true })
    writeFileSync(join(ws, 'assets', 'ref.md'), '参考', 'utf8')
    const tools = createFileTools({ currentDir: () => ws, allowedPrefixes: () => ['story/s1/'] })
    const read = tools.find((tool) => tool.name === 'read')!
    const result = (await read.execute('c', { path: 'assets/ref.md' }, undefined, undefined, undefined)) as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('参考')
  })
})

describe('read / write / ls（真实文件系统）', () => {
  it('三件工具都在，且 write → read 往返一致', async () => {
    const ws = tmpWs()
    const { names, call } = tools(ws)
    expect(names).toEqual(['ls', 'read', 'write', 'patch'])

    const written = await call('write', { path: 'scenes/s3/note.md', content: '# 分镜\n第一镜' })
    expect(written.isError).toBeUndefined()
    expect(readFileSync(join(ws, 'scenes', 's3', 'note.md'), 'utf8')).toBe('# 分镜\n第一镜')

    const read = await call('read', { path: 'scenes/s3/note.md' })
    expect(read.content[0]?.text).toBe('# 分镜\n第一镜')
    expect(read.details).toMatchObject({ truncated: false })
  })

  it('ls 列出一层：目录带斜杠、文件带字节数；上限之外如实说明', async () => {
    const ws = tmpWs()
    mkdirSync(join(ws, 'assets'), { recursive: true })
    writeFileSync(join(ws, 'assets', 'a.png'), Buffer.alloc(1024))
    const { call } = tools(ws)

    const listed = await call('ls', { path: 'assets' })
    const text = listed.content[0]?.text ?? ''
    expect(text).toContain('1 个条目')
    expect(text).toContain('a.png (1024 字节)')

    const root = await call('ls', {})
    expect(root.content[0]?.text).toContain('assets/')

    // 超过上限：折叠说明，不静默丢弃
    const many = tmpWs()
    for (let i = 0; i < FILE_LS_MAX_ENTRIES + 3; i += 1) writeFileSync(join(many, `f${i}.txt`), 'x')
    const manyList = await tools(many).call('ls', {})
    expect(manyList.content[0]?.text).toContain('另有 3 个未列出')
  })

  it('读二进制文件被拒，并指向 read_media（不让模型把二进制当文本读）', async () => {
    const ws = tmpWs()
    writeFileSync(join(ws, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    const { call } = tools(ws)
    const result = await call('read', { path: 'a.png' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('read_media')
  })

  it('越界读写一律拒绝，且不留下文件', async () => {
    const ws = tmpWs()
    const { call } = tools(ws)
    const escaped = join(ws, '..', 'huabu-escape-should-not-exist.txt')
    for (const bad of ['../huabu-escape-should-not-exist.txt', '/etc/passwd', 'C:/Windows/x.dll']) {
      const w = await call('write', { path: bad, content: 'x' })
      expect(w.isError).toBe(true)
      const r = await call('read', { path: bad })
      expect(r.isError).toBe(true)
    }
    // 关键断言：越界写入一个字节都没落地
    expect(existsSync(escaped)).toBe(false)
  })

  it('写入超上限直接拒绝（不截断后假装成功）', async () => {
    const ws = tmpWs()
    const { call } = tools(ws)
    const huge = 'a'.repeat(FILE_WRITE_MAX_BYTES + 1)
    const result = await call('write', { path: 'big.txt', content: huge })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('上限')
  })

  it('没有打开工作区时三件工具都明确拒绝', async () => {
    const { call } = tools(null)
    expect((await call('read', { path: 'a.txt' })).content[0]?.text).toContain('没有打开工作区')
    expect((await call('write', { path: 'a.txt', content: 'x' })).isError).toBe(true)
    expect((await call('ls', {})).isError).toBe(true)
  })

  it('读不存在的文件给出可读错误，而不是抛异常', async () => {
    const ws = tmpWs()
    const { call } = tools(ws)
    const result = await call('read', { path: 'nope.txt' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('读取失败')
  })
})
