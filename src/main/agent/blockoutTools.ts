import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { unlink } from 'fs/promises'
import { basename, isAbsolute, join, relative, resolve as resolvePath } from 'path'
import { app } from 'electron'
import { Type } from 'typebox'
import { importToWorkspace } from '../assets/manager'
import { broadcastAssetChanged } from '../ipc/shared'
import { resolveFfmpegBinary } from '../media/videoFrames'
import type { ToolDefinitionLike } from './mediaTools'

/**
 * blockout 粗模/运镜引擎工具（引擎源码在 src/main/blockout/*.mjs，零依赖、随包分发）。
 *
 * 形态与媒体工具一致：customTools 注入、execute 阻塞到子进程退出、进度经 onUpdate →
 * tool_update。三条契约：
 *
 * 1. **子进程隔离**：像素动作（sheet/video）4~12s，绝不能在主进程内 import 引擎跑；
 *    引擎以 ELECTRON_RUN_AS_NODE 方式被 process.execPath 执行（打包态无独立 node）。
 * 2. **退出码语义透传**：0 正常；1 用法/IO（isError，Agent 需换姿势）；2 解算 error /
 *    3 约束违规（引擎判定的数据问题，结果照常返回让 Agent 读 errors 改 author 文件，
 *    不标 isError——这是引擎在履职，不是调用失败）。
 * 3. **产物分两类**：工作产物（author/逐帧表/拼版 PNG）落 `.huabu/blockout/<场景>/`
 *    （不被素材库扫描）；只有 video 成片经 importToWorkspace 发布到 assets/video/
 *    （同镜头覆盖：重渲染先删旧同名，素材库每镜头唯一成片）。
 *
 * 惰性激活（P2）：本工具不设 promptSnippet/promptGuidelines（激活不重建 system prompt
 * 文本），创建会话后由 host.ts 摘除、Agent 读 blockout-shot 技能时再纯增量激活。
 */

/** 工具层维护的引擎版本（引擎 CLI 无 capabilities 自曝；SKILL.md 写明兼容版本） */
export const BLOCKOUT_ENGINE_VERSION = '0.2.0-mvp'

/** 工具名（host.ts 的惰性激活钩子按它摘除/激活） */
export const BLOCKOUT_TOOL_NAME = 'blockout'

/** 对应的技能目录名（随包分发于 resources/skills/，工作区 .huabu/skills/ 同名可覆盖） */
export const BLOCKOUT_SKILL_NAME = 'blockout-shot'
/** 引擎文件名固定，目录由 resolveBlockoutEngineDir 解析 */
const ENGINE_FILES = { cli: 'cli.mjs' } as const

/** 数值动作给 60s（实测 <1s，留足大场景余量）；video 按帧渲染 + 编码给 5 分钟 */
const TIMEOUT_MS = { numeric: 60_000, video: 300_000 }

type BlockoutAction = 'check' | 'describe' | 'sheet' | 'view' | 'shot' | 'shots' | 'video'

const ACTIONS: BlockoutAction[] = ['check', 'describe', 'sheet', 'view', 'shot', 'shots', 'video']

interface BlockoutToolParams {
  action: BlockoutAction
  scene: string
  shot?: string
  view?: string
  keyframes?: boolean
  width?: number
  height?: number
  size?: number
  out?: string
  publish?: boolean
}

export interface BlockoutToolDeps {
  /** 当前工作区根目录（无工作区时工具返回指引文本而不是抛错） */
  currentDir: () => string | null
}

/**
 * 内置技能根目录候选（extraResources 落点 resources/skills；开发态工程 resources/skills）。
 * 两个消费方：host.ts 的技能注入（追加在 extraSkillPaths 末尾 → 工作区同名技能先加载者胜，
 * 即工作区覆盖内置）与惰性激活钩子的 read 路径判定。只返回真实存在的目录。
 */
export function resolveBuiltinSkillsRoots(): string[] {
  const roots = app.isPackaged
    ? [join(process.resourcesPath, 'skills')]
    : [join(app.getAppPath(), 'resources', 'skills'), join(process.cwd(), 'resources', 'skills')]
  return roots.filter((root) => existsSync(root))
}

/**
 * read 工具的路径是否命中 blockout-shot 技能目录（工作区 .huabu/skills/ 覆盖层或
 * 内置 resources/skills/ 层）——host.ts 惰性激活钩子的判定核心。接受绝对/工作区相对
 * 路径；比较统一正斜杠，win32 大小写不敏感。纯函数，探针可直测。
 */
export function isBlockoutSkillReadPath(cwd: string, readPath: string): boolean {
  const norm = (p: string): string => {
    const slashed = p.replace(/\\/g, '/')
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed
  }
  const abs = norm(resolvePath(cwd, readPath))
  const skillDirs = [
    join(cwd, '.huabu', 'skills', BLOCKOUT_SKILL_NAME),
    ...resolveBuiltinSkillsRoots().map((root) => join(root, BLOCKOUT_SKILL_NAME))
  ]
  return skillDirs.some((dir) => abs.startsWith(`${norm(dir)}/`))
}

/**
 * 引擎目录解析：打包态在 extraResources 落点（resources/blockout，asar 外可被
 * 子进程执行）；开发态回退工程源目录。找不到返回 null（工具返回可操作错误）。
 */
export function resolveBlockoutEngineDir(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'blockout')]
    : [
        join(app.getAppPath(), 'src', 'main', 'blockout'), // electron-vite dev：getAppPath 即工程根
        join(process.cwd(), 'src', 'main', 'blockout'), // 探针语境（electron scripts/x.cjs）：getAppPath 指向脚本目录，cwd 才是工程根
        join(process.resourcesPath, 'blockout')
      ]
  for (const dir of candidates) {
    if (existsSync(join(dir, ENGINE_FILES.cli))) return dir
  }
  return null
}

interface EngineRun {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  spawnError: string | null
}

/** 杀整棵子进程树：video 里 ffmpeg 是引擎 spawnSync 的孙进程，只 kill 父进程杀不干净（win32 主战场） */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

function runEngine(
  engineDir: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void; timeoutMs: number }
): Promise<EngineRun> {
  return new Promise((settle) => {
    // ffmpeg 必须显式传：引擎"向上找 node_modules"的逻辑在打包态必失败
    //（extraResources 目录向上没有依赖树）；解析复用视频抽帧的 asar.unpacked 映射
    const ffmpeg = resolveFfmpegBinary()
    const child = spawn(process.execPath, [join(engineDir, ENGINE_FILES.cli), ...args], {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(ffmpeg ? { BLOCKOUT_FFMPEG: ffmpeg } : {}) }
    })

    const run: EngineRun = { code: -1, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: null }
    let settled = false
    const finish = (patch: Partial<EngineRun>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      settle({ ...run, ...patch })
    }

    const timer = setTimeout(() => {
      run.timedOut = true
      killProcessTree(child.pid ?? -1)
      // kill 后 exit 事件会来；超时/中断兜底 2s 强制结算，防止僵死进程挂住工具
      setTimeout(() => finish({}), 2_000)
    }, opts.timeoutMs)

    const onAbort = () => {
      run.aborted = true
      killProcessTree(child.pid ?? -1)
      setTimeout(() => finish({}), 2_000)
    }
    opts.signal?.addEventListener('abort', onAbort)

    // stdout 是引擎的 JSON 结果（可能上百 KB，给 4MB 硬顶防病理性内存增长）
    child.stdout.on('data', (chunk: Buffer) => {
      if (run.stdout.length < 4 * 1024 * 1024) run.stdout += chunk.toString('utf8')
    })
    // stderr：进度行（video --progress，每 20 帧一条 `渲染 i/N`）与人类可读错误
    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (run.stderr.length < 64 * 1024) run.stderr += text
      stderrTail = (stderrTail + text).slice(-2048)
      const match = /渲染\s*(\d+)\s*\/\s*(\d+)/.exec(stderrTail)
      if (match && opts.onProgress) {
        const done = Number(match[1])
        const total = Number(match[2])
        if (Number.isFinite(done) && Number.isFinite(total) && total > 0) opts.onProgress(done, total)
      }
    })
    child.on('error', (error) => finish({ spawnError: String(error) }))
    child.on('exit', (code) => finish({ code: code ?? -1 }))
  })
}

/** author 文件名 → 场景短名：去 .author.json/.json 后缀（产物目录与成片命名用） */
function sceneStem(sceneRel: string): string {
  return basename(sceneRel).replace(/(\.author)?\.json$/, '') || 'scene'
}

/** 成片资产名净化：只留安全文件名字符，超长截断（防 Agent 起怪名污染素材库） */
function assetNameOf(stem: string, shot: string): string {
  const raw = `${stem}-${shot}`.replace(/[\\/:*?"<>|\s]+/g, '-')
  return raw.length > 80 ? raw.slice(0, 80) : raw
}

/** 工作区相对路径安全带：解析后必须落在工作区内（拒绝 .. / 绝对路径逃逸） */
function insideWorkspace(workspaceDir: string, p: string): boolean {
  const rel = relative(workspaceDir, p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function assembleBlockoutTool(deps: BlockoutToolDeps): ToolDefinitionLike {
  const parameters = Type.Object({
    action: Type.Union(
      ACTIONS.map((a) => Type.Literal(a)),
      { description: 'check=数值自检(describe+碰撞) / describe=解算数字表 / sheet=四视图拼版 / view=单视图 / shot=运镜解算 / shots=全部镜头+连续性 / video=渲染成片mp4' }
    ),
    scene: Type.String({ description: 'author 场景文件的工作区相对路径（数据格式见 blockout-shot 技能）' }),
    shot: Type.Optional(Type.String({ description: '镜头 id（shot/video 用；缺省取场景第一个镜头）' })),
    view: Type.Optional(Type.String({ description: '视图名（view 动作用）：front / right / top / threequarter' })),
    keyframes: Type.Optional(Type.Boolean({ description: 'shot 动作附带关键帧拼版 PNG（视觉自检构图节奏）' })),
    width: Type.Optional(Type.Number({ description: '画幅宽（view/video，默认 view 800 / video 640）' })),
    height: Type.Optional(Type.Number({ description: '画幅高（view/video，默认 view 600 / video 360）' })),
    size: Type.Optional(Type.Number({ description: '拼版边长像素（sheet / keyframes，默认 1024；须 ≥1024 保证每格可读）' })),
    out: Type.Optional(Type.String({ description: '输出文件的工作区相对路径（缺省落 .huabu/blockout/<场景>/）' })),
    publish: Type.Optional(Type.Boolean({ description: 'video 成片是否发布到素材库（默认 true；同镜头重渲染覆盖旧成片）' }))
  })

  return {
    name: BLOCKOUT_TOOL_NAME,
    label: 'blockout 粗模/运镜引擎',
    description:
      '运行 blockout 粗模/运镜引擎：数据化白模的数值自检、四视图拼版、运镜解算与预览成片（本地零成本）。完整数据格式、参数与工作纪律见 blockout-shot 技能。',
    parameters,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const input = params as BlockoutToolParams
      const fail = (message: string): { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> } => ({
        content: [{ type: 'text', text: `[blockout engine v${BLOCKOUT_ENGINE_VERSION}] ${message}` }],
        details: { engine: BLOCKOUT_ENGINE_VERSION, action: input.action }
      })

      const workspaceDir = deps.currentDir()
      if (!workspaceDir) return fail('尚未打开工作区：blockout 引擎的工作产物需要落进工作区目录，请先让用户打开/选择一个工作区。')
      const engineDir = resolveBlockoutEngineDir()
      if (!engineDir) return fail('引擎文件缺失（src/main/blockout/cli.mjs 或打包资源 resources/blockout 不存在），无法执行。')

      // scene 是必填的相对路径；out 可选。两者都必须落进工作区
      if (typeof input.scene !== 'string' || !input.scene.trim()) return fail('缺少 scene 参数（author 场景文件的工作区相对路径）。')
      const sceneAbs = resolvePath(workspaceDir, input.scene)
      if (!insideWorkspace(workspaceDir, sceneAbs)) return fail(`scene 路径越出工作区：${input.scene}`)
      if (!existsSync(sceneAbs)) return fail(`场景文件不存在：${input.scene}（先用 write 写 author JSON，数据格式见 blockout-shot 技能）。`)

      let outAbs: string | undefined
      if (typeof input.out === 'string' && input.out.trim()) {
        outAbs = resolvePath(workspaceDir, input.out)
        if (!insideWorkspace(workspaceDir, outAbs)) return fail(`out 路径越出工作区：${input.out}`)
      }

      const stem = sceneStem(input.scene)
      const workDirAbs = join(workspaceDir, '.huabu', 'blockout', stem)
      const action = input.action

      // 组装引擎参数（--out 一律传绝对路径：引擎缺省落 CWD）
      const args: string[] = [action, '--scene', sceneAbs]
      if (action === 'sheet') {
        args.push('--out', outAbs ?? join(workDirAbs, 'sheet.png'))
        if (input.size) args.push('--size', String(Math.round(input.size)))
      } else if (action === 'view') {
        const viewName = input.view ?? 'threequarter'
        args.push('--view', viewName, '--out', outAbs ?? join(workDirAbs, `view-${viewName}.png`))
        if (input.width) args.push('--width', String(Math.round(input.width)))
        if (input.height) args.push('--height', String(Math.round(input.height)))
      } else if (action === 'shot') {
        if (input.shot) args.push('--shot', input.shot)
        if (input.keyframes) {
          // 关键帧模式：--sheet 使引擎走 renderFrameSheet，--out 即 PNG 落点
          args.push('--sheet')
          args.push('--out', outAbs ?? join(workDirAbs, `${input.shot ?? 'shot'}-keys.png`))
          if (input.size) args.push('--size', String(Math.round(input.size)))
        } else {
          // 数值模式：--out 落逐帧表 JSON（SKILL 下游都从这份文件取数）
          args.push('--out', outAbs ?? join(workDirAbs, `${input.shot ?? 'shot'}.frames.json`))
        }
      } else if (action === 'video') {
        if (input.shot) args.push('--shot', input.shot)
        if (input.width) args.push('--width', String(Math.round(input.width)))
        if (input.height) args.push('--height', String(Math.round(input.height)))
        args.push('--out', outAbs ?? join(workDirAbs, `${input.shot ?? 'shot'}.mp4`))
        args.push('--progress')
      }

      const run = await runEngine(engineDir, args, {
        cwd: workspaceDir,
        signal,
        timeoutMs: action === 'video' ? TIMEOUT_MS.video : TIMEOUT_MS.numeric,
        onProgress:
          action === 'video'
            ? (done, total) =>
                onUpdate?.({
                  content: [{ type: 'text', text: `blockout 渲染中 ${done}/${total} 帧（${Math.floor((done / total) * 100)}%）` }],
                  details: { action, progress: done / total }
                })
            : undefined
      })

      if (run.spawnError) return fail(`引擎子进程启动失败：${run.spawnError}`)
      if (run.aborted || signal?.aborted) {
        return {
          content: [{ type: 'text', text: `[blockout engine v${BLOCKOUT_ENGINE_VERSION}] 渲染已取消（用户中断）。请告知用户任务已停止，如需继续可重新发起。` }],
          details: { engine: BLOCKOUT_ENGINE_VERSION, action, cancelled: true }
        }
      }
      if (run.timedOut) {
        throw new Error(`[blockout engine v${BLOCKOUT_ENGINE_VERSION}] ${action} 超时（${TIMEOUT_MS[action === 'video' ? 'video' : 'numeric'] / 1000}s）被中止；可降低分辨率/时长后重试。`)
      }
      if (run.code === 1) {
        // 用法/IO 错误（含 ffmpeg 缺失）：不可恢复的调用失败，抛错标 isError
        throw new Error(
          `[blockout engine v${BLOCKOUT_ENGINE_VERSION}] ${action} 执行失败（用法/IO）：${(run.stderr.trim() || run.stdout.slice(0, 400)).slice(0, 500)}`
        )
      }
      if (run.code !== 0 && run.code !== 2 && run.code !== 3) {
        throw new Error(`[blockout engine v${BLOCKOUT_ENGINE_VERSION}] ${action} 异常退出（code=${run.code}）：${run.stderr.slice(0, 500)}`)
      }

      // stdout 的 JSON 是主结果；解析失败也原样透传（引擎契约保证 stdout 是 JSON）
      let parsed: Record<string, unknown> | null = null
      try {
        parsed = JSON.parse(run.stdout) as Record<string, unknown>
      } catch {
        parsed = null
      }

      const header = `[blockout engine v${BLOCKOUT_ENGINE_VERSION} · ${action}${input.shot ? ` ${input.shot}` : ''}${
        run.code === 2 ? ' · 解算有 error（改 author 数据后重跑）' : run.code === 3 ? ' · 约束违规（按引擎 errors 里的指引进行数据修改）' : ''
      }]`
      let text = `${header}\n${run.stdout.trimEnd()}`

      // 拼版产物随结果附图（与 read_media 同级体验，省一次往返）；附不上不连累结果
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text }
      ]
      const imagePath =
        action === 'sheet' || action === 'view' ? (outAbs ?? null) : action === 'shot' && input.keyframes ? (outAbs ?? null) : null
      const imageTarget = typeof parsed?.image === 'string' ? (parsed.image as string) : imagePath
      if (run.code === 0 && imageTarget && existsSync(imageTarget)) {
        try {
          const png = readFileSync(imageTarget)
          content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
          text += `\n拼版已随本条结果附上（文件：${relative(workspaceDir, imageTarget).replace(/\\/g, '/')}）；数值与图对照着看，不要从像素里量坐标。`
          content[0] = { type: 'text', text }
        } catch {
          /* 读图失败降级纯文本 */
        }
      }

      // video 成片发布（同镜头覆盖：素材库每镜头唯一成片）
      let published: { relPath: string; name: string; kind: string; bytes?: number } | undefined
      if (action === 'video' && parsed?.ok === true && input.publish !== false) {
        const videoPath = typeof parsed.video === 'string' ? (parsed.video as string) : null
        const shotName = typeof parsed.shot === 'string' ? (parsed.shot as string) : (input.shot ?? 'shot')
        if (videoPath && existsSync(videoPath)) {
          const assetName = assetNameOf(stem, shotName)
          const oldAsset = join(workspaceDir, 'assets', 'video', `${assetName}.mp4`)
          if (existsSync(oldAsset)) {
            await unlink(oldAsset).catch(() => {
              /* 删不掉就交给 importToWorkspace 的时间戳去重 */
            })
          }
          const { imported, failed } = await importToWorkspace(workspaceDir, [
            { sourcePath: videoPath, name: assetName, mime: 'video/mp4' }
          ])
          const hit = imported[0]
          if (hit) {
            broadcastAssetChanged()
            const relPath = hit.relPath ?? relative(workspaceDir, hit.absPath).replace(/\\/g, '/')
            published = { relPath, name: hit.name, kind: hit.kind, ...(hit.bytes ? { bytes: hit.bytes } : {}) }
            content[0] = {
              type: 'text',
              text: `${text}\n成片已发布到素材库（画布会出现视频卡片）：${relPath}${hit.bytes ? `（${Math.round(hit.bytes / 1024)}KB）` : ''}`
            }
          } else if (failed.length > 0) {
            content[0] = {
              type: 'text',
              text: `${text}\n（成片发布到素材库失败：${String((failed[0] as { error?: unknown })?.error ?? '未知原因')}；文件仍在 ${relative(workspaceDir, videoPath).replace(/\\/g, '/')}）`
            }
          }
        }
      }

      return {
        content,
        details: {
          engine: BLOCKOUT_ENGINE_VERSION,
          action,
          scene: input.scene,
          ...(published ? { published } : {})
        }
      }
    }
  }
}
