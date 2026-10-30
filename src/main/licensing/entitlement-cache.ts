/**
 * Persistent on-disk entitlement + license-token cache.
 *
 * The signed Ed25519 license token itself is wrapped with Electron's
 * safeStorage.encryptString when available. On platforms where
 * safeStorage is unavailable (sandbox tests, Linux without a keyring)
 * we transparently fall back to plain JSON and log once.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Entitlement } from '../../shared/billing-types'
import { BILLING_FILE_NAMES } from '../../shared/billing-storage'

export interface CachedEntitlement {
  entitlement: Entitlement
  licenseToken: string
  licenseExpiresAt: number
  graceUntil: number
}

/** The subset of Electron's safeStorage we rely on. */
export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export interface EntitlementCacheOptions {
  userDataPath: string
  safeStorage?: SafeStorageLike | null
  logger?: (message: string, meta?: Record<string, unknown>) => void
}

interface DiskEnvelope {
  entitlement: Entitlement
  licenseExpiresAt: number
  graceUntil: number
  /** base64 of safeStorage.encryptString output when encrypted is true. */
  licenseToken: string
  encrypted: boolean
  version: 1
  updatedAt: number
}

const PLAIN_WARN_ONCE = Symbol('entitlement-cache-plain-warn')
type WarnState = { [PLAIN_WARN_ONCE]?: boolean }

export class EntitlementCache {
  private readonly path: string
  private readonly safe: SafeStorageLike | null
  private readonly log: (message: string, meta?: Record<string, unknown>) => void
  private warn: WarnState = {}

  constructor(options: EntitlementCacheOptions) {
    this.path = join(options.userDataPath, BILLING_FILE_NAMES.entitlement)
    this.safe = options.safeStorage ?? null
    this.log = options.logger ?? (() => {})
  }

  async load(): Promise<CachedEntitlement | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      this.log('entitlement-cache.read-failed', { error: (error as Error).message })
      return null
    }
    let envelope: DiskEnvelope
    try {
      envelope = JSON.parse(raw) as DiskEnvelope
    } catch (error) {
      this.log('entitlement-cache.corrupt', { error: (error as Error).message })
      return null
    }
    if (!envelope || envelope.version !== 1 || !envelope.entitlement || !envelope.licenseToken) {
      this.log('entitlement-cache.unexpected-shape')
      return null
    }
    let licenseToken: string
    if (envelope.encrypted) {
      if (!this.safe || !this.safe.isEncryptionAvailable()) {
        this.log('entitlement-cache.cannot-decrypt-missing-safe-storage')
        return null
      }
      try {
        licenseToken = this.safe.decryptString(Buffer.from(envelope.licenseToken, 'base64'))
      } catch (error) {
        this.log('entitlement-cache.decrypt-failed', { error: (error as Error).message })
        return null
      }
    } else {
      licenseToken = envelope.licenseToken
    }
    return {
      entitlement: envelope.entitlement,
      licenseToken,
      licenseExpiresAt: envelope.licenseExpiresAt,
      graceUntil: envelope.graceUntil,
    }
  }

  async save(cached: CachedEntitlement): Promise<void> {
    let licenseToken = cached.licenseToken
    let encrypted = false
    if (this.safe && this.safe.isEncryptionAvailable()) {
      try {
        licenseToken = this.safe.encryptString(cached.licenseToken).toString('base64')
        encrypted = true
      } catch (error) {
        this.log('entitlement-cache.encrypt-failed', { error: (error as Error).message })
      }
    }
    if (!encrypted && !this.warn[PLAIN_WARN_ONCE]) {
      this.warn[PLAIN_WARN_ONCE] = true
      this.log('entitlement-cache.plain-fallback')
    }
    const envelope: DiskEnvelope = {
      entitlement: cached.entitlement,
      licenseExpiresAt: cached.licenseExpiresAt,
      graceUntil: cached.graceUntil,
      licenseToken,
      encrypted,
      version: 1,
      updatedAt: Math.floor(Date.now() / 1000),
    }
    await fs.mkdir(join(this.path, '..'), { recursive: true })
    await fs.writeFile(this.path, JSON.stringify(envelope, null, 2), 'utf8')
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.path, { force: true })
    } catch (error) {
      this.log('entitlement-cache.clear-failed', { error: (error as Error).message })
    }
  }
}

let defaultCache: EntitlementCache | null = null

export function initializeEntitlementCache(options: EntitlementCacheOptions): EntitlementCache {
  defaultCache = new EntitlementCache(options)
  return defaultCache
}

export async function loadEntitlement(): Promise<CachedEntitlement | null> {
  if (!defaultCache) return null
  return defaultCache.load()
}

export async function saveEntitlement(cached: CachedEntitlement): Promise<void> {
  if (!defaultCache) return
  await defaultCache.save(cached)
}

export async function clearEntitlement(): Promise<void> {
  if (!defaultCache) return
  await defaultCache.clear()
}
