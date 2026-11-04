import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createAccountService, type AccountUser } from '../account-service.ts'
import { ServiceError } from '../errors.ts'
import { verifyLicense } from '../license.ts'
import type { AccountStore, DeviceClaim } from '../store.ts'
const uid = '0d08fe00-1234-4000-8000-000000000001'
function fixture() {
  let code: { userCode: string; hash: string; deviceId: string; name: string; state: string; owner?: string } | undefined
  let generated = 0, user: AccountUser = { id: uid, email: 'buyer@example.test', emailVerified: true }, generatedUid = uid, consume = true
  const keys = generateKeyPairSync('ed25519')
  const store: AccountStore = {
    async startDevice(userCode, hash, deviceId, name) { code = { userCode, hash, deviceId, name, state: 'pending' }; return { expiresAt: Date.now() + 600_000 } },
    async approveDevice(userCode) {
      if (!code || code.userCode !== userCode) throw new ServiceError('not-found', 'Unknown code')
      if (code.state !== 'pending') throw new ServiceError('failed-precondition', 'Already approved')
      code.state = 'approved'; return code.name
    },
    async claimDevice(hash, owner): Promise<DeviceClaim> {
      if (!code || code.hash !== hash) return { status: 'expired' }
      if (code.state !== 'approved') return { status: 'pending' }
      code.state = 'exchanging'; code.owner = owner
      return { status: 'claimed', uid, deviceId: code.deviceId, deviceName: code.name }
    },
    async completeDevice(hash, owner) { if (!consume || !code || code.hash !== hash || code.owner !== owner) return false; code = undefined; return true },
    async releaseDevice(hash, owner) { if (code?.hash === hash && code.owner === owner) code.state = 'approved' },
    async touchDevice() { return { document: { plan: 'byok', status: 'active', updatedAt: 0 }, version: 1, now: 1_800_000_000_000 } }
  }
  const service = createAccountService({ store, auth: { async getUserById() { return user }, async generateMagicLink() { generated++; await new Promise(resolve => setImmediate(resolve)); return { tokenHash: 'fixture-token-hash', uid: generatedUid } } }, signingKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), activationUrl: 'http://127.0.0.1:45321/activate', owner: randomUUID })
  return { service, stored: () => code, generated: () => generated, setUser: (value: AccountUser) => user = value, changeGeneratedUid: () => generatedUid = randomUUID(), loseClaim: () => consume = false, publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
}
test('device start stores only a proof hash; concurrent approved polls generate and return exactly one token hash', async () => {
  const f = fixture(), device = { deviceId: 'mac-device-001', deviceName: 'Test Mac' }
  const started = await f.service.start(device)
  assert.equal(f.stored()?.hash, createHash('sha256').update(started.deviceCode).digest('hex'))
  assert.notEqual(f.stored()?.hash, started.deviceCode)
  assert.equal(new URL(started.verificationUrl).searchParams.get('code'), started.userCode)
  await f.service.approve(uid, { userCode: started.userCode.toLowerCase() })
  const polls = await Promise.all(Array.from({ length: 8 }, () => f.service.poll({ deviceCode: started.deviceCode })))
  assert.equal(polls.filter(poll => poll.status === 'approved').length, 1)
  assert.equal(f.generated(), 1)
  assert.deepEqual(await f.service.poll({ deviceCode: started.deviceCode }), { status: 'expired' })
})
test('changed identity, unverified email or a lost consumption fence never returns a sign-in hash', async () => {
  for (const failure of ['identity', 'email', 'fence']) {
    const f = fixture(), started = await f.service.start({ deviceId: 'mac-device-002', deviceName: 'Mac' })
    await f.service.approve(uid, { userCode: started.userCode })
    if (failure === 'identity') f.changeGeneratedUid()
    if (failure === 'email') f.setUser({ id: uid, email: 'unverified@example.test', emailVerified: false })
    if (failure === 'fence') { f.loseClaim(); assert.deepEqual(await f.service.poll({ deviceCode: started.deviceCode }), { status: 'expired' }) }
    else await assert.rejects(f.service.poll({ deviceCode: started.deviceCode }), ServiceError)
    if (failure === 'email') assert.equal(f.generated(), 0)
  }
})
test('issued license keeps the existing offline signature/device contract and database-issued time', async () => {
  const f = fixture(), result = await f.service.issueLicense(uid, { deviceId: 'mac-license-01', deviceName: 'Mac' })
  const license = verifyLicense(result.token, f.publicKey)
  assert.ok(license)
  assert.equal(license.uid, uid); assert.equal(license.deviceId, 'mac-license-01'); assert.equal(license.iat, 1_800_000_000_000)
  assert.equal(license.exp - license.iat, 30 * 86_400_000); assert.equal(license.grace - license.exp, 14 * 86_400_000)
})
