import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { win32Platform } from '../src/main/platform'
import { GOOGLE_AUTH_REDIRECT } from '../src/main/licensing/auth-redirect'

const script = readFileSync(new URL('../resources/installer.nsh', import.meta.url), 'utf8')
const lines = script.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith(';'))

test('the NSIS installer registers the app link in the install scope and a full uninstall removes only its own handler and login items', () => {
  const key = `Software\\Classes\\${new URL(GOOGLE_AUTH_REDIRECT).protocol.slice(0, -1)}`
  const command = `'"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" -- "%1"'`
  assert.deepEqual(lines.map(line => line.trim()), [
    '!macro customInstall',
    `WriteRegStr SHCTX "${key}" "" "URL:Faangin"`,
    `WriteRegStr SHCTX "${key}" "URL Protocol" ""`,
    `WriteRegStr SHCTX "${key}\\shell\\open\\command" "" ${command}`,
    '!macroend',
    '!macro customUnInstall',
    '${ifNot} ${isUpdated}',
    'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${APP_ID}"',
    'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${APP_ID}"',
    `ReadRegStr $0 SHCTX "${key}\\shell\\open\\command" ""`,
    '${if} $0 == ' + command,
    `DeleteRegKey SHCTX "${key}"`,
    '${endIf}',
    '${endIf}',
    '!macroend'
  ])
})

test('the value name Electron writes for the login item is the appId the installer script calls APP_ID', () => {
  // Settings.name defaults to the AppUserModelId, and electron-builder defines APP_ID from the appId; both must be the same string.
  const appId = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8').match(/^appId: (\S+)/m)?.[1]
  assert.equal(win32Platform.appUserModelId, appId)
  assert.equal(win32Platform.appUserModelId, 'com.faangin.desktop')
})
