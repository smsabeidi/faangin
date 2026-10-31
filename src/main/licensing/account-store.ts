import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface StoredSession { uid: string; refreshToken: string }

/** OS-backed credential encryption (Electron's safeStorage), kept injectable so the store is testable. */
export interface SecretBox {
  available: () => boolean
  encrypt: (plain: string) => Buffer
  decrypt: (data: Buffer) => string
}

const SESSION_FILE = 'account-session.bin'
const LICENSE_FILE = 'license-token.txt'

/**
 * The refresh token is a credential: it is written only when the OS can encrypt it, the same rule as the saved
 * OpenAI key. The license token is signed, not secret, so it is a plain 0600 file the app verifies offline.
 */
export class AccountStore {
  constructor(private readonly options: { userDataPath: string; secrets: SecretBox }) {}

  private path(name: string): string { return join(this.options.userDataPath, name) }

  async readSession(): Promise<StoredSession | null> {
    const { secrets } = this.options
    let encrypted: Buffer
    try { encrypted = await readFile(this.path(SESSION_FILE)) } catch { return null }
    if (!secrets.available()) return null
    try {
      const value = JSON.parse(secrets.decrypt(encrypted)) as Partial<StoredSession>
      return typeof value.uid === 'string' && value.uid && typeof value.refreshToken === 'string' && value.refreshToken ? { uid: value.uid, refreshToken: value.refreshToken } : null
    } catch { return null }
  }

  async writeSession(session: StoredSession): Promise<void> {
    const { secrets } = this.options
    if (!secrets.available()) throw new Error('OS credential encryption is unavailable. Unlock your keychain and try again; you were not signed in.')
    await this.writeAtomic(SESSION_FILE, secrets.encrypt(JSON.stringify({ uid: session.uid, refreshToken: session.refreshToken })))
  }

  clearSession(): Promise<void> { return rm(this.path(SESSION_FILE), { force: true }) }

  async readLicense(): Promise<string | null> {
    try {
      const token = (await readFile(this.path(LICENSE_FILE), 'utf8')).trim()
      return token || null
    } catch { return null }
  }

  writeLicense(token: string): Promise<void> { return this.writeAtomic(LICENSE_FILE, token) }

  clearLicense(): Promise<void> { return rm(this.path(LICENSE_FILE), { force: true }) }

  private async writeAtomic(name: string, data: string | Buffer): Promise<void> {
    const target = this.path(name), temporary = `${target}.tmp`
    await mkdir(this.options.userDataPath, { recursive: true })
    try {
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, target)
      await chmod(target, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
