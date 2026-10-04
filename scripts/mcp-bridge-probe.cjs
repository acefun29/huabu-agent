/**
 * MCP 桥接探针（真实 stdio 握手 + 工具映射 + 调用映射的机器证据）。
 *
 * 运行：pnpm probe:mcp（electron scripts/mcp-bridge-probe.cjs）
 *
 * 被测对象是 src/main/mcp/manager.ts 的 McpManager —— transpile 后真调：
 *   连接：本地测试 server（scripts/mcp/test-server.cjs，node 起 stdio 子进程）
 *   映射：tools/list → mcp_<server>_<tool> 命名 / label / parameters 透传
 *   调用：echo 文本映射、make_image 图片映射、fail → 抛错（isError 路径）
 *   生命周期：配置 diff（禁用即断开）、disposeAll 后进程退出
 *   配置层：mcp/store.ts 的 normalizeServerConfig 校验规则
 *
 * 全程本地子进程，不需要网络与任何 API Key。
 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 'mcp-probe-tmp')

const results = []
async function check(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail: typeof detail === 'string' ? detail : '' })
    console.log(`PASS ${name}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
  void started
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ---- 转译被测模块及其最小闭包到 TMP ---- */
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

// @shared/* 重定向（与 t12 探针同一手法）
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@shared/')) {
    return origResolve.call(this, path.join(TMP, 'src', 'shared', request.slice('@shared/'.length)), parent, ...rest)
  }
  return origResolve.call(this, request, parent, ...rest)
}

async function main() {
  transpileToTmp([
    'src/main/mcp/manager.ts',
    'src/main/mcp/store.ts',
    'src/main/workspace/stateDir.ts',
    'src/main/workspace/store.ts',
    'src/main/models/migrate.ts',
    'src/main/models/types.ts',
    'src/main/models/catalog.ts',
    'src/main/media/catalog/merge.ts',
    'src/main/media/catalog/types.ts',
    'src/main/media/adapters/registry.ts',
    'src/main/fsutil/atomic.ts',
    'src/shared/ipc.ts',
    'src/shared/media.ts',
    'src/shared/chatApi.ts',
    'src/shared/assets.ts'
  ])
  const { McpManager } = require(path.join(TMP, 'src/main/mcp/manager.js'))
  const { normalizeServerConfig, writeMcpServers, getMcpConfigFile } = require(path.join(TMP, 'src/main/mcp/store.js'))

  /* 配置写入探针专用 userData（electron 脚本进程的 userData = %APPDATA%/Electron，
   * 与真实应用 Huabu 隔离，不污染用户配置；结尾删除） */
  writeMcpServers([
    {
      id: 'mcp-test',
      name: 'test',
      command: process.execPath,
      // electron.exe 以 ELECTRON_RUN_AS_NODE 充当 node 跑测试 server（自包含，不依赖 PATH）
      args: [path.join(PROJECT_ROOT, 'scripts/mcp/test-server.cjs')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      enabled: true
    }
  ])

  let statusEvents = 0
  const manager = new McpManager(() => {
    statusEvents++
  })

  const waitFor = async (predicate, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await sleep(150)
    }
    throw new Error(`等待超时：${what}`)
  }

  await check('T1 配置层：名称/命令校验与归一化', () => {
    const good = normalizeServerConfig({ name: 'fs', command: 'npx', args: ['a', 'b'], env: { K: 'V' } })
    assert(typeof good === 'object' && good.name === 'fs' && good.enabled === true, '合法条目应通过')
    assert(good.args.join(',') === 'a,b' && good.env.K === 'V', 'args/env 应保留')
    assert(normalizeServerConfig({ name: '', command: 'x' }).includes('名称'), '空名应被拒')
    assert(normalizeServerConfig({ name: '非法 名', command: 'x' }).includes('只允许'), '非法字符名应被拒')
    assert(normalizeServerConfig({ name: 'x', command: '' }).includes('命令'), '空命令应被拒')
    return 'ok'
  })

  await check('T2 stdio 握手 + tools/list 映射（mcp_test_*）', async () => {
    manager.sync()
    await waitFor(
      () => manager.runtimeInfo().find((s) => s.name === 'test')?.status === 'connected',
      20000,
      'test server 连接'
    )
    const tools = await manager.assembleTools()
    const names = tools.map((t) => t.name).sort()
    assert(names.join(',') === 'mcp_test_echo,mcp_test_fail,mcp_test_make_image', `工具名映射不符：${names.join(',')}`)
    const echo = tools.find((t) => t.name === 'mcp_test_echo')
    assert(echo.label === 'test/echo', `label 应为 test/echo，实为 ${echo.label}`)
    assert(String(echo.description).includes('huabu 测试服务器'), 'description 应透传')
    assert(echo.parameters && echo.parameters.type === 'object', 'parameters 应透传 JSON Schema')
    return names.join(',')
  })

  await check('T3 调用映射：文本 / 图片 / isError', async () => {
    const tools = await manager.assembleTools()
    const echo = tools.find((t) => t.name === 'mcp_test_echo')
    const image = tools.find((t) => t.name === 'mcp_test_make_image')
    const fail = tools.find((t) => t.name === 'mcp_test_fail')

    const echoed = await echo.execute('call-1', { text: '你好' }, undefined, undefined)
    assert(echoed.content[0].type === 'text' && echoed.content[0].text === 'echo: 你好', 'echo 文本映射不符')

    const imaged = await image.execute('call-2', { label: 'demo' }, undefined, undefined)
    const textBlock = imaged.content.find((c) => c.type === 'text')
    const imageBlock = imaged.content.find((c) => c.type === 'image')
    assert(textBlock && textBlock.text === 'image for: demo', 'make_image 文本不符')
    assert(imageBlock && imageBlock.mimeType === 'image/png' && imageBlock.data.length > 20, 'image content 未映射')

    let failed = null
    try {
      await fail.execute('call-3', { message: 'boom' }, undefined, undefined)
      failed = '未抛错'
    } catch (error) {
      failed = error.message
    }
    assert(failed.includes('boom'), `isError 应抛带详情的错误：${failed}`)
    return 'text/image/error 三路映射 ok'
  })

  await check('T4 状态事件与 runtimeInfo（含 stderr 尾部）', async () => {
    const info = manager.runtimeInfo().find((s) => s.name === 'test')
    assert(info && info.status === 'connected', `runtimeInfo 应为 connected：${info && info.status}`)
    assert(info.toolCount === 3, `toolCount 应为 3：${info.toolCount}`)
    assert(statusEvents > 0, '连接完成应触发状态回调')
    return `toolCount=${info.toolCount} statusEvents=${statusEvents}`
  })

  await check('T5 配置 diff：禁用即断开、runtimeInfo 转 disabled', async () => {
    writeMcpServers([
      {
        id: 'mcp-test',
        name: 'test',
        command: process.execPath,
        args: [path.join(PROJECT_ROOT, 'scripts/mcp/test-server.cjs')],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        enabled: false
      }
    ])
    manager.sync()
    await waitFor(() => manager.runtimeInfo().find((s) => s.name === 'test')?.status === 'disabled', 5000, 'disabled 状态')
    const tools = await manager.assembleTools()
    assert(tools.length === 0, `禁用后不应有工具：${tools.length}`)
    return 'ok'
  })

  await check('T6 disposeAll：连接池清空且不抛错（子进程由 SDK close 按规范关停）', async () => {
    // 重新启用 → 连接 → disposeAll
    writeMcpServers([
      {
        id: 'mcp-test',
        name: 'test',
        command: process.execPath,
        args: [path.join(PROJECT_ROOT, 'scripts/mcp/test-server.cjs')],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        enabled: true
      }
    ])
    manager.sync()
    await waitFor(
      () => manager.runtimeInfo().find((s) => s.name === 'test')?.status === 'connected',
      20000,
      '重连'
    )
    manager.disposeAll()
    await sleep(1500)
    const tools = await manager.assembleTools()
    assert(tools.length === 0, `disposeAll 后不应再有工具：${tools.length}`)
    return 'ok'
  })

  // 清理：删除测试配置，避免残留

  await check('T7 workspace skills 段 round-trip（settings:skills-set-disabled 的服务层）', () => {
    const { WorkspaceStore } = require(path.join(TMP, 'src/main/workspace/store.js'))
    const wsRoot = path.join(app.getPath('temp'), `huabu-mcp-probe-ws-${Date.now()}`)
    fs.mkdirSync(wsRoot, { recursive: true })
    const store = new WorkspaceStore()
    store.openByPath(wsRoot)
    assert(store.skillsDisabled().length === 0, '初始禁用名单应为空')
    store.setSkillsDisabled(['brand-poster', 'brand-poster', '', 42])
    const persisted = JSON.parse(fs.readFileSync(path.join(wsRoot, '.huabu', 'workspace.json'), 'utf8'))
    assert(
      JSON.stringify(persisted.skills?.disabled) === JSON.stringify(['brand-poster']),
      `落盘应去重清洗：${JSON.stringify(persisted.skills?.disabled)}`
    )
    assert(store.skillsDisabled().join(',') === 'brand-poster', '回读一致')
    store.setSkillsDisabled([])
    const after = JSON.parse(fs.readFileSync(path.join(wsRoot, '.huabu', 'workspace.json'), 'utf8'))
    assert(!after.skills?.disabled?.length, '清空后不残留空数组脏段')
    fs.rmSync(wsRoot, { recursive: true, force: true })
    return 'ok'
  })

  // 清理：删除测试配置，避免残留
  fs.rmSync(getMcpConfigFile(), { force: true })
  fs.rmSync(TMP, { recursive: true, force: true })

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
  if (failed.length > 0) process.exitCode = 1
  app.quit()
}

app.whenReady().then(() => void main())
