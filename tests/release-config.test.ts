import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { before } from 'node:test'
import { pathToFileURL } from 'node:url'
import { win32Platform } from '../src/main/platform'

const require = createRequire(resolve('package.json'))
let release: any
before(async () => { release = await import(pathToFileURL(resolve('scripts/release-mac.mjs')).href) })
const { load } = require('js-yaml')
const { parse } = require('plist')
const team = 'ABCDE12345'
const base = { CSC_NAME: `Fixture Developer (${team})`, APPLE_TEAM_ID: team }
const keychain = { ...base, APPLE_KEYCHAIN_PROFILE: 'fixture-profile' }
const description = `Authority=Developer ID Application: Fixture Developer (${team})\nTeamIdentifier=${team}\nTimestamp=Oct 11, 2026 at 12:00:00 PM\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded\n`
const nsis = { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, shortcutName: 'Faangin', deleteAppDataOnUninstall: false, runAfterFinish: true }

test('public distribution config cannot silently skip signing or alter unsigned local packaging', async () => {
  const local = load(await readFile('electron-builder.yml', 'utf8'))
  const signed = load(await readFile('electron-builder.release.yml', 'utf8'))
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(local.mac.identity, null)
  assert.equal(local.directories.output, 'dist')
  assert.equal(pkg.scripts['dist:mac'], 'npm run build && electron-builder --mac --arm64')
  assert.equal(pkg.scripts['release:mac'], 'node scripts/release-mac.mjs')
  assert.equal(signed.forceCodeSigning, true)
  assert.equal(signed.mac.identity, undefined)
  assert.equal(signed.mac.type, 'distribution')
  assert.equal(signed.mac.hardenedRuntime, true)
  assert.equal(signed.mac.strictVerify, true)
  assert.equal(signed.mac.notarize, true)
  assert.equal(signed.directories.output, 'dist/release-mac')
  assert.equal(signed.dmg.sign, true)
  assert.equal(signed.dmg.writeUpdateInfo, false)
  assert.equal(signed.publish, null)
  assert.equal(signed.appId, local.appId)
  assert.deepEqual(signed.mac.extendInfo, local.mac.extendInfo)
})

test('Windows packaging ships the committed ICO, installs per user without elevation and keeps its release config signed', async () => {
  const local = load(await readFile('electron-builder.yml', 'utf8'))
  const signed = load(await readFile('electron-builder.release-win.yml', 'utf8'))
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(local.win.icon, 'resources/icon.ico')
  await access(local.win.icon)
  // The tray icon is imported through electron-vite's ?asset from the public directory, which the bundle does not copy, so the asar must carry the file itself.
  assert.ok(local.files.includes('resources/icon.png'))
  await access('resources/icon.png')
  // Taskbar grouping and notifications key on the AppUserModelID, which must stay the installer's appId.
  assert.equal(win32Platform.appUserModelId, local.appId)
  assert.deepEqual(local.win.target, [{ target: 'nsis', arch: ['x64'] }])
  assert.equal(local.win.artifactName, 'Faangin-${version}-Windows-${arch}-setup.${ext}')
  assert.equal(local.win.requestedExecutionLevel, 'asInvoker')
  assert.deepEqual(local.win.signtoolOptions, { publisherName: 'Muhammed Salim' })
  assert.deepEqual(local.nsis, nsis)
  assert.equal(pkg.scripts['package:win'], 'npm run build && electron-builder --win --x64 --dir')
  assert.equal(pkg.scripts['dist:win'], 'npm run build && electron-builder --win --x64')
  assert.equal(pkg.scripts['release:win'], 'node scripts/release-win.mjs')
  assert.equal(pkg.scripts['test:win32'], 'node --import tsx --import ./scripts/simulate-platform.mjs --test tests/*.test.ts')
  assert.equal(signed.forceCodeSigning, true)
  assert.equal(signed.directories.output, 'dist/release-win')
  assert.equal(signed.publish, null)
  assert.equal(signed.appId, local.appId)
  assert.deepEqual(signed.files, local.files)
  assert.deepEqual(signed.win, { ...local.win, verifyUpdateCodeSignature: false })
  assert.deepEqual(signed.nsis, { ...nsis, differentialPackage: false })
})

// app-builder-lib loads its validator through jiti, which rewrites __filename to backslashes on win32 while the host's `path` stays posix.
test('local and release configurations are accepted by the installed electron-builder schema', { skip: process.env.FAANGIN_SIMULATED_PLATFORM ? `electron-builder's schema loader cannot run with process.platform simulated as ${process.env.FAANGIN_SIMULATED_PLATFORM}; the native run covers it` : false }, async () => {
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config')
  const { DebugLogger } = require('builder-util')
  for (const file of ['electron-builder.yml', 'electron-builder.release.yml', 'electron-builder.release-win.yml']) {
    const config = await getConfig(process.cwd(), resolve(file), undefined)
    await validateConfiguration(config, new DebugLogger(false))
  }
})

test('release entitlements permit modern Electron JIT and audio without broad runtime exemptions', async () => {
  const signed = load(await readFile('electron-builder.release.yml', 'utf8'))
  assert.equal(signed.mac.entitlements, 'resources/entitlements.mac.plist')
  assert.equal(signed.mac.entitlementsInherit, signed.mac.entitlements)
  const entitlements = parse(await readFile(signed.mac.entitlements, 'utf8'))
  assert.deepEqual(entitlements, { 'com.apple.security.cs.allow-jit': true, 'com.apple.security.device.audio-input': true })
  release.assertReleaseEntitlements(entitlements)
})

test('missing production setup fails with safe variable names and rejects unsupported platforms', () => {
  const secret = 'fixture-secret-do-not-log'
  assert.throws(() => release.validateReleaseEnvironment({ APPLE_APP_SPECIFIC_PASSWORD: secret }, 'darwin'), error => {
    assert.match(String(error), /CSC_NAME, APPLE_TEAM_ID/)
    assert.doesNotMatch(String(error), new RegExp(secret))
    return true
  })
  assert.throws(() => release.validateReleaseEnvironment(keychain, 'linux'), /require a Mac/)
})

test('signing setup rejects ad-hoc identities, malformed names and mismatched teams', () => {
  for (const CSC_NAME of ['-', 'Developer ID Application: Fixture Developer (ABCDE12345)', 'Fixture Developer', 'Fixture Developer (ZZZZZ12345)', 'Fixture\nDeveloper (ABCDE12345)']) {
    assert.throws(() => release.validateReleaseEnvironment({ ...keychain, CSC_NAME }, 'darwin'), /CSC_NAME/)
  }
  assert.throws(() => release.validateReleaseEnvironment({ ...keychain, APPLE_TEAM_ID: 'bad' }, 'darwin'), /10-character/)
})

test('all three notarization strategies pass presence checks without using their secrets', () => {
  assert.deepEqual(release.validateReleaseEnvironment(keychain, 'darwin'), { notarization: 'keychain', importedCertificate: false })
  assert.equal(release.validateReleaseEnvironment({ ...keychain, APPLE_KEYCHAIN: '/fixture/login.keychain-db' }, 'darwin').notarization, 'keychain')
  assert.equal(release.validateReleaseEnvironment({ ...base, APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-password' }, 'darwin').notarization, 'apple-id')
  assert.equal(release.validateReleaseEnvironment({ ...base, APPLE_API_KEY: '/fixture/key.p8', APPLE_API_KEY_ID: 'fixture-id', APPLE_API_ISSUER: 'fixture-issuer' }, 'darwin').notarization, 'api-key')
})

test('incomplete, ambiguous and orphaned notarization credentials cannot cause a skipped step', () => {
  for (const incomplete of [{}, { APPLE_ID: 'fixture@example.invalid' }, { APPLE_API_KEY: '/fixture/key.p8' }, { APPLE_API_KEY_ID: 'fixture-id', APPLE_API_ISSUER: 'fixture-issuer' }, { APPLE_KEYCHAIN: '/fixture/login.keychain-db' }]) {
    assert.throws(() => release.validateReleaseEnvironment({ ...base, ...incomplete }, 'darwin'), /notarization strategy|missing|notarization strategies|Notarization setup/)
  }
  assert.throws(() => release.validateReleaseEnvironment({ ...keychain, APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-password' }, 'darwin'), /exactly one/)
  assert.throws(() => release.validateReleaseEnvironment({ ...base, APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-password', APPLE_KEYCHAIN: '/fixture/keychain' }, 'darwin'), /APPLE_KEYCHAIN requires/)
})

test('imported certificates require a password and password-only setup is rejected', () => {
  assert.throws(() => release.validateReleaseEnvironment({ ...keychain, CSC_LINK: 'fixture-certificate' }, 'darwin'), /CSC_KEY_PASSWORD/)
  assert.throws(() => release.validateReleaseEnvironment({ ...keychain, CSC_KEY_PASSWORD: 'fixture-password' }, 'darwin'), /CSC_KEY_PASSWORD requires CSC_LINK/)
  assert.equal(release.validateReleaseEnvironment({ ...keychain, CSC_LINK: 'fixture-certificate', CSC_KEY_PASSWORD: 'fixture-password' }, 'darwin').importedCertificate, true)
})

test('artifact verification requires Developer ID, the expected team, timestamp and runtime', () => {
  release.assertDeveloperIdSignature(description, team)
  assert.throws(() => release.assertDeveloperIdSignature(description.replace('Developer ID Application:', 'Apple Development:'), team), /Developer ID Application/)
  assert.throws(() => release.assertDeveloperIdSignature(description, 'ZZZZZ12345'), /different Developer Team/)
  assert.throws(() => release.assertDeveloperIdSignature(description.replace(/^Timestamp=.*\n/m, ''), team), /secure timestamp/)
  const noRuntime = description.replace('flags=0x10000(runtime)', 'flags=0x0(none)')
  assert.throws(() => release.assertDeveloperIdSignature(noRuntime, team), /Hardened Runtime/)
  release.assertDeveloperIdSignature(noRuntime, team, false)
})

test('signed entitlement verification rejects missing JIT/audio and permissive exceptions', () => {
  const entitlements = { 'com.apple.security.cs.allow-jit': true, 'com.apple.security.device.audio-input': true }
  for (const missing of Object.keys(entitlements)) {
    const incomplete: Record<string, boolean> = { ...entitlements }
    delete incomplete[missing]
    assert.throws(() => release.assertReleaseEntitlements(incomplete), /missing/)
  }
  for (const name of ['com.apple.security.get-task-allow', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-library-validation', 'com.apple.security.app-sandbox']) {
    assert.throws(() => release.assertReleaseEntitlements({ ...entitlements, [name]: true }), /Unexpected release entitlement/)
  }
})

test('checksums cover exact regular artifacts in deterministic order and reject unsafe inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'faangin-release-fixture-'))
  try {
    await writeFile(join(directory, 'fixture.zip'), 'fixture zip bytes')
    await writeFile(join(directory, 'fixture.dmg'), 'fixture dmg bytes')
    await release.writeChecksums(directory, ['fixture.zip', 'fixture.dmg'])
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    assert.equal(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), `${digest('fixture dmg bytes')}  fixture.dmg\n${digest('fixture zip bytes')}  fixture.zip\n`)
    for (const unsafe of [[], ['fixture.zip', 'fixture.zip'], ['../fixture.zip'], ['missing.zip'], ['SHA256SUMS'], ['fixture\n.zip']]) {
      await assert.rejects(release.writeChecksums(directory, unsafe), /artifact list|regular DMG or ZIP/)
    }
    // Windows grants symlink creation only to Developer Mode or elevated accounts; the link proves the non-regular-file rejection where it can exist.
    const linked = await symlink(join(directory, 'fixture.zip'), join(directory, 'linked.zip')).then(() => true, error => { if (process.platform === 'win32' && error.code === 'EPERM') return false; throw error })
    if (linked) await assert.rejects(release.writeChecksums(directory, ['linked.zip']), /regular DMG or ZIP/)
    for (const name of ['fixture.zip.blockmap', 'fixture.dmg.blockmap', 'latest-mac.yml', 'beta-mac.yaml', 'builder-effective-config.yaml']) await writeFile(join(directory, name), 'fixture metadata')
    await release.removeUpdateMetadata(directory)
    for (const removed of ['fixture.zip.blockmap', 'fixture.dmg.blockmap', 'latest-mac.yml', 'beta-mac.yaml']) await assert.rejects(readFile(join(directory, removed)), /ENOENT/)
    assert.equal(await readFile(join(directory, 'builder-effective-config.yaml'), 'utf8'), 'fixture metadata')
    assert.equal(await readFile(join(directory, 'fixture.zip'), 'utf8'), 'fixture zip bytes')
    assert.equal(await readFile(join(directory, 'fixture.dmg'), 'utf8'), 'fixture dmg bytes')
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('CLI preflight stops before packaging and never prints a supplied fixture password', () => {
  const secret = 'fixture-secret-do-not-log'
  // Child processes need the real environment (Windows cannot start Node without SystemRoot); only release secrets are withheld.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(APPLE_|CSC_|WIN_CSC_|AZURE_)/.test(name))), APPLE_APP_SPECIFIC_PASSWORD: secret }
  const result = spawnSync(process.execPath, ['scripts/release-mac.mjs', '--check'], { cwd: process.cwd(), env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  // The child runs on the real OS: a Mac fails on the missing identity, any other host on the platform guard.
  assert.match(result.stderr, /Release stopped: (Release setup is missing CSC_NAME, APPLE_TEAM_ID|macOS releases require a Mac)/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret))
  assert.doesNotMatch(result.stdout, /Building|Packaging|Notarizing/)
})
