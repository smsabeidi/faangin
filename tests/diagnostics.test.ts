import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDiagnosticBundle, diagnosticCaptureStatus, diagnosticJSON } from '../src/main/diagnostics'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const now = 1_700_000_000_000
const metadata = () => ({
  platform: 'darwin', arch: 'arm64', versions: { app: '0.1.0', electron: '44.7.0', node: '26.7.0', chrome: '148.0.7778.2', os: '25.6.0' },
  permissions: { microphone: 'granted', screen: 'denied' }, settings: { ...DEFAULT_SETTINGS, historyEnabled: false },
  credential: { configured: false, encryptionAvailable: true }, capture: { active: false, microphone: 'Off', system: 'Off' },
  capabilities: { microphone: true, systemAudio: false, screenCapture: true, osCredentialEncryption: true },
  storage: { schemaVersion: 3, issueCodes: ['deletion-checkpoint-pending'], persistentSessions: 2, ephemeralSessions: 1, trashedSessions: 0, transcriptTurns: 10, answers: 3 },
  runtime: { pendingRequests: 1, selectedImages: 2 }, timings: [{ firstTokenMs: 100, totalMs: 500 }, { firstTokenMs: 200, totalMs: 700 }], errorCodes: ['provider-timeout']
})

test('diagnostics include only useful versions, bounded health metadata, counters and measured timing', () => {
  const report = buildDiagnosticBundle(metadata(), now)
  assert.equal(report.exportedAt, new Date(now).toISOString())
  assert.equal(report.platform, 'darwin'); assert.equal(report.arch, 'arm64'); assert.equal(report.versions.electron, '44.7.0')
  assert.equal(report.chatProvider, 'openai')
  assert.deepEqual(report.permissions, { microphone: 'granted', screen: 'denied' })
  assert.equal(report.preferences.historyEnabled, false); assert.equal(report.preferences.models.fast, 'gpt-4.1-mini')
  assert.deepEqual(report.credential, { configured: false, encryptionAvailable: true })
  assert.deepEqual(report.capabilities, { microphone: true, systemAudio: false, screenCapture: true, osCredentialEncryption: true })
  assert.deepEqual(report.runtime, { pendingRequests: 1, selectedImages: 2 })
  assert.deepEqual(report.timings.firstText, { samples: 2, p50Ms: 100, p95Ms: 200, maxMs: 200 })
  assert.deepEqual(report.timings.completion, { samples: 2, p50Ms: 500, p95Ms: 700, maxMs: 700 })
  assert.deepEqual(report.errorCounts, { 'provider-timeout': 1 })
})

test('diagnostics report only the allowlisted selected chat provider without endpoints, model aliases or credentials', () => {
  const marker = 'PRIVATE_PROVIDER_MARKER', settings = { ...DEFAULT_SETTINGS, chatProvider: 'compatible', compatibleChatEndpoint: `https://${marker}.example/private-route`, compatibleChatModel: marker, compatibleChatSmartModel: marker, compatibleChatVision: true, compatibleApiKey: marker }
  const input = { ...metadata(), settings, provider: marker }
  const report = buildDiagnosticBundle(input, now), json = JSON.stringify(report)
  assert.equal(report.chatProvider, 'compatible')
  assert.equal('provider' in report, false)
  assert(!json.includes(marker)); assert(!json.includes('private-route')); assert(!json.includes('compatibleChatEndpoint'))
  for (const chatProvider of [marker, 'https://private.example', 'sk-fixture-secret', undefined, null, {}, ['compatible']]) assert.equal(buildDiagnosticBundle({ ...input, settings: { ...settings, chatProvider } }, now).chatProvider, 'unknown')
  let reads = 0
  for (const key of ['compatibleChatEndpoint', 'compatibleApiKey', 'chatProvider']) Object.defineProperty(settings, key, { enumerable: true, get() { reads++; throw new Error('Private settings getter must not execute.') } })
  assert.equal(buildDiagnosticBundle({ ...input, settings }, now).chatProvider, 'unknown')
  assert.equal(reads, 0)
})

test('personal settings, sessions, credentials, screenshots, logs, names, paths and devices are never exported', () => {
  const marker = 'PRIVATE_MARKER_NEVER_EXPORT', input = {
    ...metadata(), apiKey: `sk-fixture-${marker}`, path: `/Users/${marker}/private.sqlite`, username: marker,
    settings: { ...DEFAULT_SETTINGS, profile: marker, jobDescription: marker, instructions: marker, noteTemplate: marker, microphoneDeviceId: marker, screenshotSourceId: marker },
    credential: { configured: true, encryptionAvailable: true, plaintext: marker, ciphertext: marker },
    sessions: [{ title: marker, notes: marker, transcript: [{ text: marker }], answers: [{ text: marker, prompt: marker }], interview: { candidateAttempt: marker }, attachments: [{ name: `${marker}.png`, dataUrl: `data:image/png;base64,${marker}` }] }],
    capture: { active: true, microphone: `Device error at /Users/${marker}`, system: marker, sessionId: marker },
    storage: { ...metadata().storage, path: marker, backup: marker }, logs: [marker], rawErrors: [marker]
  }
  const json = diagnosticJSON(input, now)
  assert(!json.includes(marker)); assert(!json.includes('sk-fixture')); assert(!json.includes('data:image')); assert(!json.includes('/Users/'))
  const report = JSON.parse(json)
  assert.equal(report.credential.configured, true); assert.equal(report.capture.microphone, 'unknown')
  for (const forbidden of ['sessions', 'logs', 'rawErrors', 'username', 'apiKey', 'path']) assert.equal(report[forbidden], undefined)
})

test('malicious strings in allowlisted metadata fields become unknown rather than leaking', () => {
  const marker = 'PRIVATE_NEVER_EXPORT', source = metadata()
  const report = buildDiagnosticBundle({ ...source, platform: marker, arch: marker, versions: { app: marker, electron: `1.2.3-${marker}`, node: `/Users/${marker}`, chrome: `sk-fixture-${marker}`, os: marker }, permissions: { microphone: marker, screen: marker }, settings: { ...source.settings, fastModel: marker, smartModel: marker, transcriptionModel: marker, theme: marker }, storage: { ...source.storage, issueCodes: [marker, 'settings-corrupt', marker] }, errorCodes: [marker, marker, 'provider-auth'] }, now)
  assert(!JSON.stringify(report).includes(marker))
  assert.deepEqual(report.versions, { app: 'unknown', electron: 'unknown', node: 'unknown', chrome: 'unknown', os: 'unknown' })
  assert.deepEqual(report.storage.issueCodes, ['settings-corrupt', 'unknown'])
  assert.deepEqual(report.errorCounts, { unknown: 2, 'provider-auth': 1 })
})

test('numeric metadata rejects NaN, infinity, negatives, fractions in counters and excessive magnitudes', () => {
  const source = metadata()
  const report = buildDiagnosticBundle({ ...source, settings: { ...source.settings, fontSize: Infinity, opacity: -1, microphone: 'yes' }, storage: { schemaVersion: 1.1, persistentSessions: -1, ephemeralSessions: Infinity, answers: NaN, trashedSessions: 1e20, transcriptTurns: '3' }, runtime: { pendingRequests: 2.3, selectedImages: -1 }, timings: [{ firstTokenMs: -1, totalMs: Infinity }, { firstTokenMs: 3_600_001, totalMs: NaN }, { firstTokenMs: 1.4, totalMs: 0 }] }, now)
  assert.equal(report.preferences.fontSize, null); assert.equal(report.preferences.opacity, null); assert.equal(report.preferences.microphone, null)
  for (const [key, value] of Object.entries(report.storage)) if (key !== 'issueCodes') assert.equal(value, null)
  assert.deepEqual(report.runtime, { pendingRequests: null, selectedImages: null })
  assert.deepEqual(report.timings.firstText, { samples: 1, p50Ms: 1, p95Ms: 1, maxMs: 1 })
  assert.deepEqual(report.timings.completion, { samples: 1, p50Ms: 0, p95Ms: 0, maxMs: 0 })
})

test('diagnostic construction never evaluates getters or serializes arbitrary objects', () => {
  let reads = 0
  const input: Record<string, unknown> = { settings: {}, credential: {}, versions: {} }
  for (const [container, key] of [[input, 'sessions'], [input.settings, 'profile'], [input.credential, 'plaintext'], [input.versions, 'app'], [input, 'capture']] as [Record<string, unknown>, string][]) Object.defineProperty(container, key, { enumerable: true, get() { reads++; throw new Error('secret getter must not execute') } })
  const array = new Array(1)
  Object.defineProperty(array, '0', { get() { reads++; throw new Error('timing getter must not execute') } })
  input.timings = array
  assert.doesNotThrow(() => diagnosticJSON(input, now)); assert.equal(reads, 0)
  for (const malformed of [null, undefined, 'raw error text', [], new Date(), Object.create({ platform: 'darwin' })]) assert.equal(buildDiagnosticBundle(malformed, now).platform, 'unknown')
})

test('timing and error collections are bounded, and raw capture errors remain excluded', () => {
  const report = buildDiagnosticBundle({ ...metadata(), timings: Array.from({ length: 10_000 }, (_, i) => ({ firstTokenMs: i, totalMs: i * 2 })), errorCodes: Array(10_000).fill('provider-timeout') }, now)
  assert.equal(report.timings.firstText.samples, 1_000); assert.equal(report.timings.firstText.maxMs, 999)
  assert.equal(report.errorCounts['provider-timeout'], 100)
  for (const [value, expected] of [['Off', 'off'], ['Connecting…', 'connecting'], ['Requesting permission…', 'connecting'], ['Capturing', 'capturing'], ['Silent — check the source if speech is playing.', 'silent'], ['Paused', 'paused'], ['failed', 'failed'], ['Audio device disconnected.', 'failed'], ['Permission denied at /Users/private', 'unknown']] as const) assert.equal(diagnosticCaptureStatus(value), expected)
})

test('export timestamps are generated locally and invalid or input-supplied timestamps are rejected or ignored', () => {
  assert.equal(buildDiagnosticBundle({ exportedAt: 'private-input' }, now).exportedAt, new Date(now).toISOString())
  for (const invalid of [-1, Infinity, NaN, 1.2, 8_640_000_000_000_001]) assert.throws(() => buildDiagnosticBundle({}, invalid), /Invalid diagnostic export time/)
  assert(diagnosticJSON({}, now).endsWith('\n'))
})
