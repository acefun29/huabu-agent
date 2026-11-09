/**
 * SuperAgent 基础层测试（Phase 4，计划 §7.5/§9.4/§9.5）：
 * journal append-only 与 accept 硬门槛、board 投影状态机（无 review）、
 * 版本槽「只在 accept 后 active」不变量、信封预检/裁剪可观测、验收器确定性。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  SuperAgentService,
  clampEnvelope,
  journalFileFor,
  projectBoard,
  projectVersions,
  validateArtifact,
  type Envelope,
  type JournalEvent,
} from '.'

const wsDirs: string[] = []
function tmpWs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-'))
  mkdirSync(join(dir, '.huabu'), { recursive: true })
  wsDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of wsDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄未释放时 best-effort
    }
  }
})

/** 一条完整任务生命周期的标准事件序列（board/versions 测试共用） */
function lifecycleEvents(): JournalEvent[] {
  // 手工构造（纯投影测试不需要真实文件 IO）
  const events: JournalEvent[] = []
  let seq = 0
  const push = (type: JournalEvent['type'], actor: JournalEvent['actor'], payload: Record<string, unknown>) => {
    seq += 1
    events.push({ id: `e${seq}`, at: new Date(2026, 0, 1, 0, 0, seq).toISOString(), type, taskId: 'task-1', actor, payload, v: 1 })
  }
  push('task.created', 'main', { title: '第 3 场分镜图', lane: 'scenes/s3/' })
  push('task.assigned', 'main', { expert: 'expert-visual' })
  push('task.started', 'expert', {})
  push('artifact.ready', 'expert', { artifactId: 'art-1', assetId: 'asset-s3', version: 'staging-1' })
  push('validation.passed', 'validator', { acceptCriteria: ['16:9'], diff: [{ name: 'accept：16:9', passed: true }], artifactId: 'art-1', contextHash: 'hash-1' })
  push('version.activated', 'system', { assetId: 'asset-s3', version: 'v2', artifactId: 'art-1' })
  return events
}

describe('journal（append-only 事实源）', () => {
  it('append → read 往返；id/at 由 journal 生成且唯一', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const a = await service.append('task.created', 't1', 'main', { title: 'x' })
    const b = await service.append('task.assigned', 't1', 'main', { expert: 'e' })
    expect(a.id).not.toBe(b.id)
    expect(a.at <= b.at).toBe(true)
    const events = await service.events()
    expect(events.map((e) => e.type)).toEqual(['task.created', 'task.assigned'])
    // 文件确实只有两行（append-only，无覆盖）
    const lines = readFileSync(journalFileFor(ws), 'utf8').trim().split(String.fromCharCode(10))
    expect(lines.length).toBe(2)
  })

  it('validation.passed 缺 accept 证据字段被拒绝，不落盘', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    await expect(service.append('validation.passed', 't1', 'validator', { artifactId: 'a1' })).rejects.toThrow(/acceptCriteria/)
    expect(await service.events()).toEqual([])
  })

  it('version.activated 缺 assetId/version 被拒绝', async () => {
    const service = new SuperAgentService(tmpWs())
    await expect(service.append('version.activated', 't1', 'system', {})).rejects.toThrow(/assetId/)
  })

  it('崩溃安全：末尾残行被容忍丢弃，前序事实完好', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    await service.append('task.created', 't1', 'main', {})
    const file = journalFileFor(ws)
    writeFileSync(file, readFileSync(file, 'utf8') + '{"id":"broken", "type":"task.st', 'utf8')
    const events = await service.events()
    expect(events.length).toBe(1)
    expect(events[0]?.type).toBe('task.created')
    // 残行之后仍可继续 append（写链未断）
    const next = await service.append('task.started', 't1', 'expert', {})
    expect((await service.events()).length).toBe(2)
    expect(next.type).toBe('task.started')
  })

  it('并发 append 串行化：顺序落盘无交错损坏', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => service.append('task.created', `t${i}`, 'main', { i }))
    )
    const events = await service.events()
    expect(events.length).toBe(30)
    expect(new Set(events.map((e) => e.taskId)).size).toBe(30)
  })
})

describe('board 投影（无 review 状态）', () => {
  it('完整生命周期：todo→active→validating→done；两次投影恒等', () => {
    const events = lifecycleEvents()
    const board1 = projectBoard(events)
    const board2 = projectBoard([...events])
    expect(JSON.stringify(board1)).toBe(JSON.stringify(board2))
    expect(board1.length).toBe(1)
    expect(board1[0]).toMatchObject({ taskId: 'task-1', status: 'done', expert: 'expert-visual', attempts: 0, lane: 'scenes/s3/' })
    expect(board1[0]?.status).not.toBe('review')
  })

  it('validation.failed → attention + 计数；重派回 todo 可再次推进', () => {
    const events: JournalEvent[] = []
    let seq = 0
    const push = (type: JournalEvent['type'], payload: Record<string, unknown> = {}, actor: JournalEvent['actor'] = 'validator') => {
      seq += 1
      events.push({ id: `e${seq}`, at: new Date(2026, 0, 1, 0, 0, seq).toISOString(), type, taskId: 't', actor, payload, v: 1 })
    }
    push('task.created', { title: 'x' }, 'main')
    push('task.started', {}, 'expert')
    push('artifact.ready', { artifactId: 'a1' }, 'expert')
    push('validation.failed', { reason: '比例不符 16:9', diff: [] })
    expect(projectBoard(events)[0]).toMatchObject({ status: 'attention', attempts: 1 })
    push('task.assigned', { expert: 'expert-visual' }, 'main')
    expect(projectBoard(events)[0]).toMatchObject({ status: 'todo', attempts: 1 })
    push('task.started', {}, 'expert')
    push('artifact.ready', { artifactId: 'a2' }, 'expert')
    push('validation.passed', { acceptCriteria: [], diff: [], artifactId: 'a2', contextHash: 'h' })
    expect(projectBoard(events)[0]).toMatchObject({ status: 'done', attempts: 1 })
  })

  it('artifact.rejected → blocked（专家自判无法产出）', () => {
    const events: JournalEvent[] = [
      { id: '1', at: '2026-01-01T00:00:01Z', type: 'task.created', taskId: 't', actor: 'main', payload: {}, v: 1 },
      { id: '2', at: '2026-01-01T00:00:02Z', type: 'task.started', taskId: 't', actor: 'expert', payload: {}, v: 1 },
      { id: '3', at: '2026-01-01T00:00:03Z', type: 'artifact.rejected', taskId: 't', actor: 'expert', payload: { reason: '缺角色参考' }, v: 1 },
    ]
    expect(projectBoard(events)[0]).toMatchObject({ status: 'blocked', lastReason: '缺角色参考' })
  })
})

describe('版本槽（只在 accept 后 active）', () => {
  it('staging 记录；accept+激活 → active 带完整证据', () => {
    const slots = projectVersions(lifecycleEvents())
    expect(slots['asset-s3']).toBeDefined()
    expect(slots['asset-s3']?.staging).toHaveLength(1)
    const active = slots['asset-s3']?.active[0]
    expect(active).toMatchObject({ version: 'v2', artifactId: 'art-1' })
    expect(active?.accept).toMatchObject({ contextHash: 'hash-1' })
  })

  it('没有 validation.passed 的激活被防御性忽略（不变量由投影保证）', () => {
    const events: JournalEvent[] = [
      { id: '1', at: '2026-01-01T00:00:01Z', type: 'artifact.ready', taskId: 't', actor: 'expert', payload: { assetId: 'a', version: 's1', artifactId: 'art-1' }, v: 1 },
      { id: '2', at: '2026-01-01T00:00:02Z', type: 'version.activated', taskId: 't', actor: 'system', payload: { assetId: 'a', version: 'v9', artifactId: 'art-1' }, v: 1 },
    ]
    const slots = projectVersions(events)
    expect(slots['a']?.active).toEqual([])
    expect(slots['a']?.staging).toHaveLength(1)
  })
})

describe('信封预检与裁剪', () => {
  const base: Envelope = {
    taskId: 't',
    scope: 'scene/s3',
    promptLayers: [{ level: 'shot', prompt: '夜巷追逐' }],
    entities: [],
    adjacent: [],
    negative: [],
    accept: ['16:9'],
    lane: ['scenes/s3/'],
    budget: { maxRefs: 2, maxTokens: 8000 },
  }
  const ref = (assetId: string, role: Envelope['entities'][number]['role'], status: Envelope['entities'][number]['status'] = 'active') => ({
    assetId,
    path: `assets/${assetId}`,
    version: 'v1',
    kind: 'image' as const,
    role,
    status,
  })

  it('stale/pending 拒绝注入；超限按角色优先级裁剪并记录原因', () => {
    const result = clampEnvelope({
      ...base,
      entities: [ref('char', 'character'), ref('loc', 'location'), ref('prop', 'prop'), ref('old', 'reference', 'stale')],
      adjacent: [ref('prev', 'previous_take')],
    })
    expect(result.rejected).toEqual([{ assetId: 'old', reason: expect.stringContaining('stale') }])
    expect(result.dropped.map((d) => d.assetId).sort()).toEqual(['prev', 'prop'])
    expect(result.envelope.entities.map((e) => e.assetId).sort()).toEqual(['char', 'loc'])
    expect(result.dropped[0]?.reason).toContain('角色优先级')
  })

  it('未超限时全量保留', () => {
    const result = clampEnvelope({ ...base, entities: [ref('a', 'character')], adjacent: [] })
    expect(result.dropped).toEqual([])
    expect(result.rejected).toEqual([])
    expect(result.envelope.entities).toHaveLength(1)
  })
})

describe('验收器（确定性结构检查）', () => {
  const envelope: Envelope = {
    taskId: 't',
    scope: 'scene/s3',
    promptLayers: [],
    entities: [],
    adjacent: [],
    negative: [],
    accept: ['16:9', '时长 5 秒', '角色与参考一致'],
    lane: [],
    budget: { maxRefs: 2, maxTokens: 8000 },
  }

  it('结构全部达标 → passed，证据字段齐备（journal 可直接落盘）', () => {
    const result = validateArtifact(envelope, { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'video', width: 1920, height: 1080, durationS: 5.1, format: 'mp4', bytes: 1024 }, 'hash-1')
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatchObject({ artifactId: 'a1', contextHash: 'hash-1' })
    expect(result.evidence.acceptCriteria).toEqual(envelope.accept)
    expect((result.evidence.diff as unknown[]).length).toBeGreaterThan(0)
  })

  it('比例不符 → failed，reason 指明未达标项', () => {
    const result = validateArtifact(envelope, { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'video', width: 1080, height: 1080, durationS: 5, format: 'mp4', bytes: 1024 }, 'hash-1')
    expect(result.passed).toBe(false)
    expect(result.evidence.reason).toContain('16:9')
  })

  it('不可结构化的标准不判失败（视觉辅助的后续职责）', () => {
    const result = validateArtifact(envelope, { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'video', width: 1920, height: 1080, durationS: 5, format: 'mp4' }, 'hash-1')
    expect(result.passed).toBe(true)
    const consistency = result.checks.find((c) => c.name.includes('一致'))
    expect(consistency?.expected).toContain('结构检查不适用')
  })
})

/* ------------------------------------------------ Phase 4 编排闭环（runTask） */

import { buildEnvelope, envelopeToInstructions, isPathAllowed } from './dispatch'
import { runTask, parseArtifactFromReceipt, type ExpertRunner } from './orchestrator'

/** 造一个按脚本返回产物的假专家（不调模型，只验编排不变量） */
function scriptedExpert(artifacts: Array<Partial<import('.').ArtifactCandidate> & { kind: 'image' | 'video' | 'audio' | 'text' }>): ExpertRunner {
  let i = 0
  return {
    async run() {
      const spec = artifacts[Math.min(i, artifacts.length - 1)]!
      i += 1
      return {
        artifact: {
          artifactId: spec.artifactId ?? 'art-1',
          assetId: spec.assetId ?? 'asset-1',
          version: spec.version ?? 'staging-1',
          kind: spec.kind,
          ...(spec.path ? { path: spec.path } : {}),
          ...(typeof spec.width === 'number' ? { width: spec.width } : {}),
          ...(typeof spec.height === 'number' ? { height: spec.height } : {}),
          ...(typeof spec.durationS === 'number' ? { durationS: spec.durationS } : {}),
          ...(spec.format ? { format: spec.format } : {}),
          ...(typeof spec.bytes === 'number' ? { bytes: spec.bytes } : {}),
        },
        receipt: 'done',
        contextHash: 'ctx-hash',
      }
    },
  }
}

const goodIntent = (_ws: string) => ({
  taskId: 'task-run-1',
  scope: 'scenes/s3',
  prompt: '画一张 16:9 的分镜图',
  accept: ['16:9'],
})

describe('信封生成与 lane 约束', () => {
  it('intent → envelope：lane 从 scope 派生，任务层追加到 promptLayers 末尾', () => {
    const { envelope, dropped, rejected } = buildEnvelope({
      taskId: 't',
      scope: 'scenes/s3',
      prompt: '画分镜',
      accept: ['16:9'],
    })
    expect(envelope.lane).toEqual(['scenes/s3/'])
    expect(envelope.promptLayers.at(-1)).toEqual({ level: 'task', prompt: '画分镜' })
    expect(dropped).toEqual([])
    expect(rejected).toEqual([])
  })

  it('instructions 含任务/验收/写区/资产，且不含主会话内容', () => {
    const { envelope } = buildEnvelope({
      taskId: 't',
      scope: 's',
      prompt: 'P',
      accept: ['16:9'],
      entities: [{ assetId: 'a1', path: 'assets/a1.png', version: 'v1', kind: 'image', role: 'character', status: 'active' }],
    })
    const text = envelopeToInstructions(envelope)
    expect(text).toContain('任务')
    expect(text).toContain('16:9')
    expect(text).toContain('scenes/s/'.replace('scenes/s/', 's/'))
    expect(text).toContain('a1')
  })

  it('lane 白名单：前缀内放行，越界拒绝', () => {
    const { envelope } = buildEnvelope({ taskId: 't', scope: 'scenes/s3', prompt: 'p', accept: [] })
    expect(isPathAllowed(envelope, 'scenes/s3/shot1.png')).toBe(true)
    expect(isPathAllowed(envelope, 'scenes' + String.fromCharCode(92) + 's3' + String.fromCharCode(92) + 'shot1.png')).toBe(true)
    expect(isPathAllowed(envelope, 'scenes/s4/shot1.png')).toBe(false)
    expect(isPathAllowed(envelope, '../etc/passwd')).toBe(false)
  })
})

describe('runTask 编排闭环', () => {
  it('通过验收：journal 全生命周期 + 版本激活', async () => {
    const service = new SuperAgentService(tmpWs())
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert([{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png', bytes: 1024 }]),
    })
    expect(result.status).toBe('done')
    expect(result.activated).toBe(true)
    const types = (await service.events()).map((e) => e.type)
    expect(types).toEqual([
      'task.created', 'task.assigned', 'task.started', 'artifact.ready',
      'validation.passed', 'version.activated',
    ])
    const board = await service.board()
    expect(board[0]).toMatchObject({ taskId: 'task-run-1', status: 'done' })
    const active = await service.activeVersion('asset-1')
    expect(active).toMatchObject({ version: 'staging-1' })
    expect(active?.accept?.contextHash).toBe('ctx-hash')
  })

  it('shadow 模式：不写 version.activated，版本不 active', async () => {
    const service = new SuperAgentService(tmpWs())
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert([{ kind: 'image', width: 1920, height: 1080 }]),
      options: { shadow: true },
    })
    expect(result.status).toBe('done')
    expect(result.activated).toBe(false)
    const types = (await service.events()).map((e) => e.type)
    expect(types).not.toContain('version.activated')
    expect(await service.activeVersion('asset-1')).toBeUndefined()
    const slots = await service.versionSlots()
    expect(slots['asset-1']?.staging).toHaveLength(1)
  })

  it('验收失败：带 diff 转 attention，重试达上限后停止', async () => {
    const service = new SuperAgentService(tmpWs())
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert([{ kind: 'image', width: 1000, height: 1000 }]),
      options: { maxValidationAttempts: 2 },
    })
    expect(result.status).toBe('attention')
    expect(result.failures.length).toBeGreaterThan(0)
    const events = await service.events()
    expect(events.filter((e) => e.type === 'validation.failed')).toHaveLength(2)
    expect(events.some((e) => e.type === 'version.activated')).toBe(false)
    const board = await service.board()
    expect(board[0]).toMatchObject({ status: 'attention', attempts: 2 })
  })

  it('缺参考：全部引用 stale → 不生成，转 blocked', async () => {
    const service = new SuperAgentService(tmpWs())
    const result = await runTask({
      service,
      intent: {
        ...goodIntent('ws'),
        entities: [{ assetId: 'old', path: 'a', version: 'v0', kind: 'image', role: 'character', status: 'stale' }],
      },
      expert: scriptedExpert([{ kind: 'image', width: 1920, height: 1080 }]),
    })
    expect(result.status).toBe('blocked')
    expect(result.failures[0]).toContain('缺参考')
    const types = (await service.events()).map((e) => e.type)
    expect(types).toEqual(['task.created', 'artifact.rejected'])
    expect((await service.board())[0]?.status).toBe('blocked')
  })

  it('产物越出 lane 写区 → 拒绝并停止', async () => {
    const service = new SuperAgentService(tmpWs())
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert([{ kind: 'image', width: 1920, height: 1080, path: 'secrets/leak.png' }]),
    })
    expect(result.status).toBe('attention')
    expect(result.failures[0]).toContain('lane')
    expect((await service.events()).some((e) => e.type === 'version.activated')).toBe(false)
  })

  it('回执解析：从文本里提取 artifact JSON，缺字段返回 null', () => {
    const { envelope } = buildEnvelope({ taskId: 't', scope: 's', prompt: 'p', accept: [] })
    const ok = parseArtifactFromReceipt(
      '完成。{"artifactId":"a1","assetId":"as1","version":"v1","kind":"image","width":1920,"height":1080}',
      envelope
    )
    expect(ok).toMatchObject({ artifactId: 'a1', width: 1920 })
    expect(parseArtifactFromReceipt('完成，没有 JSON', envelope)).toBeNull()
    expect(parseArtifactFromReceipt('{"artifactId":"a1"}', envelope)).toBeNull()
  })
})
