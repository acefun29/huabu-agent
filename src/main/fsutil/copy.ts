import { copyFile, mkdir } from 'fs/promises'
import { join } from 'path'

/** 异步复制文件到目标目录；目录不存在时先创建。 */
export async function copyIntoDir(src: string, destDir: string, destName: string): Promise<string> {
  await mkdir(destDir, { recursive: true })
  const dest = join(destDir, destName)
  await copyFile(src, dest)
  return dest
}
