import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { atomicWriteSync } from '../workspace/store'

/**
 * 工作区级加密凭据存储（M9 扩展）。
 *
 * 实现 pi-ai 的 CredentialStore 接口，直接喂给 `ModelRuntime.create({ credentials })`，
 * 因此 pi 的认证解析、getProviderAuthStatus、getAuth 全部走这一份存储，无需环境变量。
 *
 * 安全设计（开发计划 M9 审查要点：任何日志/IPC/canvas.json 不出现明文 Key）：
 * - 明文 Key 只在主进程内存中出现，经 Electron safeStorage 加密（Windows DPAPI）后落盘；
 * - 文件放在应用状态目录（userData/huabu-state/credentials/<workspaceId>.json），
 *   不写进用户工作区目录，天然不会误提交 git；
 * - 每个工作区一个文件，两个工作区互不可见；
 * - list() 只返回元数据，read() 才解密，渲染进程永远拿不到解密结果。
 */

interface CredentialFile {
  version: 1
  /** providerId -> 加密后的凭据 JSON（base64） */
  entries: Record<string, string>
}

export class SafeStorageCredentialStore implements CredentialStore {
  private readonly file: string
  private cache: CredentialFile | null = null

  private constructor(file: string) {
    this.file = file
  }

  static forWorkspace(file: string): SafeStorageCredentialStore {
    return new SafeStorageCredentialStore(file)
  }

  get path(): string {
    return this.file
  }

  private encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private load(): CredentialFile {
    if (this.cache) return this.cache
    if (!existsSync(this.file)) {
      this.cache = { version: 1, entries: {} }
      return this.cache
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as CredentialFile
      this.cache = {
        version: 1,
        entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {}
      }
    } catch (error) {
      console.warn(`[credentials] 凭据文件解析失败，按空存储处理：${String(error)}`)
      this.cache = { version: 1, entries: {} }
    }
    return this.cache
  }

  private persist(data: CredentialFile): void {
    atomicWriteSync(this.file, JSON.stringify(data, null, 2))
    this.cache = data
  }

  private decrypt(encoded: string): Credential | undefined {
    try {
      const json = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      const parsed = JSON.parse(json) as Credential
      if (parsed && (parsed.type === 'api_key' || parsed.type === 'oauth')) return parsed
      return undefined
    } catch (error) {
      console.warn('[credentials] 解密凭据失败（可能是换了系统账户）：', String(error).slice(0, 120))
      return undefined
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const encoded = this.load().entries[providerId]
    if (!encoded) return undefined
    return this.decrypt(encoded)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const entries = this.load().entries
    const out: CredentialInfo[] = []
    for (const [providerId, encoded] of Object.entries(entries)) {
      const credential = this.decrypt(encoded)
      if (credential) out.push({ providerId, type: credential.type })
    }
    return out
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    const current = await this.read(providerId)
    const next = await fn(current)
    if (next === undefined) return current
    if (!this.encryptionAvailable()) {
      throw new Error('系统不支持凭据加密存储（safeStorage 不可用），拒绝以明文保存 API Key')
    }
    const data = this.load()
    const entries = { ...data.entries }
    entries[providerId] = safeStorage.encryptString(JSON.stringify(next)).toString('base64')
    this.persist({ version: 1, entries })
    return next
  }

  async delete(providerId: string): Promise<void> {
    const data = this.load()
    if (!(providerId in data.entries)) return
    const entries = { ...data.entries }
    delete entries[providerId]
    this.persist({ version: 1, entries })
  }

  /** 诊断展示：文件是否存在与大小，不含内容 */
  describe(): string {
    if (!existsSync(this.file)) return `${this.file}（尚未创建）`
    const size = readFileSync(this.file).byteLength
    return `${this.file}（${size} 字节，密文存储）`
  }
}

/** 供测试探针验证「磁盘上为密文」：读原始文件，返回是否含有明文 key 形态的字符串 */
export function credentialFileLooksEncrypted(file: string): { exists: boolean; plaintextHit: boolean } {
  if (!existsSync(file)) return { exists: false, plaintextHit: false }
  const raw = readFileSync(file, 'utf8')
  return { exists: true, plaintextHit: /sk-[A-Za-z0-9_-]{16,}/.test(raw) }
}

/** 确保凭据目录存在（启动时预热，避免首次写入时目录不存在） */
export function ensureCredentialsDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}
