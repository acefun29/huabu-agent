import { useCallback, useMemo, useRef, useState } from 'react'
import type { MediaProviderInfo, MediaSettingsStatus, MediaUserModelInput, MediaUserProviderInput } from '@shared/ipc'
import type { MediaConfigPatch } from '@shared/api'
import { resolveMediaTarget, toModelRef } from '@shared/mediaResolve'
import type { MediaKind } from '../../types'
import { hasBridge } from './bridge'

export interface ResolvedMediaModel {
  provider: string
  model: string
  composite: string
}

/** 媒体供应商与模型配置的状态和操作。 */
export function useMediaSettingsState() {
  const [mediaProviders, setMediaProviders] = useState<MediaProviderInfo[]>([])
  const [mediaStatus, setMediaStatus] = useState<MediaSettingsStatus['config'] | null>(null)
  const [confirmVideo, setConfirmVideo] = useState(true)
  const [mediaLoaded, setMediaLoaded] = useState(false)
  const [mediaWorkspacePath, setMediaWorkspacePath] = useState<string | null>(null)
  const [mediaLoadError, setMediaLoadError] = useState<string | null>(null)
  const [mediaAdapterKinds, setMediaAdapterKinds] = useState<Record<string, MediaKind[]>>({})

  const refreshSequence = useRef(0)

  const resetMediaWorkspace = useCallback(() => {
    refreshSequence.current += 1
    setMediaProviders([])
    setMediaStatus(null)
    setConfirmVideo(true)
    setMediaLoaded(false)
    setMediaWorkspacePath(null)
    setMediaLoadError(null)
  }, [])

  const refreshMedia = useCallback(async (expectedWorkspace?: string) => {
    if (!hasBridge()) return
    const requestId = ++refreshSequence.current
    setMediaLoadError(null)
    try {
      const before = await window.huabu.workspace.state()
      const workspacePath = before.workspace?.path
      if (!workspacePath || (expectedWorkspace && expectedWorkspace !== workspacePath)) return
      const [providersResult, statusResult, kindsResult] = await Promise.all([
        window.huabu.media.providers(),
        window.huabu.settings.mediaStatus(),
        window.huabu.media.adapterKinds()
      ])
      const after = await window.huabu.workspace.state()
      if (requestId !== refreshSequence.current || after.workspace?.path !== workspacePath) return
      if (providersResult.ok) setMediaProviders(providersResult.value)
      if (statusResult.ok) {
        setMediaStatus(statusResult.value.config)
        setConfirmVideo(statusResult.value.confirmVideo)
      }
      if (kindsResult.ok) setMediaAdapterKinds(kindsResult.value)
      if (providersResult.ok && statusResult.ok) setMediaWorkspacePath(workspacePath)
      else setMediaLoadError('媒体配置加载失败，请重试。')
      setMediaLoaded(true)
    } catch {
      if (requestId !== refreshSequence.current) return
      setMediaLoadError('媒体配置加载失败，请重试。')
      setMediaLoaded(true)
    }
  }, [])

  const updateMediaConfig = useCallback(async (patch: MediaConfigPatch) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.setConfig(patch)
    if (!result.ok) return result.error
    // 以主进程落盘后的配置为准回显
    await refreshMedia()
    return null
  }, [refreshMedia])

  const setMediaKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.settings.mediaSetKey(providerId, apiKey)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const removeMediaKey = useCallback(async (providerId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.settings.mediaRemoveKey(providerId)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserAddProvider = useCallback(async (input: MediaUserProviderInput) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userAddProvider(input)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserRemoveProvider = useCallback(async (providerId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userRemoveProvider(providerId)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserAddModel = useCallback(async (input: MediaUserModelInput) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userAddModel(input)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserRemoveModel = useCallback(async (providerId: string, modelId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userRemoveModel(providerId, modelId)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaUserRestoreModel = useCallback(async (providerId: string, modelId: string) => {
    if (!hasBridge()) return '当前环境没有可用的设置服务'
    const result = await window.huabu.media.userRestoreModel(providerId, modelId)
    if (!result.ok) return result.error
    await refreshMedia()
    return null
  }, [refreshMedia])

  const mediaBrowseCatalog = useCallback(async (providerId: string) => {
    if (!hasBridge()) return []
    const result = await window.huabu.media.browseCatalog(providerId)
    return result.ok ? result.value : []
  }, [])

  const resolveMediaModel = useCallback(
    (kind: MediaKind, override?: string): ResolvedMediaModel | null => {
      // 回退链的唯一实现在 shared/mediaResolve.ts，主进程 Agent 工具走同一条链
      const resolved = resolveMediaTarget(mediaProviders, {
        kind,
        override,
        agentProvider: mediaStatus?.agentProvider,
        agentModels: mediaStatus?.agentModels
      })
      return resolved ? { provider: resolved.provider, model: resolved.model, composite: resolved.ref } : null
    },
    [mediaProviders, mediaStatus]
  )

  const mediaModelOptions = useCallback(
    (kind: MediaKind) =>
      mediaProviders.flatMap((p) =>
        p.models
          .filter((m) => m.kind === kind)
          .map((m) => ({ id: toModelRef(p.id, m.id), label: `${p.label} · ${m.label ?? m.id}` }))
      ),
    [mediaProviders]
  )

  return useMemo(() => ({
    mediaProviders, mediaStatus, confirmVideo, mediaLoaded, mediaWorkspacePath, mediaLoadError, mediaAdapterKinds,
    refreshMedia, resetMediaWorkspace, updateMediaConfig, setMediaKey, removeMediaKey,
    mediaUserAddProvider, mediaUserRemoveProvider, mediaUserAddModel, mediaUserRemoveModel,
    mediaUserRestoreModel, mediaBrowseCatalog, resolveMediaModel, mediaModelOptions
  }), [
    mediaProviders, mediaStatus, confirmVideo, mediaLoaded, mediaWorkspacePath, mediaLoadError, mediaAdapterKinds,
    refreshMedia, resetMediaWorkspace, updateMediaConfig, setMediaKey, removeMediaKey,
    mediaUserAddProvider, mediaUserRemoveProvider, mediaUserAddModel, mediaUserRemoveModel,
    mediaUserRestoreModel, mediaBrowseCatalog, resolveMediaModel, mediaModelOptions
  ])
}

export type MediaSettingsState = ReturnType<typeof useMediaSettingsState>
