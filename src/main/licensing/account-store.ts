import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface StoredSession { uid: string; refreshToken: string; provider?: 'supabase'; supabaseUrl?: string }
export interface StoredGoogleSignIn { verifier: string; expiresAt: number; supabaseUrl: string }

/** OS-backed credential encryption (Electron's safeStorage), kept injectable so the store is testable. */
export interface SecretBox {
  available: () => boolean
  encrypt: (plain: string) => Buffer
  decrypt: (data: Buffer) => string
}

const SESSION_FILE = 'account-session.bin'
const GOOGLE_SIGN_IN_FILE = 'google-sign-in.bin'
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
    const value = await this.readEncrypted<StoredSession>(SESSION_FILE)
    return typeof value?.uid === 'string' && value.uid && typeof value.refreshToken === 'string' && value.refreshToken ? { uid: value.uid, refreshToken: value.refreshToken, ...(value.provider === 'supabase' && typeof value.supabaseUrl === 'string' ? { provider: value.provider, supabaseUrl: value.supabaseUrl } : {}) } : null
  }

  async writeSession(session: StoredSession): Promise<void> {
    await this.writeEncrypted(SESSION_FILE, { uid: session.uid, refreshToken: session.refreshToken, provider: session.provider, supabaseUrl: session.supabaseUrl })
  }

  clearSession(): Promise<void> { return this.remove(SESSION_FILE) }

  async readGoogleSignIn(): Promise<StoredGoogleSignIn | null> {
    const value = await this.readEncrypted<StoredGoogleSignIn>(GOOGLE_SIGN_IN_FILE)
    return typeof value?.verifier === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.verifier) &&
      typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) && typeof value.supabaseUrl === 'string'
      ? { verifier: value.verifier, expiresAt: value.expiresAt, supabaseUrl: value.supabaseUrl }
      : null
  }

  writeGoogleSignIn(attempt: StoredGoogleSignIn): Promise<void> { return this.writeEncrypted(GOOGLE_SIGN_IN_FILE, attempt) }

  clearGoogleSignIn(): Promise<void> { return this.remove(GOOGLE_SIGN_IN_FILE) }

  async readLicense(): Promise<string | null> {
    try {
      const token = (await readFile(this.path(LICENSE_FILE), 'utf8')).trim()
      return token || null
    } catch { return null }
  }

  writeLicense(token: string): Promise<void> { return this.writeAtomic(LICENSE_FILE, token) }

  clearLicense(): Promise<void> { return this.remove(LICENSE_FILE) }

  private remove(name: string): Promise<void> {
    return this.retrySharingViolation(() => rm(this.path(name), { force: true }))
  }

  private async readEncrypted<T>(name: string): Promise<Partial<T> | null> {
    const { secrets } = this.options
    try {
      const encrypted = await readFile(this.path(name))
      return secrets.available() ? JSON.parse(secrets.decrypt(encrypted)) as Partial<T> : null
    } catch { return null }
  }

  private writeEncrypted(name: string, value: object): Promise<void> {
    const { secrets } = this.options
    if (!secrets.available()) throw new Error('OS credential encryption is unavailable. Unlock your system credential store and try again; you were not signed in.')
    return this.writeAtomic(name, secrets.encrypt(JSON.stringify(value)))
  }

  private async writeAtomic(name: string, data: string | Buffer): Promise<void> {
    await mkdir(this.options.userDataPath, { recursive: true })
    const staging = await mkdtemp(this.path('.account-write-'))
    const temporary = join(staging, name)
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
      await this.retrySharingViolation(() => rename(temporary, this.path(name)))
    } finally {
      // Cleanup must not turn a successfully persisted refresh token into a failed write.
      await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Brief Windows sharing violations can block both replacing and removing a saved credential. */
  private async retrySharingViolation(operation: () => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try { return await operation() } catch (error) {
        if (attempt === RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error
        await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS))
      }
    }
  }
}
