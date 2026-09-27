/**
 * 素材拖拽归档探针（asset:transfer 后端 transferToLibrary 的真机文件系统证据）。
 *
 * 运行：pnpm probe:asset-transfer
 *
 * transferToLibrary 是纯 fs 编排（只依赖 store.currentDir / store.getLibraries()，
 * 不碰 electron app 模块），本探针在 electron 里转译后用 mock store 直调，
 * 在临时工作区里真删真建，断言的是磁盘事实：
 *
 *   移动：assets/ 分类文件 → 命名库（rename，原位置消失）
 *   同库拦截：源目录 === 目标目录 → 单条失败，文件不动
 *   重名序号：目标已有同名 → -2 后缀，绝不覆盖
 *   越界：../ 逃出工作区 → 拒绝
 *   复制：OS 外部文件 → copy 进库目录，源文件仍在
 *   builtin 目标：'builtin-assets' → 按扩展名归位分类子目录
 *   幽灵库：libraryId 不存在 → 抛可操作错误
 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 'asset-transfer-tmp')
const WS = path.join(TMP, 'ws')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 'asset-transfer-result.json')

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
function write(rel, content = 'x') {
  const abs = path.join(WS, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return abs
}
const existsRel = (rel) => fs.existsSync(path.join(WS, rel))

function transpileToTmp(relSources) {
  fs.rmSync(TMP, { recursive: true, force: true })
  for (const rel of relSources) {
    const source = path.join(PROJECT_ROOT, rel)
    const { outputText, diagnostics } = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: source,
      reportDiagnostics: true
    })
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    assert(errors.length === 0, `${rel} 转译失败：${errors.map((d) => d.messageText).join('; ')}`)
    const target = path.join(TMP, rel).replace(/\.ts$/, '.js')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, outputText)
  }
}

// manager.ts 值导入了 workspace/store（copyIntoDir）；真身拖 electron app 链，
// 探针给同语义 stub（copyFileSync 的目录自备版，见 store.ts copyIntoDir）。
// stub 文件在 transpileToTmp（它会清空 TMP）之后写入。
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '../workspace/store') {
    return origResolve.call(this, path.join(TMP, 'stubs', 'workspace-store.js'), parent, ...rest)
  }
  return origResolve.call(this, request, parent, ...rest)
}
function writeWorkspaceStoreStub() {
  fs.mkdirSync(path.join(TMP, 'stubs'), { recursive: true })
  fs.writeFileSync(
    path.join(TMP, 'stubs', 'workspace-store.js'),
    [
      "const fs = require('node:fs')",
      'module.exports.copyIntoDir = function copyIntoDir(src, destDir, destName) {',
      "  fs.mkdirSync(destDir, { recursive: true })",
      "  const dest = require('node:path').join(destDir, destName)",
      "  fs.copyFileSync(src, dest)",
      '  return dest',
      '}',
      'module.exports.WorkspaceStore = class WorkspaceStore {}'
    ].join('\n'),
    'utf8'
  )
}

const startedAt = new Date().toISOString()

void app
  .whenReady()
  .then(async () => {
    transpileToTmp([
      path.join('src', 'main', 'assets', 'manager.ts'),
      path.join('src', 'main', 'assets', 'tagsIndex.ts'),
      path.join('src', 'shared', 'assets.ts'),
      path.join('src', 'shared', 'ipc.ts')
    ])
    writeWorkspaceStoreStub()
    const { transferToLibrary } = require(path.join(TMP, 'src', 'main', 'assets', 'manager.js'))
    const { renameAsset, deleteAsset } = require(path.join(TMP, 'src', 'main', 'assets', 'manager.js'))

    fs.mkdirSync(WS, { recursive: true })
    // 夹具工作区：一个命名库 + 公共库 + 分类目录里的两个文件 + 库内一个同名占位
    write('assets/images/poster.png', 'poster')
    write('assets/images/dup.png', 'dup-source')
    write('素材库/A/dup.png', 'dup-occupies')
    write('素材库/B/inside-b.png', 'in-b')
    const outside = path.join(TMP, 'outside.txt')
    fs.writeFileSync(outside, 'os-file', 'utf8')

    const store = {
      currentDir: WS,
      getLibraries: () => [
        { id: 'lib-a', name: 'A', path: '素材库/A' },
        { id: 'lib-b', name: 'B', path: '素材库/B', isPublic: true }
      ]
    }

    await check('移动：画布素材 → 命名库 = rename，原位置消失', () => {
      const out = transferToLibrary(store, { libraryId: 'lib-a', movePaths: ['assets/images/poster.png'] })
      assert(out.moved.length === 1 && out.failed.length === 0, JSON.stringify(out))
      assert(out.moved[0].to === '素材库/A/poster.png', `to=${out.moved[0].to}`)
      assert(existsRel('素材库/A/poster.png') && !existsRel('assets/images/poster.png'), '磁盘文件没有真正移动')
      return 'moved.to = 素材库/A/poster.png'
    })

    await check('同库拦截：源目录 === 目标目录 → 单条失败，文件不动', () => {
      const out = transferToLibrary(store, { libraryId: 'lib-b', movePaths: ['素材库/B/inside-b.png'] })
      assert(out.moved.length === 0 && out.failed.length === 1, JSON.stringify(out))
      assert(/已在该素材库/.test(out.failed[0].error), `error=${out.failed[0].error}`)
      assert(existsRel('素材库/B/inside-b.png'), '文件不应被移动')
      return 'failed.info = 已在该素材库中'
    })

    await check('重名序号：目标已有同名 → -2 后缀，两个文件都在', () => {
      const out = transferToLibrary(store, { libraryId: 'lib-a', movePaths: ['assets/images/dup.png'] })
      assert(out.moved.length === 1, JSON.stringify(out))
      assert(out.moved[0].name === 'dup-2.png', `name=${out.moved[0].name}`)
      assert(existsRel('素材库/A/dup.png') && existsRel('素材库/A/dup-2.png'), '覆盖或丢了文件')
      return 'dup.png → dup-2.png'
    })

    await check('越界拒绝：../ 逃出工作区 → 单条失败', () => {
      const out = transferToLibrary(store, { libraryId: 'lib-a', movePaths: ['../ws/assets/images/nope.png'] })
      assert(out.moved.length === 0 && out.failed.length === 1, JSON.stringify(out))
      return 'failed.info 含越界/不存在'
    })

    await check('复制：OS 外部文件 → 进库目录，源文件仍在', () => {
      const out = transferToLibrary(store, {
        libraryId: 'lib-a',
        copyFiles: [{ sourcePath: outside, name: 'outside.txt' }]
      })
      assert(out.copied.length === 1 && out.failed.length === 0, JSON.stringify(out))
      assert(out.copied[0].relPath === '素材库/A/outside.txt', `relPath=${out.copied[0].relPath}`)
      assert(existsRel('素材库/A/outside.txt') && fs.existsSync(outside), '复制后源不应消失')
      return 'copied.relPath = 素材库/A/outside.txt'
    })

    await check('builtin 目标：按扩展名归位分类子目录', () => {
      write('素材库/B/shot.png', 'shot')
      const out = transferToLibrary(store, { libraryId: 'builtin-assets', movePaths: ['素材库/B/shot.png'] })
      assert(out.moved.length === 1 && out.moved[0].to === 'assets/images/shot.png', JSON.stringify(out.moved))
      assert(existsRel('assets/images/shot.png'), '没落到 assets/images/')
      return 'shot.png → assets/images/shot.png'
    })

    await check('幽灵库：libraryId 不存在 → 抛可操作错误', () => {
      let threw = null
      try {
        transferToLibrary(store, { libraryId: 'ghost', movePaths: ['assets/images/shot.png'] })
      } catch (e) {
        threw = e
      }
      assert(threw && /素材库不存在/.test(threw.message), `应抛错，实际：${threw}`)
      return 'error = 素材库不存在：ghost'
    })

    await check('重命名：同目录改名 + 标签索引键随迁', () => {
      const { setFileTags, loadTagsIndex } = require(path.join(TMP, 'src', 'main', 'assets', 'tagsIndex.js'))
      write('素材库/B/ren-me.md', 'x')
      setFileTags(WS, '素材库/B/ren-me.md', ['待改'])
      const out = renameAsset(store, { relPath: '素材库/B/ren-me.md', newName: '已改.md' })
      assert(out.relPath === '素材库/B/已改.md' && out.name === '已改.md', JSON.stringify(out))
      assert(existsRel('素材库/B/已改.md') && !existsRel('素材库/B/ren-me.md'), '磁盘没有真正改名')
      const index = loadTagsIndex(WS)
      assert(index['素材库/B/已改.md']?.[0] === '待改', `标签应随迁：${JSON.stringify(index)}`)
      assert(index['素材库/B/ren-me.md'] === undefined, '旧键应删除')
      return '文件 + 标签索引都改名'
    })

    await check('重命名：重名自动加序号；非法字符净化；同名 no-op', () => {
      write('素材库/B/dup-rename.md', 'a')
      write('素材库/B/dup-rename-2.md', 'b')
      const out = renameAsset(store, { relPath: '素材库/B/dup-rename-2.md', newName: 'dup-rename.md' })
      // -2 位被源文件自己占着（rename 前源还在原位），序号继续后移到 -3 —— 无覆盖、名字单调
      assert(out.name === 'dup-rename-3.md', `重名应加序号：${out.name}`)
      // 净化：把 dup-rename.md 改成带非法字符的名（此后它就叫净化名了，后续步骤用新名）
      const dirty = renameAsset(store, { relPath: '素材库/B/dup-rename.md', newName: '带:非法*名.md' })
      assert(dirty.name === '带_非法_名.md', `非法字符应净化：${dirty.name}`)
      // 同名 no-op：不落 rename、不迁移索引（文件保持净化名）
      const same = renameAsset(store, { relPath: '素材库/B/带_非法_名.md', newName: '带_非法_名.md' })
      assert(same.relPath === '素材库/B/带_非法_名.md', '同名应 no-op 回显')
      assert(existsRel('素材库/B/带_非法_名.md') && !existsRel('素材库/B/dup-rename.md'), '磁盘状态符合改名链')
      return '序号 + 净化 + no-op'
    })

    await check('重命名：越界与不存在拒绝；空名拒绝', () => {
      let threw = null
      try {
        renameAsset(store, { relPath: '../outside.md', newName: 'x.md' })
      } catch (e) {
        threw = e
      }
      assert(threw && /越出工作区|文件不存在/.test(threw.message), `越界应抛错：${threw}`)
      threw = null
      try {
        renameAsset(store, { relPath: '素材库/B/带_非法_名.md', newName: '   ' })
      } catch (e) {
        threw = e
      }
      assert(threw && /不能为空/.test(threw.message), `空名应抛错：${threw}`)
      return '三重拒绝'
    })

    await check('删除：真删文件 + 标签索引键清理；越界拒绝', () => {
      const { setFileTags, loadTagsIndex } = require(path.join(TMP, 'src', 'main', 'assets', 'tagsIndex.js'))
      write('素材库/B/del-me.md', 'x')
      setFileTags(WS, '素材库/B/del-me.md', ['临'])
      deleteAsset(store, { relPath: '素材库/B/del-me.md' })
      assert(!existsRel('素材库/B/del-me.md'), '文件应被删除')
      assert(loadTagsIndex(WS)['素材库/B/del-me.md'] === undefined, '标签键应清理')
      let threw = null
      try {
        deleteAsset(store, { relPath: '../outside.md' })
      } catch (e) {
        threw = e
      }
      assert(threw && /越出工作区|文件不存在/.test(threw.message), `越界应抛错：${threw}`)
      return '删除 + 清键 + 拒越界'
    })

    const pass = results.filter((r) => r.pass).length
    const allPass = pass === results.length
    console.log(`\n============ probe:asset-transfer ${pass}/${results.length} ${allPass ? 'PASS' : 'FAIL'} ============`)
    fs.mkdirSync(path.join(PROJECT_ROOT, 'out'), { recursive: true })
    fs.writeFileSync(
      RESULT_PATH,
      JSON.stringify({ startedAt, pass, total: results.length, verdict: allPass ? 'PASS' : 'FAIL', results }, null, 2),
      'utf8'
    )
    fs.rmSync(TMP, { recursive: true, force: true })
    app.exit(allPass ? 0 : 2)
  })
  .catch((error) => {
    console.log(`ERROR ${error && error.stack ? error.stack : error}`)
    results.push({ name: '夹具/运行', pass: false, detail: String(error && error.stack ? error.stack : error) })
    fs.mkdirSync(path.join(PROJECT_ROOT, 'out'), { recursive: true })
    fs.writeFileSync(
      RESULT_PATH,
      JSON.stringify({ startedAt, pass: 0, total: results.length, verdict: 'ERROR', results }, null, 2),
      'utf8'
    )
    app.exit(3)
  })
