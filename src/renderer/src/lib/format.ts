/**
 * token 数的紧凑显示（ChatDock 水位与 SettingsPanel 模型目录共用，原先两处各抄一份）。
 * 非法/非正值返回 null：调用方（如模型目录的 contextWindow）自行省略不渲染。
 */
export function compactTokens(value?: number): string | null {
  if (!value || value <= 0) return null
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`
  }
  if (value % 1024 === 0) return `${value / 1024}K`
  if (value >= 1000) return `${Math.round(value / 1000)}K`
  return String(value)
}
