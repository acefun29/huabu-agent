// 媒体配置强制引导：打开工作区后检测配置完成度，未完成时自动直达「设置 → 媒体生成」。
// 只在每次安装后自动弹一次（localStorage 记账），之后只靠生成拦截 + toast「去设置」闭环。

import { useEffect } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { useSettings, useSettingsUi } from '../store/settingsStore'
import { assessMediaReadiness } from '@shared/mediaResolve'

/** localStorage 标记：首次评估（无论是否弹）后即写入，保证整个安装周期最多自动弹一次 */
const GATE_FLAG = 'huabu.media-config-guide.v1'

export function MediaConfigGate() {
  const workspace = useCanvasStore((s) => s.workspace)
  const { mediaProviders, mediaStatus, mediaLoaded } = useSettings()
  const { openSettings } = useSettingsUi()

  useEffect(() => {
    if (!workspace || !mediaLoaded) return
    // 数据未就绪（providers/status 还是空快照）不评估，避免误判"未完成"
    if (mediaProviders.length === 0 || !mediaStatus) return
    let flagged: string | null = null
    try {
      flagged = localStorage.getItem(GATE_FLAG)
    } catch {
      return // localStorage 不可用（隐私模式等）：放弃自动弹，不拦任何东西
    }
    if (flagged != null) return
    try {
      localStorage.setItem(GATE_FLAG, '1')
    } catch {
      return
    }
    const readiness = assessMediaReadiness(mediaProviders, {
      agentProvider: mediaStatus.agentProvider,
      agentModels: mediaStatus.agentModels
    })
    if (!readiness.complete) openSettings('media')
  }, [workspace, mediaLoaded, mediaProviders, mediaStatus, openSettings])

  return null
}
