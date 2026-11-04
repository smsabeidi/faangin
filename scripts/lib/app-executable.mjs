import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const electronBinary = () => createRequire(import.meta.url)('electron')
// What electron-builder's unpacked output holds per platform: dist/win-unpacked/Faangin.exe, dist/mac-arm64/Faangin.app.
const unpackedExecutable = { win32: ['Faangin.exe'], darwin: ['Faangin.app', 'Contents', 'MacOS', 'Faangin'] }

/**
 * Turns FAANGIN_APP_PATH into the binary a harness spawns. A .app bundle and an unpacked output directory resolve
 * to the executable inside them, any file is used as given, and an empty value means the development Electron
 * binary from node_modules, so the same invocation works for source, macOS and Windows packaged runs.
 */
export function resolveAppExecutable(configuredApp, platform = process.platform, fallback = electronBinary) {
  if (!configuredApp) return fallback()
  if (configuredApp.endsWith('.app')) return join(configuredApp, 'Contents', 'MacOS', 'Faangin')
  if (!statSync(configuredApp, { throwIfNoEntry: false })?.isDirectory()) return configuredApp
  const nested = unpackedExecutable[platform]
  if (nested && existsSync(join(configuredApp, ...nested))) return join(configuredApp, ...nested)
  throw new Error(`FAANGIN_APP_PATH ${configuredApp} is a directory without ${nested ? join(...nested) : 'a Faangin executable'}; point it at the .app bundle, the unpacked output directory or the executable itself.`)
}

/** The packaged application archive next to `executable`, so QA reports can record which build they exercised. */
export function appAsarPath(executable, platform = process.platform) {
  return platform === 'darwin' ? join(dirname(dirname(executable)), 'Resources', 'app.asar') : join(dirname(executable), 'resources', 'app.asar')
}

/**
 * Signals a harness-launched app. POSIX launches are detached process-group leaders, so the group signal reaches
 * Electron's helper processes too. Windows has no signals: process.kill is TerminateProcess, which skips
 * before-quit and leaves the SQLite WAL and renderer partition unflushed, so a SIGTERM request first asks taskkill
 * to post WM_CLOSE to the app's windows; harness launches run with FAANGIN_SMOKE=1, where close is not intercepted,
 * so that drives window-all-closed and app.quit. Callers escalate to SIGKILL after their grace period.
 */
export function appProcessKill(child, signal, platform = process.platform) {
  if (!child.pid) return
  if (platform === 'win32' && signal === 'SIGTERM' && spawnSync('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).status === 0) return
  try { process.kill(platform === 'win32' ? child.pid : -child.pid, signal) } catch { child.kill(signal) }
}
