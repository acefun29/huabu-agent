/**
 * 工作区批量删除探针（deleteWorkspaces 的机器证据）。
 *
 * 运行：pnpm probe:workspace-delete
 *
 * 为什么要在 electron 里跑：删除走 shell.trashItem（移入系统回收站），纯 Node
 * 没有 shell 能力；守卫逻辑又长在 WorkspaceStore 私有字段（current/recents）上。
 * 探针用隔离 userData（不碰真实 recents.json），直接转译 store.ts 真调
 * deleteWorkspaces，断言：守卫拒绝（当前使用中/列表外/工作区根目录）、真实目录
 * 移入回收站后从磁盘消失、已消失目录只清登记、最近列表回传正确。
 *
 * 回收站侧只丢一个带时间戳前缀的迷你夹具目录（可在回收站辨识清理）。
 */
const { app } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 'ws-delete-probe-tmp')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 'workspace-delete-result.json')

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
function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}
function flush(startedAt) {
  mkdir(path.join(PROJECT_ROOT, 'out'))
  const pass = results.filter((r) => r.pass).length
  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify({ startedAt, pass, total: results.length, verdict: pass === results.length ? 'PASS' : 'FAIL', results }, null, 2),
    'utf8'
  )
}

/** 镜像转译 src/main + src/shared 全量（值导入全是相对路径，别名只在 import type 里会被擦除） */
function transpileAll() {
  fs.rmSync(TMP, { recursive: true, force: true })
  const sources = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.ts')) sources.push(full)
    }
  }
  walk(path.join(PROJECT_ROOT, 'src', 'main'))
  walk(path.join(PROJECT_ROOT, 'src', 'shared'))
  for (const source of sources) {
    const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: source,
      reportDiagnostics: true
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    assert(errors.length === 0, `${source} 转译失败：${errors.map((d) => d.messageText).join('; ')}`)
    const target = path.join(TMP, path.relative(PROJECT_ROOT, source)).replace(/\.ts$/, '.js')
    mkdir(path.dirname(target))
    fs.writeFileSync(target, outputText)
  }
}

const startedAt = new Date().toISOString()

app.setPath('userData', path.join(TMP, 'userData')) // 隔离：探针的 recents.json 不落真实位置

void app.whenReady().then(async () => {
  try {
    transpileAll()
    const { WorkspaceStore } = require(path.join(TMP, 'src', 'main', 'workspace', 'store.js'))
    const store = new WorkspaceStore()

    const root = path.resolve(process.cwd(), '.workspaces')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dirA = path.join(root, `__ws-probe-a-${stamp}__`) // 真目录：验证回收站
    const dirB = path.join(root, `__ws-probe-b-${stamp}__`) // 不存在的登记：验证只清登记
    mkdir(path.join(dirA, '.huabu'))
    fs.writeFileSync(path.join(dirA, '.huabu', 'workspace.json'), JSON.stringify({ version: 1 }))
    fs.writeFileSync(path.join(dirA, 'note.md'), '# probe\n')

    const summary = (p) => ({ path: p, name: path.basename(p), lastOpenedAt: new Date().toISOString() })
    const resetRecents = () => {
      store['recents'] = [summary(dirA), summary(dirB), summary(root)]
      store['current'] = null
    }

    await check('守卫：当前打开的工作区拒绝删除', async () => {
      resetRecents()
      store['current'] = { path: dirA }
      const result = await store.deleteWorkspaces([dirA])
      assert(result.removed.length === 0 && result.failures.length === 1, '应整单拒绝')
      assert(result.failures[0].error.includes('正在使用中'), `文案不符：${result.failures[0].error}`)
      assert(fs.existsSync(dirA), '目录不应被动')
      return result.failures[0].error
    })

    await check('守卫：不在最近列表的路径拒绝（防伪造 IPC）', async () => {
      resetRecents()
      const outside = path.join(os.tmpdir(), `__ws-probe-outside-${stamp}__`)
      const result = await store.deleteWorkspaces([outside])
      assert(result.failures.length === 1 && result.failures[0].error.includes('不在工作区最近列表中'), '应拒绝列表外路径')
      return '已拒绝'
    })

    await check('守卫：工作区根目录拒绝删除（防一锅端）', async () => {
      resetRecents()
      const result = await store.deleteWorkspaces([root])
      assert(result.failures.length === 1 && result.failures[0].error.includes('工作区根目录'), '应拒绝根目录')
      assert(fs.existsSync(root), '根目录不应被动')
      return result.failures[0].error
    })

    await check('删除：真目录移入回收站，磁盘消失且移出最近列表', async () => {
      resetRecents()
      const result = await store.deleteWorkspaces([dirA])
      assert(result.failures.length === 0, `不应有失败：${JSON.stringify(result.failures)}`)
      assert(result.removed.length === 1 && result.removed[0].path === dirA, 'removed 应含 dirA')
      assert(!fs.existsSync(dirA), '目录应已移入回收站（磁盘消失）')
      return `已移入回收站：${path.basename(dirA)}`
    })

    await check('删除：已消失的登记只清记录不报错；recents 回传最新清单', async () => {
      resetRecents()
      const result = await store.deleteWorkspaces([dirB])
      assert(result.failures.length === 0 && result.removed.length === 1, '消失目录应记为已清理')
      assert(
        result.recents.length === 2 && result.recents.some((r) => r.path === dirA) && result.recents.some((r) => r.path === root),
        'recents 应只剩 dirA 与根目录条目'
      )
      assert(!fs.existsSync(path.join(root, `__ws-probe-b-${stamp}__`)), 'dirB 本就不该存在')
      return '登记清理成功'
    })

    await check('回收站夹具清理：探针产生的真实删除共 1 个目录', async () => {
      const left = fs.existsSync(dirA) || fs.existsSync(dirB)
      assert(!left, '夹具目录不应残留磁盘')
      return '磁盘无残留（回收站内有 1 个带 __ws-probe-a 前缀的迷你目录）'
    })
  } catch (error) {
    results.push({ name: '探针整体', pass: false, detail: String(error) })
    console.log('FAIL 探针整体 —', error)
  }

  flush(startedAt)
  const pass = results.filter((r) => r.pass).length
  console.log(`\n${pass}/${results.length} passed -> ${RESULT_PATH}`)
  app.exit(pass === results.length ? 0 : 1)
})
