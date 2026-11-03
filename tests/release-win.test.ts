import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Node executes this release helper directly; it has no declaration file.
import * as release from '../scripts/release-win.mjs'

const certificate = { CSC_LINK: 'fixture-certificate', CSC_KEY_PASSWORD: 'fixture-password' }
const azure = { AZURE_TENANT_ID: 'fixture-tenant', AZURE_CLIENT_ID: 'fixture-client', AZURE_CLIENT_SECRET: 'fixture-client-secret', AZURE_CODE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net', AZURE_CODE_SIGNING_ACCOUNT_NAME: 'fixture-account', AZURE_CERTIFICATE_PROFILE_NAME: 'fixture-profile' }
const installer = 'Faangin-0.4.3-Windows-x64-setup.exe'
const verified = `Verifying: ${installer}\nSignature Index: 0 (Primary Signature)\nHash of file (sha256): 0123\n\nSigning Certificate Chain:\n    Issued to: Muhammed Salim\n    Issued by: Fixture CA\n    Expires:   Sat Jan 01 00:00:00 2028\n    SHA1 hash: 4567\n\nThe signature is timestamped: Tue Oct 13 12:00:00 2026\nTimestamp Verified by:\n    Issued to: Fixture Timestamp\n\nSuccessfully verified: ${installer}\n\nNumber of files successfully Verified: 1\nNumber of warnings: 0\nNumber of errors: 0\n`

test('Windows releases require a Windows host and exactly one complete signing strategy', () => {
  for (const platform of ['darwin', 'linux']) assert.throws(() => release.validateReleaseEnvironment(certificate, platform), /Windows host/)
  assert.deepEqual(release.validateReleaseEnvironment(certificate, 'win32'), { signing: 'certificate' })
  assert.deepEqual(release.validateReleaseEnvironment(azure, 'win32'), { signing: 'azure' })
  assert.throws(() => release.validateReleaseEnvironment({}, 'win32'), /exactly one signing strategy/)
  assert.throws(() => release.validateReleaseEnvironment({ ...certificate, ...azure }, 'win32'), /exactly one signing strategy/)
  assert.throws(() => release.validateReleaseEnvironment({ ...certificate, CSC_LINK: ' ' }, 'win32'), /missing CSC_LINK/)
  for (const name of Object.keys(azure)) {
    const incomplete: Record<string, string> = { ...azure }
    delete incomplete[name]
    assert.throws(() => release.validateReleaseEnvironment(incomplete, 'win32'), new RegExp(`missing ${name}`))
  }
  for (const AZURE_CODE_SIGNING_ENDPOINT of ['http://eus.codesigning.azure.net', 'eus.codesigning.azure.net']) {
    assert.throws(() => release.validateReleaseEnvironment({ ...azure, AZURE_CODE_SIGNING_ENDPOINT }, 'win32'), /HTTPS Trusted Signing endpoint/)
  }
})

test('missing production setup fails with safe variable names and never echoes a supplied secret', () => {
  const secret = 'fixture-secret-do-not-log'
  assert.throws(() => release.validateReleaseEnvironment({ CSC_KEY_PASSWORD: secret }, 'win32'), error => {
    assert.match(String(error), /missing CSC_LINK/)
    assert.doesNotMatch(String(error), new RegExp(secret))
    return true
  })
  assert.throws(() => release.validateReleaseEnvironment({ AZURE_CLIENT_SECRET: secret }, 'win32'), error => {
    assert.match(String(error), /missing AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CODE_SIGNING_ENDPOINT/)
    assert.doesNotMatch(String(error), new RegExp(secret))
    return true
  })
})

test('Authenticode verification requires a successfully verified, timestamped signtool report', () => {
  release.assertAuthenticodeSignature(verified)
  assert.throws(() => release.assertAuthenticodeSignature(verified.replace(/^Successfully verified: .*\n/m, 'SignTool Error: No signature found.\n')), /Authenticode/)
  assert.throws(() => release.assertAuthenticodeSignature(verified.replace(/^The signature is timestamped: .*\n/m, 'File is not timestamped.\n')), /secure timestamp/)
  assert.throws(() => release.assertAuthenticodeSignature(''), /Authenticode/)
})

test('checksums cover exact regular installers in deterministic order and reject unsafe inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'faangin-release-win-fixture-'))
  try {
    await writeFile(join(directory, 'b-setup.exe'), 'fixture b bytes')
    await writeFile(join(directory, 'a-setup.exe'), 'fixture a bytes')
    await release.writeChecksums(directory, ['b-setup.exe', 'a-setup.exe'])
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    assert.equal(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), `${digest('fixture a bytes')}  a-setup.exe\n${digest('fixture b bytes')}  b-setup.exe\n`)
    await writeFile(join(directory, 'fixture.zip'), 'fixture zip bytes')
    for (const unsafe of [[], ['a-setup.exe', 'a-setup.exe'], ['../a-setup.exe'], ['missing.exe'], ['SHA256SUMS'], ['fixture.zip'], ['a-setup\n.exe']]) {
      await assert.rejects(release.writeChecksums(directory, unsafe), /artifact list|regular EXE installer/)
    }
    // Windows grants symlink creation only to Developer Mode or elevated accounts; the link proves the non-regular-file rejection where it can exist.
    const linked = await symlink(join(directory, 'a-setup.exe'), join(directory, 'linked.exe')).then(() => true, error => { if (process.platform === 'win32' && error.code === 'EPERM') return false; throw error })
    if (linked) await assert.rejects(release.writeChecksums(directory, ['linked.exe']), /regular EXE installer/)
    for (const name of [`${installer}.blockmap`, 'latest.yml', 'beta.yaml', 'builder-effective-config.yaml']) await writeFile(join(directory, name), 'fixture metadata')
    await release.removeUpdateMetadata(directory)
    for (const removed of [`${installer}.blockmap`, 'latest.yml', 'beta.yaml']) await assert.rejects(readFile(join(directory, removed)), /ENOENT/)
    assert.equal(await readFile(join(directory, 'builder-effective-config.yaml'), 'utf8'), 'fixture metadata')
    assert.equal(await readFile(join(directory, 'a-setup.exe'), 'utf8'), 'fixture a bytes')
    assert.equal(await readFile(join(directory, 'b-setup.exe'), 'utf8'), 'fixture b bytes')
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('CLI preflight stops before packaging and never prints a supplied fixture password', () => {
  const secret = 'fixture-secret-do-not-log'
  // Child processes need the real environment (Windows cannot start Node without SystemRoot); only release secrets are withheld.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(APPLE_|CSC_|WIN_CSC_|AZURE_)/.test(name))), CSC_KEY_PASSWORD: secret }
  const result = spawnSync(process.execPath, ['scripts/release-win.mjs', '--check'], { cwd: process.cwd(), env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  // The child runs on the real OS: Windows fails on the incomplete certificate strategy, any other host on the platform guard.
  assert.match(result.stderr, /Release stopped: (Signing setup is missing CSC_LINK|Windows releases require a Windows host)/)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret))
  assert.doesNotMatch(result.stdout, /Building|Packaging/)
})
