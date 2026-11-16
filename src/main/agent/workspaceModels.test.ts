import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { InMemoryCredentialStore } from './contracts'
import { WorkspaceModels, authSourceOf, deriveThinkingLevels } from './workspaceModels'
import { startStubProvider } from './mastra/stubProvider'

/**
 * 工作区模型目录/凭据服务（**不依赖 pi**）。
 *
 * 这是「把 pi 从 package.json 摘掉」的前置：此前这些能力全挂在 `AgentHost.runtimeFor()`
 * 上，而那条路径要先 `await import(pi)` 成功——pi 坏了，设置页连 API Key 都录不进去。
 *
 * 凭据工厂是注入的，所以这里用 `InMemoryCredentialStore` 就能完整覆盖目录逻辑，
 * 不需要 electron 的 safeStorage。
 */

const dirs: string[] = []
function tmpWs(chat?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'huabu-wsmodels-'))
  dirs.push(dir)
  if (chat !== undefined) {
    // workspace.json 落在 .huabu/ 下（与 store 的 meta 路径一致）
    mkdirSync(join(dir, '.huabu'), { recursive: true })
    writeFileSync(
      join(dir, '.huabu', 'workspace.json'),
      JSON.stringify({ version: 1, activeProjectId: null, projects: [], chat }),
      'utf8'
    )
  }
  return dir
}
const cleanups: Array<() => void> = []
cleanups.push(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})
afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn()
    } catch {
      /* best-effort */
    }
  }
})

function make(workspaceDir: string) {
  const credentials = new InMemoryCredentialStore()
  const logs: string[] = []
  const service = new WorkspaceModels({
    createCredentials: async () => credentials,
    log: (message) => logs.push(message)
  })
  return { service, credentials, logs, workspaceDir }
}

describe('凭据与目录', () => {
  it('录入 Key 后清单里该供应商标记为已配置，且明文不进日志', async () => {
    const ws = tmpWs()
    const { service, logs } = make(ws)

    const before = await service.runtimeInfo(ws)
    expect(before.ok).toBe(true)
    if (before.ok) {
      expect(before.value.ready).toBe(true)
      expect(before.value.configuredProviders).toEqual([])
    }

    const saved = await service.setApiKey(ws, 'deepseek', 'sk-secret-value')
    expect(saved.ok).toBe(true)

    const after = await service.runtimeInfo(ws)
    expect(after.ok && after.value.configuredProviders).toContain('deepseek')
    const deepseek = after.ok ? after.value.models.filter((m) => m.provider === 'deepseek') : []
    expect(deepseek.length).toBeGreaterThan(0)
    expect(deepseek.every((m) => m.authConfigured)).toBe(true)

    // 日志里只允许出现 provider id，绝不能出现 Key 的任何片段
    expect(logs.join('\n')).toContain('deepseek')
    expect(logs.join('\n')).not.toContain('sk-secret-value')
  })

  it('已配置凭据的模型排在前面（下拉第一眼就是能用的）', async () => {
    const ws = tmpWs()
    const { service } = make(ws)
    await service.setApiKey(ws, 'deepseek', 'k')
    const info = await service.runtimeInfo(ws)
    const models = info.ok ? info.value.models : []
    const flags = models.map((m) => m.authConfigured)
    const lastConfigured = flags.lastIndexOf(true)
    const firstUnconfigured = flags.indexOf(false)
    // 已配置的连续排在前面：最后一个已配置的下标 < 第一个未配置的下标
    expect(lastConfigured).toBeGreaterThanOrEqual(0)
    if (firstUnconfigured >= 0) expect(lastConfigured).toBeLessThan(firstUnconfigured)
  })

  it('删除 Key 后回到未配置；空 Key / 非法 providerId 被拒', async () => {
    const ws = tmpWs()
    const { service } = make(ws)
    await service.setApiKey(ws, 'deepseek', 'k')
    expect((await service.removeApiKey(ws, 'deepseek')).ok).toBe(true)
    const info = await service.runtimeInfo(ws)
    expect(info.ok && info.value.configuredProviders).toEqual([])

    expect((await service.setApiKey(ws, 'deepseek', '   ')).ok).toBe(false)
    expect((await service.setApiKey(ws, '../evil', 'k')).ok).toBe(false)
  })

  it('媒体 Key 与聊天 Key 隔离（media: 前缀，互不覆盖）', async () => {
    const ws = tmpWs()
    const { service, credentials } = make(ws)
    await service.setApiKey(ws, 'openai', 'chat-key')
    await service.setMediaKey(ws, 'openai', 'media-key')

    expect(await service.getMediaKey(ws, 'openai')).toBe('media-key')
    expect(await service.hasMediaKey(ws, 'openai')).toBe(true)
    // 聊天凭据没被媒体凭据覆盖
    expect(await credentials.read('openai')).toMatchObject({ key: 'chat-key' })

    expect((await service.removeMediaKey(ws, 'openai')).ok).toBe(true)
    expect(await service.hasMediaKey(ws, 'openai')).toBe(false)
    expect(await credentials.read('openai')).toMatchObject({ key: 'chat-key' })
  })

  it('同一工作区复用同一个凭据存储（凭据保热），不同工作区互不串味', async () => {
    const a = tmpWs()
    const b = tmpWs()
    const created: string[] = []
    const service = new WorkspaceModels({
      createCredentials: async (dir) => {
        created.push(dir)
        return new InMemoryCredentialStore()
      },
      log: () => {}
    })
    await service.setApiKey(a, 'deepseek', 'ka')
    await service.setApiKey(a, 'deepseek', 'ka2')
    await service.setApiKey(b, 'deepseek', 'kb')
    // 每个工作区只创建一次
    expect(created.filter((dir) => dir === a)).toHaveLength(1)
    expect(created.filter((dir) => dir === b)).toHaveLength(1)
    expect(await service.runtimeInfo(a)).toMatchObject({ ok: true })
  })
})

describe('供应商连通性自检（pi-free）', () => {
  /** 把 stub 供应商登记成唯一供应商的 model 配置 */
  const stubChat = (baseUrl: string) => ({
    userProviders: [
      {
        id: 'stub',
        name: '本地 stub',
        baseUrl,
        models: [{ id: 'stub-1', name: 'Stub 1', reasoning: false, input: ['text'], contextWindow: 64_000, maxTokens: 4_096 }]
      }
    ]
  })

  it('有 Key + 服务可达 → requestOk；无 Key → 只报认证未配置', async () => {
    const stub = await startStubProvider()
    cleanups.push(() => void stub.close())
    const ws = tmpWs(stubChat(stub.baseUrl))
    const { service } = make(ws)

    // 未配置凭据：不该发请求，直接给出可操作提示
    const noKey = await service.testProvider(ws, 'stub')
    expect(noKey.ok && noKey.value).toMatchObject({ authOk: false, requestOk: false })
    expect(noKey.ok && noKey.value.message).toContain('未配置凭据')
    expect(stub.requests).toHaveLength(0)

    await service.setApiKey(ws, 'stub', 'stub-key')
    const success = await service.testProvider(ws, 'stub')
    expect(success.ok).toBe(true)
    if (success.ok) {
      expect(success.value.authOk).toBe(true)
      expect(success.value.requestOk).toBe(true)
      expect(success.value.message).toContain('连接正常')
    }
    // 真的发了一次请求（自检通过 = 会话能发出去，不是假阳性）
    expect(stub.requests).toHaveLength(1)
    // 只请求最小额度
    const body = stub.requests[0] as unknown as { max_tokens?: number }
    expect(body.max_tokens).toBeLessThanOrEqual(8)
  })

  it('服务返回 401 → requestOk=false 且带可展示原因（不抛异常）', async () => {
    const stub = await startStubProvider({
      override: (res) => {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return true
      }
    })
    cleanups.push(() => void stub.close())
    const ws = tmpWs(stubChat(stub.baseUrl))
    const { service } = make(ws)
    await service.setApiKey(ws, 'stub', 'bad-key')

    const result = await service.testProvider(ws, 'stub')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.authOk).toBe(true)
      expect(result.value.requestOk).toBe(false)
      expect(result.value.message.length).toBeGreaterThan(0)
    }
  })

  it('供应商不在清单里 → 明确失败而不是空结果', async () => {
    const ws = tmpWs()
    const { service } = make(ws)
    expect(await service.testProvider(ws, 'no-such-provider')).toMatchObject({
      ok: false,
      code: 'model_unavailable'
    })
  })
})

describe('纯函数', () => {
  it('deriveThinkingLevels：非推理为空、无映射给六档、有映射只剔除显式 null', () => {
    expect(deriveThinkingLevels({ reasoning: false })).toEqual([])
    expect(deriveThinkingLevels({ reasoning: true })).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    // 只有**显式**声明的 null 才剔除；映射里没提到的档位保留（沿用 pi 时代的语义）
    expect(deriveThinkingLevels({ reasoning: true, thinkingLevelMap: { low: null, medium: 'x' } })).toEqual([
      'minimal',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    // off 永远不在列表里（会话层不认，传进去会被 clamp 到最低档）
    expect(deriveThinkingLevels({ reasoning: true })).not.toContain('off')
  })

  it('authSourceOf 沿用 pi 时代的取值（渲染端不用改）', () => {
    expect(authSourceOf('stored')).toBe('workspace-store')
    expect(authSourceOf('env')).toBe('environment')
    expect(authSourceOf('none')).toBe('none')
  })
})
