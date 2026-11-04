import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface StoredSession { uid: string; refreshToken: string; provider?: 'supabase'; supabaseUrl?: string }

/** OS-backed credential encryption (Electron's safeStorage), kept injectable so the store is testable. */
export interface SecretBox {
  available: () => boolean
  encrypt: (plain: string) => Buffer
  decrypt: (data: Buffer) => string
}

const SESSION_FILE = 'account-session.bin'
const LICENSE_FILE = 'license-token.txt'
/** Windows refuses to replace a file another process holds open without FILE_SHARE_DELETE (Defender, Search indexer); POSIX never reports these for this call. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 40

/**
 * The refresh token is a credential: it is written only when the OS can encrypt it, the same rule as the saved
 * OpenAI key. The license token is signed, not secret, so it is a plain file the app verifies offline. Mode 0600 is
 * POSIX hardening; on Windows it is a no-op and the per-user %APPDATA% ACL keeps both files private.
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
      return typeof value.uid === 'string' && value.uid && typeof value.refreshToken === 'string' && value.refreshToken ? { uid: value.uid, refreshToken: value.refreshToken, ...(value.provider === 'supabase' && typeof value.supabaseUrl === 'string' ? { provider: value.provider, supabaseUrl: value.supabaseUrl } : {}) } : null
    } catch { return null }
  }

  async writeSession(session: StoredSession): Promise<void> {
    const { secrets } = this.options
    if (!secrets.available()) throw new Error('OS credential encryption is unavailable. Unlock your system credential store and try again; you were not signed in.')
    await this.writeAtomic(SESSION_FILE, secrets.encrypt(JSON.stringify({ uid: session.uid, refreshToken: session.refreshToken, provider: session.provider, supabaseUrl: session.supabaseUrl })))
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
      await this.replace(temporary, target)
      await chmod(target, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /** A rotated refresh token that fails to land signs the user out on the next launch, so brief sharing violations are retried rather than surfaced. */
  private async replace(temporary: string, target: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try { return await rename(temporary, target) } catch (error) {
        if (attempt === RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error
        await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS))
      }
    }
  }
}
