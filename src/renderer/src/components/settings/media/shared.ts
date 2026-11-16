/**
 * 媒体设置各视图共用的常量与纯函数。
 *
 * 视图文件只负责渲染与交互；适配器类型、官方 Key 入口和能力参数换算集中在这里，
 * 避免同一份口径在多个表单里各写一遍。
 */

import type { MediaProviderType } from '@shared/ipc'
import {
  MEDIA_REF_ROLES,
  type MediaRefQuota,
  type MediaRefRole,
  type ModelCapabilities
} from '@shared/media'
import { matchBareModelId, parseModelRef } from '@shared/mediaResolve'
import type { MediaKind } from '../../../types'

/** 新增供应商可用的适配器类型（与主进程注册表对应；新增类型时两处同步） */
export const ADAPTER_TYPE_OPTIONS: { value: MediaProviderType; label: string; baseUrlHint?: string }[] = [
  { value: 'gateway-vidu', label: 'Vidu 生数科技（图片 / 视频）' },
  { value: 'gateway-qianfan', label: '百度千帆（图片 / 视频）' },
  { value: 'gateway-pixverse', label: '拍我 AI（视频）' },
  { value: 'gateway-zhipu-media', label: '智谱（图片 / 视频）' },
  { value: 'gateway-tokenhub', label: '腾讯 TokenHub（图片 / 视频）' },
  { value: 'gateway-openai-compat', label: 'OpenAI 兼容（图片 / 视频 / 语音合成）', baseUrlHint: 'https://api.openai.com/v1' },
  { value: 'gateway-dashscope', label: '阿里云百炼（异步任务）' },
  { value: 'gateway-token-plan', label: '阿里云 Token Plan（订阅制：文生图同步 / 文生视频异步）', baseUrlHint: 'https://token-plan.cn-beijing.maas.aliyuncs.com' },
  { value: 'gateway-volcark', label: '火山方舟' },
  { value: 'gateway-minimax', label: 'MiniMax（海螺视频 / 图片）' },
  { value: 'gateway-tencent', label: '腾讯混元（生图 / 生视频）' }
]

/**
 * 内置媒体供应商「创建 / 管理 API Key」页面的官方直达地址（2026-10 逐家官网核实）。
 * openai / dashscope 与对话供应商同一家（复用已核实地址）；火山方舟为控制台
 * 「API Key 管理」深链（登录后直达）；MiniMax / 腾讯云为各自控制台密钥页。
 * 用户自建的 gateway-* 供应商无固定官网，不在表内也就不显示链接。
 */
export const MEDIA_API_KEY_URLS: Record<string, { url: string; label: string }> = {
  vidu: { url: 'https://platform.vidu.cn/', label: 'Vidu 开放平台' },
  qianfan: { url: 'https://console.bce.baidu.com/qianfan/', label: '百度千帆' },
  pixverse: { url: 'https://platform.pai.video/', label: '拍我 AI 开放平台' },
  'zhipu-media': { url: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', label: '智谱开放平台' },
  tokenhub: { url: 'https://console.cloud.tencent.com/tokenhub/api-key', label: '腾讯 TokenHub' },
  openai: { url: 'https://platform.openai.com/api-keys', label: 'OpenAI 平台' },
  dashscope: { url: 'https://bailian.console.aliyun.com/?apiKey=1', label: '阿里云百炼' },
  'token-plan': { url: 'https://bailian.console.aliyun.com/cn-beijing/subscription/overview', label: '百炼 Token Plan 订阅页' },
  volcark: { url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', label: '火山方舟' },
  minimax: { url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', label: 'MiniMax 开放平台' },
  tencent: { url: 'https://console.cloud.tencent.com/cam/capi', label: '腾讯云（API 密钥管理）' },
}

/** 全部媒体大类（矩阵通道异常时的兜底 = 不因数据缺失卡住表单） */
export const ALL_KINDS: MediaKind[] = ['image', 'video', 'audio']

export type MediaView = 'defaults' | 'add' | 'provider'

/** 存储值 → 规范化复合串：统一 `provider:模型id` 记法（旧裸 id 兼容映射，映射不到返回空） */
export function normalizeStoredRef(
  kind: MediaKind,
  stored: string,
  providers: Parameters<typeof matchBareModelId>[0],
  agentProviderId: string
): string {
  if (!stored) return ''
  if (stored.includes(':')) return stored
  return matchBareModelId(providers, stored, kind, agentProviderId || undefined)?.ref ?? ''
}

/** 复合串 → 完整显示名（供应商 · 模型名）；供应商/模型已不在清单返回 null（已失效） */
export function displayNameOfRef(
  ref: string,
  providers: Array<{ id: string; label: string; models: Array<{ id: string; label?: string }> }>
): string | null {
  const parsed = parseModelRef(ref)
  if (!parsed) return null
  const provider = providers.find((p) => p.id === parsed.provider)
  const model = provider?.models.find((m) => m.id === parsed.model)
  if (!provider || !model) return null
  return `${provider.label} · ${model.label ?? model.id}`
}

/** 凭据来源徽章：media:providers 的 authHint（workspace-store / environment:<NAME> / none） */
export function authHintLabel(hint?: string): string {
  if (!hint || hint === 'none') return '未配置凭据'
  if (hint.startsWith('environment')) return `走环境变量 ${hint.slice('environment:'.length)}`
  return '加密存储'
}

/**
 * 表单态能力参数 → media:user-add-* 载荷：全空则不留字段（不声明，参数面板与
 * 编排层按兜底走）。去重升序在这里先做一遍，主进程 sanitizeCapabilities 再同源兜底。
 *
 * `maxRefImages` 是已废弃的老字段：新声明一律走 refQuota/refModes/refTotal，
 * 这里**不再写它**（存量配置仍由 normalizeMediaCaps 派生读取，零迁移）。
 */
export function capsPayload(
  kind: MediaKind,
  caps: ModelCapabilities,
  costHint: string
): { capabilities?: ModelCapabilities; costHint?: string } {
  const out: ModelCapabilities = {}
  if (caps.ratios?.length) out.ratios = [...new Set(caps.ratios)]
  if (caps.durations?.length) out.durations = [...new Set(caps.durations)].sort((a, b) => a - b)
  const refQuota = (caps.refQuota ?? [])
    .filter((q) => MEDIA_REF_ROLES.includes(q.role) && Number.isFinite(q.max) && q.max > 0)
    .map((q) => ({ role: q.role, max: Math.floor(q.max) }))
  // 存量只有 maxRefImages 的模型：编辑时按老语义搬成逐角色配额，不让它悄悄退回兜底 4 张
  if (refQuota.length === 0) refQuota.push(...legacyQuota(kind, caps.maxRefImages))
  if (refQuota.length > 0) out.refQuota = refQuota
  if (caps.refModes?.length) out.refModes = [...new Set(caps.refModes)]
  if (Number.isFinite(caps.refTotal) && (caps.refTotal ?? 0) > 0) out.refTotal = Math.floor(caps.refTotal!)
  const voices = (caps.voices ?? []).filter((v) => v.id.trim()).map((v) => ({ id: v.id.trim(), label: (v.label ?? v.id).trim() || v.id.trim() }))
  if (voices.length > 0) out.voices = voices
  return {
    ...(Object.keys(out).length > 0 ? { capabilities: out } : {}),
    ...(costHint.trim() ? { costHint: costHint.trim() } : {})
  }
}

/** 该模型大类下可声明的参考角色（音频通道今天没有任何参考输入） */
export function rolesForKind(kind: MediaKind): MediaRefRole[] {
  if (kind === 'image') return ['reference_image']
  if (kind === 'video') {
    return ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio']
  }
  return []
}

/**
 * 老字段 `maxRefImages` 折算成逐角色配额（与主进程 normalizeMediaCaps 同一映射）：
 * 图片模型 = 参考图 N 张，视频模型 = 首帧 1 张。设置页据此显示与保存，不再写回老字段。
 */
export function legacyQuota(kind: MediaKind, maxRefImages: number | undefined): MediaRefQuota[] {
  const n = Math.floor(Number(maxRefImages))
  if (!Number.isFinite(n) || n <= 0) return []
  return [{ role: kind === 'video' ? 'first_frame' : 'reference_image', max: n }]
}

/** 配额编辑器里每个角色的一句话说明（各家官方语义，避免把首帧当参考图填） */
export const REF_ROLE_NOTE: Record<MediaRefRole, string> = {
  first_frame: '视频从这张图开始（图生视频的首帧）',
  last_frame: '视频在这张图结束，需与首帧同时给',
  reference_image: '垫图 / 风格参考，不决定构图边界',
  reference_video: '参考视频：方舟只收公网 URL，百炼需先上传换临时引用',
  reference_audio: '参考音频：百炼需先上传换临时引用'
}
