import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Entitlement } from '../src/shared/billing-types'
import { EntitlementCache, type CachedEntitlement, type SafeStorageLike } from '../src/main/licensing/entitlement-cache'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'faangin-ent-'))
}

function makeCached(): CachedEntitlement {
  const now = 1_780_000_000
  const entitlement: Entitlement = {
    uid: 'uid-1',
    plan: 'pro_yearly',
    status: 'active',
    stripeCustomerId: 'cus_1',
    currentPeriodEnd: now + 365 * 86400,
    graceUntil: now + 379 * 86400,
    devices: [],
    createdAt: now,
    updatedAt: now,
  }
  return {
    entitlement,
    licenseToken: 'header.payload.signature',
    licenseExpiresAt: now + 30 * 86400,
    graceUntil: now + 44 * 86400,
  }
}

class FakeSafeStorage implements SafeStorageLike {
  private readonly available: boolean
  constructor(available: boolean) { this.available = available }
  isEncryptionAvailable(): boolean { return this.available }
  encryptString(plain: string): Buffer { return Buffer.from('enc:' + plain, 'utf8') }
  decryptString(encrypted: Buffer): string {
    const text = encrypted.toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
    return text.slice(4)
  }
}

test('round-trips through safeStorage when available', async () => {
  const dir = makeTempDir()
  try {
    const cache = new EntitlementCache({ userDataPath: dir, safeStorage: new FakeSafeStorage(true) })
    await cache.save(makeCached())
    const loaded = await cache.load()
    assert.ok(loaded)
    assert.equal(loaded.licenseToken, 'header.payload.signature')
    assert.equal(loaded.entitlement.plan, 'pro_yearly')
    const diskRaw = await fs.readFile(join(dir, 'entitlement.json'), 'utf8')
    assert.ok(!diskRaw.includes('header.payload.signature'), 'raw file must not include plaintext when encrypted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load returns null when no file exists', async () => {
  const dir = makeTempDir()
  try {
    const cache = new EntitlementCache({ userDataPath: dir })
    assert.equal(await cache.load(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load tolerates corrupt JSON', async () => {
  const dir = makeTempDir()
  try {
    const path = join(dir, 'entitlement.json')
    await fs.writeFile(path, '{ not: valid json', 'utf8')
    const warnings: string[] = []
    const cache = new EntitlementCache({ userDataPath: dir, logger: msg => warnings.push(msg) })
    assert.equal(await cache.load(), null)
    assert.ok(warnings.some(entry => entry.includes('corrupt')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('falls back to plain JSON when safeStorage is unavailable', async () => {
  const dir = makeTempDir()
  try {
    const warnings: string[] = []
    const cache = new EntitlementCache({
      userDataPath: dir,
      safeStorage: new FakeSafeStorage(false),
      logger: msg => warnings.push(msg),
    })
    await cache.save(makeCached())
    const diskRaw = await fs.readFile(join(dir, 'entitlement.json'), 'utf8')
    assert.ok(diskRaw.includes('header.payload.signature'))
    const loaded = await cache.load()
    assert.ok(loaded)
    assert.equal(loaded.licenseToken, 'header.payload.signature')
    assert.ok(warnings.some(entry => entry.includes('plain-fallback')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clear deletes the on-disk file', async () => {
  const dir = makeTempDir()
  try {
    const cache = new EntitlementCache({ userDataPath: dir })
    await cache.save(makeCached())
    await cache.clear()
    assert.equal(await cache.load(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load returns null when encrypted blob cannot be decrypted', async () => {
  const dir = makeTempDir()
  try {
    const cache = new EntitlementCache({ userDataPath: dir, safeStorage: new FakeSafeStorage(true) })
    await cache.save(makeCached())
    // Simulate re-opening on a machine where encryption is unavailable.
    const next = new EntitlementCache({ userDataPath: dir, safeStorage: new FakeSafeStorage(false) })
    assert.equal(await next.load(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
