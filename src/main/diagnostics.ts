/** Explicit metadata export. Never serialize AppState, session objects, or logs. */
const issues = ['settings-corrupt', 'answer-corrupt', 'interview-corrupt', 'configuration-corrupt', 'deletion-checkpoint-pending'] as const
export const DIAGNOSTIC_ERROR_CODES = ['provider-auth', 'provider-quota', 'provider-rate-limit', 'provider-unavailable', 'provider-timeout', 'capture-permission', 'capture-device', 'capture-disconnect', 'storage-busy', 'storage-full', 'save-failed', 'storage-corrupt', 'unsupported-schema', 'credential-unavailable', 'unknown'] as const
type Data = Record<string, unknown>
function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return {}
  return value as Data
}
// Access only explicit data properties. An unexpected getter must not retrieve
// a credential or run arbitrary application code during an export.
function field(value: unknown, key: string): unknown { return Object.getOwnPropertyDescriptor(object(value), key)?.value }
function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T { return typeof value === 'string' && values.includes(value as T) ? value as T : fallback }
function flag(value: unknown): boolean | null { return typeof value === 'boolean' ? value : null }
function number(value: unknown, max = 1_000_000_000): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null }
function count(value: unknown): number | null { const n = number(value); return n !== null && Number.isSafeInteger(n) ? n : null }
function version(value: unknown): string { return typeof value === 'string' && value.length <= 50 && /^\d{1,5}(?:\.\d{1,5}){1,3}(?:-(?:alpha|beta|rc)\.\d{1,5})?$/.test(value) ? value : 'unknown' }
function values(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value)) return []
  const result: unknown[] = []
  for (let i = 0; i < Math.min(value.length, limit); i++) result.push(Object.getOwnPropertyDescriptor(value, String(i))?.value)
  return result
}
function model(value: unknown): string { return choice(value, ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-live-transcribe', 'unknown'], 'unknown') }
export function diagnosticCaptureStatus(value: unknown): 'off' | 'connecting' | 'capturing' | 'silent' | 'paused' | 'failed' | 'unknown' {
  if (value === 'Off' || value === 'off') return 'off'
  if (value === 'Connecting…' || value === 'connecting' || value === 'Requesting permission…') return 'connecting'
  if (value === 'Listening' || value === 'Capturing' || value === 'capturing' || value === 'Listening…') return 'capturing'
  if (value === 'Paused' || value === 'paused') return 'paused'
  if (value === 'Silent — check the source if speech is playing.' || value === 'silent') return 'silent'
  if (value === 'failed' || value === 'Audio device disconnected.' || value === 'No audio frames — reconnect this source.' || value === 'Audio overflow — source stopped.') return 'failed'
  return 'unknown'
}
function timings(samples: unknown[], key: string): { samples: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null } {
  const measured = samples.map(sample => number(field(sample, key), 3_600_000)).filter((n): n is number => n !== null).sort((a, b) => a - b)
  const percentile = (fraction: number) => measured.length ? Math.round(measured[Math.max(0, Math.ceil(measured.length * fraction) - 1)]) : null
  return { samples: measured.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: measured.length ? Math.round(measured[measured.length - 1]) : null }
}

/**
 * Input contract: {platform,arch,versions:{app,electron,node,chrome,os},
 * permissions:{microphone,screen},settings,credential:{configured,encryptionAvailable},
 * capture:{active,microphone,system},storage:repo.diagnostics(),
 * capabilities:{microphone,systemAudio,screenCapture,osCredentialEncryption},
 * runtime:{pendingRequests,selectedImages},timings:[{firstTokenMs,totalMs}],
 * errorCodes:[DIAGNOSTIC_ERROR_CODES]}. Unknown fields and strings are excluded.
 * Existing full settings can be passed: personal fields are never accessed.
 */
export function buildDiagnosticBundle(input: unknown, exportedAt = Date.now()) {
  if (!Number.isSafeInteger(exportedAt) || exportedAt < 0 || exportedAt > 8_640_000_000_000_000) throw new Error('Invalid diagnostic export time.')
  const versions = field(input, 'versions'), settings = field(input, 'settings'), permissions = field(input, 'permissions')
  const credential = field(input, 'credential'), capture = field(input, 'capture'), storage = field(input, 'storage'), runtime = field(input, 'runtime')
  const capabilities = field(input, 'capabilities')
  const timingSamples = values(field(input, 'timings'), 1_000)
  const errorCounts: Partial<Record<typeof DIAGNOSTIC_ERROR_CODES[number], number>> = {}
  for (const value of values(field(input, 'errorCodes'), 100)) { const code = choice(value, DIAGNOSTIC_ERROR_CODES, 'unknown'); errorCounts[code] = (errorCounts[code] ?? 0) + 1 }
  return {
    format: 'faangin-diagnostics', schemaVersion: 1, exportedAt: new Date(exportedAt).toISOString(),
    platform: choice(field(input, 'platform'), ['darwin', 'win32', 'linux', 'unknown'], 'unknown'),
    arch: choice(field(input, 'arch'), ['arm64', 'x64', 'ia32', 'unknown'], 'unknown'),
    versions: { app: version(field(versions, 'app')), electron: version(field(versions, 'electron')), node: version(field(versions, 'node')), chrome: version(field(versions, 'chrome')), os: version(field(versions, 'os')) },
    chatProvider: choice(field(settings, 'chatProvider'), ['openai', 'compatible', 'unknown'], 'unknown'),
    permissions: { microphone: choice(field(permissions, 'microphone'), ['not-determined', 'granted', 'denied', 'restricted', 'unknown'], 'unknown'), screen: choice(field(permissions, 'screen'), ['not-determined', 'granted', 'denied', 'restricted', 'unknown'], 'unknown') },
    preferences: {
      theme: choice(field(settings, 'theme'), ['dark', 'light', 'system', 'unknown'], 'unknown'), opacity: number(field(settings, 'opacity'), 1), fontSize: number(field(settings, 'fontSize'), 24),
      microphone: flag(field(settings, 'microphone')), systemAudio: flag(field(settings, 'systemAudio')), privacyMode: flag(field(settings, 'privacyMode')), historyEnabled: flag(field(settings, 'historyEnabled')), includeHistory: flag(field(settings, 'includeHistory')), launchAtLogin: flag(field(settings, 'launchAtLogin')), smartMode: flag(field(settings, 'smartMode')),
      models: { fast: model(field(settings, 'fastModel')), smart: model(field(settings, 'smartModel')), transcription: model(field(settings, 'transcriptionModel')) }
    },
    credential: { configured: flag(field(credential, 'configured')), encryptionAvailable: flag(field(credential, 'encryptionAvailable')) },
    capabilities: { microphone: flag(field(capabilities, 'microphone')), systemAudio: flag(field(capabilities, 'systemAudio')), screenCapture: flag(field(capabilities, 'screenCapture')), osCredentialEncryption: flag(field(capabilities, 'osCredentialEncryption')) },
    capture: { active: flag(field(capture, 'active')), microphone: diagnosticCaptureStatus(field(capture, 'microphone')), system: diagnosticCaptureStatus(field(capture, 'system')) },
    storage: {
      schemaVersion: count(field(storage, 'schemaVersion')), issueCodes: [...new Set(values(field(storage, 'issueCodes'), 20).map(value => choice(value, [...issues, 'unknown'], 'unknown')))].sort(),
      persistentSessions: count(field(storage, 'persistentSessions')), ephemeralSessions: count(field(storage, 'ephemeralSessions')), trashedSessions: count(field(storage, 'trashedSessions')), transcriptTurns: count(field(storage, 'transcriptTurns')), answers: count(field(storage, 'answers'))
    },
    runtime: { pendingRequests: count(field(runtime, 'pendingRequests')), selectedImages: count(field(runtime, 'selectedImages')) },
    timings: { firstText: timings(timingSamples, 'firstTokenMs'), completion: timings(timingSamples, 'totalMs'), sampleLimit: 1_000 },
    errorCounts,
    contentPolicy: 'Metadata only. No credentials, session text, images, document names, device identifiers, paths, or raw errors.'
  }
}
export function diagnosticJSON(input: unknown, exportedAt = Date.now()): string { return `${JSON.stringify(buildDiagnosticBundle(input, exportedAt), null, 2)}\n` }
