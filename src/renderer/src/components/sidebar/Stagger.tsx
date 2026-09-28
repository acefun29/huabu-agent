import type { ReactNode } from 'react'
import { motion } from 'motion/react'

/** 列表项入场：轻微错开，面板打开时有一层层铺开的感觉 */
export function Stagger({ index, children }: { index: number; children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.018, 0.14), duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  )
}
