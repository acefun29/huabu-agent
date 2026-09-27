import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { DEFAULT_MEDIA_DURATION_S, DEFAULT_MEDIA_RATIO, MEDIA_RATIOS, type MediaAccessMode, type MediaJobStatus, type MediaKind, type MediaRatio, type ModelCapabilities } from '../../shared/media'

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
  /** 参考图（垫图/首帧）的工作区相对路径（媒体产物目录优先解析） */
  refPaths?: string[]
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
  refCount: number
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
}

const KIND_LABEL: Record<MediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频'
}

/**
 * 参考图参数描述：静态通用上限（真实上限由宿主按模型能力截断）。
 */
function referenceImagesParam(kind: MediaKind) {
  const role = kind === 'video' ? '首帧' : '垫图'
  return Type.Optional(
    Type.Array(Type.String(), {
      description:
        `${role}参考：工作区内图片文件的相对路径数组（媒体产物如 "xxxx.png"，素材库文件如 "assets/xxx.png"），` +
        `最多 4 张；不需要时省略`
    })
  )
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
  if (text.includes('不支持比例') || text.includes('不支持时长') || text.includes('没有模型')) {
    return (
      `生成参数不被当前模型接受：${text}${where}。` +
      `请按错误信息里的支持列表调整参数后重试，或改用其他模型，并向用户说明原因。`
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
  if (final.params?.ratio) parts.push(`比例 ${final.params.ratio}`)
  if (final.params?.width && final.params?.height) parts.push(`${final.params.width}×${final.params.height}px`)
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
          reference_images: referenceImagesParam(kind)
        })
      : kind === 'video'
        ? Type.Object({
            prompt: Type.String({ description: '内容描述（主体、动作、镜头运动、氛围）' }),
            name: nameParam(),
            ratio: ratioParam(),
            duration_seconds: durationParam(),
            reference_images: referenceImagesParam(kind),
            confirmed: Type.Optional(
              Type.Boolean({ description: '视频生成成本高：先向用户确认，用户同意后置 true' })
            )
          })
        : Type.Object({
            prompt: Type.String({ description: '音频内容描述（乐器/风格/情绪/节奏）' }),
            name: nameParam(),
            duration_seconds: durationParam()
          })

  return {
    name,
    label,
    description:
      kind === 'image'
        ? '根据文字描述生成一张图片，可用 reference_images 垫图（以参考图为底生成）。调用会阻塞到生成完成，结果里包含实际参数与产物路径；产物同时作为媒体节点出现在画布上。'
        : kind === 'video'
          ? '根据文字描述生成一段短视频，可用 reference_images 指定首帧。成本较高：调用前需先向用户确认，得到同意后传 confirmed=true。调用会阻塞到生成完成（可能数分钟），结果里包含实际参数与产物路径。'
          : '根据文字描述生成一段音频（音效/配乐）。调用会阻塞到生成完成，结果里包含实际参数与产物路径。',
    parameters,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const input = params as {
        prompt: string
        name?: string
        ratio?: MediaRatio
        duration_seconds?: number
        reference_images?: string[]
        confirmed?: boolean
      }
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
            refCount: input.reference_images?.length ?? 0
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
            ...(input.reference_images && input.reference_images.length > 0
              ? { refPaths: input.reference_images }
              : {}),
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

      // 成功：文本摘要必回；图片且对话模型支持视觉时附产物缩略图（多模态感知）
      const text =
        `${KIND_LABEL[kind]}已生成成功（jobId=${final.jobId}，${final.provider}/${final.model}${paramsSummary(final)}）。` +
        `产物：${final.artifact.relPath}（${final.artifact.mime}` +
        `${final.artifact.width ? `，${final.artifact.width}×${final.artifact.height}px` : ''}` +
        `${final.artifact.durationSeconds ? `，${final.artifact.durationSeconds}s` : ''}），` +
        `已作为媒体节点出现在画布上（来源标记为当前会话）。请基于以上真实结果回答用户。`
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text }
      ]
      if (
        kind === 'image' &&
        ctx.supportsImageInput?.() &&
        ctx.readArtifactAsBase64 &&
        final.artifact.mime.startsWith('image/')
      ) {
        const image = ctx.readArtifactAsBase64(final.artifact.relPath)
        if (image) content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      }
      return {
        content,
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
