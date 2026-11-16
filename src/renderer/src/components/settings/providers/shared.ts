/** 模型供应商设置各视图共用的常量与校验规则。 */

import type { ThinkingLevelName } from '@shared/ipc'

/**
 * 与主进程 chat 覆盖层的 ID 校验（main/models/catalog/merge.ts 的 PROVIDER_ID/MODEL_ID_PATTERN）
 * 大体一致，但这里刻意更宽：允许 `:` 与 `/`（自建模型常写 `网关/模型` 复合 id），大小写
 * 不敏感只为本输入框的容错；主进程侧仍是严格纯 id，最终以主进程校验为准。
 */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._\-/:]*$/i

/** 档位声明的可选集（off 由「推理模型」开关表达，不进列表）；顺序即 THINKING_LEVELS 顺序 */
export const EFFORT_LEVELS: readonly ThinkingLevelName[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const ALL_EFFORT_LEVELS: ThinkingLevelName[] = [...EFFORT_LEVELS]

/**
 * 各内置供应商「创建 / 管理 API Key」页面的官方直达地址（2026-10 逐家官网核实）。
 * 注意两家已迁新域名：Anthropic 控制台 console.anthropic.com → platform.claude.com，
 * 月之暗面 platform.moonshot.cn → platform.kimi.com（旧地址 301，这里直接链新址）。
 * 自定义供应商无固定官网，不在表内也就不显示链接。链接走 <a target="_blank">，
 * 由主窗口 setWindowOpenHandler 接管交给系统浏览器。
 */
export const API_KEY_URLS: Record<string, { url: string; label: string }> = {
  openai: { url: 'https://platform.openai.com/api-keys', label: 'OpenAI 平台' },
  anthropic: { url: 'https://platform.claude.com/settings/keys', label: 'Anthropic 控制台' },
  glm: { url: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', label: '智谱 BigModel' },
  deepseek: { url: 'https://platform.deepseek.com/api_keys', label: 'DeepSeek 开放平台' },
  kimi: { url: 'https://platform.kimi.com/console/api-keys', label: 'Kimi 开放平台' },
  qwen: { url: 'https://bailian.console.aliyun.com/?apiKey=1', label: '阿里云百炼' },
}
