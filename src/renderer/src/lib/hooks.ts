import { useEffect, useRef, type RefObject } from 'react'

/**
 * outside-click + Esc 关闭的公共实现（此前 Composer×2 / WorkspaceSwitcher / ContextMenu
 * 各自手抄同一份 effect）。onDismiss 存进 ref：调用方传内联箭头也不会让监听器反复重挂。
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void): void {
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  })
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismissRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissRef.current()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ref, active])
}

/**
 * 纯 Esc 关闭（设置面板与其内嵌对话框、媒体查看器此前各抄一份）。
 * 对话框场景用 capture+swallow：捕获阶段拦截并吞掉事件，避免冒泡到外层
 * 把承载对话框的设置面板一起关掉。
 */
export function useEsc(
  active: boolean,
  onEsc: () => void,
  opts?: { capture?: boolean; swallow?: boolean }
): void {
  const escRef = useRef(onEsc)
  useEffect(() => {
    escRef.current = onEsc
  })
  const { capture = false, swallow = false } = opts ?? {}
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (swallow) e.stopPropagation()
      escRef.current()
    }
    window.addEventListener('keydown', onKey, capture)
    return () => window.removeEventListener('keydown', onKey, capture)
  }, [active, capture, swallow])
}
