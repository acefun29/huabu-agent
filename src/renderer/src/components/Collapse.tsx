import type { ReactNode } from 'react'
import type { JSX } from 'react'

/**
 * 折叠区域：grid 行高 0fr→1fr 过渡，未知高度的展开/收起双向平滑。
 * 不用 max-height 方案：内容远短于上限时收起会先空跑剩余额度再动，观感发滞。
 * 子内容保持挂载（收起只是高度归零被裁剪），需要懒挂载的场景由调用方自己控制。
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }): JSX.Element {
  return (
    <div
      aria-hidden={open ? undefined : true}
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      }`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
