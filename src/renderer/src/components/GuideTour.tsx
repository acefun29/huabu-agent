import { useEffect, useLayoutEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, CirclePlay, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useCanvasStore } from '../store/canvasStore'

interface TourStep {
  /** 高亮目标的选择器（元素不存在时讲解卡片居中显示） */
  selector?: string
  title: string
  body: string
}

/**
 * 分步演示（入口在 设置 → 使用引导）：按「画布 → 素材卡片 → 批量操作 → 工作区 →
 * 清空画布 → 会话 → 素材库 → 对话 → 设置」的顺序，站在使用者角度讲每个区域怎么玩。
 * 目标元素靠 data-tour / 结构选择器定位，元素缺席时降级为居中讲解。
 */
const STEPS: TourStep[] = [
  {
    title: '画布：自由编排的工作台',
    body: '这块画布属于当前工作区，所有会话共用，随便摆放、整理都不影响对话。\n\n· 滚轮缩放；空格 + 拖动（或中键拖动）平移\n· 左键拖空白处 = 框选卡片，按住 Shift 可追加选择\n· 右键空白处 = 新建生成卡片（图片 / 视频 / 音频），或把素材库里的文件钉上来\n· 把电脑里的文件直接拖进来 = 自动归档到素材库，并出现在画布上',
  },
  {
    selector: '.canvas-node',
    title: '素材卡片：画布上的文件',
    body: '每张卡片对应工作区里的一个文件。\n\n· 单击选中（作为要交给助手的参考），双击放大查看（视频 / 音频可播放）\n· 拖动卡片摆放位置，拖右下角改大小\n· 按住卡片右上角的竖点把手，拖进下方输入框 = 交给助手当参考\n· 右键卡片 = 以此生成（垫图 / 首帧）、引用进会话、打开文件位置、从画布移除\n\n移除卡片不会删除文件，文件始终保存在工作区里。',
  },
  {
    selector: '[data-tour="selection-bar"]',
    title: '批量操作：一次搞定多张卡片',
    body: '框选多张卡片后，画布顶部会出现一条浮动操作条：\n\n· 引用进会话：整批一起交给助手当参考\n· 从画布移除：一次收走多张卡片（文件不受影响）\n\n也可以按住其中一张的把手拖进输入框，整批都会带上。\n（当前没有选中卡片，所以看不到它——框选几张再翻回这一步看看）',
  },
  {
    selector: '[data-tour="topbar"]',
    title: '工作区：不同项目分开放',
    body: '左上角可以切换或新建工作区。\n\n每个工作区有自己的一套画布、素材库和会话，互不干扰——用它来分开不同的项目。',
  },
  {
    selector: '[data-tour="rail-clear"]',
    title: '清空画布：一键重整',
    body: '左侧栏的橡皮擦图标就是「清空画布」：点一下进入确认态，3 秒内再点一次执行（画布为空时不可点）。\n\n放心：只清画布上的卡片，文件都还保存在工作区和素材库里，随时可以再钉回来。\n\n画布空白处右键也能找到同一个操作。',
  },
  {
    selector: '[data-tour="rail-sessions"]',
    title: '会话：和助手的对话',
    body: '左侧第一个图标打开会话列表。会话就是一段对话，切换会话不会动画布——素材和摆放都保持原样。\n\n· 聊久了想换个话题，点 + 新建会话即可\n· 鼠标悬停在会话上：分叉可以复制一段对话重新聊；删除只删对话记录，不删素材文件',
  },
  {
    selector: '[data-tour="rail-libraries"]',
    title: '素材库：文件的收纳架',
    body: '素材库按目录整理工作区里的文件，所有会话共用。\n\n· 展开后点文件即可钉到画布，也可以直接拖到画布任意位置\n· 新建素材库 = 增加一个自定义分类\n· 助手生成的新文件也会自动存进素材库',
  },
  {
    selector: '[data-tour="composer"]',
    title: '对话：把素材交给助手',
    body: '底部输入框就是和助手对话的地方：\n\n· 选中画布卡片、或把卡片 / 文件拖进输入框，就会作为参考一起发给助手\n· 直接把电脑文件拖进输入框 = 临时引用（不进素材库，chip 用虚线框区分）\n· 发送后参考 chip 仍挂在输入框上方，可继续用或点 × 移除\n· 点输入框上方的把手可展开完整对话历史；Enter 发送，Shift+Enter 换行',
  },
  {
    selector: '[data-tour="rail-settings"]',
    title: '设置：按需调整',
    body: '左下角的齿轮打开设置：使用引导、模型供应商、媒体生成、外观等都在这里配置。\n\n想再看一遍这份演示？回到 设置 → 使用引导 随时打开。',
  },
]

const CARD_W = 340

interface TargetRect {
  x: number
  y: number
  width: number
  height: number
}

export function GuideTour() {
  const guideOpen = useCanvasStore((s) => s.guideOpen)
  const closeGuide = useCanvasStore.getState().closeGuide
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<TargetRect | null>(null)

  // 每次打开从头开始
  useEffect(() => {
    if (guideOpen) setStep(0)
  }, [guideOpen])

  const current = STEPS[step]

  // 定位高亮目标；元素缺席（如未划选时的操作条）则降级为居中讲解
  useLayoutEffect(() => {
    if (!guideOpen) return
    const measure = () => {
      const el = current.selector ? document.querySelector(current.selector) : null
      if (!el) {
        setRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      setRect({ x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [guideOpen, step, current.selector])

  // Esc 退出，←/→ 翻页
  useEffect(() => {
    if (!guideOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeGuide()
      if (e.key === 'ArrowRight') setStep((s) => Math.min(s + 1, STEPS.length - 1))
      if (e.key === 'ArrowLeft') setStep((s) => Math.max(s - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [guideOpen, closeGuide])

  if (!guideOpen) return null

  const last = step === STEPS.length - 1

  // 讲解卡片落位：优先目标下方，空间不够放上方，再不够/无目标则屏幕居中
  const cardPos = (() => {
    if (!rect) return { left: `calc(50% - ${CARD_W / 2}px)`, top: '38%' }
    const vh = window.innerHeight
    const estH = 240
    const below = rect.y + rect.height + 14
    const above = rect.y - estH - 14
    const top = below + estH < vh - 16 ? below : above > 16 ? above : Math.max(16, (vh - estH) / 2)
    const cx = rect.x + rect.width / 2
    const left = Math.min(Math.max(16, cx - CARD_W / 2), window.innerWidth - CARD_W - 16)
    return { left, top }
  })()

  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-label="操作演示">
      {/* 暗化背景（高亮区域由下面带巨大阴影的镂空框让出）；点击不穿透、不关闭，避免误触 */}
      <div className="absolute inset-0 bg-black/30" />

      {/* 高亮镂空框：box-shadow 撑出整屏暗角，框内透亮 */}
      {rect && (
        <motion.div
          initial={false}
          animate={{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }}
          transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          className="pointer-events-none absolute left-0 top-0 rounded-2xl ring-2 ring-(--accent)"
          style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.42)' }}
        />
      )}

      {/* 讲解卡片：内容随步数即时替换（不带进出场动画，避免快速翻页时点击落在旧卡片上） */}
      <div
        className="absolute rounded-3xl bg-(--surface-card) p-5 shadow-2xl ring-1 ring-(--outline)"
        style={{ ...cardPos, width: CARD_W }}
      >
        <div className="mb-2 flex items-center gap-2">
          <CirclePlay size={15} className="shrink-0 text-(--accent)" />
          <span className="text-[13px] font-semibold text-(--on-surface)">{current.title}</span>
          <button
            onClick={closeGuide}
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-(--on-surface-muted) transition-colors hover:bg-(--outline-soft)"
            title="退出演示（Esc）"
          >
            <X size={13} />
          </button>
        </div>
        <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-(--on-surface-variant)">{current.body}</div>

        <div className="mt-4 flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-(--on-surface-muted)">
            {step + 1} / {STEPS.length}
          </span>
          <div className="ml-1 flex gap-1">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                aria-label={`第 ${i + 1} 步`}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-4 bg-(--accent)' : 'w-1.5 bg-(--outline) hover:bg-(--on-surface-muted)'
                }`}
              />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[12px] font-medium text-(--on-surface-variant) transition-colors hover:bg-(--outline-soft)"
              >
                <ArrowLeft size={12} />
                上一步
              </button>
            )}
            <button
              onClick={() => (last ? closeGuide() : setStep(step + 1))}
              className="flex items-center gap-1 rounded-full bg-(--fab-bg) px-3.5 py-1.5 text-[12px] font-medium text-(--fab-text) transition hover:opacity-90"
            >
              {last ? '完成' : '下一步'}
              {!last && <ArrowRight size={12} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
