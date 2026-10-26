import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Repository } from '../src/main/repository'
import { assertSystemAudioConsent, SYSTEM_AUDIO_CONSENT_MESSAGE, SYSTEM_AUDIO_NOTICE_VERSION, systemAudioConsented, systemAudioConsentReceipt } from '../src/main/system-audio-consent'
import { normalizeAccelerator, resolveShortcutBindings } from '../src/main/shortcut-manager'
import { settingsPatch } from '../src/main/validation'
import { DEFAULT_SETTINGS } from '../src/shared/types'

function databaseFixture(run: (file: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'faangin-posture-'))
  try { run(join(directory, 'workspace.sqlite')) } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('screen-share hiding stays off and the Dock icon stays visible by default', () => {
  assert.equal(DEFAULT_SETTINGS.privacyMode, false)
  assert.equal(DEFAULT_SETTINGS.hideDockIcon, false)
})

test('listening to computer audio requires an acknowledgment of the current notice', () => {
  assert.throws(() => assertSystemAudioConsent(true, false), new RegExp(SYSTEM_AUDIO_CONSENT_MESSAGE))
  assert.doesNotThrow(() => assertSystemAudioConsent(true, true))
  assert.doesNotThrow(() => assertSystemAudioConsent(false, false))
  assert.equal(systemAudioConsented(systemAudioConsentReceipt(1_000)), true)
  for (const receipt of [undefined, null, 'yes', {}, { version: SYSTEM_AUDIO_NOTICE_VERSION }, { version: SYSTEM_AUDIO_NOTICE_VERSION + 1, acknowledgedAt: 1 }, { version: SYSTEM_AUDIO_NOTICE_VERSION, acknowledgedAt: 0 }, { version: SYSTEM_AUDIO_NOTICE_VERSION, acknowledgedAt: Number.NaN }]) {
    assert.equal(systemAudioConsented(receipt), false)
  }
})

test('the computer audio acknowledgment survives a restart even with session history off', () => {
  databaseFixture(file => {
    let repo = new Repository(file)
    try {
      repo.saveSettings({ ...repo.settings(), historyEnabled: false })
      assert.equal(systemAudioConsented(repo.configuration('system-audio-consent')), false)
      repo.saveConfiguration('system-audio-consent', systemAudioConsentReceipt())
      repo.close(); repo = new Repository(file)
      assert.equal(systemAudioConsented(repo.configuration('system-audio-consent')), true)
      assert.equal(repo.settings().historyEnabled, false)
    } finally { repo.close() }
  })
})

test('a saved settings row that names a retired keymap keeps every other preference', () => {
  databaseFixture(file => {
    let repo = new Repository(file)
    repo.saveSettings({ ...DEFAULT_SETTINGS, fontSize: 17, historyEnabled: true, privacyMode: true })
    repo.close()
    const raw = new DatabaseSync(file)
    try {
      const row = raw.prepare('SELECT json FROM settings WHERE id=1').get() as { json: string }
      raw.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify({ ...JSON.parse(row.json), shortcutPreset: 'interviewcoder' }))
    } finally { raw.close() }
    repo = new Repository(file)
    try {
      const settings = repo.settings()
      assert.equal(settings.shortcutPreset, 'faangin')
      assert.equal(settings.fontSize, 17); assert.equal(settings.historyEnabled, true); assert.equal(settings.privacyMode, true)
      assert.deepEqual(repo.diagnostics().issueCodes, [])
    } finally { repo.close() }
  })
})

test('a custom key from a retired keymap keeps its action and turns off the Faangin default it collides with', () => {
  const key = normalizeAccelerator('CommandOrControl+Shift+S')
  const patch = settingsPatch({ shortcutPreset: 'interviewcoder', shortcutOverrides: { assist: 'CommandOrControl+Shift+S' } })
  assert.equal(patch.shortcutPreset, 'faangin')
  assert.deepEqual(patch.shortcutOverrides, { assist: key, screenshot: null })
  const bindings = resolveShortcutBindings('faangin', patch.shortcutOverrides)
  assert.equal(new Set(bindings.map(binding => binding.accelerator)).size, bindings.length)
  assert.equal(bindings.find(binding => binding.action === 'assist')?.accelerator, key)
  assert.deepEqual(settingsPatch({ shortcutPreset: 'faangin', shortcutOverrides: { assist: 'CommandOrControl+Shift+S' } }).shortcutOverrides, { assist: key })
})

test('the configuration warning stays until every unreadable record has been rewritten', () => {
  databaseFixture(file => {
    let repo = new Repository(file)
    repo.saveConfiguration('preset-catalog', { version: 1 }); repo.saveConfiguration('system-audio-consent', systemAudioConsentReceipt())
    repo.close()
    const raw = new DatabaseSync(file)
    try { raw.prepare("UPDATE configuration SET json='{' WHERE name IN ('preset-catalog','system-audio-consent')").run() } finally { raw.close() }
    repo = new Repository(file)
    try {
      for (const name of ['preset-catalog', 'system-audio-consent'] as const) assert.throws(() => repo.configuration(name), /unreadable/)
      repo.saveConfiguration('system-audio-consent', systemAudioConsentReceipt())
      assert.deepEqual(repo.diagnostics().issueCodes, ['configuration-corrupt'])
      repo.saveConfiguration('preset-catalog', { version: 1 })
      assert.deepEqual(repo.diagnostics().issueCodes, [])
    } finally { repo.close() }
  })
})
