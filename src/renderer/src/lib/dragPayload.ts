import type { AssetLibraryFile } from '@shared/ipc'
import { ASSET_IDS_MIME, LIBRARY_ASSET_MIME, LEGACY_ASSET_MIME } from '../store/canvas/shared'

/**
 * 拖拽载荷解析的唯一入口：JSON.parse + try/catch + 形状校验收口在这里。
 *
 * 此前各消费点（素材库面板 / 画布 / 输入框 / 生成卡）散落着裸 `JSON.parse(getData(...))`，
 * 载荷形状只靠 as 断言、坏了就吞进 catch——一处忘了 try 就会把异常炸进 React 事件栈。
 * 这里统一成「解析失败或形状不符返回 null」，调用方只处理 null 一种失败形态。
 */

/** AssetLibraryFile 里 kind 的合法取值（shape 校验用；与 shared/ipc.ts 保持一致） */
const LIBRARY_KINDS = new Set(['image', 'video', 'audio', 'doc', 'code', 'other'])

/** 校验值是否为非空字符串（载荷字段的最小可信形态） */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 拖拽源通道识别（只读 dt.types，不触发 getData）：三通道判定收口一处。
 * - osFiles：OS 文件拖入（复制语义）
 * - libraryEntry：素材库条目拖出（LIBRARY_ASSET_MIME，移动语义）
 * - canvasNodes：画布卡片拖出（批量 ASSET_IDS_MIME 优先，遗留单卡通道兜底）
 */
export function dragSourceTypes(types: readonly string[]): {
  osFiles: boolean
  libraryEntry: boolean
  canvasNodes: boolean
} {
  return {
    osFiles: types.includes('Files'),
    libraryEntry: types.includes(LIBRARY_ASSET_MIME),
    canvasNodes: types.includes(ASSET_IDS_MIME) || types.includes(LEGACY_ASSET_MIME)
  }
}

/**
 * LIBRARY_ASSET_MIME 载荷：`{ libraryId, entry }`（库文件拖出 = 钉引用/移动）。
 * entry 只校验消费方真正用到的字段（name/relPath/kind/bytes），多出来的字段不深究。
 */
export function parseLibraryEntryPayload(dt: DataTransfer): { libraryId: string; entry: AssetLibraryFile } | null {
  const raw = dt.getData(LIBRARY_ASSET_MIME)
  if (!raw) return null
  try {
    const payload = JSON.parse(raw) as {
      libraryId?: unknown
      entry?: { name?: unknown; relPath?: unknown; kind?: unknown; bytes?: unknown }
    } | null
    if (!nonEmptyString(payload?.libraryId)) return null
    const entry = payload?.entry
    if (
      !entry ||
      typeof entry !== 'object' ||
      !nonEmptyString(entry.name) ||
      !nonEmptyString(entry.relPath) ||
      typeof entry.kind !== 'string' ||
      !LIBRARY_KINDS.has(entry.kind) ||
      typeof entry.bytes !== 'number'
    ) {
      return null
    }
    return { libraryId: payload.libraryId, entry: entry as unknown as AssetLibraryFile }
  } catch {
    return null
  }
}

/**
 * ASSET_IDS_MIME 载荷：画布卡片 id 数组（批量引用/批量移动）。
 * 数组内每项都必须是非空字符串，任一不符整体判 null（半批引用比拒绝更危险）。
 * 空数组是合法形状（返回 []）：输入框整批通道命中后不回退单卡通道，语义由调用方决定。
 */
export function parseAssetIdsPayload(dt: DataTransfer): string[] | null {
  const raw = dt.getData(ASSET_IDS_MIME)
  if (!raw) return null
  try {
    const ids = JSON.parse(raw) as unknown
    if (!Array.isArray(ids) || !ids.every((id) => nonEmptyString(id))) return null
    return ids as string[]
  } catch {
    return null
  }
}

/**
 * 遗留单卡通道载荷：节点 id 字符串（生成卡加参考 / 输入框单卡注入还在用）。
 * getData 未命中或空串都返回 null。
 */
export function parseLegacyAssetPayload(dt: DataTransfer): string | null {
  const raw = dt.getData(LEGACY_ASSET_MIME)
  return nonEmptyString(raw) ? raw : null
}
