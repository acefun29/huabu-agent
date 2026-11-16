/**
 * SuperAgent 基础层测试（Phase 4，计划 §7.5/§9.4/§9.5）：
 * journal append-only 与 accept 硬门槛、board 投影状态机（无 review）、
 * 版本槽「只在 accept 后 active」不变量、信封预检/裁剪可观测、验收器确定性。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

/** 最小 PNG：签名 + IHDR 里的宽高，足够 media/imageSize.ts 读出真实尺寸 */
function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** 在工作区里真的落一个产物文件，返回工作区相对路径（验收器现在要 stat 到它） */
function putArtifact(ws: string, relPath: string, content: Buffer = Buffer.alloc(1024, 7)): string {
  const abs = join(ws, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return relPath
}

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

  it('需求版本（A05）：created=1，每次 user.changed +1，投影可回放', () => {
    const events: JournalEvent[] = []
    let seq = 0
    const push = (type: JournalEvent['type'], payload: Record<string, unknown> = {}) => {
      seq += 1
      events.push({ id: `e${seq}`, at: new Date(2026, 0, 1, 0, 0, seq).toISOString(), type, taskId: 't', actor: 'user', payload, v: 1 })
    }
    push('task.created', { prompt: '16:9', accept: ['16:9'] })
    expect(projectBoard(events)[0]?.requirementRevision).toBe(1)
    push('user.changed', { prompt: '4:3', accept: ['4:3'] })
    push('user.changed', { prompt: '1:1', accept: ['1:1'] })
    const task = projectBoard(events)[0]
    expect(task?.requirementRevision).toBe(3)
    expect(task?.accept).toEqual(['1:1'])
    expect(task?.requirementChangedAt).toBeTruthy()
    // 重复投影恒等（journal 是唯一事实源）
    expect(projectBoard([...events])[0]?.requirementRevision).toBe(3)
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
    // 验收通过 ≠ 交付完成（R03）：非 shadow 任务的 done 由版本激活产生
    expect(projectBoard(events)[0]).toMatchObject({ status: 'validating', attempts: 1 })
    push('version.activated', { assetId: 'as', version: 'v1', artifactId: 'a2' }, 'system')
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

  it('user.changed 不改变任务状态；但把新需求落到投影上，并留改需求时间（C13）', () => {
    const events: JournalEvent[] = [
      {
        id: '1',
        at: '2026-01-01T00:00:01Z',
        type: 'task.created',
        taskId: 't',
        actor: 'main',
        payload: { prompt: '旧需求', accept: ['16:9'] },
        v: 1
      },
      {
        id: '2',
        at: '2026-01-01T00:00:02Z',
        type: 'user.changed',
        taskId: 't',
        actor: 'user',
        payload: { prompt: '改需求：改成 4:3', accept: ['4:3'] },
        v: 1
      },
      // 对不存在的任务不凭空建行
      { id: '3', at: '2026-01-01T00:00:03Z', type: 'user.changed', taskId: 'ghost', actor: 'user', payload: { prompt: 'x' }, v: 1 },
    ]
    const board = projectBoard(events)
    expect(board).toHaveLength(1)
    // 状态不变（用户改需求不是状态迁移）
    expect(board[0]).toMatchObject({ taskId: 't', status: 'todo' })
    // 但重派要用的 prompt/accept 必须是最新版，否则重派等于按旧需求重做
    expect(board[0]?.prompt).toBe('改需求：改成 4:3')
    expect(board[0]?.accept).toEqual(['4:3'])
    expect(board[0]?.requirementChangedAt).toBe('2026-01-01T00:00:02Z')
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

describe('验收器（确定性结构检查，落真实文件）', () => {
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

  it('真实文件 + 实测元数据达标 → passed，证据字段齐备（journal 可直接落盘）', async () => {
    const ws = tmpWs()
    const path = putArtifact(ws, 'scene/s3/a.mp4')
    const result = await validateArtifact(
      envelope,
      { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'video', width: 1920, height: 1080, durationS: 5.1, path },
      {
        workspaceDir: ws,
        expertContextHash: 'hash-1',
        // 视频的尺寸/时长必须实测（A04）：这里注入替身模拟 ffmpeg 探测结果
        probeMedia: async () => ({ width: 1920, height: 1080, durationS: 5.1 })
      }
    )
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatchObject({ artifactId: 'a1' })
    // 文件内容哈希优先于专家自报的 contextHash（C7：accept 要能钉住真实字节）
    expect(result.evidence.contextHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.evidence.acceptCriteria).toEqual(envelope.accept)
    expect((result.evidence.diff as unknown[]).length).toBeGreaterThan(0)
    expect(result.checks.find((c) => c.name === '尺寸来自实测')?.actual).toBe('1920x1080')
  })

  it('A04：硬条件拿不到实测证据时不能通过（伪 mp4 + 回执自报宽高时长）', async () => {
    const ws = tmpWs()
    const path = putArtifact(ws, 'scene/s3/fake.mp4', Buffer.from('definitely not a video'))
    const result = await validateArtifact(
      envelope,
      { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'video', width: 1920, height: 1080, durationS: 5, path },
      { workspaceDir: ws, probeMedia: async () => null }
    )
    // 旧行为：无确定失败项 → passed:true。现在比例/时长是硬条件，缺证据即阻断
    expect(result.passed).toBe(false)
    expect(result.evidence.reason).toContain('16:9')
    const ratio = result.checks.find((c) => c.name.includes('16:9'))
    expect(ratio?.required).toBe(true)
    expect(ratio?.undetermined).toBe(true)
    expect(ratio?.actual).toBe('无法实测')
  })

  it('比例不符 → failed，reason 指明未达标项', async () => {
    const ws = tmpWs()
    const path = putArtifact(ws, 'scene/s3/a.mp4')
    const result = await validateArtifact(
      envelope,
      { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'video', width: 1080, height: 1080, durationS: 5, path },
      { workspaceDir: ws, expertContextHash: 'hash-1' }
    )
    expect(result.passed).toBe(false)
    expect(result.evidence.reason).toContain('16:9')
  })

  it('不可结构化的标准记为 undetermined 并进 gaps，不阻断激活', async () => {
    const ws = tmpWs()
    const path = putArtifact(ws, 'scene/s3/a.mp4')
    const result = await validateArtifact(
      envelope,
      { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'video', width: 1920, height: 1080, durationS: 5, path },
      { probeMedia: async () => ({ width: 1920, height: 1080, durationS: 5 }), workspaceDir: ws, expertContextHash: 'hash-1' }
    )
    expect(result.passed).toBe(true)
    const consistency = result.checks.find((c) => c.name.includes('一致'))
    expect(consistency?.undetermined).toBe(true)
    expect(consistency?.passed).toBe(false)
    // 语义标准不进硬条件：记录成证据缺口，由产品策略决定是否要人工确认
    expect(consistency?.required).toBeUndefined()
    expect(result.gaps.some((name) => name.includes('一致'))).toBe(true)
  })

  /* ---- C1 的回归点：回执自报不再能决定结论 ---- */

  it('回执不声明 path → 直接 failed（零检查通过的老路已封）', async () => {
    const ws = tmpWs()
    const result = await validateArtifact(
      { ...envelope, accept: [] },
      { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'image', width: 1920, height: 1080, bytes: 204800, format: 'png' },
      { workspaceDir: ws }
    )
    expect(result.passed).toBe(false)
    expect(result.evidence.reason).toContain('产物路径')
  })

  it('文件不存在 → failed（自报 bytes/width 不再能过）', async () => {
    const ws = tmpWs()
    const result = await validateArtifact(
      envelope,
      { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'video', width: 1920, height: 1080, durationS: 5, path: 'scene/s3/ghost.mp4', bytes: 204800 },
      { workspaceDir: ws }
    )
    expect(result.passed).toBe(false)
    expect(result.evidence.reason).toContain('产物文件存在')
  })

  it('图片尺寸以文件头为准，自报值与真实值不一致时按真实的判', async () => {
    const ws = tmpWs()
    // 真实文件是 1:1，自报 16:9 —— 结论必须跟文件走
    const path = putArtifact(ws, 'scene/s3/square.png', pngBuffer(1000, 1000))
    const result = await validateArtifact(
      { ...envelope, accept: ['16:9'] },
      { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'image', width: 1920, height: 1080, path },
      { workspaceDir: ws }
    )
    expect(result.passed).toBe(false)
    const ratio = result.checks.find((c) => c.name.includes('16:9'))
    expect(ratio?.actual).toBe('1000:1000')
  })

  it('路径越出工作区（`..` / 绝对路径）→ failed', async () => {
    const ws = tmpWs()
    for (const bad of ['../outside.png', 'C:/Windows/System32/x.png', '/etc/passwd']) {
      const result = await validateArtifact(
        { ...envelope, accept: [] },
        { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'image', path: bad },
        { workspaceDir: ws }
      )
      expect(result.passed).toBe(false)
      expect(result.evidence.reason).toContain('产物文件存在')
    }
  })

  it('扩展名与 kind 不符 → failed（格式判定取自真实文件名）', async () => {
    const ws = tmpWs()
    const path = putArtifact(ws, 'scene/s3/a.png')
    const result = await validateArtifact(
      { ...envelope, accept: [] },
      { artifactId: 'a1', assetId: 'as', version: 's1', kind: 'video', path },
      { workspaceDir: ws }
    )
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === '格式匹配类型')?.actual).toBe('png')
  })
})

/* ------------------------------------------------ Phase 4 编排闭环（runTask） */

import { buildEnvelope, envelopeToInstructions, isPathAllowed, taskInputFromJournal } from './dispatch'
import { runTask, parseArtifactFromReceipt, type ExpertRunner } from './orchestrator'
import type { TaskEvent } from '../../shared/ipc'

/** 造一个按脚本返回产物的假专家（不调模型，只验编排不变量） */
function scriptedExpert(
  ws: string,
  artifacts: Array<Partial<import('.').ArtifactCandidate> & { kind: 'image' | 'video' | 'audio' | 'text' }>
): ExpertRunner {
  let i = 0
  return {
    async run() {
      const spec = artifacts[Math.min(i, artifacts.length - 1)]!
      i += 1
      // 真的落盘：验收器按磁盘事实判定（C1）。图片用能读出宽高的最小 PNG，
      // 其余类型写一段字节——存在性/非空/扩展名都是真实的
      if (spec.path) {
        const content =
          spec.kind === 'image' && typeof spec.width === 'number' && typeof spec.height === 'number'
            ? pngBuffer(spec.width, spec.height)
            : Buffer.alloc(1024, 7)
        putArtifact(ws, spec.path, content)
      }
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

  it('lane 前缀自身非法时不放行任何路径（C6：配置错误要暴露而不是静默 fail-closed）', () => {
    const withLane = (lane: string[]) =>
      buildEnvelope({ taskId: 't', scope: 'scenes/s3', prompt: 'p', accept: [], lane })
    // 绝对路径 / 盘符 / `..` 段：即使被比较的路径"看起来在该前缀下"也不放行
    expect(isPathAllowed(withLane(['../etc/']).envelope, 'etc/passwd')).toBe(false)
    expect(isPathAllowed(withLane(['/tmp/']).envelope, 'tmp/a.png')).toBe(false)
    expect(isPathAllowed(withLane(['C:/tmp/']).envelope, 'tmp/a.png')).toBe(false)
    expect(isPathAllowed(withLane(['.']).envelope, 'a.png')).toBe(false)
    // 合法前缀照常工作
    expect(isPathAllowed(withLane(['scenes/s3/']).envelope, 'scenes/s3/a.png')).toBe(true)
  })
})

describe('runTask 编排闭环', () => {
  it('专家流式事件带上 taskId/attempt 转发（详情页实时显示的依据）', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    putArtifact(ws, 'scenes/s3/a.png', pngBuffer(1920, 1080))
    const seen: TaskEvent[] = []
    const expert: ExpertRunner = {
      async run({ broadcast }) {
        broadcast?.({ type: 'task.expert_start', expert: 'expert-visual' })
        broadcast?.({ type: 'task.expert_delta', channel: 'text', text: '实时内容' })
        broadcast?.({ type: 'task.expert_end' })
        return {
          artifact: {
            artifactId: 'art-live',
            assetId: 'asset-live',
            version: 'staging-1',
            kind: 'image',
            width: 1920,
            height: 1080,
            path: 'scenes/s3/a.png',
            bytes: 1024
          },
          receipt: 'done',
          contextHash: 'ctx-hash'
        }
      }
    }
    await runTask({
      service,
      intent: goodIntent('ws'),
      expert,
      options: { onTaskEvent: (event) => seen.push(event) }
    })
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'task.expert_start', taskId: 'task-run-1', attempt: 1 }),
        expect.objectContaining({
          type: 'task.expert_delta',
          taskId: 'task-run-1',
          attempt: 1,
          channel: 'text',
          text: '实时内容'
        }),
        expect.objectContaining({ type: 'task.expert_end', taskId: 'task-run-1', attempt: 1 })
      ])
    )
  })

  it('验收失败后重试：第二次尝试带上上一轮的失败项（不再原样重跑）', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const seen: Array<string | undefined> = []
    // 第一轮声明一个**不存在**的文件 → 「产物文件存在」失败；第二轮同样，用来观察喂进去的反馈
    const expert: ExpertRunner = {
      async run({ previousFailure }) {
        seen.push(previousFailure)
        return {
          artifact: {
            artifactId: 'art-x',
            assetId: 'asset-x',
            version: 'staging-1',
            kind: 'text',
            path: 'scenes/s3/plot.md',
            bytes: 10
          },
          receipt: 'x',
          contextHash: 'ctx'
        }
      }
    }
    await runTask({ service, intent: goodIntent('ws'), expert })
    expect(seen).toHaveLength(2)
    // 第一次没有反馈；第二次必须带上失败原因与失败项（期望/实际）
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toContain('产物文件存在')
    expect(seen[1]).toContain('scenes/s3/plot.md')
  })
  it('需求变更（A05）：验收通过但需求已变 → 不激活，落 requirement.stale 退回 attention', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const path = putArtifact(ws, 'scenes/s3/a.png', pngBuffer(1920, 1080))
    const expert: ExpertRunner = {
      async run() {
        // 专家执行期间用户直连专家改需求（appendUserChange 的同一条事实）
        await service.append('user.changed', 'task-run-1', 'user', {
          prompt: '改成 4:3 重新出一版',
          accept: ['4:3']
        })
        return {
          artifact: {
            artifactId: 'art-1',
            assetId: 'asset-1',
            version: 'staging-1',
            kind: 'image',
            path,
            width: 1920,
            height: 1080
          },
          receipt: 'ok',
          contextHash: 'ctx'
        }
      }
    }
    const result = await runTask({ service, intent: goodIntent('ws'), expert })
    expect(result.status).toBe('attention')
    expect(result.activated).toBe(false)
    const types = (await service.events()).map((event) => event.type)
    expect(types).toContain('requirement.stale')
    // 关键：不能出现验收通过/版本激活——旧结果的 16:9 不满足新需求的 4:3
    expect(types).not.toContain('validation.passed')
    expect(types).not.toContain('version.activated')
    const board = await service.board()
    expect(board[0]).toMatchObject({ status: 'attention', requirementRevision: 2 })
    expect(board[0]?.lastReason).toContain('需求已变更')
    expect(board[0]?.lastReason).toContain('第 1 版 → 第 2 版')
  })

  it('取消优先于激活（A08）：验收写盘期间取消 → 不再写 version.activated', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const controller = new AbortController()
    const originalAppend = service.append.bind(service)
    let armed = true
    // 模拟「用户恰好在 validation.passed 落盘这段 await 里点了停止」
    service.append = async (type, taskId, actor, payload = {}) => {
      const event = await originalAppend(type, taskId, actor, payload)
      if (type === 'validation.passed' && armed) {
        armed = false
        controller.abort()
      }
      return event
    }
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png', bytes: 1024 }]),
      options: { signal: controller.signal }
    })
    expect(result.status).toBe('blocked')
    expect(result.activated).toBe(false)
    const events = await service.events()
    const types = events.map((event) => event.type)
    // 验收结论已落盘（那一刻还不知道被取消），但**不能**再激活
    expect(types).toContain('validation.passed')
    expect(types).not.toContain('version.activated')
    const cancelled = events.find((event) => event.type === 'task.cancelled')
    expect(cancelled?.payload).toMatchObject({ reason: expect.stringContaining('激活前') })
    // R03：任务板必须与返回值/日志同结论——验收通过不算完成，取消后应显示受阻
    const board = await service.board()
    expect(board[0]?.status).toBe('blocked')
  })

  it('A10：task.created 落下可重建输入的 spec；重派据此还原', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const intent = {
      ...goodIntent('ws'),
      promptLayers: [{ level: 'project', prompt: '冷调写实短剧' }],
      negative: ['不要字幕', '不要水印'],
      lane: ['scenes/s3/']
    }
    await runTask({
      service,
      intent,
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png', bytes: 1024 }])
    })
    const events = await service.events()
    const created = events.find((event) => event.type === 'task.created')!
    expect(created.payload.spec).toMatchObject({
      promptLayers: [{ level: 'project', prompt: '冷调写实短剧' }],
      negative: ['不要字幕', '不要水印'],
      lane: ['scenes/s3/']
    })
    // 重派输入从 journal 重建：除 taskId 外与原始派单等价
    const input = taskInputFromJournal(events, 'task-run-1')
    expect(input).toMatchObject({
      scope: 'scenes/s3',
      prompt: '画一张 16:9 的分镜图',
      accept: ['16:9'],
      negative: ['不要字幕', '不要水印'],
      lane: ['scenes/s3/'],
      promptLayers: [{ level: 'project', prompt: '冷调写实短剧' }]
    })
  })

  it('taskInputFromJournal：旧任务无 spec 时退化为当时确实记下的字段；不存在返回 null', () => {
    const legacy = [
      {
        id: 'e1',
        at: 't',
        type: 'task.created' as const,
        taskId: 't1',
        actor: 'main' as const,
        v: 1,
        payload: { scope: 's', prompt: 'p', accept: ['16:9'], expert: 'expert-visual' }
      }
    ]
    expect(taskInputFromJournal(legacy, 't1')).toEqual({
      scope: 's',
      prompt: 'p',
      accept: ['16:9'],
      expert: 'expert-visual'
    })
    expect(taskInputFromJournal(legacy, 'nope')).toBeNull()
  })

  it('A02：回执路径抄错时，以工具实测路径验收并留下 receiptPath 证据', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const realPath = putArtifact(ws, 'scenes/s3/real.png', pngBuffer(1920, 1080))
    const expert: ExpertRunner = {
      async run() {
        return {
          // 模型在回执里写了一个不存在的路径（抄错文件名）
          artifact: { artifactId: 'a1', assetId: 'as', version: 'v1', kind: 'image', path: 'scenes/s3/claimed.png' },
          receipt: 'ok',
          contextHash: 'ctx',
          // 工具真实回执：产物就在 real.png
          observed: { path: realPath, kind: 'image', width: 1920, height: 1080 }
        }
      }
    }
    const result = await runTask({ service, intent: goodIntent('ws'), expert })
    expect(result.status).toBe('done')
    const events = await service.events()
    const ready = events.find((event) => event.type === 'artifact.ready')!
    // 验收用的是真实路径；模型声明的路径作为证据留在 journal 里
    expect(ready.payload).toMatchObject({ path: realPath, receiptPath: 'scenes/s3/claimed.png' })
    const passed = events.find((event) => event.type === 'validation.passed')!
    const existsCheck = (passed.payload.diff as Array<{ name: string; expected?: string }>).find(
      (check) => check.name === '产物文件存在'
    )
    expect(existsCheck?.expected).toBe(realPath)
  })

  it('A02：回执没声明路径时，用工具路径直接交付（不再判「无法验收」）', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const realPath = putArtifact(ws, 'scenes/s3/real2.png', pngBuffer(1920, 1080))
    const expert: ExpertRunner = {
      async run() {
        return {
          artifact: { artifactId: 'a2', assetId: 'as2', version: 'v1', kind: 'image' },
          receipt: 'ok',
          contextHash: 'ctx',
          observed: { path: realPath, kind: 'image', width: 1920, height: 1080 }
        }
      }
    }
    const result = await runTask({ service, intent: goodIntent('ws'), expert })
    expect(result.status).toBe('done')
    const passed = (await service.events()).find((event) => event.type === 'validation.passed')!
    expect(passed.payload.artifactId).toBe('a2')
  })

  it('回执解析：assetId 空串不算格式不合格（模型不知道账本 id）', () => {
    const envelope = buildEnvelope({ ...goodIntent('ws'), expert: 'expert-exec' }).envelope
    // 真机上模型写的就是空串：此前整条被跳过 → 已有 13.8KB 文件的的任务报「回执格式不合格」
    const receipt =
      '已写入文件。\n\n{"artifactId":"plot-scifi-ringbell-shooting","assetId":"","version":"v2","kind":"text",' +
      '"path":"story/plot-scifi-v2/plot-scifi-ringbell-shooting.md","format":"md","bytes":13884,"width":0,"height":0,"durationS":0}'
    const parsed = parseArtifactFromReceipt(receipt, envelope)
    expect(parsed).toMatchObject({
      artifactId: 'plot-scifi-ringbell-shooting',
      // 系统按 artifactId 生成资产身份
      assetId: 'plot-scifi-ringbell-shooting',
      version: 'v2',
      kind: 'text',
      path: 'story/plot-scifi-v2/plot-scifi-ringbell-shooting.md',
      format: 'md',
      bytes: 13884
    })
  })

  it('回执解析：显式 assetId 保留（同一资产的后续版本复用）；缺 artifactId 仍拒绝', () => {
    const envelope = buildEnvelope({ ...goodIntent('ws'), expert: 'expert-exec' }).envelope
    const withAsset = parseArtifactFromReceipt(
      '{"artifactId":"a2","assetId":"shot-1","version":"v3","kind":"text","path":"scenes/s3/b.md"}',
      envelope
    )
    expect(withAsset?.assetId).toBe('shot-1')
    expect(withAsset?.format).toBe('md')
    expect(parseArtifactFromReceipt('{"assetId":"x","version":"v1","kind":"text","path":"a.md"}', envelope)).toBeNull()
  })

  it('通过验收：journal 全生命周期 + 版本激活', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png', bytes: 1024 }]),
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
    // accept 证据钉的是真实文件内容哈希，不再是常量 envelope:<taskId>:<scope>（C7）
    expect(active?.accept?.contextHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('shadow 模式：不写 version.activated，版本不 active', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png' }]),
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
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      // 真实文件是 1:1，accept 要 16:9 → 确定性地验收失败
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1000, height: 1000, path: 'scenes/s3/square.png' }]),
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
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const result = await runTask({
      service,
      intent: {
        ...goodIntent('ws'),
        entities: [{ assetId: 'old', path: 'a', version: 'v0', kind: 'image', role: 'character', status: 'stale' }],
      },
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png' }]),
    })
    expect(result.status).toBe('blocked')
    expect(result.failures[0]).toContain('缺参考')
    const types = (await service.events()).map((e) => e.type)
    expect(types).toEqual(['task.created', 'artifact.rejected'])
    expect((await service.board())[0]?.status).toBe('blocked')
  })

  it('产物越出 lane 写区 → blocked（越权不是可重试的验收失败），board 与返回值一致', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'secrets/leak.png' }]),
    })
    // 越界是「专家越权」，主 Agent 重派同一任务不会解决：状态统一 blocked（此前返回 attention 但
    // board 投影为 blocked，UI 与返回值不一致）
    expect(result.status).toBe('blocked')
    expect(result.failures[0]).toContain('lane')
    expect((await service.events()).some((e) => e.type === 'version.activated')).toBe(false)
    expect((await service.board())[0]?.status).toBe('blocked')
  })

  it('并发闸：排队期间不写 task.started，取得槽位后才真正开跑（C15）', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    let release!: () => void
    let entered = false
    const gate = async <T>(fn: () => Promise<T>): Promise<T> => {
      entered = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return fn()
    }
    const pending = runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png' }]),
      options: { withSlot: gate }
    })
    // 闸还没放行：任务已登记（created/assigned），但没有 started
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(entered).toBe(true)
    const early = (await service.events()).map((e) => e.type)
    expect(early).toEqual(['task.created', 'task.assigned'])
    expect((await service.board())[0]?.status).toBe('todo')

    release()
    const result = await pending
    expect(result.status).toBe('done')
    expect((await service.events()).map((e) => e.type)).toContain('task.started')
  })

  it('lane 路径归一化：`..` 段与绝对路径一律拒绝（前缀匹配不能放行穿越）', () => {
    const { envelope } = buildEnvelope({ taskId: 't', scope: 'scenes/s3', prompt: 'p', accept: [] })
    expect(isPathAllowed(envelope, 'scenes/s3/sub/a.png')).toBe(true)
    expect(isPathAllowed(envelope, 'scenes/s3/a.png')).toBe(true)
    // 穿越到写区之外
    expect(isPathAllowed(envelope, 'scenes/s3/../../etc/passwd')).toBe(false)
    // 归一化后仍落在写区内 → 放行（a/../b 不是逃逸）
    expect(isPathAllowed(envelope, 'scenes/s3/a/../b.png')).toBe(true)
    // 绝对路径不属于工作区相对路径
    expect(isPathAllowed(envelope, '/etc/passwd')).toBe(false)
    expect(isPathAllowed(envelope, 'C:/Windows/System32/x.dll')).toBe(false)
    // 空路径
    expect(isPathAllowed(envelope, '   ')).toBe(false)
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

describe('task:event 事件总线（渲染端未接时静默）', () => {
  it('通过验收：status(active) → validation(passed) → activated → status(done)', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const seen: string[] = []
    await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png' }]),
      options: { onTaskEvent: (e) => seen.push(e.type + (e.type === 'task.status' ? ':' + e.status : '')) },
    })
    expect(seen).toEqual(['task.status:active', 'task.validation', 'task.activated', 'task.status:done'])
  })

  it('shadow：不产生 task.activated', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const seen: string[] = []
    await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png' }]),
      options: { shadow: true, onTaskEvent: (e) => seen.push(e.type) },
    })
    expect(seen).not.toContain('task.activated')
    expect(seen).toContain('task.validation')
  })

  it('事件出口抛错不影响编排（journal 是事实源）', async () => {    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const result = await runTask({
      service,
      intent: goodIntent('ws'),
      expert: scriptedExpert(ws, [{ kind: 'image', width: 1920, height: 1080, path: 'scenes/s3/a.png' }]),
      options: {
        onTaskEvent: () => {
          throw new Error('renderer 未就绪')
        },
      },
    })
    expect(result.status).toBe('done')
    expect((await service.events()).some((e) => e.type === 'version.activated')).toBe(true)
  })
})

describe('journal / board / versions 加固', () => {
  it('read() 按 id 去重：重复行只生效一次（C9）', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    const first = await service.append('validation.failed', 't1', 'validator', { reason: 'x' })
    // 外部复制/合并 journal 的等价形态：整段重复一遍
    const raw = readFileSync(journalFileFor(ws), 'utf8')
    writeFileSync(journalFileFor(ws), raw + raw, 'utf8')
    const events = await service.events()
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(first.id)
    // 投影不双计 attempts（此前每行累加一次）
    expect((await service.board())[0]?.attempts).toBe(1)
  })

  it('启动对账：停在 active 的任务补终态收口，且不误伤本进程在跑的任务（C5）', async () => {
    const ws = tmpWs()
    const service = new SuperAgentService(ws)
    await service.append('task.created', 'ghost', 'main', {})
    await service.append('task.started', 'ghost', 'expert', { attempt: 1 })
    expect((await service.board())[0]?.status).toBe('active')

    // 本进程正在跑 → 不当成孤儿
    expect(await service.reconcile(new Set(['ghost']))).toEqual([])
    expect((await service.board())[0]?.status).toBe('active')

    // 没人认领 → 收成 blocked（可被重派救回）
    expect(await service.reconcile()).toEqual(['ghost'])
    expect((await service.board())[0]?.status).toBe('blocked')
    // 幂等：再跑一次没有可收口的
    expect(await service.reconcile()).toEqual([])
  })

  it('终态保护：done 之后迟到的 task.created / artifact.ready / validation.failed 打不回去（C12）', () => {
    const base = lifecycleEvents()
    const stamp = new Date(2026, 0, 2).toISOString()
    const late: JournalEvent[] = [
      { ...base[0]!, id: 'late-created', at: stamp, payload: { title: '重复派单' } },
      { ...base[3]!, id: 'late-ready', at: stamp, payload: { artifactId: 'art-2', assetId: 'asset-s3', version: 'v9' } },
      { ...base[6]! as JournalEvent, id: 'late-failed', type: 'validation.failed', at: stamp, actor: 'validator', payload: { reason: '迟到' } },
    ]
    const board = projectBoard([...base, ...late])
    expect(board[0]?.status).toBe('done')
    expect(board[0]?.attempts).toBe(0)
    expect(board[0]?.lastReason).toBeUndefined()
  })

  it('终态事件把 active 收成 blocked（C5 的事件全集）', () => {
    const base = lifecycleEvents().slice(0, 3) // created / assigned / started
    const at = new Date(2026, 0, 9).toISOString()
    for (const type of ['task.cancelled', 'task.timed_out', 'task.superseded'] as const) {
      const events: JournalEvent[] = [
        ...base,
        { ...base[2]!, id: `end-${type}`, type, at, payload: { reason: type } },
      ]
      expect(projectBoard(events)[0]?.status).toBe('blocked')
    }
  })

  it('shadow 不许事后补激活（C19）', () => {
    const events = lifecycleEvents().map((event) =>
      event.type === 'validation.passed' ? { ...event, payload: { ...event.payload, shadow: true } } : event
    )
    expect(projectVersions(events)['asset-s3']?.active).toEqual([])
  })

  it('激活必须针对被验收的那份产物：assetId/version 不符则不生效（C4）', () => {
    const events = lifecycleEvents().map((event) =>
      event.type === 'validation.passed'
        ? { ...event, payload: { ...event.payload, assetId: 'asset-other', version: 'staging-1' } }
        : event
    )
    expect(projectVersions(events)['asset-s3']?.active).toEqual([])
  })

  it('同一版本不得重复激活（C20）', () => {
    const events = lifecycleEvents()
    const again: JournalEvent = { ...events[5]!, id: 'dup-activate', at: new Date(2026, 0, 9).toISOString() }
    expect(projectVersions([...events, again])['asset-s3']?.active).toHaveLength(1)
  })
})

/* ------------------------------------- Phase 4 真模型专家 E2E（无凭据跳过） */
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY

describe.skipIf(!DEEPSEEK_KEY)('runTask × 真模型专家（DeepSeek）', () => {
  it(
    '专家按信封产出候选产物 → 结构验收通过 → 版本激活（非 shadow）',
    async () => {
      const { InMemoryCredentialStore } = await import('../agent/contracts')
      const { ChatModelManager } = await import('../models/manager')
      const { createModelGateway } = await import('../agent/mastra/modelGateway')
      const { mastraMemoryFor } = await import('../agent/mastra/memory')
      const { createLlmExpertRunner } = await import('./orchestrator')
      const ws = tmpWs()
      const credentials = new InMemoryCredentialStore()
      await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
      const manager = new ChatModelManager({ credentials, config: {} })
      const gateway = createModelGateway({ registrations: () => manager.registrations() })
      const service = new SuperAgentService(ws)
      // 验收器现在要 stat 到真实产物（C1）：先把文件与真实尺寸准备好，
      // 专家只需如实回执。这样这条 E2E 验证的是「验收链路」，而不是「专家会不会撒谎」。
      putArtifact(ws, 'scenes/s3/shot1.png', pngBuffer(1920, 1080))

      const result = await runTask({
        service,
        intent: {
          taskId: 'e2e-task-1',
          scope: 'scenes/s3',
          prompt:
            '你只需产出一条回执（不要真的生成图片，产物已存在）。回执必须包含一行 JSON：' +
            '{"artifactId":"art-e2e-1","assetId":"asset-e2e-1","version":"staging-1","kind":"image",' +
            '"width":1920,"height":1080,"path":"scenes/s3/shot1.png","format":"png"}，' +
            '除这行 JSON 外只回一句"完成"。',
          accept: ['16:9'],
        },
        expert: createLlmExpertRunner({
          gateway,
          modelRef: { providerId: 'deepseek', modelId: 'deepseek-flash' },
          memory: await mastraMemoryFor(ws),
        }),
      })

      expect(result.status).toBe('done')
      expect(result.activated).toBe(true)
      expect(result.artifact).toMatchObject({ artifactId: 'art-e2e-1', width: 1920 })
      const active = await service.activeVersion('asset-e2e-1')
      expect(active?.version).toBe('staging-1')
      expect(active?.accept?.contextHash).toBeTruthy()
    },
    240_000
  )

  it(
    'shadow 模式真模型：journal 有 artifact.ready 但无 version.activated',
    async () => {
      const { InMemoryCredentialStore } = await import('../agent/contracts')
      const { ChatModelManager } = await import('../models/manager')
      const { createModelGateway } = await import('../agent/mastra/modelGateway')
      const { mastraMemoryFor } = await import('../agent/mastra/memory')
      const { createLlmExpertRunner } = await import('./orchestrator')
      const ws = tmpWs()
      const credentials = new InMemoryCredentialStore()
      await credentials.modify('deepseek', async () => ({ type: 'api_key' as const, key: DEEPSEEK_KEY! }))
      const manager = new ChatModelManager({ credentials, config: {} })
      const gateway = createModelGateway({ registrations: () => manager.registrations() })
      const service = new SuperAgentService(ws)

      const result = await runTask({
        service,
        intent: {
          taskId: 'e2e-task-shadow',
          scope: 'scenes/s4',
          prompt:
            '只产出回执（不要真的生成图片）：一行 JSON ' +
            '{"artifactId":"art-shadow","assetId":"asset-shadow","version":"staging-s","kind":"image",' +
            '"width":1280,"height":720,"path":"scenes/s4/a.png","format":"png","bytes":1024}',
          accept: ['16:9'],
        },
        expert: createLlmExpertRunner({
          gateway,
          modelRef: { providerId: 'deepseek', modelId: 'deepseek-flash' },
          memory: await mastraMemoryFor(ws),
        }),
        options: { shadow: true },
      })

      expect(result.status).toBe('done')
      expect(result.activated).toBe(false)
      expect(await service.activeVersion('asset-shadow')).toBeUndefined()
      const types = (await service.events()).map((e) => e.type)
      expect(types).toContain('artifact.ready')
      expect(types).not.toContain('version.activated')
    },
    240_000
  )
})
