import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
// @ts-expect-error Node executes this harness helper directly; it has no declaration file.
import { appAsarPath, appProcessKill, resolveAppExecutable } from '../scripts/lib/app-executable.mjs'

const platforms = ['darwin', 'win32']

test('an empty FAANGIN_APP_PATH means the development Electron binary', () => {
  for (const platform of platforms) {
    assert.equal(resolveAppExecutable(undefined, platform, () => 'electron-fixture'), 'electron-fixture')
    assert.equal(resolveAppExecutable('', platform, () => 'electron-fixture'), 'electron-fixture')
  }
  assert.match(resolveAppExecutable(undefined, 'darwin'), /[\\/]node_modules[\\/]electron[\\/]dist[\\/]/)
})

test('a .app bundle resolves to its MacOS binary without touching the disk', () => {
  for (const platform of platforms) assert.equal(resolveAppExecutable('/Applications/Faangin.app', platform), join('/Applications/Faangin.app', 'Contents', 'MacOS', 'Faangin'))
})

test('an unpacked output directory resolves to the executable its platform packages into it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'faangin-app-executable-'))
  try {
    const win = join(directory, 'win-unpacked'), mac = join(directory, 'mac-arm64'), empty = join(directory, 'empty')
    await mkdir(win); await writeFile(join(win, 'Faangin.exe'), 'MZ fixture')
    await mkdir(join(mac, 'Faangin.app', 'Contents', 'MacOS'), { recursive: true }); await writeFile(join(mac, 'Faangin.app', 'Contents', 'MacOS', 'Faangin'), 'fixture')
    await mkdir(empty)
    assert.equal(resolveAppExecutable(win, 'win32'), join(win, 'Faangin.exe'))
    assert.equal(resolveAppExecutable(mac, 'darwin'), join(mac, 'Faangin.app', 'Contents', 'MacOS', 'Faangin'))
    // Output packaged for the other OS cannot run here, so it is reported rather than guessed at.
    assert.throws(() => resolveAppExecutable(win, 'darwin'), /directory without Faangin\.app/)
    assert.throws(() => resolveAppExecutable(mac, 'win32'), /directory without Faangin\.exe/)
    for (const platform of [...platforms, 'linux']) assert.throws(() => resolveAppExecutable(empty, platform), /directory without/)
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('an executable path is used as given, whether or not it exists yet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'faangin-app-executable-'))
  try {
    const exe = join(directory, 'Faangin.exe'), binary = join(directory, 'Faangin')
    await writeFile(exe, 'MZ fixture'); await writeFile(binary, 'fixture')
    assert.equal(resolveAppExecutable(exe, 'win32'), exe)
    assert.equal(resolveAppExecutable(binary, 'darwin'), binary)
    for (const platform of platforms) assert.equal(resolveAppExecutable(join(directory, 'missing', 'Faangin.exe'), platform), join(directory, 'missing', 'Faangin.exe'))
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('app.asar sits beside the executable in each platform layout', () => {
  assert.equal(appAsarPath('/Applications/Faangin.app/Contents/MacOS/Faangin', 'darwin'), '/Applications/Faangin.app/Contents/Resources/app.asar')
  assert.equal(appAsarPath(join('dist', 'win-unpacked', 'Faangin.exe'), 'win32'), join('dist', 'win-unpacked', 'resources', 'app.asar'))
  assert.equal(appAsarPath(join('dist', 'linux-unpacked', 'faangin'), 'linux'), join('dist', 'linux-unpacked', 'resources', 'app.asar'))
})

test('appProcessKill ends a harness child through its group on POSIX and by pid on Windows', async () => {
  for (const platform of platforms) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: 'ignore' })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    appProcessKill(child, 'SIGTERM', platform)
    await Promise.race([exited, new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${platform} child survived SIGTERM`)), 5000))])
    assert.ok(child.exitCode !== null || child.signalCode !== null)
  }
  assert.doesNotThrow(() => appProcessKill({ pid: undefined, kill() { throw new Error('never signalled') } }, 'SIGKILL', 'darwin'))
})

test('simulate-platform.mjs reports win32 while keeping the real temp directory and host path separators', () => {
  const env = { ...process.env }
  delete env.TEMP; delete env.TMP
  const probe = 'JSON.stringify({ platform: process.platform, tmpdir: require("node:os").tmpdir(), sep: require("node:path").sep, temp: process.env.TEMP, tmp: process.env.TMP })'
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('scripts/simulate-platform.mjs')).href, '-p', probe], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines[0], 'Simulating process.platform=win32 for tests')
  const simulated = JSON.parse(lines.at(-1)!)
  assert.equal(simulated.platform, 'win32')
  assert.equal(simulated.sep, sep)
  assert.equal(simulated.tmpdir, simulated.temp)
  assert.equal(simulated.tmpdir, simulated.tmp)
  assert.doesNotMatch(simulated.tmpdir, /undefined/)
  assert.ok(existsSync(simulated.tmpdir), `${simulated.tmpdir} is the real temp directory`)
})
