/**
 * Fetches the current Ed25519 verification key from the backend's public
 * endpoint and caches results on disk keyed by kid. The last-known-good
 * key is baked into the binary so new installs can verify tokens before
 * their first successful fetch; production builds must overwrite the
 * placeholder below before shipping.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { LicensePublicKey } from '../../shared/billing-types'
import { BILLING_FILE_NAMES, backendOrigin, joinBackend } from '../../shared/billing-storage'

// TODO(billing-integration): bake real key before shipping. These are empty
// placeholders - the on-disk cache or a successful refresh will supplant
// them before any token is verified.
export const BAKED_PUBLIC_KEYS: readonly LicensePublicKey[] = [
  {
    kid: 'dev-placeholder-v1',
    alg: 'EdDSA',
    publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  },
]

export interface KeyCacheOptions {
  userDataPath: string
  origin?: string
  fetchImpl?: typeof fetch
  nowSeconds?: () => number
}

interface PersistedCache {
  updatedAt: number
  keys: LicensePublicKey[]
}

type CacheState = {
  path: string
  origin: string
  fetchImpl: typeof fetch
  now: () => number
  keys: Map<string, LicensePublicKey>
  lastRefreshAt: number
  lastRefreshFailedAt: number
}

export class LicenseKeyCache {
  private readonly state: CacheState

  constructor(options: KeyCacheOptions) {
    this.state = {
      path: join(options.userDataPath, BILLING_FILE_NAMES.licenseKeys),
      origin: options.origin ?? backendOrigin(),
      fetchImpl: options.fetchImpl ?? ((...args) => fetch(...args)),
      now: options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
      keys: new Map(BAKED_PUBLIC_KEYS.map(key => [key.kid, key])),
      lastRefreshAt: 0,
      lastRefreshFailedAt: 0,
    }
  }

  async getPublicKey(kid: string): Promise<LicensePublicKey | null> {
    await this.loadFromDiskOnce()
    const cached = this.state.keys.get(kid)
    if (cached) return cached
    // Unknown kid - try a refresh in case the server rotated.
    const refreshed = await this.refreshPublicKeys()
    if (!refreshed) return null
    return this.state.keys.get(kid) ?? null
  }

  async refreshPublicKeys(): Promise<boolean> {
    const url = joinBackend(this.state.origin, '/public/license-key')
    try {
      const response = await this.state.fetchImpl(url)
      if (!response.ok) {
        this.state.lastRefreshFailedAt = this.state.now()
        return false
      }
      const body = await response.json() as { keys?: unknown } | LicensePublicKey
      const incoming = Array.isArray((body as { keys?: unknown }).keys)
        ? (body as { keys: unknown[] }).keys
        : [body]
      let changed = false
      for (const entry of incoming) {
        if (!isLicensePublicKey(entry)) continue
        const existing = this.state.keys.get(entry.kid)
        if (!existing || existing.publicKey !== entry.publicKey) {
          this.state.keys.set(entry.kid, entry)
          changed = true
        }
      }
      this.state.lastRefreshAt = this.state.now()
      if (changed) await this.persist()
      return true
    } catch {
      this.state.lastRefreshFailedAt = this.state.now()
      return false
    }
  }

  snapshot(): LicensePublicKey[] {
    return [...this.state.keys.values()]
  }

  private diskLoaded = false

  private async loadFromDiskOnce(): Promise<void> {
    if (this.diskLoaded) return
    this.diskLoaded = true
    try {
      const raw = await fs.readFile(this.state.path, 'utf8')
      const parsed = JSON.parse(raw) as PersistedCache
      if (!parsed || !Array.isArray(parsed.keys)) return
      for (const entry of parsed.keys) {
        if (isLicensePublicKey(entry)) this.state.keys.set(entry.kid, entry)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt cache: ignore and let the baked keys stand.
      }
    }
  }

  private async persist(): Promise<void> {
    const payload: PersistedCache = {
      updatedAt: this.state.now(),
      keys: [...this.state.keys.values()],
    }
    try {
      await fs.mkdir(join(this.state.path, '..'), { recursive: true })
      await fs.writeFile(this.state.path, JSON.stringify(payload, null, 2), 'utf8')
    } catch {
      // Non-fatal: a failed persist just means a slower cold-start next time.
    }
  }
}

export function isLicensePublicKey(value: unknown): value is LicensePublicKey {
  if (!value || typeof value !== 'object') return false
  const object = value as Record<string, unknown>
  return (
    typeof object.kid === 'string' &&
    object.alg === 'EdDSA' &&
    typeof object.publicKey === 'string'
  )
}

let defaultCache: LicenseKeyCache | null = null

export function initializeLicenseKeyCache(options: KeyCacheOptions): LicenseKeyCache {
  defaultCache = new LicenseKeyCache(options)
  return defaultCache
}

export async function getPublicKey(kid: string): Promise<LicensePublicKey | null> {
  if (!defaultCache) return null
  return defaultCache.getPublicKey(kid)
}

export async function refreshPublicKeys(): Promise<void> {
  if (!defaultCache) return
  await defaultCache.refreshPublicKeys()
}
