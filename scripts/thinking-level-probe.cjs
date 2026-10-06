/**
 * 思考档位防劫持探针（实机回归，驱动真实 AgentHost）。
 *
 * 运行：pnpm probe:thinking-level
 *
 * 背景：pi 在两条路径上会让机器全局默认档位（~/.pi/agent/settings.json 的
 * defaultThinkingLevel，与其他 pi 系工具共用）压过会话内的选择——
 *   1. create 未显式传档位 → pi 读全局默认（实机为 "max"）→ 对自定义模型 clamp 成 high；
 *   2. setModel 换模型 → _getThinkingLevelForModelSwitch 全局默认优先于会话当前值。
 * 实测后果：用户在会话里选「中」，重选一次模型就被顶成「高」，网关拒收 reasoning_effort。
 *
 * host.ts 的修复：create 新会话缺省显式传 pi 内置 medium（重绑不传，靠会话历史恢复）；
 * setModel 后把会话原档位显式回设（setThinkingLevel 按新模型 clamp）。
 *
 * 本探针在本机真环境跑（被污染的全局配置是天然夹具，要求非 medium 才有区分度），
 * 隔离 userData，写迷你工作区夹具 + 注册自定义推理模型（无 thinkingLevelMap），
 * 走真 AgentHost 的 create / setThinking / setModel，零网络（不发起模型请求）。
 */
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const TMP = path.join(PROJECT_ROOT, 'out', 'thinking-level-probe-tmp')
const RESULT_PATH = path.join(PROJECT_ROOT, 'out', 'thinking-level-result.json')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

/** 镜像转译 src/main + src/shared（workspace-delete-probe 同款） */
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
    let output = outputText
    if (path.relative(PROJECT_ROOT, source) === path.join('src', 'main', 'agent', 'host.ts')) {
      // ts 转译把动态 import() 降级成 require()，ESM-only 的 pi 加载不了；
      // CJS 里真动态 import 可用，把这一处还原成 import()
      output = output.replace(
        'await Promise.resolve(`${PI_PACKAGE}`).then(s => __importStar(require(s)))',
        'await import(PI_PACKAGE)'
      )
    }
    const target = path.join(TMP, path.relative(PROJECT_ROOT, source)).replace(/\.ts$/, '.js')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, output)
  }
}

const startedAt = new Date().toISOString()

app.setPath('userData', path.join(TMP, 'userData')) // 隔离：safeStorage 凭据不落真实位置

void app.whenReady().then(async () => {
  try {
    transpileAll()
    const store = require(path.join(TMP, 'src', 'main', 'workspace', 'store.js'))
    const { AgentHost } = require(path.join(TMP, 'src', 'main', 'agent', 'host.js'))

    // 夹具：迷你工作区（chat.userProviders 挂一个无档位映射的推理模型）
    const ws = path.join(TMP, 'ws')
    fs.mkdirSync(path.join(ws, '.huabu'), { recursive: true })
    fs.writeFileSync(
      path.join(ws, '.huabu', 'workspace.json'),
      JSON.stringify({
        version: 1,
        chat: {
          userProviders: [
            {
              id: 'probe-gw',
              name: 'Probe Gateway',
              baseUrl: 'https://probe.example.com/v1',
              api: 'openai-completions',
              models: [{ id: 'm1', reasoning: true }]
            }
          ]
        }
      })
    )

    // 前置夹具断言：本机全局默认档位确实非 medium（否则探针无区分度）。
    // agentDir 与 host 内部同源（pi.getAgentDir()），不是猜路径
    const pi = await import('@earendil-works/pi-coding-agent')
    const settingsDefault = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(pi.getAgentDir(), 'settings.json'), 'utf8'))
        return raw.defaultThinkingLevel
      } catch {
        return undefined
      }
    })()
    record(
      '夹具：全局 defaultThinkingLevel 非 medium（被污染才有区分度）',
      typeof settingsDefault === 'string' && settingsDefault !== 'medium',
      `global=${String(settingsDefault)}`
    )

    const host = new AgentHost(() => {})
    const setKey = await host.setApiKey(ws, 'probe-gw', 'probe-key')
    assert(setKey.ok, `setApiKey 失败：${setKey.error ?? ''}`)

    // 1. create 未传档位（新会话）→ 必须落到 pi 内置 medium，不被全局默认 clamp 劫持。
    //    显式指定 probe-gw/m1：该模型无 thinkingLevelMap（七档全开放），medium 不会被 clamp；
    //    不用自动选模 —— 那会依赖机器 env（比如碰巧有 DEEPSEEK_API_KEY 就选中内置 deepseek，
    //    而 deepseek-flash 的档位表本就没有 medium，clamp 上浮属于正确行为，会污染断言）
    const created = await host.create({ nodeId: 'n1', modelId: 'probe-gw/m1' }, { currentDir: ws })
    assert(created.ok, `create 失败：${created.error ?? ''}`)
    record(
      'create 未传档位 → medium（防全局默认劫持）',
      created.value.thinkingLevel === 'medium',
      `level=${created.value.thinkingLevel}`
    )

    // 2. 用户选档后换模型（同模型重选 = 实机翻车路径）→ 档位保持，不被全局默认覆盖
    const setThinking = host.setThinking({ nodeId: 'n1', thinkingLevel: 'medium' })
    assert(setThinking.ok, `setThinking 失败：${setThinking.error ?? ''}`)
    const switched = await host.setModel({ nodeId: 'n1', modelId: 'probe-gw/m1' })
    assert(switched.ok, `setModel 失败：${switched.error ?? ''}`)
    record(
      'setModel 后档位保持 medium（防切换劫持）',
      switched.value.thinkingLevel === 'medium',
      `level=${switched.value.thinkingLevel}`
    )

    // 3. 显式传档位创建 → 原样生效
    const createdLow = await host.create({ nodeId: 'n2', modelId: 'probe-gw/m1', thinkingLevel: 'low' }, { currentDir: ws })
    assert(createdLow.ok, `create(low) 失败：${createdLow.error ?? ''}`)
    record('create 传 low → 生效 low', createdLow.value.thinkingLevel === 'low', `level=${createdLow.value.thinkingLevel}`)

    // 4. 档位声明的落盘链路（设置页编辑的底层）：editCustomModel → 磁盘 → managedModels
    const overlay = require(path.join(TMP, 'src', 'main', 'models', 'overlay.js'))
    overlay.editCustomModel(ws, {
      providerId: 'probe-gw',
      modelId: 'm1',
      reasoning: true,
      thinkingLevels: ['low', 'medium', 'xhigh']
    })
    const savedMap = store.readChatConfig(ws).userProviders?.[0]?.models?.[0]?.thinkingLevelMap
    record(
      'editCustomModel 落盘 thinkingLevelMap（选中恒等/未选中 null）',
      savedMap?.low === 'low' && savedMap?.medium === 'medium' && savedMap?.xhigh === 'xhigh' && savedMap?.high === null,
      JSON.stringify(savedMap ?? null)
    )
    const modelsResult = await host.managedModels(ws, 'probe-gw')
    assert(modelsResult.ok, `managedModels 失败：${modelsResult.error ?? ''}`)
    const m1 = modelsResult.value?.find((m) => m.id === 'm1')
    record(
      'managedModels 派生 thinkingLevels（编辑对话框预填数据源）',
      JSON.stringify(m1?.thinkingLevels) === JSON.stringify(['low', 'medium', 'xhigh']),
      JSON.stringify(m1?.thinkingLevels ?? null)
    )
  } catch (error) {
    record('探针整体', false, error instanceof Error ? error.stack ?? error.message : String(error))
  }

  const pass = results.filter((r) => r.pass).length
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true })
  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify({ startedAt, pass, total: results.length, verdict: pass === results.length ? 'PASS' : 'FAIL', results }, null, 2),
    'utf8'
  )
  console.log(`\n${pass}/${results.length} passed -> ${RESULT_PATH}`)
  app.exit(pass === results.length ? 0 : 1)
})
