import { readFile } from 'fs/promises'

/**
 * 网关适配器共用的参考图（垫图/首帧）装载工具。
 *
 * 从队列网关适配器抽出：本地图片文件 → base64 data URI，是各家「image_url/image 类
 * 参数吃公网 URL 或 base64」形态里唯一离线可用的官方支持形态；超出大小上限或
 * 读取失败的参考图跳过（不阻塞纯文生生成的提交）。
 *
 * 用 fs/promises 异步读取：参考图可达 12MB，同步 readFileSync 会把主进程卡住
 * 「读盘 + base64 编码」整段时间，await 让出事件循环不阻塞别的任务。
 */

/** 参考图列表里第一个图片文件 → base64 data URI；没有图片参考或读取失败返回 undefined */
export async function firstImageRefDataUri(refFiles?: string[]): Promise<string | undefined> {
  for (const file of refFiles ?? []) {
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
    const mime = EXT_MIME[ext]
    if (!mime) continue
    try {
      const bytes = await readFile(file)
      if (bytes.byteLength === 0 || bytes.byteLength > 12 * 1024 * 1024) continue
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      continue
    }
  }
  return undefined
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}
