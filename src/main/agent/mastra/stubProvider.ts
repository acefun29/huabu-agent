/**
 * 本地 OpenAI 兼容 stub（**仅测试使用**）。
 *
 * 用途：让「真实协议链路」可以在没有任何凭据、不花一分额度的情况下被测试。
 * 网关（`modelGateway/providers.ts`）是自己用 fetch 发 `POST {baseUrl}/chat/completions`
 * 并读 SSE 的，所以一个最小的本地服务就足以跑完整条链路：
 *
 *   ChatModelManager → registrations() → createModelGateway → fetch + SSE
 *     → aiSdkLanguageModel → Mastra Agent → 工具桥 → 事件
 *
 * 两个消费方：`runtimeStub.test.ts`（整条对话 + 工具往返 + 分叉）与
 * `workspaceModels.test.ts`（供应商连通性自检）。
 */

import { createServer, type Server, type ServerResponse } from 'node:http'

export interface StubRequest {
  messages: Array<{ role?: string; [key: string]: unknown }>
}

/** 响应剧本：`echo` 直接给文本；`tool-then-text` 先要求调 ls，拿到工具结果后给文本 */
export type StubPlan = 'echo' | 'tool-then-text'

export interface StubProvider {
  baseUrl: string
  server: Server
  /** 收到的请求体（按顺序），用于断言「第二轮带回了工具结果」 */
  requests: StubRequest[]
  close(): Promise<void>
}

function sse(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

export interface StubOptions {
  plan?: StubPlan
  /** 覆盖响应：返回非空则直接用它（例如模拟 401） */
  override?: (res: ServerResponse, body: StubRequest) => boolean
}

export async function startStubProvider(options: StubOptions = {}): Promise<StubProvider> {
  const plan = options.plan ?? 'echo'
  const requests: StubRequest[] = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (piece) => {
      raw += piece
    })
    req.on('end', () => {
      let body: StubRequest = { messages: [] }
      try {
        body = JSON.parse(raw) as StubRequest
      } catch {
        /* 空 body 也能跑 */
      }
      requests.push(body)
      if (options.override?.(res, body)) return

      const hasToolResult = (body.messages ?? []).some((message) => message.role === 'tool')
      if (plan === 'tool-then-text' && !hasToolResult) {
        sse(res, [
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_ls_1',
                      type: 'function',
                      function: { name: 'ls', arguments: '{"path":""}' }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          },
          // reasoning 通道也覆盖：网关把它映射成 thinking
          { choices: [{ index: 0, delta: { reasoning_content: '先看看工作区' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
        ])
        return
      }
      sse(res, [
        { choices: [{ index: 0, delta: { content: '工作区里有一个 ' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'note.md' }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 42, completion_tokens: 7 }
        }
      ])
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    server,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
