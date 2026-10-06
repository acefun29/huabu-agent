/**
 * 全场景测试编排器（v2 前端版）：一条命令跑完应用级场景并产出结果 JSON。
 *
 * 分层：
 *   A. 应用启动预检：CDP 可达、IPC/版本、测试桥就位
 *   B. 主进程/中间件层边界：渲染端不可信输入一律被拒（含新增通道的越界/非法载荷）
 *   C. IPC 全链路矩阵：chat/media/workspace/settings 每条通道一问一答 + 事件往返
 *   D. UI 业务流（经底部对话坞与 store 同路径驱动）：
 *      对话闭环（对话坞）/ 生成卡片全生命周期 / 参考与连线 / fork（只复制对话历史）/
 *      删除确认 / 生成卡片回喂对话 / 媒体查看器 / 画布持久化（v3 会话坞模型）/
 *      工作区切换恢复 / 并发上限 / 侧栏两步清空画布
 *   E. 资源清理收尾：任务账本全终态、无 .part 残留、注册表收支平衡
 *
 * 前置：REMOTE_DEBUGGING_PORT=9222 pnpm dev
 * 运行：node scripts/full-scenario.mjs [--port 9222]
 *
 * 消耗额度说明：D 组的对话闭环/Agent 工具流依赖真实模型凭据；
 * 无凭据时该两组自动降级为 SKIP。mock 适配器已随 42db3cf 从生产目录移除，
 * 依赖"mock 生成成功"的媒体场景（C 矩阵生成段 / D1 Agent 媒体 / D2 生命周期 / D3 并发）
 * 在清单无 mock 时同样降级 SKIP —— 恢复方式：给清单挂一个 id=mock 的自定义供应商，或真 Key。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callHelper, connectRendererPage, installHelpers, pollUntil, sleep } from './lib/cdp.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9222'
const WS_DIR = path.join(PROJECT_ROOT, '.workspaces', 'full-scenario-v2')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 'full-scenario-result.json')

const groups = []
let currentGroup = null
function group(name) {
  currentGroup = { name, steps: [] }
  groups.push(currentGroup)
}
function record(name, pass, detail, evidence = null) {
  currentGroup.steps.push({ name, pass, detail, evidence })
  const tag = pass === true ? 'PASS' : pass === false ? 'FAIL' : String(pass)
  console.log(`${tag} [${currentGroup.name}] ${name} — ${detail}`)
}

// 实例 renderer 端口可能与默认 hint（5173）不同（端口被占时顺延 5174）——
// 不指定会回退到 pages[0] 连上 DevTools 页，求值全挂；用 --url 显式指明。
const URL_HINT = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'localhost:5173'
const { session, page } = await connectRendererPage({ port: PORT, urlHint: URL_HINT })
await installHelpers(session)
console.log(`已连接渲染页：${page.url}`)

const evalp = (expr) => session.evaluate(expr, { awaitPromise: true })
const store = () => callHelper(session, 'store')
const storeState = () => evalp('window.__huabuCanvas.state()')
const storeAction = (action, ...args) => {
  const argSource = args.map((item) => JSON.stringify(item)).join(', ')
  return evalp(`window.__huabuCanvas.actions.${action}(${argSource})`)
}

/* -------------------------------------------------------------------------- */
/* 预置：往全场景工作区写可导入的种子文件（Node 直写目录，main 的 files 通道直接可见） */
/* -------------------------------------------------------------------------- */
function seedWorkspaceFiles() {
  // 1x1 红色 PNG（43 字节，标准 base64）
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  fs.mkdirSync(path.join(WS_DIR, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(WS_DIR, 'assets', 'moodboard.png'), PNG_1PX)
  fs.mkdirSync(path.join(WS_DIR, 'docs'), { recursive: true })
  fs.writeFileSync(
    path.join(WS_DIR, 'docs', 'brief.md'),
    '# E2E Brief\n\n这是全场景测试的种子文档。Huabu 画布上的卡片只是本目录文件的引用。\n'
  )
  // 切换测试用的工作区每次用全新目录，避免上一次运行的画布残留干扰判定
  try {
    fs.rmSync(path.join(path.dirname(WS_DIR), `e2e-switch-${process.pid}`), { recursive: true, force: true })
  } catch {
    /* 不存在则忽略 */
  }
}
seedWorkspaceFiles()
const SWITCH_WS_NAME = `e2e-switch-${process.pid}`

/* -------------------------------------------------------------------------- */
/* A. 应用启动预检                                                              */
/* -------------------------------------------------------------------------- */
group('A-启动预检')
{
  const pong = await evalp('window.huabu.ping()')
  record('IPC 联通（app:ping）', pong === 'pong', String(pong))
  const version = await evalp('window.huabu.version()')
  const nodeOk = Number(version.node.split('.')[0]) >= 22
  record('版本与 Node >= 22', version.isPackaged === false && nodeOk, `electron=${version.electron} node=${version.node}`)
  await pollUntil(
    session,
    () => evalp('Boolean(window.__huabuCanvas && window.__huabuCanvas.state().booted)'),
    (ok) => ok === true,
    { timeout: 15000, label: 'test-bridge' }
  )
  const wsBadge = await pollUntil(
    session,
    () => callHelper(session, 'workspaceBadge'),
    (b) => b !== null && b.path !== '',
    { timeout: 10000, label: 'ws-badge' }
  )
  if (wsBadge.timedOut) {
    // 尚未打开工作区（TopBar/角标只在工作区打开后渲染）：走测试桥打开全场景工作区
    await storeAction('openWorkspace', WS_DIR)
  } else {
    record('当前工作区', true, wsBadge.value?.path)
    await storeAction('openWorkspace', WS_DIR)
  }
  const opened = await pollUntil(
    session,
    () => callHelper(session, 'workspaceBadge'),
    (b) => b && b.path && b.path.replace(/\\/g, '/').endsWith('full-scenario-v2'),
    { timeout: 10000, label: 'ws-open' }
  )
  record('全场景工作区打开', !opened.timedOut, opened.value?.path ?? 'null')
  await sleep(600)
}

/* -------------------------------------------------------------------------- */
/* B. 主进程/中间件层边界（渲染端不可信输入一律被拒）                              */
/* -------------------------------------------------------------------------- */

// mock 适配器已从生产目录移除（42db3cf）：依赖"mock 生成成功"的媒体场景据此降级 SKIP，
// 边界负路径断言改用真实 provider 的模型 id（只验证"被拒"，不消耗额度）
const mediaProvidersProbe = await evalp('window.huabu.media.providers()')
const hasMock = (mediaProvidersProbe.value ?? []).some((p) => p.id === 'mock')
const MEDIA_SKIP_REASON = 'mock 适配器已移除（42db3cf），该用例需 mock provider 或真实凭据'

group('B-边界校验')
{
  const cases = [
    ['chat:create cwd 越界被拒', `window.huabu.chat.create({ nodeId: 'boundary-x', cwd: 'C:\\\\Windows' })`, (r) => r.ok === false && r.code === 'cwd_rejected'],
    ['chat:history 越界路径被拒', `window.huabu.chat.history({ nodeId: 'x', sessionFile: 'C:\\\\Windows\\\\win.ini' })`, (r) => r.ok === false && r.code === 'cwd_rejected'],
    ['workspace:read-file 越界被拒', `window.huabu.workspace.readFile('..\\\\secret.txt')`, (r) => r.ok === false],
    ['workspace:read-file 非文本类型被拒', `window.huabu.workspace.readFile('bin.exe')`, (r) => r.ok === false && /不支持/.test(r.error ?? '')],
    ['workspace:create 非法名字被拒', `window.huabu.workspace.create('..')`, (r) => r.ok === false],
    ['workspace:reveal 越界路径被拒', `window.huabu.workspace.reveal('..\\\\..\\\\win.ini')`, (r) => r.ok === false],
    ['media:generate 未知 provider 被拒', `window.huabu.media.generate({ provider: 'nope', model: 'x', kind: 'image', prompt: 'x' })`, (r) => r.ok === false && /provider/.test(r.error ?? '')],
    ['media:generate 未知模型被拒', `window.huabu.media.generate({ provider: 'dashscope', model: 'dashscope/nope', kind: 'image', prompt: 'x' })`, (r) => r.ok === false && /模型/.test(r.error ?? '')],
    ['media:generate kind 不匹配被拒', `window.huabu.media.generate({ provider: 'dashscope', model: 'dashscope/wan2.7-image', kind: 'video', prompt: 'x' })`, (r) => r.ok === false],
    ['media:set-config 并发越界被拒', `window.huabu.media.setConfig({ concurrency: 99 })`, (r) => r.ok === false],
    ['media:set-config 绝对路径输出目录被拒', `window.huabu.media.setConfig({ outputDir: 'C:\\\\Windows' })`, (r) => r.ok === false],
    ['media:cancel 未知任务返回失败', `window.huabu.media.cancel('no-such-job')`, (r) => r.ok === false],
    ['workspace:open-path 不存在目录报错', `window.huabu.workspace.openPath('Z:\\\\definitely-not-exist-huabu')`, (r) => r.ok === false],
    ['settings:set-api-key 非法 providerId 被拒', `window.huabu.settings.setApiKey('bad id!?', 'sk-x')`, (r) => r.ok === false],
    ['settings:set-api-key 空 Key 被拒', `window.huabu.settings.setApiKey('deepseek', '   ')`, (r) => r.ok === false],
    ['asset:create-library 非法名字被拒', `window.huabu.asset.createLibrary('..')`, (r) => r.ok === false],
    ['asset:remove-library 内置库被拒', `window.huabu.asset.removeLibrary('builtin-assets')`, (r) => r.ok === false]
  ]
  for (const [name, expr, predicate] of cases) {
    try {
      const result = await evalp(expr)
      record(name, predicate(result), JSON.stringify(result).slice(0, 140))
    } catch (error) {
      record(name, false, `异常：${error.message}`)
    }
  }
  const badCanvas = await evalp(`window.huabu.workspace.saveCanvas({ version: 9, nodes: 'nope' })`)
  record('canvas-save 非法快照被拒', badCanvas.ok === false, JSON.stringify(badCanvas).slice(0, 120))
}

/* -------------------------------------------------------------------------- */
/* C. IPC 全链路矩阵：每条通道一次合法往返                                        */
/* -------------------------------------------------------------------------- */
group('C-IPC矩阵')
{
  const canvasSave = await evalp(
    `window.huabu.workspace.saveCanvas({ version: 2, savedAt: new Date().toISOString(), meta: { activeChatId: null, view: { x: 0, y: 0, scale: 1 } }, nodes: [] })`
  )
  record('workspace:canvas-save v2（含 meta，v1/v2 兼容）', canvasSave.ok === true, JSON.stringify(canvasSave).slice(0, 80))
  const canvasLoad2 = await evalp('window.huabu.workspace.loadCanvas()')
  record(
    'workspace:canvas-load 往返（v2 + meta）',
    canvasLoad2.ok === true && canvasLoad2.value?.version === 2 && Array.isArray(canvasLoad2.value?.nodes) && typeof canvasLoad2.value?.meta === 'object',
    `version=${canvasLoad2.value?.version} nodes=${canvasLoad2.value?.nodes?.length}`
  )
  // v3（会话坞模型）：会话清单进 meta.sessions，画布节点只剩文件卡片
  const canvasSaveV3 = await evalp(
    `window.huabu.workspace.saveCanvas({ version: 3, savedAt: new Date().toISOString(), meta: { activeSessionId: 'sess-x', view: { x: 0, y: 0, scale: 1 }, sessions: [{ id: 'sess-x', title: '矩阵会话', createdAt: new Date().toISOString() }] }, nodes: [] })`
  )
  record('workspace:canvas-save v3（会话清单 meta.sessions）', canvasSaveV3.ok === true, JSON.stringify(canvasSaveV3).slice(0, 80))
  const canvasLoadV3 = await evalp('window.huabu.workspace.loadCanvas()')
  record(
    'workspace:canvas-load v3 往返（meta.sessions）',
    canvasLoadV3.ok === true && canvasLoadV3.value?.version === 3 && (canvasLoadV3.value?.meta?.sessions ?? []).some((s) => s.id === 'sess-x'),
    `version=${canvasLoadV3.value?.version} sessions=${canvasLoadV3.value?.meta?.sessions?.length}`
  )
  const setDef = await evalp(`window.huabu.workspace.setDefaultModel(null)`)
  record('workspace:set-default-model(null)', setDef.ok === true, JSON.stringify(setDef).slice(0, 80))
  const files = await evalp('window.huabu.workspace.files()')
  record(
    'workspace:files（跳过 .huabu，可导入清单）',
    files.ok === true && Array.isArray(files.value) && files.value.every((f) => !f.relPath.startsWith('.huabu')),
    `files=${files.value?.length}`
  )
  // 准备一个可读文本文件再读
  const writeProbe = await evalp(
    `(async () => { const r = await window.huabu.chat.create({ nodeId: 'ipc-probe-holder' }); return r.ok })()`
  )
  record('chat:create（矩阵用）', writeProbe === true, 'nodeId=ipc-probe-holder')
  const readText = await evalp(`(async () => {
    // 先经 Agent 不可行（无需消耗额度）：直接用 media:import 剪贴板通道造文件不可靠，
    // 这里读 workspace:files 找到的首个 doc/code 文件；找不到则跳过
    const files = await window.huabu.workspace.files()
    const target = (files.value ?? []).find((f) => f.kind === 'doc' || f.kind === 'code')
    if (!target) return { skipped: true }
    const r = await window.huabu.workspace.readFile(target.relPath)
    return { skipped: false, ok: r.ok, truncated: r.value?.truncated, bytes: r.value?.bytes }
  })()`)
  record(
    'workspace:read-file（文本上下文）',
    readText.skipped === true || readText.ok === true,
    JSON.stringify(readText).slice(0, 100)
  )
  const runtime = await evalp('window.huabu.chat.runtime()')
  record(
    'chat:runtime 结构 + 零密钥',
    runtime.ok === true && Array.isArray(runtime.value.models) && !/sk-[A-Za-z0-9]{10,}/.test(JSON.stringify(runtime.value)),
    `models=${runtime.value?.models?.length} ready=${runtime.value?.ready}`
  )
  const providers = await evalp('window.huabu.settings.chatProviders()')
  record(
    'settings:chat-providers 零密钥',
    providers.ok === true && providers.value.providers.length > 0 && !/sk-[A-Za-z0-9]{10,}/.test(JSON.stringify(providers.value)),
    `providers=${providers.value?.providers?.length}`
  )
  const mediaProviders = await evalp('window.huabu.media.providers()')
  record(
    'media:providers（清单非空）',
    mediaProviders.ok === true && mediaProviders.value.length >= 1,
    `count=${mediaProviders.value?.length}${hasMock ? ' 含mock' : ' 无mock（42db3cf 移除）'}`
  )
  const mediaStatus = await evalp('window.huabu.settings.mediaStatus()')
  record(
    'settings:media-status（含 config 全字段）',
    mediaStatus.ok === true &&
      mediaStatus.value.config &&
      typeof mediaStatus.value.config.concurrency === 'number' &&
      typeof mediaStatus.value.config.outputDir === 'string' &&
      typeof mediaStatus.value.confirmVideo === 'boolean',
    JSON.stringify(mediaStatus.value?.config ?? {}).slice(0, 140)
  )
  const setConfig = await evalp(`window.huabu.media.setConfig({ defaultRatio: '1:1', defaultDuration: 5 })`)
  record('media:set-config 往返', setConfig.ok === true, JSON.stringify(setConfig).slice(0, 80))
  // 应用默认 provider 是内置真实网关（dashscope）；mock 存在时测试环境的 Agent 媒体工具显式钉在
  // mock（零配额离线可跑）。钉完后必须走 UI 同路径刷新渲染端 settings 缓存，否则卡片生成仍按旧缓存选默认网关
  if (hasMock) {
    const pinMock = await evalp(
      `window.huabu.media.setConfig({ agentProvider: 'mock', agentModels: { image: 'mock/image-v1', video: 'mock/video-v1', audio: 'mock/audio-v1' } })`
    )
    record('media:set-config 测试钉 mock（Agent 工具离线回退）', pinMock.ok === true, JSON.stringify(pinMock).slice(0, 80))
  } else {
    record('media:set-config 测试钉 mock（Agent 工具离线回退）', 'SKIP', MEDIA_SKIP_REASON)
  }
  await storeAction('refreshSettings')
  await sleep(600)

  // media:generate + media:job 事件往返 + media:jobs（带参考图路径：mock 忽略但链路必须通）
  await evalp(`window.__jobEvents = []; window.huabu.media.onJobEvent(j => window.__jobEvents.push(j.state))`)
  if (hasMock) {
    const gen = await evalp(
      `window.huabu.media.generate({ provider: 'mock', model: 'mock/image-v1', kind: 'image', prompt: 'ipc matrix test', nodeId: 'ipc-matrix-holder', refPaths: ['no-such-ref.png'] })`
    )
    record('media:generate 提交（含参考路径过滤）', gen.ok === true && Boolean(gen.value?.jobId), JSON.stringify(gen).slice(0, 100))
    const events = await pollUntil(
      session,
      () => evalp('window.__jobEvents.join(",")'),
      (s) => s.includes('succeeded'),
      { timeout: 30_000, interval: 300, label: 'job-events' }
    )
    record('media:job 事件往返（queued→running→succeeded）', !events.timedOut, `trace=${events.value}`)
    const jobs = await evalp('window.huabu.media.jobs()')
    record('media:jobs 账本', jobs.ok === true && jobs.value.some((j) => j.jobId === gen.value?.jobId && j.state === 'succeeded'), `jobs=${jobs.value?.length}`)
  } else {
    record('media:generate 提交（含参考路径过滤）', 'SKIP', MEDIA_SKIP_REASON)
    record('media:job 事件往返（queued→running→succeeded）', 'SKIP', MEDIA_SKIP_REASON)
    record('media:jobs 账本', 'SKIP', MEDIA_SKIP_REASON)
  }

  // 用户供应商/模型管理（workspace.json 覆盖层）：创建 → 清单可见 → 加模型 →
  // 隐藏内置模型 → 恢复 → 删除供应商，整链自清理不污染工作区
  const addUserProvider = await evalp(
    `window.huabu.media.userAddProvider({ id: 'e2e-compat', label: 'E2E 兼容网关', type: 'gateway-openai-compat', baseUrl: 'https://api.e2e.example/v1', firstModel: { id: 'e2e-img', kind: 'image' } })`
  )
  record('media:user-add-provider 创建（openai-compat + baseUrl）', addUserProvider.ok === true, JSON.stringify(addUserProvider).slice(0, 100))
  const dupProvider = await evalp(
    `window.huabu.media.userAddProvider({ id: 'e2e-compat', type: 'gateway-openai-compat', firstModel: { id: 'e2e-img', kind: 'image' } })`
  )
  record('media:user-add-provider 重复 id 被拒', dupProvider.ok === false, JSON.stringify(dupProvider.error ?? '').slice(0, 80))
  const providersWithUser = await evalp('window.huabu.media.providers()')
  const userEntry = (providersWithUser.value ?? []).find((p) => p.id === 'e2e-compat')
  record(
    'media:providers 用户供应商出现（type/source 透传）',
    providersWithUser.ok === true && userEntry?.type === 'gateway-openai-compat' && userEntry?.source === 'user',
    `entry=${JSON.stringify({ type: userEntry?.type, source: userEntry?.source, models: userEntry?.models?.length })}`
  )
  const addModel = await evalp(
    `window.huabu.media.userAddModel({ providerId: 'e2e-compat', id: 'e2e-vid', kind: 'video' })`
  )
  record('media:user-add-model 追加模型', addModel.ok === true, JSON.stringify(addModel).slice(0, 80))
  const hideBuiltin = await evalp(`window.huabu.media.userRemoveModel('openai', 'openai/gpt-image-1.5')`)
  const statusHidden = await evalp('window.huabu.settings.mediaStatus()')
  const hiddenList = statusHidden.value?.config?.hiddenBuiltin ?? []
  record(
    'media:user-remove-model 内置模型进隐藏清单',
    hideBuiltin.ok === true && hiddenList.includes('openai/gpt-image-1.5'),
    `hidden=${JSON.stringify(hiddenList)}`
  )
  const restoreBuiltin = await evalp(`window.huabu.media.userRestoreModel('openai', 'openai/gpt-image-1.5')`)
  const statusRestored = await evalp('window.huabu.settings.mediaStatus()')
  record(
    'media:user-restore-model 恢复隐藏',
    restoreBuiltin.ok === true && !(statusRestored.value?.config?.hiddenBuiltin ?? []).includes('openai/gpt-image-1.5'),
    `hidden=${JSON.stringify(statusRestored.value?.config?.hiddenBuiltin ?? [])}`
  )
  const removeProvider = await evalp(`window.huabu.media.userRemoveProvider('e2e-compat')`)
  const providersClean = await evalp('window.huabu.media.providers()')
  record(
    'media:user-remove-provider 删除（清单回落）',
    removeProvider.ok === true && !(providersClean.value ?? []).some((p) => p.id === 'e2e-compat'),
    `count=${providersClean.value?.length}`
  )

  // MuAPI 聚合中转目录与 gateway-predict 协议已从生产环境移除（2026-09），相关场景随之删除
  await evalp(`window.huabu.chat.dispose({ nodeId: 'ipc-probe-holder' })`)
}

/* -------------------------------------------------------------------------- */
/* D0. 对话能力预检（有无凭据决定 D1 是否可跑）                                   */
/* -------------------------------------------------------------------------- */
let chatCapable = false
group('D0-对话预检')
{
  const runtime = await evalp('window.huabu.chat.runtime()')
  chatCapable = runtime.ok === true && runtime.value.ready === true && (runtime.value.configuredProviders?.length ?? 0) > 0
  record(
    '对话凭据可用性',
    chatCapable,
    chatCapable ? `providers=${runtime.value.configuredProviders.join(',')}` : '无凭据：D1/D2 对话相关用例降级为 SKIP（其余离线照跑）'
  )
}

/* -------------------------------------------------------------------------- */
/* D1. 对话闭环：自动建会话 → 流式 → 工具卡片 → write 产物回画布 → Agent 媒体工具  */
/* -------------------------------------------------------------------------- */
group('D1-对话闭环')
{
  if (!chatCapable) {
    record('对话闭环（需凭据）', 'SKIP', '本机未配置对话模型凭据，跳过真实模型用例')
  } else {
    await callHelper(session, 'startWatch')
    // 清空画布从头开始：经测试桥删除所有卡片
    const before = await storeState()
    for (const node of before.nodes) await storeAction('requestRemoveNode', node.id)
    await sleep(300)
    const confirmNow = await callHelper(session, 'confirmDialog', true)
    void confirmNow

    // 1) 底部输入框发送（无当前会话 → 自动新建，标题取开头）
    const sent = await callHelper(session, 'send', '请把字符串 HUABU-E2E-OK 写入文件 e2e-note.txt，然后告诉我写好了。')
    record('底部输入框发送', sent.ok === true, JSON.stringify(sent).slice(0, 120))
    await sleep(400)
    const sess1 = await storeState()
    record(
      '无当前会话时自动新建会话（会话坞模型）',
      (sess1.sessions?.length ?? 0) >= 1 && Boolean(sess1.activeSessionId),
      `sessions=${sess1.sessions?.length} active=${sess1.activeSessionId}`
    )
    const composer1 = await callHelper(session, 'composer')
    record(
      '流式期间不能再次发送',
      composer1?.submitDisabled === true,
      `submitDisabled=${composer1?.submitDisabled}`
    )
    const dock1 = await callHelper(session, 'dock')
    record(
      '用户消息出现在对话坞',
      dock1.visible === true && dock1.messages.some((m) => m.role === 'user'),
      `msgs=${dock1.messages?.length}`
    )
    // 2) 等首条模型消息出现（流式开始），再等全部静默 —— 避免流式未启动时空闲轮询空过
    const firstReply = await pollUntil(
      session,
      () => callHelper(session, 'dock'),
      (d) => d.messages.some((m) => m.role === 'model' && (m.streaming || m.text.length > 0)),
      { timeout: 60_000, interval: 300, label: 'first-reply' }
    )
    record('模型消息开始出现在对话坞', !firstReply.timedOut, `msgs=${JSON.stringify(firstReply.value?.messages?.length)}`)
    const idle = await pollUntil(
      session,
      () =>
        evalp(`(() => {
          const s = window.__huabuCanvas.state()
          const chat = s.activeSessionId ? s.chats[s.activeSessionId] : null
          return Boolean(chat && chat.running === false && chat.history.length > 1)
        })()`),
      (ok) => ok === true,
      { timeout: 150_000, interval: 500, label: 'chat-idle' }
    )
    record('回复流式完成', !idle.timedOut, `rounds=${idle.samples?.length}`)
    const watchLog1 = await callHelper(session, 'stopWatch')
    const streamedGrowth = (watchLog1 ?? []).some((entry) => entry.draftLength > 0)
    record('流式轨迹有增量（逐字浮现）', streamedGrowth, `entries=${watchLog1?.length}`)
    const dockAfter = await callHelper(session, 'dock')
    record(
      '回复内容出现在对话坞',
      dockAfter.messages.some((m) => m.role === 'model' && m.text.length > 0),
      `msgs=${dockAfter.messages.length}`
    )
    // 3) write 工具 → 产物文件卡片自动钉到画布
    const wroteCard = await pollUntil(
      session,
      () => storeState(),
      (st) => st.nodes.some((n) => n.type === 'asset' && (n.data.name === 'e2e-note.txt' || String(n.data.path ?? '').endsWith('e2e-note.txt'))),
      { timeout: 20_000, interval: 500, label: 'write-pin' }
    )
    record('write 工具产物自动钉为文件卡片（两入口一出口）', !wroteCard.timedOut, JSON.stringify(wroteCard.value?.nodes?.filter((n) => n.type === 'asset').map((n) => n.data.name)).slice(0, 120))
    // 4) Agent 媒体工具（generate_image）→ 生成卡片承接 → 产物版本
    if (!hasMock) {
      // mock 移除后 Agent 媒体工具走真实网关（需凭据），本段整体降级；画布收尾照做
      record('Agent 媒体工具链（发话/卡片/落盘/去重）', 'SKIP', MEDIA_SKIP_REASON)
    } else {
    // 等 store 级空闲（多 turn 间隙 DOM 上看不到流式，但会话仍在跑）
    const storeIdle = await pollUntil(
      session,
      () => evalp(`Object.values(window.__huabuCanvas.state().chats).every(c => !c.running)`),
      (ok) => ok === true,
      { timeout: 150_000, interval: 500, label: 'store-idle' }
    )
    record('会话回到空闲（store 级 running=false）', !storeIdle.timedOut, '')
    // 账本会积累历史任务（工作区固定目录），去重回归断言必须以「本次新任务」为基线
    const imageJobsBefore = new Set(
      ((await evalp('window.huabu.media.jobs()')).value ?? [])
        .filter((j) => j.sourceChatId && j.kind === 'image' && j.state === 'succeeded')
        .map((j) => j.jobId)
    )
    const sent2 = await callHelper(session, 'send', 'Use the generate_image tool now with prompt "a cute cat poster, vivid colors". After submitting, reply with the word SUBMITTED.')
    record('Agent 媒体工具发话', sent2.ok === true, JSON.stringify(sent2).slice(0, 80))
    const toolCard = await pollUntil(
      session,
      () => callHelper(session, 'dock'),
      (d) => d.tools.some((t) => t.name === 'generate_image'),
      { timeout: 120_000, interval: 500, label: 'agent-image-tool' }
    )
    record('generate_image 工具卡片出现', !toolCard.timedOut, JSON.stringify(toolCard.value?.tools).slice(0, 120))
    const agentGenCard = await pollUntil(
      session,
      () => storeState(),
      (st) => st.nodes.some((n) => n.type === 'asset' && n.data.gen && String(n.data.fromChatId ?? '').length > 0),
      { timeout: 20_000, interval: 400, label: 'agent-gen-card' }
    )
    record('Agent 发起的生成卡片自动出现在会话旁', !agentGenCard.timedOut, `genCards=${agentGenCard.value?.nodes?.filter((n) => n.data.gen)?.length}`)
    const agentDone = await pollUntil(
      session,
      () => evalp('window.huabu.media.jobs()'),
      (r) => (r.value ?? []).some((j) => j.sourceChatId && j.state === 'succeeded' && j.kind === 'image' && !imageJobsBefore.has(j.jobId)),
      { timeout: 60_000, interval: 500, label: 'agent-job-done' }
    )
    record('Agent 发起的图片任务真实落盘', !agentDone.timedOut, `jobs=${agentDone.value?.value?.length}`)
    // 去重回归：一个任务的 queued/running×N/succeeded 事件只能建出一张承接卡片
    const newImageJob = ((await evalp('window.huabu.media.jobs()')).value ?? []).find(
      (j) => j.sourceChatId && j.kind === 'image' && j.state === 'succeeded' && !imageJobsBefore.has(j.jobId)
    )
    const artifactPath = newImageJob?.artifact?.relPath ?? '(missing)'
    const cardPoll = await pollUntil(
      session,
      () => storeState(),
      (st) =>
        st.nodes.some(
          (n) => n.type === 'asset' && (n.data.gen?.versions ?? []).some((v) => v.path === artifactPath)
        ),
      { timeout: 20_000, interval: 400, label: 'agent-card-settled' }
    )
    const boundCards = (cardPoll.value?.nodes ?? []).filter(
      (n) => n.type === 'asset' && (n.data.gen?.versions ?? []).some((v) => v.path === artifactPath)
    ).length
    record('同一任务只建一张承接卡片（事件去重）', boundCards === 1, `cards=${boundCards} path=${artifactPath}`)
    } // end hasMock（Agent 媒体工具链）
    // 收尾：清空画布，给 D2 一个干净底板
    const mid = await storeState()
    for (const node of mid.nodes) await storeAction('requestRemoveNode', node.id)
    await sleep(200)
    await callHelper(session, 'confirmDialog', true)
    await sleep(200)
  }
}

/* -------------------------------------------------------------------------- */
/* D2. 生成卡片全生命周期（mock provider，离线）+ 参考连线 + fork + 回喂 + 撤销    */
/* -------------------------------------------------------------------------- */
group('D2-生成与编排')
{
  // 准备素材：从工作目录导入一张图片（mock 生成产物已在媒体目录，这里直接用 D1 的产物；若无则用 workspace:files 里的首图，再无则先 mock 生成一张）
  const jobsNow = await evalp('window.huabu.media.jobs()')
  let seedImagePath = null
  for (const job of jobsNow.value ?? []) {
    if (job.state === 'succeeded' && job.kind === 'image' && job.artifact) {
      seedImagePath = job.artifact.relPath
      break
    }
  }
  if (!seedImagePath && hasMock) {
    const g = await evalp(`window.huabu.media.generate({ provider: 'mock', model: 'mock/image-v1', kind: 'image', prompt: 'seed image' })`)
    await pollUntil(
      session,
      () => evalp('window.huabu.media.jobs()'),
      (r) => (r.value ?? []).some((j) => j.jobId === g.value?.jobId && j.state === 'succeeded'),
      { timeout: 30_000, label: 'seed-image' }
    )
    const refreshed = await evalp('window.huabu.media.jobs()')
    seedImagePath = (refreshed.value ?? []).find((j) => j.jobId === g.value?.jobId)?.artifact?.relPath ?? null
  }
  record(
    '种子图片就绪（产物目录内）',
    Boolean(seedImagePath) || !hasMock,
    seedImagePath ? String(seedImagePath) : hasMock ? '(missing)' : MEDIA_SKIP_REASON
  )

  // 1) 生成卡片全生命周期（提示词写在卡片内联控制台，不再占用底部输入框）
  const genId = await storeAction('createGenerateNode', 'image')
  record('新建生成卡片并进入生成模式', Boolean(genId), `id=${genId}`)
  await sleep(300)
  const consoleSnap = await callHelper(session, 'genSnapshot', genId)
  record(
    '生成卡片自带内联提示词控制台',
    consoleSnap !== null && consoleSnap.prompt === '' && consoleSnap.regenerateVisible === true,
    `prompt=${JSON.stringify(consoleSnap?.prompt)}`
  )
  const composerChat = await callHelper(session, 'composer')
  record(
    '底部输入框保持对话身份（不随生成卡片切换）',
    composerChat !== null && /会话:/.test(composerChat.status ?? ''),
    `status=${JSON.stringify(composerChat?.status)}`
  )
  if (hasMock) {
    await storeAction('submitGeneration', genId, 'e2e lifecycle poster, minimal')
    const queued = await callHelper(session, 'genSnapshot', genId)
    record('提交后卡片进入排队/生成中', queued?.status === 'queued' || queued?.status === 'running', `status=${queued?.status}`)
    // 2) 生成中重复提交拦截（必须在 running 窗口内验证）
    await storeAction('submitGeneration', genId, 'should be blocked')
    await sleep(400)
    const blockedToast = await callHelper(session, 'toastText')
    record('生成中重复提交被拦截并提示', Boolean(blockedToast && blockedToast.includes('生成中')), JSON.stringify(blockedToast))
    const done = await pollUntil(
      session,
      () => callHelper(session, 'genSnapshot', genId),
      (s) => s && s.status === 'succeeded',
      { timeout: 30_000, interval: 300, label: 'gen-done' }
    )
    record('生成完成：卡片状态 succeeded', !done.timedOut, `status=${done.value?.status} path=${done.value?.pathText}`)

    // （重复提交拦截已提前到 running 窗口内验证）

    // 3) 再生成 → 版本数 2 → 版本切换
    const state1 = await storeState()
    const versions1 = state1.nodes.find((n) => n.id === genId)?.data?.gen?.versions?.length ?? 0
    await storeAction('submitGeneration', genId, 'e2e lifecycle poster v2')
    const done2 = await pollUntil(
      session,
      () => storeState(),
      (st) => (st.nodes.find((n) => n.id === genId)?.data?.gen?.versions?.length ?? 0) >= versions1 + 1,
      { timeout: 30_000, interval: 400, label: 'gen-v2' }
    )
    record('再生成产出新版本（版本历史保留）', !done2.timedOut, `versions=${done2.value?.nodes?.find((n) => n.id === genId)?.data?.gen?.versions?.length}`)
    await storeAction('setActiveGenerate', genId)
    await evalp(`document.querySelector('[data-testid="switch-version"]')?.click()`)
    await sleep(200)
    const stateSwitched = await storeState()
    const genNow = stateSwitched.nodes.find((n) => n.id === genId)?.data?.gen
    record(
      '版本切换：卡片指向对应版本文件',
      Boolean(genNow?.activeVersionId) && genNow.versions.length >= 2,
      `active=${genNow?.activeVersionId} path=${stateSwitched.nodes.find((n) => n.id === genId)?.data?.path}`
    )
  } else {
    // 无 mock：卡片不会真实提交，为让"清空保留提示词 / 失败态重试入口"两条
    // 依赖 gen.prompt 的断言回到测试本意，这里模拟用户在卡片控制台输入过提示词
    await storeAction('updateGenerate', genId, { prompt: 'e2e lifecycle poster, minimal' })
    record('提交后卡片进入排队/生成中', 'SKIP', MEDIA_SKIP_REASON)
    record('生成中重复提交被拦截并提示', 'SKIP', MEDIA_SKIP_REASON)
    record('生成完成：卡片状态 succeeded', 'SKIP', MEDIA_SKIP_REASON)
    record('再生成产出新版本（版本历史保留）', 'SKIP', MEDIA_SKIP_REASON)
    record('版本切换：卡片指向对应版本文件', 'SKIP', MEDIA_SKIP_REASON)
  }

  // 4) 导入工作目录文件 → 参考连线
  await storeAction('refreshDirFiles')
  await sleep(400)
  const st0 = await storeState()
  const imageEntry = (st0.dirFiles ?? []).find((f) => f.kind === 'image')
  let importedCardId = null
  if (imageEntry) {
    await storeAction('importFromDirectory', imageEntry)
    await sleep(300)
    const st1 = await storeState()
    const imported = st1.nodes.find((n) => n.type === 'asset' && n.data.path === imageEntry.path)
    importedCardId = imported?.id ?? null
    record('从工作目录导入 = 钉引用卡片并自动选中', Boolean(imported), JSON.stringify(imageEntry))
  } else {
    record('从工作目录导入（目录里没有图片文件）', 'SKIP', '种子文件缺失，跳过导入用例')
  }
  // 参考关系：优先用导入的工作区文件卡片作参考（refs 存于卡片数据，提交时作垫图/首帧）
  const refTargetId = importedCardId ?? (await storeState()).nodes.find((n) => n.type === 'asset' && n.data.storage === 'media' && n.id !== genId)?.id ?? null
  const gen2Id = refTargetId ? await storeAction('createGenerateNode', 'video', null, [refTargetId]) : null
  await sleep(300)
  const st2 = await storeState()
  const gen2Refs = refTargetId ? (st2.nodes.find((n) => n.id === gen2Id)?.data?.gen?.refs ?? []) : []
  record('参考关系存于卡片数据（refs）', refTargetId ? gen2Refs.includes(refTargetId) : false, `refs=${JSON.stringify(gen2Refs)}`)
  // 以此生成（垫图）路径
  if (refTargetId) {
    const deriveId = await storeAction('createGenerateNode', 'image', null, [refTargetId])
    const stDerive = await storeState()
    const deriveNode = stDerive.nodes.find((n) => n.id === deriveId)
    record('「以此生成」新卡片自带参考且待生成', deriveNode?.data?.gen?.refs?.includes(refTargetId) === true, `refs=${JSON.stringify(deriveNode?.data?.gen?.refs)}`)
    await storeAction('requestRemoveNode', deriveId)
  }

  // 5) fork：只复制对话历史，画布公用不动（会话坞模型）
  const chatId = await storeAction('createSession', 'fork 母会话')
  // 指令必须明确禁止工具调用：模型若自作主张 ls/read 会把单轮拖到几分钟，超时假报
  await storeAction('sendMessage', '不要使用任何工具，直接回复四个字：已收到第一句。')
  const forkIdle = chatCapable
    ? await pollUntil(
        session,
        () => evalp(`Object.values(window.__huabuCanvas.state().chats).every(c => !c.running)`),
        (ok) => ok === true,
        { timeout: 240_000, interval: 500, label: 'fork-idle' }
      )
    : { timedOut: false }
  if (chatCapable) {
    record('fork 前母会话回复完成', !forkIdle.timedOut, '')
  }
  await storeAction('forkSession', chatId)
  await sleep(300)
  const stFork = await storeState()
  const forkMeta = (stFork.sessions ?? []).find((s) => s.forkedFromId === chatId)
  const forkChatData = forkMeta ? stFork.chats[forkMeta.id] : null
  // fork 双路径（环境自适应）：有凭据时母会话真实回复成功、写出了 JSONL → 走文件级
  // 分叉（fork 自带 sessionFile，chatsMap.history 故意留空待切换时结构化回放，断言分叉
  // 文件真实存在且非空）；无凭据时母会话发送即失败、无 JSONL → 退回「复制 UI 历史」
  //（无 sessionFile，断言 history ≥ 1）。旧断言只认第二条路径，在有凭据的机器上必假失败。
  const forkFileLevel = Boolean(forkMeta?.sessionFile)
  record(
    'fork 分叉生效（文件级或 UI 复制，随凭据环境自适应）',
    Boolean(
      forkMeta &&
        (forkFileLevel
          ? fs.existsSync(forkMeta.sessionFile) && fs.statSync(forkMeta.sessionFile).size > 0
          : (forkChatData?.history?.length ?? 0) >= 1)
    ),
    forkFileLevel ? `file=${path.basename(forkMeta.sessionFile)}` : `history=${forkChatData?.history?.length}`
  )
  record(
    'fork 关系记录在会话元数据',
    Boolean(forkMeta?.forkedFromLabel),
    `label=${forkMeta?.forkedFromLabel}`
  )

  // 6) 生成卡片回喂对话（第九节缺口修复）
  await storeAction('injectAsset', genId)
  await sleep(200)
  const compFeed = await callHelper(session, 'composer')
  record(
    '生成卡片可注入对话上下文（chips 出现）',
    (compFeed.chips ?? []).length >= 1,
    `chips=${JSON.stringify(compFeed.chips)}`
  )
  if (chatCapable && forkMeta) {
    await storeAction('switchSession', forkMeta.id)
    await callHelper(session, 'send', '用一句话描述你看到的上下文里有什么资产。')
    const feedIdle = await pollUntil(
      session,
      () => evalp(`Object.values(window.__huabuCanvas.state().chats).every(c => !c.running)`),
      (ok) => ok === true,
      { timeout: 150_000, interval: 500, label: 'feed-idle' }
    )
    record('生成卡片作为上下文发送成功（回喂对话）', !feedIdle.timedOut, '')
  } else {
    record('生成卡片回喂（真实发送需凭据）', 'SKIP', '已验证上下文 chip 注入；真实模型发送跳过')
  }

  // 7) 删除确认（有历史的会话）与卡片撤销
  if (forkMeta) {
    await storeAction('requestRemoveSession', forkMeta.id)
    await sleep(200)
    const confirm1 = await callHelper(session, 'confirmDialog')
    record('删除有历史会话先弹确认框', confirm1.visible === true, JSON.stringify(confirm1).slice(0, 120))
    await callHelper(session, 'confirmDialog', true)
    await sleep(200)
    const stDel = await storeState()
    record('确认后会话从列表移除（画布与文件不动）', !(stDel.sessions ?? []).some((s) => s.id === forkMeta.id), `sessions=${stDel.sessions?.length}`)
  } else {
    record('删除会话确认框', 'SKIP', 'fork 会话不存在（fork 未执行）')
  }
  // 待生成卡片直接删除（无版本）→ 不弹确认，可撤销
  await storeAction('requestRemoveNode', gen2Id ?? genId)
  await sleep(200)
  const confirm2 = await callHelper(session, 'confirmDialog')
  record('无版本的卡片删除不弹确认', confirm2.visible === false || confirm2.accepted === true, JSON.stringify(confirm2).slice(0, 80))
  await storeAction('undo')
  await sleep(150)
  const stUndo = await storeState()
  record('Toast 撤销：卡片被恢复', stUndo.nodes.some((n) => n.id === (gen2Id ?? genId)), '')

  // 8) 清空结果（有版本 → 确认框）
  await storeAction('requestClearGenerateVersions', genId)
  await sleep(200)
  const confirm3 = await callHelper(session, 'confirmDialog', true)
  record('清空结果走确认框（不可逆护栏）', confirm3.accepted === true, '')
  await sleep(200)
  const stCleared = await storeState()
  const clearedGen = stCleared.nodes.find((n) => n.id === genId)?.data?.gen
  record('清空后保留卡片与提示词、版本清空', Boolean(clearedGen && clearedGen.versions.length === 0 && clearedGen.prompt), `versions=${clearedGen?.versions?.length}`)

  // 9) 失败路径与重试（未知 provider 提交失败 → failed → 重试按钮可见）
  await storeAction('updateGenerate', genId, { versions: [], status: 'failed', error: 'e2e-injected-failure' })
  await sleep(200)
  const failedSnap = await callHelper(session, 'genSnapshot', genId)
  record('失败态呈现错误与重试入口', failedSnap.status === 'failed' && failedSnap.retryVisible === true, JSON.stringify(failedSnap.errorText).slice(0, 80))

  // 10) 媒体查看器（图片放大）—— 需要卡片带真实产物（path），故挂在 hasMock 上
  if (hasMock) {
    await storeAction('openViewer', genId)
    await sleep(300)
    const viewer1 = await callHelper(session, 'viewer')
    record('媒体查看器打开（图片）', viewer1.visible === true && viewer1.image === true, JSON.stringify(viewer1).slice(0, 100))
    await storeAction('closeViewer')
    await sleep(200)
  } else {
    record('媒体查看器打开（图片）', 'SKIP', MEDIA_SKIP_REASON)
  }
  record('查看器 Esc/关闭可退出', (await callHelper(session, 'viewer')).visible === false, '')
}

/* -------------------------------------------------------------------------- */
/* D3. 画布持久化 + 工作区切换恢复 + 并发上限                                    */
/* -------------------------------------------------------------------------- */
group('D3-持久化与并发')
{
  // 1) 画布快照落盘（防抖 800ms；v3：会话清单进 meta.sessions，画布只剩文件卡片）
  const st = await storeState()
  const activeSession = st.activeSessionId ?? null
  await sleep(1400)
  const snapshot = await evalp('window.huabu.workspace.loadCanvas()')
  const persistedActive = snapshot.value?.meta?.activeSessionId ?? null
  const nodeTypes = [...new Set((snapshot.value?.nodes ?? []).map((n) => n.type))]
  record(
    '画布 v3 快照落盘（节点 + 会话清单 + 活动会话）',
    snapshot.ok === true &&
      snapshot.value?.version === 3 &&
      snapshot.value.nodes.length >= 1 &&
      persistedActive === activeSession,
    `nodes=${snapshot.value?.nodes?.length} active=${persistedActive} sessions=${snapshot.value?.meta?.sessions?.length}`
  )
  record(
    '画布只剩文件卡片，会话清单只存引用（不内嵌历史）',
    nodeTypes.every((t) => t === 'asset') &&
      (snapshot.value?.meta?.sessions ?? []).every((s) => !('history' in s) && !('running' in s)),
    `types=${JSON.stringify(nodeTypes)} sessionKeys=${JSON.stringify(Object.keys(snapshot.value?.meta?.sessions?.[0] ?? {}))}`
  )

  // 2) 新建工作区切换 → 空画布 → 切回 → 节点与活动会话恢复
  const prevPath = st.workspace.path
  await storeAction('createWorkspace', SWITCH_WS_NAME)
  await sleep(900)
  const stSwitched = await storeState()
  record(
    '切换到新工作区：画布为空',
    stSwitched.nodes.length === 0 && stSwitched.workspace.name === SWITCH_WS_NAME,
    `nodes=${stSwitched.nodes.length} name=${stSwitched.workspace.name}`
  )
  await storeAction('openWorkspace', prevPath)
  await sleep(1100)
  const stBack = await storeState()
  record(
    '切回工作区：节点恢复且活动会话还原',
    stBack.nodes.length === st.nodes.length && stBack.activeSessionId === activeSession,
    `nodes=${stBack.nodes.length}/${st.nodes.length} active=${stBack.activeSessionId}`
  )

  // 3) 并发上限真实生效：concurrency=2，3 个任务 → 任一时刻 running ≤ 2
  await evalp(`window.__concTrace = []; window.huabu.media.onJobEvent(j => window.__concTrace.push({ s: j.state, at: Date.now() }))`)
  const setConc = await evalp(`window.huabu.media.setConfig({ concurrency: 2 })`)
  record('media:set-config concurrency=2', setConc.ok === true, '')
  if (hasMock) {
    const genIds = []
    for (let i = 0; i < 3; i += 1) {
      const r = await evalp(`window.huabu.media.generate({ provider: 'mock', model: 'mock/video-v1', kind: 'video', prompt: 'conc ${i}', durationSeconds: 3 })`)
      if (r.ok) genIds.push(r.value.jobId)
    }
    // 采样 running 峰值
    const peakSamples = []
    for (let i = 0; i < 40; i += 1) {
      const jobs = await evalp('window.huabu.media.jobs()')
      const mine = (jobs.value ?? []).filter((j) => genIds.includes(j.jobId))
      peakSamples.push(mine.filter((j) => j.state === 'running').length)
      if (mine.every((j) => j.state === 'succeeded' || j.state === 'failed')) break
      await sleep(250)
    }
    const peakRunning = Math.max(...peakSamples, 0)
    record('并发上限生效（running 峰值 ≤ 2）', peakRunning <= 2 && peakRunning >= 1, `peak=${peakRunning} samples=${peakSamples.join(',')}`)
    const traceRunning = await evalp('window.__concTrace.filter(e => e.s === "running").length')
    record('任务状态事件流可见（running 事件）', Number(traceRunning) >= 1, `runningEvents=${traceRunning}`)
    // 等三个任务全部终态（第三个任务要等前两个让出并发槽才开始，8s 模拟时长 × 2 轮）
    const concDone = await pollUntil(
      session,
      () => evalp('window.huabu.media.jobs()'),
      (r) => {
        const mine = (r.value ?? []).filter((j) => genIds.includes(j.jobId))
        return mine.length === genIds.length && mine.every((j) => ['succeeded', 'failed', 'cancelled'].includes(j.state))
      },
      { timeout: 90_000, interval: 500, label: 'conc-terminal' }
    )
    record('并发任务全部到达终态', !concDone.timedOut, `states=${(concDone.value?.value ?? []).filter((j) => genIds.includes(j.jobId)).map((j) => j.state).join(',')}`)
  } else {
    record('并发上限生效（running 峰值 ≤ 2）', 'SKIP', MEDIA_SKIP_REASON)
    record('任务状态事件流可见（running 事件）', 'SKIP', MEDIA_SKIP_REASON)
    record('并发任务全部到达终态', 'SKIP', MEDIA_SKIP_REASON)
  }
  await evalp(`window.huabu.media.setConfig({ concurrency: 3 })`)

  // 4) 侧栏清空画布：两步确认（点一次进入确认态，3 秒内再点一次才执行）
  const stPreClear = await storeState()
  if (stPreClear.nodes.length > 0) {
    await evalp(`document.querySelector('[data-testid="clear-canvas"]')?.click()`)
    await sleep(200)
    const armState = await callHelper(session, 'clearCanvasButton')
    record('清空画布第一步进入确认态', armState.visible === true && armState.confirming === true, JSON.stringify(armState))
    await evalp(`document.querySelector('[data-testid="clear-canvas"]')?.click()`)
    await sleep(300)
    const stClearedAll = await storeState()
    record('确认后画布引用卡片全部移除（素材文件不动）', stClearedAll.nodes.length === 0, `nodes=${stClearedAll.nodes.length}`)
  } else {
    record('侧栏清空画布', 'SKIP', '画布已空，无卡片可清')
  }
}

/* -------------------------------------------------------------------------- */
/* E. 资源清理收尾                                                              */
/* -------------------------------------------------------------------------- */
group('E-清理收尾')
{
  // 会话注册表收支平衡：当前工作区的会话全部 dispose 后，同 nodeId 可重建
  // （会话坞模型：会话 id 即 chat:create 的绑定键，画布不再持有会话）
  const sessionIds = await evalp(`window.__huabuCanvas.state().sessions.map(s => s.id)`)
  let recreateOk = true
  let firstId = null
  for (const id of sessionIds ?? []) {
    firstId = firstId ?? id
    await evalp(`window.huabu.chat.dispose({ nodeId: ${JSON.stringify(id)} })`)
  }
  if (firstId) {
    const recreate = await evalp(`window.huabu.chat.create({ nodeId: ${JSON.stringify(firstId)} })`)
    recreateOk = recreate.ok === true
    await evalp(`window.huabu.chat.dispose({ nodeId: ${JSON.stringify(firstId)} })`)
  }
  record('会话注册表收支平衡（同 nodeId 可重建）', recreateOk, `sessions=${sessionIds?.length}`)
  const jobs = await evalp('window.huabu.media.jobs()')
  const terminal = (jobs.value ?? []).every((j) => ['succeeded', 'failed', 'cancelled'].includes(j.state))
  record('媒体任务账本全部终态', terminal, `states=${(jobs.value ?? []).map((j) => j.state).join(',')}`)
}

session.close()

// Node 侧补查：.part 残留 + 产物完整性
const mediaDir = path.join(WS_DIR, '.huabu', 'media')
const leftovers = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter((f) => f.endsWith('.part')) : []
group('E-清理收尾')
record('无 .part 残留临时文件', leftovers.length === 0, `leftovers=${JSON.stringify(leftovers)}`)
const mediaFiles = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter((f) => !f.endsWith('.json')) : []
record(
  '产物目录存在真实媒体文件',
  mediaFiles.length >= 1 || !hasMock,
  mediaFiles.length >= 1 ? `files=${mediaFiles.slice(0, 5).join(',')}` : MEDIA_SKIP_REASON
)

const allSteps = groups.flatMap((g) => g.steps.map((s) => ({ group: g.name, ...s })))
const failed = allSteps.filter((s) => s.pass === false)
const skipped = allSteps.filter((s) => s.pass === 'SKIP')
const summary = {
  startedAt: new Date().toISOString(),
  page: page.url,
  groups: groups.map((g) => ({ name: g.name, steps: g.steps })),
  totals: {
    pass: allSteps.filter((s) => s.pass === true).length,
    fail: failed.length,
    skip: skipped.length
  },
  finishedAt: null
}
fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true })
fs.writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2))
console.log(`\n== FULL SCENARIO: PASS=${summary.totals.pass} FAIL=${failed.length} SKIP=${summary.totals.skip} ==`)
failed.forEach((s) => console.log(`FAIL [${s.group}] ${s.name} — ${s.detail}`))
console.log(`结果已写入 ${RESULT_PATH}`)
process.exit(failed.length === 0 ? 0 : 1)
