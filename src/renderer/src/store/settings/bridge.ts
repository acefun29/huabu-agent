/** 渲染端可以在不加载桌面桥的浏览器预览中运行。 */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.huabu)
}
