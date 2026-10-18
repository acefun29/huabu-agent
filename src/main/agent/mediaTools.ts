import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_MEDIA_DURATION_S,
  DEFAULT_MEDIA_RATIO,
  MEDIA_RATIOS,
  REF_ROLE_LABEL,
  checkMediaRefs,
  mediaKindOfPath,
  nearestMediaRatio,
  normalizeMediaCaps,
  type MediaAccessMode,
  type MediaJobStatus,
  type MediaKind,
  type MediaRatio,
  type MediaRefInput,
  type MediaRefRole,
  type ModelCapabilities
} from '../../shared/media'
import { MEDIA_SRC_MARKER } from './contextEviction'

/** 宿主持有的工具定义（pi 的 ToolDefinition，类型擦除后无运行时依赖） */
export type ToolDefinitionLike = ToolDefinition

/**
 * Agent 媒体生成工具桥（M13，同步等待版）。
 *
 * 通过 createAgentSession 的 customTools 注入 generate_image / generate_video / generate_audio。
 * 三条硬约束：
 *
 * 1. **同步等待终态**：execute 内提交任务并 await 到 succeeded/failed/cancelled 才返回 ——
 *    Pi 的工具执行没有超时（abort signal 只在工具之间检查），阻塞期间经 onUpdate 推
 *    tool_execution_update 进度，用户在工具卡片上能看到排队/生成中/完成。
 *    成功结果（含实际参数与产物路径）直接进 Agent 上下文；多模态对话模型还能拿到产物图片。
 * 2. **视频确认闸门**（workspace.json media.confirmVideo，默认 true）：视频成本高，
 *    未带 confirmed=true 调用时返回「需用户确认」的指令文本，由 Agent 在对话中向用户求证，
 *    用户答复确认后 Agent 再带 confirmed=true 重调 —— 以对话作为确认 UI，防止误烧配额。
 * 3. **provider/model 由配置解析**（数据驱动）：工具只描述意图（kind+参数），
 *    具体用哪个 provider/模型由宿主按 workspace.json 解析，本文件不出现模型名；
 *    参数 schema 是静态全集，当前模型能力的校验在 execute 内现读（改默认模型即时生效）。
 *
 * 失败信息契约：submit/轮询的每一步失败都必须原样进入工具结果文本（含可操作指引），
 * 让 Agent 能向用户解释原因并引导配置 —— 绝不允许把失败吞成"已提交"。
 */

export interface MediaToolSubmitInput {
  kind: MediaKind
  prompt: string
  ratio?: MediaRatio
  durationSeconds?: number
  /** 音色 id（音频通道；由当前模型的 voices 清单校验） */
  voice?: string
  /** 带角色的参考素材（工作区相对路径），角色由工具参数名给定、编排层按模型能力判定 */
  refs?: MediaRefInput[]
  confirmed?: boolean
  /** 产物文件主名（不含扩展名）：Agent 给素材命名的口子，宿主净化 + 重名自动加序号 */
  name?: string
}

/** 工具卡片实时进度（经 pi onUpdate → tool_execution_update 推给渲染端） */
export interface MediaToolProgress {
  state: MediaJobStatus['state']
  progress: number
  message?: string
}

/** 确认卡上展示的生成要素（变更前确认模式；provider/model 提交前解析，失败时不带） */
export interface MediaApprovalInfo {
  prompt: string
  provider?: string
  model?: string
  ratio?: MediaRatio
  durationSeconds?: number
  /** 参考素材摘要（"首帧 1 · 参考视频 2"）；空串 = 没有参考素材 */
  refSummary: string
}

export interface MediaToolContext {
  /**
   * 提交任务并等待终态（宿主实现：解析 provider/model → 编排层 submit → waitForCompletion）。
   * 抛错 = 提交阶段失败（无工作区/无可用模型/凭据缺失/参数非法），工具会把错误转成指引文本。
   */
  submit: (
    input: MediaToolSubmitInput,
    signal: AbortSignal | undefined,
    onProgress?: (progress: MediaToolProgress) => void
  ) => Promise<MediaJobStatus>
  /** 视频确认闸门开关（读 workspace.json，允许运行中修改）；变更前确认模式下被确认卡取代 */
  confirmVideo: () => boolean
  /**
   * 访问模式（读 workspace.json media.accessMode，现读）：'confirm' = 变更前确认 ——
   * 所有 generate_* 在提交前先经 requestApproval 征得用户同意，拒绝即不提交。
   */
  accessMode?: () => MediaAccessMode
  /**
   * 变更前确认的宿主实现：向渲染端发确认卡并等待回执（接受 = true）。
   * signal 中止时宿主应立即返回 false；缺省实现视为无条件接受（不拦截）。
   */
  requestApproval?: (
    kind: MediaKind,
    info: MediaApprovalInfo,
    signal: AbortSignal | undefined
  ) => Promise<boolean>
  /** execute 内每次现读的当前模型能力（比例/时长合法性校验）；解不出返回 undefined */
  capabilities?: (kind: MediaKind) => ModelCapabilities | undefined
  /** 当前会话的对话模型是否支持图片输入（决定成功结果是否携带产物图片） */
  supportsImageInput?: () => boolean
  /** 读取媒体产物为缩放后的 base64（主进程内完成，路径越界返回 undefined） */
  readArtifactAsBase64?: (relPath: string, maxEdge?: number) => { data: string; mimeType: string } | undefined
  /** 读取视频产物首帧关键帧为 base64（宿主在主进程抽帧；失败/不支持返回 undefined，绝不影响生成成功结果） */
  readVideoPosterAsBase64?: (artifact: {
    relPath: string
    artifactDirRel?: string
  }) => Promise<{ data: string; mimeType: string } | undefined>
}

const KIND_LABEL: Record<MediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频'
}

/**
 * 参考素材参数：按角色分槽的扁平顶层参数 —— 角色写在参数名里，模型不必猜
 * "这张图当首帧还是参考图"。描述里的上限是静态说法，真实上限与角色支持由 execute
 * 现读模型能力判定（超限截断留痕、角色不被支持则报错，绝不静默丢素材）。
 */
function refSlotParam(role: MediaRefRole, opts?: { single?: boolean }) {
  const label = REF_ROLE_LABEL[role]
  const what = opts?.single ? '工作区内单个文件的相对路径' : '工作区内文件相对路径的数组'
  return Type.Optional(
    Type.String({
      description: `${label}参考：${what}。${REF_SLOT_HINT[role]}上限由当前模型决定，超出部分不进请求并在结果里逐条说明；不需要时省略`
    })
  )
}

/** 每个角色的官方语义一句话（模型据此决定挂哪条素材，不靠猜） */
const REF_SLOT_HINT: Record<MediaRefRole, string> = {
  first_frame: '视频从这张图开始生成（首帧图生视频）；',
  last_frame: '视频在这张图结束，必须与 first_frame 同时给；',
  reference_image: '以参考图为素材生成，不决定构图边界；',
  reference_video: '参考视频（画面风格/运镜的参照）；',
  reference_audio: '参考音频（音色/节奏的参照）；'
}

/** 同类槽位 = 路径数组的参数（typebox 的 array<string>，与单值槽位区分开） */
function refListParam(role: MediaRefRole) {
  const label = REF_ROLE_LABEL[role]
  return Type.Optional(
    Type.Array(Type.String(), {
      description:
        `${label}参考：工作区内文件相对路径的数组。${REF_SLOT_HINT[role]}` +
        `上限由当前模型决定，超出部分不进请求并在结果里逐条说明；不需要时省略`
    })
  )
}

/** 工具参数（按角色分槽）→ 跨 IPC 的 MediaRefInput[] */
function collectToolRefs(input: ToolParams, kind: MediaKind): MediaRefInput[] {
  const slots: [MediaRefRole, string | string[] | undefined][] = [
    ['first_frame', input.first_frame],
    ['last_frame', input.last_frame],
    ['reference_image', input.reference_images],
    ['reference_video', input.reference_videos],
    ['reference_audio', input.reference_audios]
  ]
  const refs: MediaRefInput[] = []
  for (const [role, value] of slots) {
    if (typeof value === 'string') refs.push({ role, path: value })
    else if (Array.isArray(value)) refs.push(...value.map((path) => ({ role, path })))
  }
  // 音频通道今天没有任何参考素材形态（各家 TTS 只吃文稿），给了也不如立刻说清
  if (kind === 'audio') return []
  return refs
}

/** 确认卡摘要：把角色数出来（"首帧 1 · 参考视频 2"），空组合 = 空串 */
function refSummaryOf(refs: readonly MediaRefInput[]): string {
  const counts = new Map<MediaRefRole, number>()
  for (const ref of refs) counts.set(ref.role, (counts.get(ref.role) ?? 0) + 1)
  return [...counts].map(([role, n]) => `${REF_ROLE_LABEL[role]} ${n}`).join(' · ')
}

/** 画面比例：静态全集枚举；当前模型不支持时 execute 报错会给出该模型的支持清单 */
function ratioParam() {
  return Type.Optional(
    Type.Unsafe<MediaRatio>({
      type: 'string',
      enum: [...MEDIA_RATIOS],
      description: `画面比例，可选 ${MEDIA_RATIOS.join(' / ')}；缺省 ${DEFAULT_MEDIA_RATIO}。若当前模型只支持其中部分取值，报错信息会列出支持项`
    })
  )
}

/** 时长：静态通用文案；模型只收档位时同理，非法值由 execute 报错给出档位 */
function durationParam() {
  return Type.Optional(
    Type.Number({
      description: `时长（秒），默认 ${DEFAULT_MEDIA_DURATION_S}。若当前模型只支持固定档位，报错信息会列出档位，按档位重发`
    })
  )
}

/**
 * 产物命名：Agent 给生成素材取名的口子。描述里写明参考图场景的前缀约定——
 * 用户说「和原图前缀一致」时，模型从 reference_images 的文件名取主干照做。
 */
function nameParam() {
  return Type.Optional(
    Type.String({
      description:
        '产物文件名（不含扩展名，扩展名按实际格式自动定；重名时宿主会自动加序号，不会覆盖已有文件）。' +
        '用户对产物命名有要求时按用户的说法填；基于参考图创作且用户未另行指定时，' +
        '取第一张参考图文件名的主干作前缀（如参考图 海报-v1.png → 海报-v1-重绘）；省略则用随机 id 命名'
    })
  )
}

/** 音频音色：静态文案（可用音色是模型声明，execute 现读校验后报错列出支持清单） */
function voiceParam() {
  return Type.Optional(
    Type.String({
      description: '音色 id（TTS）。当前模型可用音色见「设置 → 媒体生成」该模型的能力声明；不在清单内时错误信息会列出支持项。缺省用模型默认音色'
    })
  )
}

/** 工具参数（三条 generate_* 的并集，按 kind 各取所需） */
interface ToolParams {
  prompt: string
  name?: string
  ratio?: MediaRatio
  duration_seconds?: number
  voice?: string
  first_frame?: string
  last_frame?: string
  reference_images?: string[]
  reference_videos?: string[]
  reference_audios?: string[]
  confirmed?: boolean
}

/**
 * 失败分类 → 可操作文案。错误串来自编排层（manager/resolveAgentMedia），按稳定短语匹配；
 * 兜底原样透出。所有文案都要求 Agent 转告用户并给出下一步。
 */
function failureGuidance(kind: MediaKind, error: string | undefined, provider?: string, model?: string): string {
  const label = KIND_LABEL[kind]
  const where = provider ? `（provider=${provider}${model ? ` · model=${model}` : ''}）` : ''
  const text = error ?? '未知错误'
  if (text.includes('没有可用的') || text.includes('未配置凭据')) {
    return (
      `${label}生成不可用：${text}${where}。` +
      `请告诉用户：需要打开「设置 → 媒体生成」，选择一个媒体供应商并在那里录入 API Key（对话供应商的 Key 与媒体生成是两套独立配置），` +
      `或把默认生成模型切换到已配置凭据的供应商。在用户配置好之前不要再次尝试生成。`
    )
  }
  if (text.includes('不支持比例') || text.includes('不支持时长') || text.includes('没有模型') || text.includes('没有音色')) {
    return (
      `生成参数不被当前模型接受：${text}${where}。` +
      `请按错误信息里的支持列表调整参数后重试，或改用其他模型，并向用户说明原因。`
    )
  }
  if (text.includes('参考素材') || text.includes('参考（') || text.includes('只接受公网') || text.includes('上传通道')) {
    return (
      `参考素材不被当前模型接受：${text}${where}。` +
      `请按错误信息里的支持范围调整：换用声明了这种参考的模型、减少素材条数、或把素材换成更小/更少的图片。` +
      `提示「只接受公网 URL」时，可以让用户提供公网可访问的地址（放进对应槽位的 URL），不要反复用同一组素材重试。`
    )
  }
  if (text.includes('超时')) {
    return (
      `生成任务超时：${text}${where}。` +
      `请告诉用户任务已停止，可以重试一次或更换模型；若多次超时建议检查网络或供应商服务状态。`
    )
  }
  if (/401|403|invalid.{0,8}key|unauthorized|鉴权|认证/i.test(text)) {
    return (
      `生成凭据被拒绝：${text}${where}。` +
      `请告诉用户「设置 → 媒体生成」里该供应商的 API Key 可能无效或已过期，请检查后重新录入；配置好之前不要再尝试生成。`
    )
  }
  return (
    `${label}生成失败：${text}${where}。请把失败原因转告用户；如果是临时性错误可以重试一次，` +
    `若仍失败建议检查「设置 → 媒体生成」的供应商配置。`
  )
}

function paramsSummary(final: MediaJobStatus): string {
  const parts: string[] = []
  // 比例与像素以落盘产物为准（图生图等场景可能不按请求比例出图），请求值仅在与实际不一致时并列标注；
  // 产物尺寸缺席（音频/尺寸解析失败）时退回请求参数 —— 那已是没有更准事实源的下策
  const dims =
    final.artifact?.width && final.artifact?.height
      ? { width: final.artifact.width, height: final.artifact.height }
      : undefined
  const actualRatio = dims ? nearestMediaRatio(dims.width, dims.height) : undefined
  if (actualRatio && dims) {
    const requested = final.params?.ratio
    parts.push(requested && requested !== actualRatio ? `比例 ${actualRatio}（请求 ${requested}）` : `比例 ${actualRatio}`)
    parts.push(`实际 ${dims.width}×${dims.height}px`)
  } else {
    if (final.params?.ratio) parts.push(`比例 ${final.params.ratio}`)
    if (final.params?.width && final.params?.height) parts.push(`${final.params.width}×${final.params.height}px`)
  }
  if (final.params?.durationSeconds) parts.push(`时长 ${final.params.durationSeconds}s`)
  return parts.length ? `，实际参数：${parts.join(' / ')}` : ''
}

function makeTool(kind: MediaKind, ctx: MediaToolContext): ToolDefinition {
  const name = `generate_${kind}`
  const label = `生成${KIND_LABEL[kind]}`
  const parameters =
    kind === 'image'
      ? Type.Object({
          prompt: Type.String({ description: '画面描述（越具体越好：主体、风格、构图、光线）' }),
          name: nameParam(),
          ratio: ratioParam(),
          reference_images: refListParam('reference_image')
        })
      : kind === 'video'
        ? Type.Object({
            prompt: Type.String({ description: '内容描述（主体、动作、镜头运动、氛围）' }),
            name: nameParam(),
            ratio: ratioParam(),
            duration_seconds: durationParam(),
            first_frame: refSlotParam('first_frame', { single: true }),
            last_frame: refSlotParam('last_frame', { single: true }),
            reference_images: refListParam('reference_image'),
            reference_videos: refListParam('reference_video'),
            reference_audios: refListParam('reference_audio'),
            confirmed: Type.Optional(
              Type.Boolean({ description: '视频生成成本高：先向用户确认，用户同意后置 true' })
            )
          })
        : Type.Object({
            prompt: Type.String({ description: '音频内容描述（乐器/风格/情绪/节奏）' }),
            name: nameParam(),
            duration_seconds: durationParam(),
            voice: voiceParam()
          })

  return {
    name,
    label,
    description:
      kind === 'image'
        ? '根据文字描述生成一张图片，可用 reference_images 垫图（以参考图为底生成，条数上限由模型决定）。调用会阻塞到生成完成，结果里包含实际参数与产物路径；产物同时作为媒体节点出现在画布上。'
        : kind === 'video'
          ? '根据文字描述生成一段短视频。参考素材按角色分槽：first_frame/last_frame 是首帧/首尾帧图生视频，reference_images/reference_videos/reference_audios 是全模态参考（哪种角色可用由当前模型决定，混用首帧与 reference_* 会报错）。成本较高：调用前需先向用户确认，得到同意后传 confirmed=true。调用会阻塞到生成完成（可能数分钟），结果里包含实际参数与产物路径。'
          : '根据文字描述生成一段音频（音效/配乐），可选 voice 指定音色。调用会阻塞到生成完成，结果里包含实际参数与产物路径。',
    parameters,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const input = params as ToolParams
      const refs = collectToolRefs(input, kind)
      // 变更前确认模式：所有生成提交前先弹确认卡（取代视频对话闸门 —— 反正都要用户点头）。
      // 拒绝走「返回文本」而非抛错：这是用户的决定不是故障，Agent 应转告并等待新指示。
      if ((ctx.accessMode?.() ?? 'full') === 'confirm') {
        onUpdate?.({
          content: [{ type: 'text', text: `等待用户确认（${KIND_LABEL[kind]}生成）…` }],
          details: { submitted: false, state: 'awaiting-approval' }
        })
        const approved = await ctx.requestApproval?.(
          kind,
          {
            prompt: input.prompt,
            ...(input.ratio ? { ratio: input.ratio } : {}),
            ...(input.duration_seconds ? { durationSeconds: input.duration_seconds } : {}),
            refSummary: refSummaryOf(refs)
          },
          signal
        )
        if (approved !== true) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `用户拒绝了本次${KIND_LABEL[kind]}生成（变更前确认模式），任务未提交。` +
                  `请转告用户已按要求取消；如需继续，等用户明确提出后再重新生成，不要未经确认直接重试。`
              }
            ],
            details: { submitted: false, reason: 'declined' }
          }
        }
      } else if (kind === 'video' && ctx.confirmVideo() && input.confirmed !== true) {
        return {
          content: [
            {
              type: 'text',
              text:
                '视频生成需要用户确认（防误烧配额）。请向用户说明将要生成的视频内容并询问是否继续；' +
                '用户同意后，用相同参数再次调用 generate_video 并传入 confirmed=true。本次调用未提交任何任务。'
            }
          ],
          details: { submitted: false, reason: 'confirm-required' }
        }
      }

      // 能力现读校验：schema 是静态全集，合法性按本次解析到的模型判——同会话改默认模型即时生效
      const caps = ctx.capabilities?.(kind)
      if (caps?.ratios?.length && input.ratio && !caps.ratios.includes(input.ratio)) {
        throw new Error(failureGuidance(kind, `不支持比例 ${input.ratio}（当前模型支持：${caps.ratios.join(' / ')}）`))
      }
      if (caps?.durations?.length && input.duration_seconds && !caps.durations.includes(input.duration_seconds)) {
        throw new Error(
          failureGuidance(
            kind,
            `不支持时长 ${input.duration_seconds}s（当前模型支持档位：${caps.durations.join(' / ')}）`
          )
        )
      }
      if (caps?.voices?.length && input.voice && !caps.voices.some((v) => v.id === input.voice)) {
        throw new Error(
          failureGuidance(kind, `没有音色 ${input.voice}（当前模型支持：${caps.voices.map((v) => v.id).join(' / ')}）`)
        )
      }
      // 参考素材前置检查用编排层同一份纯函数（角色、类型、模式互斥）：这里拦下省一次任务记录，
      // 且工具文本能直接给模型可操作的指引；配额截断与投递形态仍在闸门里做
      if (refs.length > 0 && caps) {
        const checked = checkMediaRefs(
          refs.map((ref) => ({ ...ref, mediaType: mediaKindOfPath(ref.path ?? ref.url ?? '')?.kind })),
          normalizeMediaCaps(caps, kind),
          KIND_LABEL[kind]
        )
        if (checked.issues.length > 0) {
          throw new Error(
            failureGuidance(kind, `参考素材不被当前模型接受：${checked.issues.map((i) => i.message).join('；')}`)
          )
        }
      }

      /** 进度透传：编排层的 patch 事件 → pi 的 tool_execution_update */
      const onProgress = (progress: MediaToolProgress) => {
        const percent = Math.round(progress.progress * 100)
        onUpdate?.({
          content: [
            { type: 'text', text: `${KIND_LABEL[kind]}生成${progress.message ?? progress.state}（${percent}%）` }
          ],
          details: { submitted: true, state: progress.state, progress: progress.progress, message: progress.message }
        })
      }

      let final: MediaJobStatus
      try {
        final = await ctx.submit(
          {
            kind,
            prompt: input.prompt,
            ...(input.name && input.name.trim() ? { name: input.name } : {}),
            ...(input.ratio ? { ratio: input.ratio } : {}),
            ...(input.duration_seconds ? { durationSeconds: input.duration_seconds } : {}),
            ...(input.voice ? { voice: input.voice } : {}),
            ...(refs.length > 0 ? { refs } : {}),
            confirmed: input.confirmed
          },
          signal,
          onProgress
        )
      } catch (error) {
        // 提交阶段失败（无工作区/无可用模型/凭据缺失/参数非法）——抛错让卡片落失败态，错误必须可操作
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(failureGuidance(kind, message))
      }

      if (final.state === 'cancelled') {
        return {
          content: [{ type: 'text', text: '生成已取消（用户中断）。请告知用户任务已停止，如需继续可重新发起。' }],
          details: { submitted: true, jobId: final.jobId, state: final.state }
        }
      }
      if (final.state !== 'succeeded' || !final.artifact) {
        // 抛错而非返回：pi 会把工具结果标为 error（卡片红色失败态），错误文本照样进模型上下文
        throw new Error(failureGuidance(kind, final.error ?? final.message, final.provider, final.model))
      }

      // 成功：文本摘要必回；产物画面且对话模型支持视觉时随结果附上（多模态感知）。
      // images 为空 = 纯文本成功结果；附了画面就必须在文本里如实说明（文本基于真实结果）。
      let text =
        `${KIND_LABEL[kind]}已生成成功（jobId=${final.jobId}，${final.provider}/${final.model}${paramsSummary(final)}）。` +
        `产物：${final.artifact.relPath}（${final.artifact.mime}` +
        `${final.artifact.width ? `，${final.artifact.width}×${final.artifact.height}px` : ''}` +
        `${final.artifact.durationSeconds ? `，${final.artifact.durationSeconds}s` : ''}），` +
        `已作为媒体节点出现在画布上（来源标记为当前会话）。`
      // 参考素材的处置留痕必须转告：用户挂了 5 张而模型只吃 1 张时，"生成成功"不等于
      // "按全部参考生成"——不说清就是Agent 在替网关撒谎
      if (final.notes?.length) {
        text += `注意：${final.notes.join('；')}。请把这条说明如实转告用户。`
      }
      const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
      if (
        kind === 'image' &&
        ctx.supportsImageInput?.() &&
        ctx.readArtifactAsBase64 &&
        final.artifact.mime.startsWith('image/')
      ) {
        const image = ctx.readArtifactAsBase64(final.artifact.relPath)
        if (image) images.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      }
      // 视频生成成本最高、动辄数分钟，成功后 Agent"看不到"产物就得再手动调 read_media：
      // 抽 1 帧首帧随结果回传自检（P2）。抽帧挂在成功路径上，失败绝不能连累生成结果 ——
      // 整段 try/catch，宿主实现抛错一律按"没有首帧"处理，文本原样（降级纯文本）。
      if (kind === 'video' && ctx.supportsImageInput?.() && ctx.readVideoPosterAsBase64 && final.artifact) {
        try {
          const poster = await ctx.readVideoPosterAsBase64({
            relPath: final.artifact.relPath,
            ...(final.artifactDirRel ? { artifactDirRel: final.artifactDirRel } : {})
          })
          if (poster) {
            images.push({ type: 'image', data: poster.data, mimeType: poster.mimeType })
            text += '已随本条结果附上产物首帧关键帧，可据此确认画面；需要查看更多画面可用 read_media。'
          }
        } catch {
          // 首帧是增强项：宿主抽帧抛错 → 降级为纯文本成功结果，不抛、不改文案
        }
      }
      // 附了图的结果带路径标记行：历史淘汰层按它提取锚点路径（contextEviction）。
      // 图片产物与视频首帧同源（都是 final.artifact），一条标记即可覆盖整组图块
      if (images.length > 0) text += `\n${MEDIA_SRC_MARKER}${final.artifact.relPath}]`
      text += '请基于以上真实结果回答用户。'
      return {
        content: [{ type: 'text', text }, ...images],
        details: {
          submitted: true,
          jobId: final.jobId,
          state: final.state,
          artifact: final.artifact,
          ...(final.params ? { params: final.params } : {})
        }
      }
    }
  }
}

export function createMediaTools(ctx: MediaToolContext): ToolDefinition[] {
  return [makeTool('image', ctx), makeTool('video', ctx), makeTool('audio', ctx)]
}
