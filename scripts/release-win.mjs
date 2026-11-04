import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const output = join(project, 'dist', 'release-win')
const releaseConfig = 'electron-builder.release-win.yml'
const strategies = [
  { name: 'certificate', fields: ['CSC_LINK', 'CSC_KEY_PASSWORD'] },
  { name: 'azure', fields: ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_CODE_SIGNING_ENDPOINT', 'AZURE_CODE_SIGNING_ACCOUNT_NAME', 'AZURE_CERTIFICATE_PROFILE_NAME'] }
]

// Only environment names appear in diagnostics. No password, certificate,
// private key, or provider credential is read from a file by this script.
export function validateReleaseEnvironment(env, platform = process.platform) {
  if (platform !== 'win32') throw new Error('Windows releases require a Windows host with the Windows SDK signing tools (signtool).')
  const present = name => typeof env[name] === 'string' && env[name].trim().length > 0
  const chosen = strategies.filter(strategy => strategy.fields.some(present))
  if (chosen.length !== 1) throw new Error('Configure exactly one signing strategy: CSC_LINK + CSC_KEY_PASSWORD for a .pfx certificate, or Azure Trusted Signing with AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET + AZURE_CODE_SIGNING_ENDPOINT + AZURE_CODE_SIGNING_ACCOUNT_NAME + AZURE_CERTIFICATE_PROFILE_NAME. Local dist:win remains unsigned.')
  const incomplete = chosen[0].fields.filter(name => !present(name))
  if (incomplete.length) throw new Error(`Signing setup is missing ${incomplete.join(', ')}.`)
  if (chosen[0].name === 'azure') {
    let endpoint
    try { endpoint = new URL(env.AZURE_CODE_SIGNING_ENDPOINT) } catch { throw new Error('AZURE_CODE_SIGNING_ENDPOINT must be the HTTPS Trusted Signing endpoint of the account region.') }
    if (endpoint.protocol !== 'https:') throw new Error('AZURE_CODE_SIGNING_ENDPOINT must be the HTTPS Trusted Signing endpoint of the account region.')
  }
  return { signing: chosen[0].name }
}

export function assertAuthenticodeSignature(report) {
  if (!/^Successfully verified: .+$/m.test(report)) throw new Error('Release artifact failed Authenticode verification (signtool verify /pa).')
  if (!/^The signature is timestamped: .+$/m.test(report)) throw new Error('Release signature is missing a secure timestamp.')
}

export async function writeChecksums(directory, artifacts) {
  if (artifacts.length === 0 || new Set(artifacts).size !== artifacts.length) throw new Error('Release artifact list is empty or contains duplicates.')
  const entries = await readdir(directory, { withFileTypes: true })
  const lines = []
  for (const name of [...artifacts].sort()) {
    if (name !== basename(name) || /[\r\n\0]/.test(name) || !/\.exe$/.test(name) || !entries.some(entry => entry.name === name && entry.isFile())) {
      throw new Error('Checksum input must be a regular EXE installer in the release directory.')
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk)
    lines.push(`${hash.digest('hex')}  ${name}`)
  }
  await writeFile(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o644 })
}

export async function removeUpdateMetadata(directory) {
  // There is no updater in this product. Builder's optional blockmaps and channel
  // manifests (latest.yml, beta.yml, ...) would only advertise a feed that never exists.
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const channelManifest = /^[A-Za-z0-9-]+\.ya?ml$/.test(entry.name) && entry.name !== 'builder-effective-config.yaml'
    if (!entry.isDirectory() && (entry.name.endsWith('.blockmap') || channelManifest)) await rm(join(directory, entry.name), { force: true })
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
      if (code !== 0) return reject(new Error(`${label} failed${code === null ? '' : ` (exit ${code})`}. No verified release was produced. Check tool availability, certificate access, signing credential validity, and service connectivity; sensitive tool output is suppressed.`))
      resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })
    })
  })
}

// signtool ships with the Windows SDK and is rarely on PATH; the newest installed kit wins. process.env is read
// directly because Windows variable names are case-insensitive only there, not in a spread copy ("Path" vs "PATH").
async function locateSigntool() {
  const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, 'signtool.exe'))
  const kits = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  try {
    const versions = (await readdir(kits)).filter(name => /^10\.\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    candidates.push(...versions.map(version => join(kits, version, 'x64', 'signtool.exe')))
  } catch {}
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch {}
  }
  throw new Error('signtool.exe was not found on PATH or in a Windows 10/11 SDK. Install the "Windows SDK Signing Tools for Desktop Apps" component.')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: npm run release:win [-- --check]. This command never publishes.')
  const setup = validateReleaseEnvironment(process.env)
  const env = { ...process.env }
  // No provider key is needed for packaging. Disable potentially sensitive debug output.
  delete env.OPENAI_API_KEY
  delete env.DEBUG
  delete env.NODE_DEBUG
  const signtool = await locateSigntool()
  if (args[0] === '--check') {
    console.log('Release environment and signtool availability checks passed. No build, signing, or publishing was performed. Certificate validity still requires a real release run.')
    return
  }
  console.log('Building the production application.')
  // npm resolves to npm.cmd on Windows and Node refuses to spawn .cmd files without a shell, so the
  // build goes through npm's JavaScript entry point: the running npm under `npm run`, else the bundled one.
  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  await run('Production build', process.execPath, [npmCli, 'run', 'build'], env)
  // Clear only this explicit release output. Unsigned dist/win-unpacked is preserved.
  await rm(output, { recursive: true, force: true })
  console.log('Packaging and Authenticode signing. No publishing is enabled.')
  // The release config carries the certificate strategy; Azure Trusted Signing is enabled per run so the
  // config file never names an account, and the TrustedSigning module reads AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET itself.
  // Its required publisherName is the certificate subject the config already declares for signtool, read rather than repeated.
  const { win: { signtoolOptions: { publisherName } } } = createRequire(import.meta.url)('js-yaml').load(await readFile(join(project, releaseConfig), 'utf8'))
  const azure = setup.signing === 'azure' ? [
    `-c.win.azureSignOptions.endpoint=${env.AZURE_CODE_SIGNING_ENDPOINT}`,
    `-c.win.azureSignOptions.codeSigningAccountName=${env.AZURE_CODE_SIGNING_ACCOUNT_NAME}`,
    `-c.win.azureSignOptions.certificateProfileName=${env.AZURE_CERTIFICATE_PROFILE_NAME}`,
    `-c.win.azureSignOptions.publisherName=${publisherName}`
  ] : []
  await run('Signed packaging', process.execPath, [join(project, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', '--x64', '--config', releaseConfig, '--publish', 'never', ...azure], env)
  const { version } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error('Release version cannot be used in an artifact filename.')
  const installer = `Faangin-${version}-Windows-x64-setup.exe`
  for (const file of [join(output, 'win-unpacked', 'Faangin.exe'), join(output, installer)]) {
    const report = await run('Authenticode verification', signtool, ['verify', '/pa', '/v', file], env)
    assertAuthenticodeSignature(`${report.stdout}\n${report.stderr}`)
  }
  await removeUpdateMetadata(output)
  await writeChecksums(output, [installer])
  console.log('Signed installer verified. SHA256SUMS is in dist/release-win. Publishing and physical-device acceptance remain separate steps.')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(`Release stopped: ${error.message}`); process.exitCode = 1 })
}
