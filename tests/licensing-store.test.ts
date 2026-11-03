import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, type PathLike } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AccountStore } from '../src/main/licensing/account-store'
import { DeviceIdentity } from '../src/main/licensing/device-identity'
import { fakeSecrets } from './licensing-support'

/** The store looks `rename` up on the real module at call time, so mocking it here stands in for a Windows sharing violation. */
const fsPromises = createRequire(resolve('package.json'))('node:fs/promises') as typeof import('node:fs/promises')

function directory(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'faangin-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return dir
}
/** NTFS has no POSIX mode bits (libuv reports 0o666) and the per-user %APPDATA% ACL is the protection there, so Windows only checks the file is ours to write. */
function assertOwnerOnly(path: string): void {
  const mode = statSync(path).mode & 0o777
  if (process.platform === 'win32') assert.ok(mode & 0o200, `${path} is writable`)
  else assert.equal(mode, 0o600)
}

test('the refresh token is stored encrypted, owner-only, and reads back', async t => {
  const dir = directory(t)
  const store = new AccountStore({ userDataPath: dir, secrets: fakeSecrets() })
  assert.equal(await store.readSession(), null)
  await store.writeSession({ uid: 'user-1', refreshToken: 'refresh-secret-value' })
  const path = join(dir, 'account-session.bin')
  assert.ok(!readFileSync(path).toString().includes('refresh-secret-value'), 'the credential is not stored in clear text')
  assertOwnerOnly(path)
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
  await assert.rejects(store.writeSession({ uid: 'user-1', refreshToken: 'refresh-2' }), /credential encryption is unavailable\. Unlock your system credential store/)
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
  assertOwnerOnly(join(dir, 'license-token.txt'))
  assert.equal(await store.readLicense(), 'v1.payload.signature')
  await store.clearLicense()
  assert.equal(await store.readLicense(), null)
})

test('replacing a file retries brief Windows sharing violations and surfaces persistent or unrelated failures', async t => {
  const dir = directory(t)
  const store = new AccountStore({ userDataPath: dir, secrets: fakeSecrets() })
  const realRename = fsPromises.rename
  const failing = (code: string) => Promise.reject(Object.assign(new Error(code), { code }))
  let busy = 2
  const spy = mock.method(fsPromises, 'rename', (from: PathLike, to: PathLike) => busy-- > 0 ? failing('EBUSY') : realRename(from, to))
  t.after(() => spy.mock.restore())
  await store.writeLicense('v1.first.signature')
  assert.equal(spy.mock.callCount(), 3, 'two sharing violations, then success')
  assert.equal(await store.readLicense(), 'v1.first.signature')
  spy.mock.mockImplementation(() => failing('EPERM'))
  await assert.rejects(store.writeLicense('v1.second.signature'), { code: 'EPERM' })
  assert.equal(spy.mock.callCount(), 3 + 5, 'a persistent violation gives up after five attempts')
  assert.equal(await store.readLicense(), 'v1.first.signature', 'the previous file is untouched')
  assert.throws(() => readFileSync(join(dir, 'license-token.txt.tmp')), /ENOENT/, 'no temporary file is left behind')
  spy.mock.mockImplementation(() => failing('EXDEV'))
  await assert.rejects(store.writeLicense('v1.third.signature'), { code: 'EXDEV' })
  assert.equal(spy.mock.callCount(), 3 + 5 + 1, 'unrelated errors are not retried')
})

test('the device id is stable, server-valid, and tied to this install and host', async t => {
  const dir = directory(t)
  const device = await new DeviceIdentity({ userDataPath: dir, hostname: () => 'Sam’s MacBook Pro' }).get()
  assert.match(device.deviceId, /^[A-Za-z0-9_-]{8,64}$/)
  assert.equal(device.deviceName, 'Sam’s MacBook Pro')
  assertOwnerOnly(join(dir, '.device-salt'))
  assert.deepEqual(await new DeviceIdentity({ userDataPath: dir, hostname: () => 'Sam’s MacBook Pro' }).get(), device, 'a restart keeps the same device')
  assert.notEqual((await new DeviceIdentity({ userDataPath: dir, hostname: () => 'Other Mac' }).get()).deviceId, device.deviceId, 'copied data on another host is a new device')
  assert.notEqual((await new DeviceIdentity({ userDataPath: directory(t), hostname: () => 'Sam’s MacBook Pro' }).get()).deviceId, device.deviceId, 'a reinstall without the salt is a new device')
})

test('device names are bounded and never empty; a short salt is replaced', async t => {
  const dir = directory(t)
  assert.equal((await new DeviceIdentity({ userDataPath: dir, hostname: () => 'x'.repeat(100) }).get()).deviceName.length, 64)
  assert.equal((await new DeviceIdentity({ userDataPath: directory(t), hostname: () => '   ' }).get()).deviceName, 'Device')
  const shortDir = directory(t)
  writeFileSync(join(shortDir, '.device-salt'), 'short')
  await new DeviceIdentity({ userDataPath: shortDir, hostname: () => 'Mac' }).get()
  assert.ok(readFileSync(join(shortDir, '.device-salt'), 'utf8').length >= 32)
})

test('an empty hostname takes the platform default device name, never the OS the tests run on', async t => {
  assert.equal((await new DeviceIdentity({ userDataPath: directory(t), hostname: () => '   ', defaultDeviceName: 'Mac' }).get()).deviceName, 'Mac')
  assert.equal((await new DeviceIdentity({ userDataPath: directory(t), hostname: () => '', defaultDeviceName: 'Windows PC' }).get()).deviceName, 'Windows PC')
  assert.equal((await new DeviceIdentity({ userDataPath: directory(t), hostname: () => 'DESKTOP-5K3J2P1', defaultDeviceName: 'Windows PC' }).get()).deviceName, 'DESKTOP-5K3J2P1', 'a real hostname always wins')
})

test('startup and sign-in share one device identity while the first salt is created', async t => {
  const dir = directory(t)
  const identity = new DeviceIdentity({ userDataPath: dir, hostname: () => 'Test Mac' })
  const devices = await Promise.all(Array.from({ length: 12 }, () => identity.get()))
  assert.equal(new Set(devices.map(device => device.deviceId)).size, 1)
  const afterRestart = await new DeviceIdentity({ userDataPath: dir, hostname: () => 'Test Mac' }).get()
  assert.deepEqual(afterRestart, devices[0])
})
