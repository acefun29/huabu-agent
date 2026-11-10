import { memo, useMemo } from 'react'

/**
 * 专家头像：GitHub 风格像素 identicon（7×7 左右镜像），带渐变与「像素流动」动效。
 *
 * 为什么不用图片资源：专家池是数据驱动的（id 来自注册表），头像必须能从 id 直接派生，
 * 加一个专家不该需要再加一张图。纯 SVG 生成体积为零、离线可用、任意尺寸不糊。
 *
 * 实现要点（沿用已经验证过的方案）：
 * - 哈希 → 调色板 + 格子：同一 id 永远同一张脸，不同 id 有足够区分度；
 * - 渐变用 `gradientUnits="userSpaceOnUse"` + `shape-rendering="crispEdges"`：
 *   每个格子是渐变的一小段切片，拼起来是连续渐变而不是 N 份重复渐变（也就没有接缝）；
 * - 动效是「按格子相位错开的透明度/缩放脉冲」：一轮动画后所有格子回到同一起点，
 *   因此可以 `animation-iteration-count: infinite` 而不跳变。
 * - `prefers-reduced-motion` 下完全关闭动画（只留静态图案）。
 */

const PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ['#6ea8ff', '#4c6ef5', '#7048e8'],
  ['#ffb86b', '#ff7a45', '#e8590c'],
  ['#63e6be', '#20c997', '#0ca678'],
  ['#faa2c1', '#f06595', '#c2255c'],
  ['#a5d8ff', '#4dabf7', '#1971c2'],
  ['#c0eb75', '#94d82d', '#5c940d'],
  ['#ffd43b', '#fab005', '#e67700'],
  ['#d0bfff', '#9775fa', '#6741d9'],
  ['#99e9f2', '#22b8cf', '#0b7285'],
  ['#ffc9c9', '#ff6b6b', '#c92a2a']
]

const GRID = 7
/** 半格数：7 → 4 列（含中列），右半边镜像 */
const HALF = Math.ceil(GRID / 2)

function fnv1a(text: string): number {
  let hash = 2166136261 >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 确定性伪随机（mulberry32）：同 seed 同序列 */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface IdenticonPattern {
  colors: readonly [string, string, string]
  /** 7×7 布尔的扁平数组（index = y * 7 + x） */
  cells: boolean[]
}

function buildPattern(seed: string): IdenticonPattern {
  const hash = fnv1a(`${seed}@${GRID}`)
  const rand = mulberry32(hash)
  const colors = PALETTES[hash % PALETTES.length]
  const cells: boolean[] = []
  for (let y = 0; y < GRID; y += 1) {
    const left: boolean[] = []
    for (let x = 0; x < HALF; x += 1) left.push(rand() > 0.44)
    for (let x = 0; x < GRID; x += 1) cells.push(left[x < HALF ? x : GRID - 1 - x])
  }
  // 全空图案退化成「中心一点」：空头像在列表里像加载失败
  if (!cells.some(Boolean)) cells[Math.floor((GRID * GRID) / 2)] = true
  return { colors, cells }
}

export type ExpertStatus = 'running' | 'attention' | 'idle'

export interface ExpertAvatarProps {
  /** 生成图案的种子（用专家 id 或任务 id） */
  seed: string
  /** 展示边长（px）；≤26 时自动降级为轻量模式（只脉冲不缩放） */
  size?: number
  /** 圆角（CSS 值，如 '10px' / '50%'） */
  radius?: string
  /** 右下角状态点；缺省不显示 */
  status?: ExpertStatus
  /** 无障碍标签（缺省用 seed） */
  label?: string
  className?: string
}

const STATUS_COLOR: Record<ExpertStatus, string> = {
  running: 'var(--accent)',
  attention: '#e8590c',
  idle: 'var(--on-surface-muted)'
}

/** 单个头像（纯 SVG，无状态；memo 避免任务板刷新时整排重渲） */
export const ExpertAvatar = memo(function ExpertAvatar({
  seed,
  size = 24,
  radius = '30%',
  status,
  label,
  className = ''
}: ExpertAvatarProps) {
  const pattern = useMemo(() => buildPattern(seed), [seed])
  const gradientId = useMemo(() => `expert-avatar-${fnv1a(seed).toString(36)}`, [seed])
  const lite = size <= 26
  const mid = (GRID - 1) / 2

  return (
    <span
      className={`hb-expert-avatar ${lite ? 'hb-expert-avatar-lite' : ''} ${className}`}
      style={{ width: size, height: size, borderRadius: radius }}
      role="img"
      aria-label={label ?? seed}
      title={label ?? seed}
    >
      <svg viewBox={`0 0 ${GRID} ${GRID}`} shapeRendering="crispEdges" className="hb-expert-avatar-svg">
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2={GRID}
            y2={GRID}
          >
            <stop offset="0" stopColor={pattern.colors[0]} />
            <stop offset="0.52" stopColor={pattern.colors[1]} />
            <stop offset="1" stopColor={pattern.colors[2]} />
          </linearGradient>
        </defs>
        {pattern.cells.map((on, index) => {
          if (!on) return null
          const x = index % GRID
          const y = (index - x) / GRID
          const dx = x - mid
          const dy = y - mid
          // 斜向光带相位：列权重略小于行 → 波纹带倾角，比纯水平更耐看
          const phase = x * 0.62 + y
          const dist = Math.sqrt(dx * dx + dy * dy)
          return (
            <rect
              key={index}
              x={x}
              y={y}
              width={1}
              height={1}
              fill={`url(#${gradientId})`}
              className="hb-expert-avatar-cell"
              style={
                {
                  '--phase': phase.toFixed(3),
                  '--ring': Math.round(dist * 2) / 2
                } as React.CSSProperties
              }
            />
          )
        })}
      </svg>
      {status ? (
        <span
          className={`hb-expert-avatar-dot ${status === 'running' ? 'is-running' : ''}`}
          style={{ background: STATUS_COLOR[status] }}
        />
      ) : null}
    </span>
  )
})
