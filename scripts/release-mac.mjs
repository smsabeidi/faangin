import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const project = fileURLToPath(new URL('..', import.meta.url))
const output = join(project, 'dist', 'release-mac')

// Only environment names appear in diagnostics. No password, certificate,
// private key, or provider credential is read from a file by this script.
export function validateReleaseEnvironment(env, platform = process.platform) {
  if (platform !== 'darwin') throw new Error('macOS releases require a Mac with Apple command-line tools.')
  const present = name => typeof env[name] === 'string' && env[name].trim().length > 0
  const missing = ['CSC_NAME', 'APPLE_TEAM_ID'].filter(name => !present(name))
  if (missing.length) throw new Error(`Release setup is missing ${missing.join(', ')}. Supply a real Developer ID Application identity; local dist:mac remains available.`)
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID must be the 10-character Apple Developer Team ID.')
  if (!/^.+ \([A-Z0-9]{10}\)$/.test(env.CSC_NAME) || /[\r\n\0]/.test(env.CSC_NAME) || env.CSC_NAME.startsWith('Developer ID ')) {
    throw new Error('CSC_NAME must be the Developer ID Application certificate name suffix, including (TEAMID), without the "Developer ID Application:" prefix.')
  }
  if (!env.CSC_NAME.endsWith(`(${env.APPLE_TEAM_ID})`)) throw new Error('CSC_NAME and APPLE_TEAM_ID must identify the same Developer Team.')
  if (present('CSC_LINK') && !present('CSC_KEY_PASSWORD')) throw new Error('CSC_KEY_PASSWORD is required when importing a certificate with CSC_LINK.')
  if (present('CSC_KEY_PASSWORD') && !present('CSC_LINK')) throw new Error('CSC_KEY_PASSWORD requires CSC_LINK; otherwise use an installed Keychain identity.')
  const strategies = [
    { name: 'api-key', fields: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] },
    { name: 'apple-id', fields: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD'] },
    { name: 'keychain', fields: ['APPLE_KEYCHAIN_PROFILE'] }
  ]
  const chosen = strategies.filter(strategy => strategy.fields.some(present))
  if (chosen.length !== 1) throw new Error('Configure exactly one notarization strategy: APPLE_KEYCHAIN_PROFILE; APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER; or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD. No notarization will be skipped.')
  const incomplete = chosen[0].fields.filter(name => !present(name))
  if (incomplete.length) throw new Error(`Notarization setup is missing ${incomplete.join(', ')}.`)
  if (present('APPLE_KEYCHAIN') && chosen[0].name !== 'keychain') throw new Error('APPLE_KEYCHAIN requires the APPLE_KEYCHAIN_PROFILE strategy.')
  return { notarization: chosen[0].name, importedCertificate: present('CSC_LINK') }
}

export function assertDeveloperIdSignature(description, teamId, requireRuntime = true) {
  if (!/^Authority=Developer ID Application:.+$/m.test(description)) throw new Error('Release artifact is not signed with Developer ID Application.')
  if (!description.split(/\r?\n/).includes(`TeamIdentifier=${teamId}`)) throw new Error('Release artifact was signed by a different Developer Team.')
  if (!/^Timestamp=.+$/m.test(description)) throw new Error('Release signature is missing a secure timestamp.')
  if (requireRuntime && !/^.*flags=.*\bruntime\b.*$/m.test(description)) throw new Error('Release application is missing Hardened Runtime.')
}

export function assertReleaseEntitlements(entitlements) {
  for (const name of ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input']) {
    if (entitlements[name] !== true) throw new Error(`Signed application is missing the ${name} entitlement.`)
  }
  for (const name of ['com.apple.security.get-task-allow', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-library-validation', 'com.apple.security.app-sandbox']) {
    if (entitlements[name] === true) throw new Error(`Unexpected release entitlement: ${name}.`)
  }
}

export async function writeChecksums(directory, artifacts) {
  if (artifacts.length === 0 || new Set(artifacts).size !== artifacts.length) throw new Error('Release artifact list is empty or contains duplicates.')
  const entries = await readdir(directory, { withFileTypes: true })
  const lines = []
  for (const name of [...artifacts].sort()) {
    if (name !== basename(name) || /[\r\n\0]/.test(name) || !/\.(dmg|zip)$/.test(name) || !entries.some(entry => entry.name === name && entry.isFile())) {
      throw new Error('Checksum input must be a regular DMG or ZIP in the release directory.')
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk)
    lines.push(`${hash.digest('hex')}  ${name}`)
  }
  await writeFile(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o644 })
}

export async function removeUpdateMetadata(directory) {
  // There is no updater in this product. Stapling the DMG and recreating the ZIP
  // invalidates builder's optional blockmaps and channel update manifests.
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() && (entry.name.endsWith('.blockmap') || /^[A-Za-z0-9-]+-mac\.ya?ml$/.test(entry.name))) {
      await rm(join(directory, entry.name), { force: true })
    }
  }
}

// Child output can include authentication diagnostics. Keep it in memory for
// verification and report only a safe stage name; never echo raw tool errors.
function run(label, executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', () => reject(new Error(`${label} could not start. Check that the required local tools are installed.`)))
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`${label} failed${code === null ? '' : ` (exit ${code})`}. No verified release was produced. Check tool availability, certificate access, Apple credential validity, and service connectivity; sensitive tool output is suppressed.`))
      resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })
    })
  })
}

async function verifyApp(app, env) {
  const { parse } = require('plist')
  const frameworks = join(app, 'Contents', 'Frameworks')
  const helpers = (await readdir(frameworks, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app')).map(entry => join(frameworks, entry.name))
  for (const bundle of [app, ...helpers]) {
    await run('Code signature verification', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], env)
    const description = await run('Code signature inspection', '/usr/bin/codesign', ['--display', '--verbose=4', bundle], env)
    assertDeveloperIdSignature(`${description.stdout}\n${description.stderr}`, env.APPLE_TEAM_ID)
    const entitlements = await run('Entitlements inspection', '/usr/bin/codesign', ['--display', '--entitlements', ':-', bundle], env)
    assertReleaseEntitlements(parse(entitlements.stdout))
  }
  await run('App stapled ticket verification', '/usr/bin/xcrun', ['stapler', 'validate', app], env)
  await run('App Gatekeeper assessment', '/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], env)
}

function notarizationOptions(strategy, appPath, env) {
  if (strategy === 'api-key') return { appPath, appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER }
  if (strategy === 'apple-id') return { appPath, appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID }
  return { appPath, keychainProfile: env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? { keychain: env.APPLE_KEYCHAIN } : {}) }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: npm run release:mac [-- --check]. This command never publishes.')
  const setup = validateReleaseEnvironment(process.env)
  // The notarization library also runs in this process and uses the debug package.
  delete process.env.DEBUG
  delete process.env.NODE_DEBUG
  const env = { ...process.env }
  // No provider key is needed for packaging. Disable potentially sensitive debug output.
  delete env.OPENAI_API_KEY
  delete env.DEBUG
  delete env.NODE_DEBUG
  await run('Apple notarytool availability check', '/usr/bin/xcrun', ['--find', 'notarytool'], env)
  await run('Apple stapler availability check', '/usr/bin/xcrun', ['--find', 'stapler'], env)
  if (setup.notarization === 'api-key') {
    try { await access(env.APPLE_API_KEY) } catch { throw new Error('APPLE_API_KEY must point to an accessible App Store Connect .p8 private-key file. Its contents were not read.') }
  }
  if (!setup.importedCertificate) {
    const identities = await run('Installed signing identity check', '/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], env)
    if (!identities.stdout.includes(`"Developer ID Application: ${env.CSC_NAME}"`)) throw new Error('The configured Developer ID Application identity is not available in Keychain. Install its certificate and private key, or supply CSC_LINK and CSC_KEY_PASSWORD.')
  }
  if (args[0] === '--check') {
    console.log('Release environment and Apple tool metadata checks passed. No build, signing, notarization, or publishing was performed. Apple credential validity still requires a real release run.')
    return
  }
  console.log('Building the production application.')
  await run('Production build', 'npm', ['run', 'build'], env)
  // Clear only this explicit release output. Unsigned dist/mac-arm64 is preserved.
  await rm(output, { recursive: true, force: true })
  console.log('Packaging, Developer ID signing, and app notarization. No publishing is enabled.')
  await run('Signed packaging and app notarization', process.execPath, [join(project, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--mac', '--arm64', '--config', 'electron-builder.release.yml', '--publish', 'never'], env)
  const app = join(output, 'mac-arm64', 'Faangin.app')
  await verifyApp(app, env)
  const { version } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error('Release version cannot be used in an artifact filename.')
  const stem = `Faangin-${version}-macOS-arm64`
  const dmg = join(output, `${stem}.dmg`), zip = join(output, `${stem}.zip`)
  await access(dmg)
  const description = await run('DMG signature inspection', '/usr/bin/codesign', ['--display', '--verbose=4', dmg], env)
  assertDeveloperIdSignature(`${description.stdout}\n${description.stderr}`, env.APPLE_TEAM_ID, false)
  console.log('Notarizing and stapling the final DMG.')
  // electron-builder notarizes the app, not its DMG. Notarize the final container
  // independently so an offline download carries its own stapled ticket.
  const { notarize } = require('@electron/notarize')
  try { await notarize(notarizationOptions(setup.notarization, dmg, env)) } catch { throw new Error('Final DMG notarization or stapling failed. Check Apple credential validity and service connectivity. Sensitive service diagnostics are suppressed; no verified release was produced.') }
  await run('DMG code signature verification', '/usr/bin/codesign', ['--verify', '--verbose=2', dmg], env)
  await run('DMG stapled ticket verification', '/usr/bin/xcrun', ['stapler', 'validate', dmg], env)
  await run('DMG Gatekeeper assessment', '/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg], env)
  // ZIP files cannot be stapled. Recreate the ZIP from the verified, stapled app,
  // then inspect the app extracted from the exact archive that will be shipped.
  await rm(zip, { force: true })
  await run('Stapled application ZIP creation', '/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], env)
  const extracted = await mkdtemp(join(tmpdir(), 'faangin-release-check-'))
  try {
    await run('Final ZIP extraction', '/usr/bin/ditto', ['-x', '-k', zip, extracted], env)
    await verifyApp(join(extracted, 'Faangin.app'), env)
  } finally { await rm(extracted, { recursive: true, force: true }) }
  await removeUpdateMetadata(output)
  await writeChecksums(output, [`${stem}.dmg`, `${stem}.zip`])
  console.log('Signed and notarized DMG/ZIP verified. SHA256SUMS is in dist/release-mac. Publishing and physical-device acceptance remain separate steps.')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(`Release stopped: ${error.message}`); process.exitCode = 1 })
}
