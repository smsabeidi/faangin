import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore } from '../src/main/licensing/account-store'
import { DeviceIdentity } from '../src/main/licensing/device-identity'
import { fakeSecrets } from './licensing-support'

function directory(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'faangin-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const mode = (path: string): number => statSync(path).mode & 0o777

test('the refresh token is stored encrypted, owner-only, and reads back', async t => {
  const dir = directory(t)
  const store = new AccountStore({ userDataPath: dir, secrets: fakeSecrets() })
  assert.equal(await store.readSession(), null)
  await store.writeSession({ uid: 'user-1', refreshToken: 'refresh-secret-value' })
  const path = join(dir, 'account-session.bin')
  assert.ok(!readFileSync(path).toString().includes('refresh-secret-value'), 'the credential is not stored in clear text')
  assert.equal(mode(path), 0o600)
  assert.deepEqual(await store.readSession(), { uid: 'user-1', refreshToken: 'refresh-secret-value' })
  await store.clearSession()
  assert.equal(await store.readSession(), null)
})

test('without OS encryption nothing is written, and a stored credential is not read', async t => {
  const dir = directory(t)
  const secrets = fakeSecrets({ available: true })
  const store = new AccountStore({ userDataPath: dir, secrets })
  await store.writeSession({ uid: 'user-1', refreshToken: 'refresh-1' })
  secrets.state.available = false
  assert.equal(await store.readSession(), null)
  await store.clearSession()
  await assert.rejects(store.writeSession({ uid: 'user-1', refreshToken: 'refresh-2' }), /credential encryption is unavailable/)
  assert.throws(() => readFileSync(join(dir, 'account-session.bin')), /ENOENT/)
  assert.throws(() => readFileSync(join(dir, 'account-session.bin.tmp')), /ENOENT/, 'no temporary file is left behind')
})

test('an unreadable or malformed session file reads as signed out', async t => {
  const dir = directory(t)
  const store = new AccountStore({ userDataPath: dir, secrets: fakeSecrets() })
  writeFileSync(join(dir, 'account-session.bin'), 'garbage')
  assert.equal(await store.readSession(), null)
  writeFileSync(join(dir, 'account-session.bin'), fakeSecrets().encrypt(JSON.stringify({ uid: 'user-1' })))
  assert.equal(await store.readSession(), null, 'a session without a refresh token is not a session')
})

test('the license token is a plain owner-only file that can be cleared', async t => {
  const dir = directory(t)
  const store = new AccountStore({ userDataPath: dir, secrets: fakeSecrets() })
  assert.equal(await store.readLicense(), null)
  await store.writeLicense('v1.payload.signature')
  assert.equal(readFileSync(join(dir, 'license-token.txt'), 'utf8'), 'v1.payload.signature')
  assert.equal(mode(join(dir, 'license-token.txt')), 0o600)
  assert.equal(await store.readLicense(), 'v1.payload.signature')
  await store.clearLicense()
  assert.equal(await store.readLicense(), null)
})

test('the device id is stable, server-valid, and tied to this install and host', async t => {
  const dir = directory(t)
  const device = await new DeviceIdentity({ userDataPath: dir, hostname: () => 'Sam’s MacBook Pro' }).get()
  assert.match(device.deviceId, /^[A-Za-z0-9_-]{8,64}$/)
  assert.equal(device.deviceName, 'Sam’s MacBook Pro')
  assert.equal(mode(join(dir, '.device-salt')), 0o600)
  assert.deepEqual(await new DeviceIdentity({ userDataPath: dir, hostname: () => 'Sam’s MacBook Pro' }).get(), device, 'a restart keeps the same device')
  assert.notEqual((await new DeviceIdentity({ userDataPath: dir, hostname: () => 'Other Mac' }).get()).deviceId, device.deviceId, 'copied data on another host is a new device')
  assert.notEqual((await new DeviceIdentity({ userDataPath: directory(t), hostname: () => 'Sam’s MacBook Pro' }).get()).deviceId, device.deviceId, 'a reinstall without the salt is a new device')
})

test('device names are bounded and never empty; a short salt is replaced', async t => {
  const dir = directory(t)
  assert.equal((await new DeviceIdentity({ userDataPath: dir, hostname: () => 'x'.repeat(100) }).get()).deviceName.length, 64)
  assert.equal((await new DeviceIdentity({ userDataPath: directory(t), hostname: () => '   ' }).get()).deviceName, 'Mac')
  const shortDir = directory(t)
  writeFileSync(join(shortDir, '.device-salt'), 'short')
  await new DeviceIdentity({ userDataPath: shortDir, hostname: () => 'Mac' }).get()
  assert.ok(readFileSync(join(shortDir, '.device-salt'), 'utf8').length >= 32)
})
