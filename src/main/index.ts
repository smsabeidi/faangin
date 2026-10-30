import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, safeStorage, screen, session as electronSession, shell, systemPreferences, Tray, type IpcMainInvokeEvent, type IpcMainEvent, type Session as ElectronSession } from 'electron'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { open, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Repository } from './repository'
import { AttachmentSelection } from './attachment-selection'
import { reorderSessionAttachments } from './attachment-order'
import { ScreenshotCapture } from './screenshot-capture'
import { ScreenshotRegionStore } from './screenshot-region'
import { compilePrompt } from './prompts'
import * as validate from './validation'
import { CaptureFence } from '../capture/fence'
import { createLiveTranscriber, generateAnswer, generateCompiledAnswer, verifyConfiguredModels } from './inference'
import { waitForSurface } from './surface-ready'
import { validateMicrophoneInventory } from './microphone-inventory'
import { sessionMarkdown } from './session-export'
import { PresetCatalog } from './presets'
import { durablePresetSnapshot } from './preset-persistence'
import { memoryCandidates, selectMemoryCandidates, editMemorySnippet, resolveMemorySnippets, type MemorySnippet } from './context-memory'
import { prepareMemorySelection } from './memory-selection'
import { WindowStateManager, jsonWindowStateStore, type WindowBounds, type WindowLayout } from './window-state'
import { constrainOverlayBounds, defaultOverlayBounds, overlayExpandedHeight, overlaySizeLimits, OVERLAY_LAYOUT } from './overlay-layout'
import { ShortcutManager, applyStartupShortcutBindings, resolveShortcutBindings, SHORTCUT_ACTIONS, type ShortcutBinding } from './shortcut-manager'
import { MacDockPolicy, OverlayInteractionPolicy } from './native-policy'
import { CapturePolicy } from './capture-policy'
import { CaptureLifecycle, type CaptureLease } from './capture-lifecycle'
import { LiveReplyCoordinator, type LiveReplyCandidate } from './live-replies'
import { admitsLiveReply, liveReplyTranscript } from './live-reply-context'
import { InterviewResponseDecoder } from './interview-response'
import { transcriptionContext } from './transcription-context'
import { answerReasoning } from './model-capabilities'
import { interruptionReason, shouldInterruptInterviewAnswer, shortcutGenerationInput, waitForInterruptedRequests, type InterviewInterruption } from './interview-interruptions'
import { ManualPreparationFence } from './manual-preparation'
import { CaptureSolveCoordinator, CaptureSolveImages, captureSolveConnectionIdentity } from './capture-solve'
import { capturePermissionRequestAllowed, capturePermissionCheckAllowed } from './capture-permissions'
import { requestSetupPermission, type SetupPermission } from './permission-setup'
import { AccessSetupCoordinator, ACCESS_SETUP_MESSAGE, checkSystemAudioReadiness, setupAudioPermissionAllowed, setupAudioPermissionCheckAllowed, type SystemAudioReadinessResult } from './access-setup'
import { assertSystemAudioConsent, systemAudioConsented, systemAudioConsentReceipt } from './system-audio-consent'
import { probeNativeSystemAudio } from './native-audio-probe'
import { diagnosticJSON } from './diagnostics'
import { normalizeCompatibleChatEndpoint, validateCompatibleChatConfiguration, generateCompatibleAnswer, type CompatibleChatCredential } from './compatible-chat'
import { release, tmpdir } from 'node:os'
import type { AccessPermissionKind, AccessSetupState, Action, Answer, AppEvent, AppState, Attachment, AudioChannel, CaptureCommand, MicrophoneDevice, Session, Settings, TranscriptTurn, WindowKind } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { registerBillingIpc } from './licensing/ipc'

const mainDirectory = __dirname
const smoke = process.env.FAANGIN_SMOKE === '1'
const smokeVisible = smoke && process.env.FAANGIN_QA_VISIBLE === '1'
const liveFixture = smoke && !!process.env.FAANGIN_USER_DATA_DIR && process.env.FAANGIN_SMOKE_LIVE_FIXTURE === '1'
const screenshotFixture = liveFixture && process.env.FAANGIN_SMOKE_CAPTURE_FIXTURE === '1'
const fixtureDataPath = process.env.FAANGIN_USER_DATA_DIR ? resolve(process.env.FAANGIN_USER_DATA_DIR) : ''
const ownedAccessFixture = smoke && !!fixtureDataPath && (/^\/private\/tmp\/faangin-/.test(fixtureDataPath) || /^\/tmp\/faangin-/.test(fixtureDataPath) || fixtureDataPath.startsWith(resolve(tmpdir()) + '/faangin-'))
const accessFixtureMode = ownedAccessFixture ? (process.env.FAANGIN_SMOKE_ACCESS_FIXTURE || (process.env.FAANGIN_SMOKE_ACCESS_READY === '1' ? 'ready' : '')) : ''
const accessFixtureEnabled = accessFixtureMode === 'required' || accessFixtureMode === 'ready'
const fixtureOSGranted = accessFixtureEnabled && (accessFixtureMode === 'ready' || process.env.FAANGIN_SMOKE_ACCESS_OS_GRANTED === '1')
const accessFixturePermissions = { microphone: fixtureOSGranted ? 'granted' : 'not-determined', screen: fixtureOSGranted ? 'granted' : 'not-determined' }
let accessFixtureProbeResult = 'success'
const accessTelemetry = { gateBlocks: 0, statusChecks: 0, permissionRequests: 0, systemAudioChecks: 0, backgroundAudioChecks: 0, allTracksStopped: true, activeProbeTracks: 0, probeTracksStarted: 0, probeTracksStopped: 0, captureStarts: 0, generationStarts: 0, screenCaptures: 0, cloudRequests: 0 }
if (process.env.FAANGIN_USER_DATA_DIR && smoke) app.setPath('userData', resolve(process.env.FAANGIN_USER_DATA_DIR))
app.setName('Faangin')
app.enableSandbox()
let repo: Repository, settings: Settings, workspace: BrowserWindow | null = null, overlay: BrowserWindow | null = null, captureWindow: BrowserWindow | null = null, documentWindow: BrowserWindow | null = null, tray: Tray | null = null
let currentSessionId: string | null = null, quitting = false, captureGeneration = 0
let captureState: AppState['capture'] = { active: false, sessionId: null, microphone: 'Off', system: 'Off' }
let captureStartup: AbortController | null = null
const fence = new CaptureFence()
const attachments = new Map<string, Attachment[]>()
const captureSolveImages = new CaptureSolveImages()
const attachmentSelection = new AttachmentSelection()
const partialTranscripts = new Map<string, TranscriptTurn>()
const selectedMemory = new Map<string, MemorySnippet[]>()
let presetCatalog = new PresetCatalog(), presetRecoveryRequired = false
let savedPresetSnapshot = presetCatalog.snapshot()
let windowState: WindowStateManager | null = null
let overlayWindowLayout: WindowLayout | null = null
let accessSetup: AccessSetupCoordinator
let accessSetupWindow: BrowserWindow | null = null
let accessSetupLease: { contents: Electron.WebContents; expiresAt: number } | null = null
let accessRequestPending = false
let systemAudioConsent = false
const overlayInteraction = new OverlayInteractionPolicy()
const dockPolicy = new MacDockPolicy({
  platform: process.platform,
  setActivationPolicy: policy => app.setActivationPolicy(policy),
  hide: () => app.dock!.hide(),
  show: () => app.dock!.show(),
  onError: error => emit({ type: 'error', message: `Dock visibility could not be changed: ${safeError(error)}. The Faangin menu bar menu remains available.` })
})
const shortcutManager = new ShortcutManager(smoke ? { register: () => true, unregister() {} } : globalShortcut, shortcutAction)
const capturePolicy = new CapturePolicy({ idleTimeoutMs: 0 })
let capturePolicyTimer: ReturnType<typeof setInterval> | null = null
let deviceChangeTimer: ReturnType<typeof setTimeout> | null = null
const timingSamples: Array<{ firstTokenMs?: number; totalMs?: number }> = []
const diagnosticErrors: string[] = []
let connectionTest: AbortController | null = null
let manualQuestionPreparations = 0
const manualPreparations = new ManualPreparationFence()
interface GenerationRequest { abort: AbortController; sessionId: string; epoch: number; answer: Answer; done: Promise<void>; settle(): void; terminalPublished: boolean; published: boolean }
const requests = new Map<string, GenerationRequest>()
const liveReplies = new LiveReplyCoordinator({ hooks: {
  allowed: candidate => automaticReplyAllowed(candidate),
  busy: () => requests.size > 0 || !!connectionTest || manualQuestionPreparations > 0 || captureSolve.preparing(),
  run: (candidate, signal) => new Promise<void>((resolve, reject) => {
    try {
      generate({ sessionId: candidate.turn.sessionId, action: 'reply', prompt: '', attachmentIds: [] }, {
        candidate, signal, complete: answer => answer.status === 'failed' ? reject(new Error(answer.error || 'The live suggestion failed.')) : resolve()
      })
    } catch (error) { reject(error) }
  }),
  onState: () => { if (settings) emit({ type: 'live-suggestions', state: liveSuggestionStatus() }) }
} })
type Live = Awaited<ReturnType<typeof createLiveTranscriber>>
const live = new Map<AudioChannel, Live>()
const commits = new Map<AudioChannel, number>()
const shortcuts: AppState['shortcuts'] = []
const documentJobs = new Map<string, { window: BrowserWindow; resolve: (text: string) => void; reject: (error: Error) => void }>()
let microphoneInventoryPromise: Promise<MicrophoneDevice[]> | null = null
let microphoneInventoryJob: { id: string; window: BrowserWindow; resolve: (devices: MicrophoneDevice[]) => void; reject: (error: Error) => void } | null = null
interface CapturePermissionProbe { contents: Electron.WebContents; reachedDisplayHandler: boolean; nativeAudio?: boolean; sourceEnumerationStarted: boolean; sourcesEnumerated: boolean; sourceCount: number; sourceSelected: boolean; callbackResponded: boolean; callbackGranted: boolean; sourceError?: string; requests: Array<{ permission: string; mediaTypes?: unknown }> }
let capturePermissionProbe: CapturePermissionProbe | null = null
const revokedChannels = new Set<AudioChannel>()
const capturesPerSecond = new Map<AudioChannel, { at: number; bytes: number }>()
let accessibility: AppState['accessibility'] = { reduceTransparency: false, reduceMotion: false, increaseContrast: false }
let accessibilitySubscription: number | null = null
let appearanceRefresh: NodeJS.Immediate | null = null
function userDataFile(name: string): string { return join(app.getPath('userData'), name) }
async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error(`Choose a file smaller than ${Math.round(limit / 1024 / 1024)} MB.`)
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1)); let offset = 0
    while (offset < buffer.length) { const result = await file.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead }
    if (offset > limit || offset > info.size) throw new Error('The file changed during import. Try again.')
    return buffer.subarray(0, offset)
  } finally { await file.close() }
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'The operation failed.').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1000)
}
function requireKey(): string {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('OS credential encryption is unavailable. Unlock your keychain and restart Faangin.')
  const path = userDataFile('openai.key.enc')
  if (!existsSync(path)) throw new Error('Enter your replacement OpenAI API key in Settings first.')
  try { return safeStorage.decryptString(readFileSync(path)) } catch { throw new Error('The saved key could not be decrypted. Replace it in Settings.') }
}
function keyConfigured(): boolean { return existsSync(userDataFile('openai.key.enc')) }
function compatibleCredential(endpoint: string): CompatibleChatCredential | undefined {
  const path = userDataFile('compatible-chat.key.enc')
  if (!existsSync(path)) return undefined
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Unlock OS credential storage before using the configured chat key.')
  try {
    const value = JSON.parse(safeStorage.decryptString(readFileSync(path))) as CompatibleChatCredential
    if (value.endpoint !== endpoint) throw new Error('destination-changed')
    if (typeof value.apiKey !== 'string' || !value.apiKey || value.apiKey.length > 1024 || /[\s\u0000-\u001f]/.test(value.apiKey)) throw new Error('invalid-key')
    return value
  } catch { throw new Error('The compatible chat key is unavailable or belongs to another endpoint. Replace or remove it in Settings; your OpenAI key is never reused.') }
}
function compatibleKeyConfigured(): boolean { try { return !!settings.compatibleChatEndpoint && !!compatibleCredential(settings.compatibleChatEndpoint) } catch { return false } }
function chatConfigured(): boolean { return settings.chatProvider === 'openai' ? keyConfigured() : !!settings.compatibleChatEndpoint && !!(settings.smartMode ? settings.compatibleChatSmartModel : settings.compatibleChatModel) }
function fullSession(id: string, includeDeleted = false): Session {
  const stored = repo.get(id, includeDeleted)
  const active = new Map([...requests.values()].filter(request => request.sessionId === id && request.epoch === stored.contextEpoch).map(request => [request.answer.id, request.answer]))
  return { ...stored, answers: stored.answers.map(answer => ({ ...(active.get(answer.id) ?? answer) })), attachments: (attachments.get(id) ?? []).map(image => ({ ...image })), selectedAttachmentIds: attachmentSelection.get(id), memory: structuredClone(selectedMemory.get(id) ?? []) }
}
function permissions(): AppState['permissions'] {
  if (accessFixtureEnabled) return { platform: process.platform, ...accessFixturePermissions }
  return { platform: process.platform, microphone: process.platform === 'darwin' || process.platform === 'win32' ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown', screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unknown' }
}
function accessSetupState(): AccessSetupState { return accessSetup.snapshot(permissions()) }
function accessSetupBlocked(): boolean {
  if (!accessSetupState().required) return false
  accessTelemetry.gateBlocks++
  overlayInteraction.hide()
  showWindow('workspace')
  return true
}
function requireAccessSetup(): void { if (accessSetupBlocked()) throw new Error(ACCESS_SETUP_MESSAGE) }
/** Starts from the overlay or a shortcut open the notice in the workspace, where it can be read and acknowledged. */
function requireSystemAudioConsent(sessionId: string, resume = false): void {
  try { assertSystemAudioConsent(settings.systemAudio, systemAudioConsent) }
  catch (error) { showWindow('workspace'); if (workspace) sendUI(workspace, { type: 'system-audio-consent', sessionId, resume }); throw error }
}
function refreshAccessReadiness(): AccessSetupState {
  accessTelemetry.statusChecks++
  const current = accessSetupState()
  if (current.required && (capturePolicy.state().phase !== 'idle' || overlay?.isVisible() || requests.size > 0 || captureSolve.preparing())) {
    cancelRequests()
    if (capturePolicy.state().phase !== 'idle') void stopCapture().catch(error => emit({ type: 'error', message: safeError(error) }))
    overlayInteraction.hide(); showWindow('workspace')
  }
  emitState()
  return current
}
async function openPermissionSettings(kind: AccessPermissionKind): Promise<void> {
  if (accessFixtureEnabled) return
  if (process.platform === 'darwin') await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture'}`)
  else if (process.platform === 'win32') await shell.openExternal(kind === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy')
  else throw new Error('Open your desktop system settings to configure capture permissions.')
}
async function requestComputerAudioAccess(background = false): Promise<void> {
  if (capturePolicy.state().phase !== 'idle' || captureState.active) throw new Error('Stop listening before checking computer audio access.')
  if (process.platform === 'darwin' && permissions().screen !== 'granted') throw new Error('Allow screen access first, then check computer audio.')
  accessSetup.beginAudioCheck(); accessTelemetry.systemAudioChecks++; if (background) accessTelemetry.backgroundAudioChecks++; emitState()
  let result: SystemAudioReadinessResult
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (accessFixtureEnabled) {
      const success = accessFixtureProbeResult === 'success'
      if (success) { accessTelemetry.probeTracksStarted += 2; accessTelemetry.probeTracksStopped += 2 }
      result = { verified: success, allTracksStopped: true, ...(!success ? { error: accessFixtureProbeResult === 'denied' ? 'NotAllowedError' : accessFixtureProbeResult === 'timeout' ? 'AccessTimeout' : 'NoAudioTrack' } : {}) }
    } else {
      accessSetupWindow = windowFor('capture')
      const window = accessSetupWindow
      await waitForSurface(window.webContents, new AbortController().signal, 10_000)
      accessSetupLease = { contents: window.webContents, expiresAt: Date.now() + 45_000 }
      result = await Promise.race([
        window.webContents.executeJavaScript(`(${checkSystemAudioReadiness.toString()})()`, true) as Promise<SystemAudioReadinessResult>,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { accessSetupLease = null; if (!window.isDestroyed()) window.destroy(); reject(new Error('AccessTimeout')) }, 45_000) })
      ])
    }
    accessTelemetry.allTracksStopped = result?.allTracksStopped === true
    const success = result?.verified === true && result?.allTracksStopped === true
    const denied = result.error === 'NotAllowedError' || result.error === 'PermissionDeniedError'
    const issue = success ? undefined : denied ? 'Computer audio access was not allowed. Enable Faangin in Screen & System Audio Recording, then retry the access check.' : 'Computer audio could not be verified. Check your output device and system permissions, then retry the access check.'
    accessSetup.finishAudioCheck(success, issue, denied)
    if (!success) { if (denied && !background) await openPermissionSettings('system-audio'); throw new Error(issue) }
  } catch (error) {
    if (accessSetupState().checking) accessSetup.finishAudioCheck(false, 'Computer audio access could not be checked. Retry after checking system settings.')
    throw error
  } finally {
    clearTimeout(timer); accessSetupLease = null
    if (accessSetupWindow && !accessSetupWindow.isDestroyed()) accessSetupWindow.destroy()
    accessSetupWindow = null; accessTelemetry.activeProbeTracks = 0
    emitState()
  }
}
function state(kind: WindowKind = 'workspace'): AppState {
  return { settings, accessSetup: accessSetupState(), systemAudioConsented: systemAudioConsent, accessibility: { ...accessibility }, keyConfigured: keyConfigured(), chatConfigured: chatConfigured(), compatibleKeyConfigured: compatibleKeyConfigured(), overlayClickThrough: overlayInteraction.passive, captureSolve: captureSolve.state(), permissions: permissions(), sessions: repo.list(), currentSession: currentSessionId ? fullSession(currentSessionId) : null, version: app.getVersion(), windowKind: kind, capture: { ...captureState }, liveSuggestions: liveSuggestionStatus(), shortcuts, presets: presetCatalog.snapshot(), storageWarnings: [...repo.diagnostics().issueCodes, ...(presetRecoveryRequired ? ['preset-recovery-required'] : [])] }
}
function savePresetCatalog(next: PresetCatalog): void {
  const snapshot = durablePresetSnapshot(next.snapshot(), savedPresetSnapshot, id => {
    try { const session = repo.get(id, true); return { persistent: repo.isPersistent(id), savedSnapshot: repo.hasSavedSnapshot(id), mode: session.mode } } catch { return null }
  })
  repo.saveConfiguration('preset-catalog', snapshot)
  savedPresetSnapshot = snapshot
  presetCatalog = next
}
function priorCandidates(id: string, query = '') {
  repo.get(id)
  const sessions = repo.list(query).filter(item => item.id !== id && item.persistent !== false).slice(0, 20).map(item => repo.get(item.id))
  return memoryCandidates({ currentSessionId: id, sessions, query })
}
function clearSessionAux(id: string): void {
  captureSolve.cancel(id)
  captureSolveImages.clear(id)
  screenshotCapture.invalidate(id)
  screenshotRegions.clearSession(id)
  attachments.delete(id); attachmentSelection.clear(id); selectedMemory.delete(id)
  for (const [key, turn] of partialTranscripts) if (turn.sessionId === id) partialTranscripts.delete(key)
  emit({ type: 'transcript-clear', sessionId: id })
  if (!presetRecoveryRequired) {
    const next = new PresetCatalog(presetCatalog.snapshot()); next.clearSession(id)
    try { savePresetCatalog(next) } catch (error) { presetCatalog = next; emit({ type: 'error', code: 'save-failed', message: `Session data was cleared, but its preset choice could not be saved: ${safeError(error)}` }) }
  }
}
function uiWindows(): BrowserWindow[] { return [workspace, overlay].filter((window): window is BrowserWindow => !!window && !window.isDestroyed()) }
function windowBackground(isOverlay: boolean): string {
  if (!accessibility.reduceTransparency && (isOverlay || process.platform === 'darwin')) return '#00000000'
  return nativeTheme.shouldUseDarkColors ? '#111111' : '#f5f5f7'
}
function applyWindowAppearance(window: BrowserWindow, isOverlay: boolean): void {
  window.setBackgroundColor(windowBackground(isOverlay))
  // Native HUD material can obscure apps beneath the transparent overlay.
  // The overlay uses its renderer tint; the workspace retains macOS vibrancy.
  if (process.platform === 'darwin') window.setVibrancy(isOverlay || accessibility.reduceTransparency ? null : 'window')
  // Keep text and controls fully legible; the renderer applies user opacity to the background.
  if (isOverlay) window.setOpacity(1)
}
function refreshAppearance(): void {
  accessibility = {
    reduceTransparency: nativeTheme.prefersReducedTransparency,
    reduceMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
    increaseContrast: nativeTheme.shouldUseHighContrastColors
  }
  for (const window of uiWindows()) applyWindowAppearance(window, window === overlay)
}
function scheduleAppearanceRefresh(): void {
  if (quitting || appearanceRefresh) return
  // Let Chromium process the same OS notification before reading its theme properties.
  appearanceRefresh = setImmediate(() => { appearanceRefresh = null; refreshAppearance(); emitState() })
}
function setupAppearance(): void {
  nativeTheme.themeSource = settings.theme
  refreshAppearance()
  nativeTheme.on('updated', scheduleAppearanceRefresh)
  if (process.platform === 'darwin') accessibilitySubscription = systemPreferences.subscribeWorkspaceNotification('NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification', scheduleAppearanceRefresh)
}
function disposeAppearance(): void {
  nativeTheme.off('updated', scheduleAppearanceRefresh)
  if (appearanceRefresh) { clearImmediate(appearanceRefresh); appearanceRefresh = null }
  if (accessibilitySubscription !== null) { systemPreferences.unsubscribeWorkspaceNotification(accessibilitySubscription); accessibilitySubscription = null }
}
function sendUI(window: BrowserWindow, event: AppEvent): void { try { if (!window.webContents.isDestroyed()) window.webContents.send('faangin:event', event) } catch {} }
function recordDiagnosticError(error: unknown): void {
  const raw = typeof error === 'string' ? error : error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
  if (raw === 'cancelled' || raw === 'notes_changed' || raw === 'transcript_incomplete') return
  const categories: Record<string, string> = { invalid_credentials: 'provider-auth', permission_denied: 'provider-auth', 'capture-permission': 'capture-permission', quota_exhausted: 'provider-quota', rate_limited: 'provider-rate-limit', offline: 'provider-unavailable', timeout: 'provider-timeout', capture_timeout: 'capture-device', capture_failed: 'capture-device', capture_disconnect: 'capture-disconnect', storage_failed: 'save-failed', 'save-failed': 'save-failed', 'storage-save-failed': 'save-failed', 'storage-busy': 'storage-busy', 'storage-full': 'storage-full', 'storage-corrupt': 'storage-corrupt', 'unsupported-schema': 'unsupported-schema', 'credential-unavailable': 'credential-unavailable' }
  diagnosticErrors.push(typeof raw === 'string' && Object.hasOwn(categories, raw) ? categories[raw] : 'unknown')
  if (diagnosticErrors.length > 100) diagnosticErrors.splice(0, diagnosticErrors.length - 100)
}
function emit(event: AppEvent): void { if (event.type === 'error') recordDiagnosticError(event.code); for (const window of uiWindows()) sendUI(window, event) }
function emitState(): void { for (const window of uiWindows()) sendUI(window, { type: 'state', state: state(window === overlay ? 'overlay' : 'workspace') }) }
function sendCapture(command: CaptureCommand): void { try { if (captureWindow && !captureWindow.isDestroyed() && !captureWindow.webContents.isDestroyed()) captureWindow.webContents.send('faangin:capture-command', command) } catch {} }
function emitCapture(): void { emit({ type: 'capture-status', ...captureState }) }
function rendererURL(surface: string, kind?: WindowKind): string {
  if (process.env.ELECTRON_RENDERER_URL) { const url = new URL(`${surface}.html`, process.env.ELECTRON_RENDERER_URL.endsWith('/') ? process.env.ELECTRON_RENDERER_URL : `${process.env.ELECTRON_RENDERER_URL}/`); if (kind) url.searchParams.set('window', kind); return url.href }
  const url = pathToFileURL(join(mainDirectory, `../renderer/${surface}.html`)); if (kind) url.searchParams.set('window', kind); return url.href
}
function isLocalURL(value: string, surface: string): boolean {
  try { const expected = new URL(rendererURL(surface)), actual = new URL(value); return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname } catch { return false }
}
function validSender(event: IpcMainInvokeEvent | IpcMainEvent, kind: 'ui' | 'capture' | 'document'): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  const allowed = kind === 'ui' ? uiWindows().includes(window!) : kind === 'capture' ? window === captureWindow : window === documentWindow
  const surface = kind === 'ui' ? 'index' : kind
  if (!allowed || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isLocalURL(event.senderFrame.url, surface)) throw new Error('Untrusted request sender.')
}
function secureSession(target: ElectronSession, kind: 'ui' | 'capture' | 'document'): void {
  const setupScope = (contents: Electron.WebContents | null, isMainFrame: boolean, requestingUrl?: string) => {
    const trusted = kind === 'capture' && !!contents && accessSetupWindow?.webContents === contents && isMainFrame && isLocalURL(contents.getURL(), 'capture') && (!requestingUrl || isLocalURL(requestingUrl, 'capture'))
    return { trusted, active: trusted && accessSetupLease?.contents === contents && accessSetupLease.expiresAt > Date.now() }
  }
  const permissionScope = (contents: Electron.WebContents | null, isMainFrame: boolean, requestingUrl?: string) => ({
    trustedCaptureMainFrame: kind === 'capture' && !!contents && captureWindow?.webContents === contents && isMainFrame && isLocalURL(contents.getURL(), 'capture') && (!requestingUrl || isLocalURL(requestingUrl, 'capture')),
    activeSystemAudio: !!settings?.systemAudio && fence.acceptsFrames(captureGeneration) && !!captureResources && captureResources.token === captureGeneration && !captureResources.stopped && capturePolicy.state().sessionId === captureResources.sessionId && !revokedChannels.has('system')
  })
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const trustedUI = kind === 'ui' && uiWindows().some(window => window.webContents === contents) && isLocalURL(contents.getURL(), 'index') && details.isMainFrame && isLocalURL(details.requestingUrl, 'index')
    if (permission === 'clipboard-sanitized-write') { callback(trustedUI); return }
    const types = 'mediaTypes' in details ? details.mediaTypes : undefined
    if (capturePermissionProbe?.contents === contents) capturePermissionProbe.requests.push({ permission, mediaTypes: types })
    const setup = setupScope(contents, details.isMainFrame, details.requestingUrl)
    callback(capturePermissionRequestAllowed(permissionScope(contents, details.isMainFrame, details.requestingUrl), permission, types) || setupAudioPermissionAllowed(setup.trusted, setup.active, permission, types))
  })
  target.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (permission === 'clipboard-sanitized-write') return kind === 'ui' && !!contents && uiWindows().some(window => window.webContents === contents) && isLocalURL(contents.getURL(), 'index') && details.isMainFrame && (!details.requestingUrl || isLocalURL(details.requestingUrl, 'index'))
    const mediaType = (details as { mediaType?: string }).mediaType
    const setup = setupScope(contents, details.isMainFrame, details.requestingUrl)
    return capturePermissionCheckAllowed(permissionScope(contents, details.isMainFrame, details.requestingUrl), permission, mediaType) || setupAudioPermissionCheckAllowed(setup.trusted, setup.active, permission, mediaType)
  })
  target.setDevicePermissionHandler(() => false)
  target.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    if (url.protocol === 'file:') { const path = fileURLToPath(url); callback({ cancel: !path.startsWith(resolve(mainDirectory, '../renderer') + '/') }); return }
    if (process.env.ELECTRON_RENDERER_URL && new URL(process.env.ELECTRON_RENDERER_URL).origin === url.origin && (url.protocol === 'http:' || url.protocol === 'ws:')) { callback({}); return }
    callback({ cancel: true })
  })
  if (kind === 'capture') target.setDisplayMediaRequestHandler(async (request, callback) => {
    let replied = false
    let nativeProbe: CapturePermissionProbe | null = null
    const respond: typeof callback = value => { if (replied) return; replied = true; if (nativeProbe) { nativeProbe.callbackResponded = true; nativeProbe.callbackGranted = !!value?.audio }; try { callback(value) } catch {} }
    try {
      const setupLease = accessSetupLease, setupContents = accessSetupWindow?.webContents
      const setupCurrent = () => !!setupLease && accessSetupLease === setupLease && setupLease.expiresAt > Date.now() && !!setupContents && !setupContents.isDestroyed() && accessSetupWindow?.webContents === setupContents && setupLease.contents === setupContents && request.frame === setupContents.mainFrame && isLocalURL(request.frame.url, 'capture')
      if (setupCurrent()) {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
        const source = sources.find(item => item.display_id === String(screen.getPrimaryDisplay().id))
        if (!source || !setupCurrent()) { respond({}); return }
        respond({ video: source, audio: 'loopback' }); return
      }
      const generation = captureGeneration, sessionId = capturePolicy.state().sessionId, contents = captureWindow?.webContents
      const current = () => !!contents && !contents.isDestroyed() && captureWindow?.webContents === contents && request.frame === contents.mainFrame && isLocalURL(request.frame.url, 'capture') && generation === captureGeneration && fence.acceptsFrames(generation) && !!sessionId && capturePolicy.state().sessionId === sessionId && settings.systemAudio && !revokedChannels.has('system')
      if (!current()) { respond({}); return }
      if (capturePermissionProbe && capturePermissionProbe.contents === contents) {
        capturePermissionProbe.reachedDisplayHandler = true
        if (!capturePermissionProbe.nativeAudio) { respond({}); return }
        nativeProbe = capturePermissionProbe
      }
      if (nativeProbe) nativeProbe.sourceEnumerationStarted = true
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      if (nativeProbe) { nativeProbe.sourcesEnumerated = true; nativeProbe.sourceCount = sources.length }
      const primary = screen.getPrimaryDisplay()
      const source = sources.find(item => item.display_id === String(primary.id))
      if (nativeProbe) nativeProbe.sourceSelected = !!source
      if (!source || !current()) { respond({}); return }
      // Electron 44 routes macOS default-output loopback through CoreAudio Tap.
      respond({ video: source, audio: 'loopback' })
    } catch (error) { if (nativeProbe) nativeProbe.sourceError = error instanceof Error ? error.name : 'SourceError'; respond({}) }
  }, { useSystemPicker: false })
}
function windowFor(surface: 'index' | 'capture' | 'document', kind?: WindowKind): BrowserWindow {
  const role = surface === 'index' ? 'ui' : surface
  // Keep local setup preferences across launches. Capture and document surfaces stay ephemeral.
  const partition = role === 'ui' ? 'persist:faangin-ui' : `faangin-${role}`
  const targetSession = electronSession.fromPartition(partition)
  secureSession(targetSession, role)
  const isOverlay = kind === 'overlay'
  const isUI = surface === 'index'
  const nativeMaterial = isUI && !isOverlay && process.platform === 'darwin' && !accessibility.reduceTransparency
  const area = screen.getPrimaryDisplay().workArea
  const layout: WindowLayout = isOverlay ? {
    defaultBounds: defaultOverlayBounds(area, settings.overlayCollapsed, settings.overlayExpandedHeight), minWidth: OVERLAY_LAYOUT.minWidth, minHeight: settings.overlayCollapsed ? OVERLAY_LAYOUT.collapsedHeight : OVERLAY_LAYOUT.minHeight,
    boundsPolicy: (value, workArea) => constrainOverlayBounds(value, workArea, settings.overlayCollapsed, settings.overlayExpandedHeight),
    sizeLimits: workArea => overlaySizeLimits(workArea, settings.overlayCollapsed)
  } : { defaultBounds: { x: area.x + 40, y: area.y + 60, width: 1280, height: 840 }, minWidth: 900, minHeight: 400 }
  const bounds = isUI ? windowState?.restore(kind!, layout) ?? layout.defaultBounds : undefined
  const overlayLimits = isOverlay && bounds ? overlaySizeLimits(screen.getDisplayMatching(bounds).workArea, settings.overlayCollapsed) : undefined
  const window = new BrowserWindow({
    title: surface === 'capture' ? 'Faangin Audio Capture' : surface === 'document' ? 'Faangin Document Import' : 'Faangin',
    width: isOverlay ? OVERLAY_LAYOUT.width : 1280, height: isOverlay ? OVERLAY_LAYOUT.height : 840,
    ...(bounds ?? {}), minWidth: Math.min(layout.minWidth, bounds?.width ?? area.width), minHeight: Math.min(layout.minHeight, bounds?.height ?? area.height), resizable: !isOverlay || !settings.overlayCollapsed,
    ...(overlayLimits ? { minWidth: overlayLimits.minWidth, minHeight: overlayLimits.minHeight, maxWidth: overlayLimits.maxWidth, maxHeight: overlayLimits.maxHeight, fullscreenable: false, maximizable: false } : {}),
    show: false, focusable: !isOverlay || !overlayInteraction.passive, frame: !isOverlay, transparent: isOverlay, alwaysOnTop: isOverlay, skipTaskbar: isOverlay || surface !== 'index',
    backgroundColor: isUI ? windowBackground(isOverlay) : '#101014',
    ...(nativeMaterial ? { vibrancy: 'window' as const, visualEffectState: 'followWindow' as const } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, partition, preload: join(mainDirectory, '../preload/index.js'), additionalArguments: [`--faangin-surface=${surface === 'index' ? kind : surface}`, ...(smoke ? ['--faangin-smoke'] : []), ...(liveFixture && surface === 'index' ? ['--faangin-live-fixture'] : [])], spellcheck: false, backgroundThrottling: surface !== 'capture' }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (surface === 'index') {
      try {
        const destination = new URL(url)
        if (destination.protocol === 'https:' && !destination.username && !destination.password && url.length <= 8192) {
          void shell.openExternal(destination.href).catch(() => emit({ type: 'error', message: 'The link could not be opened in your browser.' }))
        }
      } catch { /* Keep malformed or non-web destinations outside the desktop process. */ }
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => { if (!isLocalURL(url, surface)) event.preventDefault() })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('render-process-gone', () => { if (surface === 'capture') { void stopCapture(); emit({ type: 'error', message: 'Audio capture stopped because its process closed.' }) } })
  if (surface === 'index') {
    windowState?.attach(kind!, window, layout)
    window.setContentProtection(settings.privacyMode)
    applyWindowAppearance(window, isOverlay)
    window.on('focus', () => { scheduleAppearanceRefresh(); refreshAccessReadiness() })
    if (isOverlay) {
      overlayWindowLayout = layout; window.setAlwaysOnTop(true, 'floating'); window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); overlayInteraction.attach(window)
      window.setMaximizable(false); window.setFullScreenable(false)
      window.on('maximize', () => { window.unmaximize(); applyOverlayLayout() })
      window.on('enter-full-screen', () => { window.setFullScreen(false) })
      window.on('leave-full-screen', () => applyOverlayLayout())
      windowState?.save('overlay')
    }
    // Overlay presentation is explicit. A late ready-to-show must never focus it
    // or undo an intervening Hide while its renderer was loading.
    if (!isOverlay && (!smoke || smokeVisible)) window.once('ready-to-show', () => {
      if (!quitting && !window.isDestroyed() && !overlayInteraction.desiredVisible) window.show()
    })
    window.on('close', event => { if (!quitting && !smoke) { event.preventDefault(); if (isOverlay) overlayInteraction.hide(); else window.hide() } })
  }
  void window.loadURL(rendererURL(surface, kind))
  return window
}
function showWindow(kind: WindowKind, expectedOverlayRevision?: number): void {
  if (quitting) return
  if (kind === 'overlay' && accessSetupBlocked()) return
  if (kind === 'workspace') { if (!workspace || workspace.isDestroyed()) workspace = windowFor('index', kind); if (!smoke || smokeVisible) { workspace.show(); workspace.focus() } }
  else {
    if (expectedOverlayRevision !== undefined && expectedOverlayRevision !== overlayInteraction.checkpoint()) return
    if (!overlay || overlay.isDestroyed()) overlay = windowFor('index', kind)
    if (!smoke || smokeVisible) overlayInteraction.showOutput(expectedOverlayRevision)
  }
  emitState()
}
function makeOverlayInteractive(): void {
  if (quitting) return
  if (accessSetupBlocked()) return
  if (!overlay || overlay.isDestroyed()) overlay = windowFor('index', 'overlay')
  if (!smoke || smokeVisible) overlayInteraction.showInteractive()
  else overlayInteraction.setPassive(false)
  refreshMenu(); emitState()
}
function applyDockPreference(): void {
  // Production always installs a status menu first. Hidden smoke jobs do not
  // change the developer's Dock; visible isolated native QA exercises this path.
  if (!smoke || smokeVisible) dockPolicy.apply(settings.hideDockIcon)
}
function applyOverlayLayout(): void {
  if (!overlay || overlay.isDestroyed() || !overlayWindowLayout) return
  const current = overlay.getBounds(), area = screen.getDisplayMatching(current).workArea
  overlayWindowLayout.minHeight = settings.overlayCollapsed ? OVERLAY_LAYOUT.collapsedHeight : OVERLAY_LAYOUT.minHeight
  const preferred = settings.overlayCollapsed ? OVERLAY_LAYOUT.collapsedHeight : current.height <= OVERLAY_LAYOUT.collapsedHeight ? overlayExpandedHeight(settings.overlayExpandedHeight) : current.height
  setOverlayBounds(constrainOverlayBounds({ ...current, height: preferred }, area, settings.overlayCollapsed, settings.overlayExpandedHeight))
  windowState?.save('overlay'); windowState?.reflow('overlay')
}
function setOverlayBounds(bounds: WindowBounds): void {
  if (!overlay || overlay.isDestroyed()) return
  const limits = overlaySizeLimits(screen.getDisplayMatching(bounds).workArea, settings.overlayCollapsed)
  if (!overlay.isResizable()) overlay.setResizable(true)
  overlay.setMinimumSize(1, 1)
  overlay.setMaximumSize(limits.maxWidth, limits.maxHeight)
  overlay.setMinimumSize(limits.minWidth, limits.minHeight)
  overlay.setBounds(bounds)
  overlay.setResizable(!settings.overlayCollapsed)
  // Cocoa can restore the zoom style when resizability changes; keep this a floating panel.
  overlay.setMaximizable(false)
  overlay.setFullScreenable(false)
}
function resizeOverlay(size: { width: number; height: number }): void {
  requireAccessSetup()
  if (!overlay || overlay.isDestroyed()) overlay = windowFor('index', 'overlay')
  const wasCollapsed = settings.overlayCollapsed
  if (wasCollapsed) settings = repo.saveSettings({ ...settings, overlayCollapsed: false })
  const current = overlay.getBounds(), area = screen.getDisplayMatching(current).workArea
  const next = constrainOverlayBounds({ ...current, ...size }, area, false, settings.overlayExpandedHeight, false)
  if (overlayWindowLayout) overlayWindowLayout.minHeight = OVERLAY_LAYOUT.minHeight
  setOverlayBounds(next)
  // Native resize/move events debounce geometry persistence; dragging never rewrites sessions/settings.
  if (wasCollapsed) emitState()
}
function resetOverlayLayout(): void {
  requireAccessSetup()
  if (!overlay || overlay.isDestroyed()) overlay = windowFor('index', 'overlay')
  const area = screen.getDisplayMatching(overlay.getBounds()).workArea
  settings = repo.saveSettings({ ...settings, overlayCollapsed: false, overlayExpandedHeight: OVERLAY_LAYOUT.height })
  if (overlayWindowLayout) overlayWindowLayout.minHeight = OVERLAY_LAYOUT.minHeight
  setOverlayBounds(defaultOverlayBounds(area))
  windowState?.save('overlay'); refreshMenu(); emitState()
}
function cancelRequests(sessionId?: string): void {
  captureSolve.cancel(sessionId)
  manualPreparations.cancel(sessionId)
  if (!sessionId || sessionId === captureState.sessionId || sessionId === currentSessionId) liveReplies.reset()
  if (!sessionId) connectionTest?.abort()
  for (const request of requests.values()) if (!sessionId || request.sessionId === sessionId) request.abort.abort()
}
function canPublish(sessionId: string, epoch: number): boolean { try { return repo.epoch(sessionId) === epoch } catch { return false } }
function automaticReplyAllowed(candidate: LiveReplyCandidate): boolean {
  if (accessSetupState().required) return false
  const resources = captureResources
  return admitsLiveReply(candidate, { enabled: !!settings?.liveSuggestions, source: settings?.liveSuggestionSource ?? 'system',
    currentSessionId, active: captureState.active, captureSessionId: captureState.sessionId, phase: capturePolicy.state().phase,
    generation: resources?.token ?? -1, stopped: resources?.stopped ?? true, listening: resources?.listening ?? new Set(),
    revoked: revokedChannels, epochCurrent: canPublish(candidate.turn.sessionId, candidate.epoch), quitting })
}
function liveSuggestionStatus(): NonNullable<AppState['liveSuggestions']> {
  const source = settings?.liveSuggestionSource ?? 'system', sessionId = captureState.sessionId
  const snapshot = liveReplies.snapshot()
  if (!settings?.liveSuggestions) return { phase: 'off', source, sessionId, reason: 'Live suggestions are off.' }
  if (!captureState.active || capturePolicy.state().phase !== 'running') return { phase: 'ready', source, sessionId, reason: 'Start or resume listening for automatic replies.' }
  if (currentSessionId !== sessionId) return { phase: 'off', source, sessionId, reason: 'Select the session that is listening.' }
  if (!captureResources?.listening.has(source) || revokedChannels.has(source)) return { phase: 'off', source, sessionId, reason: `Enable and connect ${source === 'system' ? 'System audio' : 'Microphone'} for live suggestions.` }
  const understanding = snapshot.phase === 'generating' && [...requests.values()].some(request => request.sessionId === sessionId && request.answer.origin === 'automatic' && !request.published)
  return { ...snapshot, ...(understanding ? { phase: 'understanding' as const } : {}), ...(snapshot.reason ? { reason: safeError(new Error(snapshot.reason)) } : {}), source, sessionId }
}
function refreshLiveSuggestions(restart = false): void {
  const resources = captureResources
  const ready = !!settings?.liveSuggestions && !quitting && captureState.active && capturePolicy.state().phase === 'running' &&
    !!resources && !resources.stopped && currentSessionId === resources.sessionId && resources.listening.has(settings.liveSuggestionSource) && !revokedChannels.has(settings.liveSuggestionSource)
  if (!ready) liveReplies.reset()
  else if (restart || liveReplies.snapshot().phase === 'off') liveReplies.resume()
  emit({ type: 'live-suggestions', state: liveSuggestionStatus() })
}
interface AutomaticGeneration { candidate: LiveReplyCandidate; signal: AbortSignal; complete(answer: Answer): void }
function interruptRequest(request: GenerationRequest, reason: InterviewInterruption): void {
  if (request.answer.status !== 'streaming') return
  request.answer.interruption = { reason: reason.reason, ...(reason.transcriptId ? { transcriptId: reason.transcriptId } : {}), at: Date.now() }
  request.answer.status = 'cancelled'
  request.abort.abort(reason)
  if (request.published && canPublish(request.sessionId, request.epoch)) {
    try { repo.saveAnswer(request.answer); request.terminalPublished = true; emit({ type: 'answer-complete', answer: request.answer }); emitState() }
    catch (error) { emit({ type: 'error', message: `Interrupted answer could not be saved: ${safeError(error)}`, code: 'storage_failed' }) }
  }
}
async function generateManual(input: ReturnType<typeof validate.generateInput>): Promise<{ requestId: string }> {
  requireAccessSetup()
  if (captureSolve.preparing()) throw new Error('Capture & solve is capturing the current screen. Wait for its answer to start.')
  if (manualQuestionPreparations) throw new Error('The latest question is still being finalized. Wait for the current answer request to start.')
  const session = fullSession(input.sessionId), epoch = session.contextEpoch
  if (input.replaceActive && (session.mode !== 'interview' || currentSessionId !== session.id)) throw new Error('Answer latest is available in the current interview session.')
  // A click can arrive before the VAD silence tail. Commit accepted question
  // audio and wait for its final words before compiling a spoken answer.
  if (input.replaceActive || (input.action === 'reply' && captureState.active && captureState.sessionId === session.id)) {
    const preferred = live.get(settings.liveSuggestionSource)
    const channels = input.action === 'reply' && captureState.active && captureState.sessionId === session.id ? preferred ? [preferred] : [...live.values()] : []
    const preparation = manualPreparations.begin(session.id)
    const assertPreparation = () => {
      manualPreparations.assertCurrent(preparation)
      if (quitting || !canPublish(session.id, epoch) || currentSessionId !== session.id) throw new Error('The interview changed while the question was transcribing. Answer again in the current session.')
    }
    manualQuestionPreparations++
    const automaticPaused = liveReplies.snapshot().phase === 'paused'
    try {
      assertPreparation()
      if (input.replaceActive) {
        const previous = [...requests.values()].filter(request => request.sessionId === session.id && !['notes', 'draft', 'recap'].includes(request.answer.action))
        for (const request of previous) interruptRequest(request, { type: 'interview-interruption', reason: 'manual-takeover' })
        if (!automaticPaused) liveReplies.reset()
        assertPreparation()
        await waitForInterruptedRequests(previous.map(request => request.done))
        assertPreparation()
      } else if (channels.length && !automaticPaused) liveReplies.reset()
      assertPreparation()
      await Promise.all(channels.map(channel => channel.flush()))
      assertPreparation()
    } finally { manualPreparations.release(preparation); manualQuestionPreparations--; if (!automaticPaused) refreshLiveSuggestions() }
  }
  return generate(input)
}
function generate(input: ReturnType<typeof validate.generateInput>, automatic?: AutomaticGeneration): { requestId: string } {
  requireAccessSetup()
  accessTelemetry.generationStarts++; accessTelemetry.cloudRequests++
  if (automatic) { if (automatic.signal.aborted || !automaticReplyAllowed(automatic.candidate)) throw new Error('Live suggestion cancelled.') }
  else if (liveReplies.snapshot().phase !== 'paused') { liveReplies.reset(); refreshLiveSuggestions() }
  const startedAt = performance.now()
  if (requests.size >= 4) throw new Error('Four answers are already running. Cancel one before starting another.')
  const session = fullSession(input.sessionId), epoch = session.contextEpoch
  const requestedIds = attachmentSelection.validateRequested(session.id, input.attachmentIds ?? [], session.attachments.map(image => image.id))
  const selected = requestedIds.map(id => session.attachments.find(image => image.id === id)!)
  const partials = !automatic && captureState.active && captureState.sessionId === session.id ? [...partialTranscripts.values()].filter(turn => turn.sessionId === session.id) : []
  const memory = input.action === 'draft' ? [] : resolveMemorySnippets(session.id, selectedMemory.get(session.id) ?? [], id => repo.get(id))
  const snapshotSettings = presetCatalog.settingsFor(session.id, session.mode, settings), snapshotSession = { ...session, transcript: automatic ? liveReplyTranscript(session, automatic.candidate) : [...session.transcript, ...partials], answers: session.answers, attachments: [] }
  const compiled = compilePrompt({ action: input.action, prompt: input.prompt ?? '', settings: snapshotSettings, session: snapshotSession, attachments: selected, smart: input.smart ?? snapshotSettings.smartMode, memory, ...(automatic ? { replyTarget: automatic.candidate.turn.id, automatic: { source: settings.liveSuggestionSource, channels: [...captureResources?.listening ?? []] } } : {}) })
  const compatible = snapshotSettings.chatProvider === 'compatible' ? validateCompatibleChatConfiguration({ endpoint: snapshotSettings.compatibleChatEndpoint, model: (input.smart ?? snapshotSettings.smartMode) ? snapshotSettings.compatibleChatSmartModel : snapshotSettings.compatibleChatModel, vision: snapshotSettings.compatibleChatVision }) : null
  const apiKey = compatible ? undefined : requireKey(), credential = compatible ? compatibleCredential(compatible.endpoint) : undefined
  repo.shadowIfHistoryOff(input.sessionId)
  const requestId = randomUUID(), abort = new AbortController()
  const abortAutomatic = () => {
    const reason = interruptionReason(automatic?.signal.reason), request = requests.get(requestId)
    if (reason && request) interruptRequest(request, reason)
    else abort.abort()
  }
  if (automatic) { automatic.signal.addEventListener('abort', abortAutomatic, { once: true }); if (automatic.signal.aborted) abortAutomatic() }
  const answer: Answer = { id: randomUUID(), requestId, sessionId: input.sessionId, origin: automatic ? 'automatic' : 'manual', action: input.action, prompt: input.prompt ?? '', text: '', model: compatible?.model ?? ((input.smart ?? snapshotSettings.smartMode) ? snapshotSettings.smartModel : snapshotSettings.fastModel), status: 'streaming', createdAt: Date.now(), usedPartialContext: compiled.sources.provisional, ...(compiled.transcriptReferences ? { transcriptReferences: compiled.transcriptReferences } : {}), context: { transcriptIds: compiled.sources.transcriptIds, attachmentIds: compiled.sources.attachmentIds, priorAnswerIds: compiled.sources.priorAnswerIds, memorySourceIds: compiled.sources.memorySourceIds, truncated: compiled.sources.truncated, ...(compiled.sources.replyTargetId ? { replyTargetId: compiled.sources.replyTargetId } : {}), ...(compiled.sources.interviewContextKey ? { interviewContextKey: compiled.sources.interviewContextKey } : {}), ...(compiled.sources.interviewSnapshot ? { interviewSnapshot: compiled.sources.interviewSnapshot } : {}), ...(compiled.sources.interruptedAnswerIds?.length ? { interruptedAnswerIds: compiled.sources.interruptedAnswerIds } : {}) } }
  let settle!: () => void
  const done = new Promise<void>(resolve => { settle = resolve })
  const request: GenerationRequest = { abort, sessionId: input.sessionId, epoch, answer, done, settle, terminalPublished: false, published: false }
  const decoder = automatic && session.mode === 'interview' ? new InterviewResponseDecoder() : null
  let protocolError: Error | undefined
  const publishAnswer = (): void => {
    if (request.published) return
    repo.saveAnswer(answer); request.published = true; emit({ type: 'answer-started', answer })
    if (automatic) emit({ type: 'live-suggestions', state: liveSuggestionStatus() })
  }
  // An automatic model may decide WAIT. Do not create a blank answer card or
  // pollute working-solution history until it has useful assistance to stream.
  if (!decoder) publishAnswer()
  requests.set(requestId, request)
  if (automatic) emit({ type: 'live-suggestions', state: liveSuggestionStatus() })
  // Run after IPC acknowledgement; persisted streaming state precedes every delta.
  setImmediate(() => { void (async () => {
    try {
      const onDelta = (delta: string) => {
        if (abort.signal.aborted || !canPublish(input.sessionId, epoch) || (automatic && !automaticReplyAllowed(automatic.candidate))) return
        let visible: string
        try { visible = decoder ? decoder.push(delta) : delta } catch (error) { protocolError = error instanceof Error ? error : undefined; throw error }
        if (!visible) return
        if (!request.published && !visible.trim()) { answer.text += visible; return }
        if (visible.trim()) answer.firstTokenMs ??= Math.round(performance.now() - startedAt)
        publishAnswer()
        answer.text += visible; emit({ type: 'answer-delta', requestId, sessionId: input.sessionId, delta: visible, firstTokenMs: answer.firstTokenMs })
      }
      const result = compatible ? await generateCompatibleAnswer(compiled, compatible, { signal: abort.signal, credential, onDelta }) : await generateCompiledAnswer(compiled, answer.model, { apiKey: apiKey!, signal: abort.signal, onDelta })
      if (!canPublish(input.sessionId, epoch)) return
      if (!abort.signal.aborted) { if (decoder) decoder.finish(); else answer.text = result.text }
      answer.model = result.model; answer.inputTokens = result.inputTokens; answer.outputTokens = result.outputTokens; answer.status = abort.signal.aborted ? 'cancelled' : 'complete'
      if (input.action === 'notes' && answer.status === 'complete' && !repo.applyGeneratedNotes(input.sessionId, epoch, snapshotSession.notes, answer.text)) {
        emit({ type: 'error', message: 'Your notes changed while this answer was generated. Your edits were kept; the generated notes are available in Assistance.', code: 'notes_changed' })
      }
    } catch (error) { answer.status = abort.signal.aborted ? 'cancelled' : 'failed'; if (!abort.signal.aborted) { recordDiagnosticError(protocolError ?? error); answer.error = safeError(protocolError ?? error); if (canPublish(input.sessionId, epoch)) { try { publishAnswer() } catch { emit({ type: 'error', message: 'The automatic answer could not be saved. Check available disk space and try again.', code: 'storage_failed' }) } } } }
    finally {
      answer.totalMs = Math.round(performance.now() - startedAt)
      timingSamples.push({ firstTokenMs: answer.firstTokenMs, totalMs: answer.totalMs }); if (timingSamples.length > 1000) timingSamples.shift()
      requests.delete(requestId)
      if (request.published && canPublish(input.sessionId, epoch)) {
        try { repo.saveAnswer(answer); if (!request.terminalPublished) emit({ type: 'answer-complete', answer }); emitState() } catch (error) { emit({ type: 'error', message: `Answer could not be saved: ${safeError(error)}`, code: 'storage_failed' }) }
      }
      if (automatic) { automatic.signal.removeEventListener('abort', abortAutomatic); automatic.complete(answer) }
      request.settle()
    }
  })() })
  return { requestId }
}
interface CaptureResources {
  token: number; sessionId: string; epoch: number; startup: AbortController; pipelines: Map<AudioChannel, Live>; draining: Set<Promise<void>>; listening: Set<AudioChannel>
  stopped: boolean; activated: boolean; closed: boolean; sourceTimer: ReturnType<typeof setTimeout> | null
  ready: Promise<void>; readyResolve: () => void; readyReject: (error: Error) => void; lease: CaptureLease
}
let captureResources: CaptureResources | null = null
const captureLifecycle = new CaptureLifecycle(capturePolicy, {
  acquire: acquireCapture,
  status: (sessionId, status) => {
    if (status === 'ended') captureState = { active: false, sessionId: null, microphone: 'Off', system: 'Off' }
    else if (status === 'paused') captureState = { active: false, sessionId, microphone: settings.microphone ? 'Paused' : 'Off', system: settings.systemAudio ? 'Paused' : 'Off' }
    else if (status === 'starting') captureState = { active: false, sessionId, microphone: settings.microphone ? 'Connecting…' : 'Off', system: settings.systemAudio ? 'Connecting…' : 'Off' }
    else captureState.active = !!captureResources?.listening.size
    try { repo.setStatus(sessionId, status) } catch (error) { emit({ type: 'error', message: `Capture ${status}; session status could not be saved: ${safeError(error)}`, code: 'storage_failed' }) }
    refreshLiveSuggestions()
    emitCapture(); emitState()
  },
  error: error => emit({ type: 'error', message: `Capture could not resume: ${safeError(error)}`, code: 'capture_failed' })
})
function abortableCapture<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown, value?: T) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted)
      if (error !== undefined) reject(error); else resolve(value!)
    }
    const aborted = () => finish(new Error('Capture acquisition cancelled.'))
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs)
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(value => finish(undefined, value), error => finish(error))
    if (signal.aborted) aborted()
  })
}
async function acquireCapture(sessionId: string, signal: AbortSignal): Promise<CaptureLease> {
  requireAccessSetup()
  const apiKey = requireKey(), session = repo.get(sessionId), options = { ...settings }
  if (!options.microphone && !options.systemAudio) throw new Error('Enable microphone or system audio in Settings.')
  const token = fence.begin(sessionId, session.contextEpoch), startup = new AbortController()
  captureGeneration = token; captureStartup = startup
  commits.clear(); capturesPerSecond.clear(); revokedChannels.clear(); partialTranscripts.clear(); live.clear()
  emit({ type: 'transcript-clear', sessionId })
  let readyResolve!: () => void, readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  void ready.catch(() => {})
  let disposed: Promise<void> | null = null
  const resources: CaptureResources = { token, sessionId, epoch: session.contextEpoch, startup, pipelines: new Map(), draining: new Set(), listening: new Set(), stopped: false, activated: false, closed: false, sourceTimer: null, ready, readyResolve, readyReject, lease: null! }
  const current = () => !signal.aborted && !resources.stopped && fence.acceptsFrames(token) && canPublish(sessionId, session.contextEpoch)
  const assertCurrent = () => { if (!current()) throw new Error('Capture acquisition cancelled.') }
  const lease: CaptureLease = {
    generation: token,
    async activate(activationSignal) {
      assertCurrent()
      resources.activated = true
      resources.sourceTimer = setTimeout(() => {
        if (!current()) return
        for (const channel of resources.pipelines.keys()) if (!resources.listening.has(channel)) {
          captureState[channel] = 'Audio source did not start. Check permissions and reconnect.'
          emit({ type: 'error', message: `${channel === 'system' ? 'System audio' : 'Microphone'}: ${captureState[channel]}`, code: 'capture_timeout' })
          releaseChannel(token, channel)
        }
        resources.sourceTimer = null
      }, 30_000)
      sendCapture({ type: 'start', generation: token, sessionId, microphone: resources.pipelines.has('microphone'), systemAudio: resources.pipelines.has('system'), microphoneDeviceId: options.microphoneDeviceId })
      await abortableCapture(resources.ready, activationSignal, 31_000, 'No audio source became ready. Check capture permissions and start again.')
      assertCurrent()
      if (captureStartup === startup) captureStartup = null
    },
    stopAccepting() {
      if (resources.stopped) return
      resources.stopped = true
      if (captureGeneration === token) {
        liveReplies.reset()
        fence.stop(); live.clear(); partialTranscripts.clear(); captureState.active = false
        emit({ type: 'transcript-clear', sessionId }); emitCapture()
      }
      startup.abort()
      if (resources.sourceTimer) { clearTimeout(resources.sourceTimer); resources.sourceTimer = null }
      resources.readyReject(new Error('Capture acquisition cancelled.'))
      sendCapture({ type: 'stop', generation: token, sessionId, microphone: false, systemAudio: false, microphoneDeviceId: '' })
    },
    dispose() {
      if (disposed) return disposed
      lease.stopAccepting()
      const pipelines = [...resources.pipelines.values()]; resources.pipelines.clear()
      // Finalize already-accepted speech for at most five seconds; new frames are fenced out.
      disposed = Promise.allSettled([...resources.draining, ...pipelines.map(pipeline => pipeline.stop())]).then(() => {
        resources.closed = true; signal.removeEventListener('abort', aborted)
        if (captureStartup === startup) captureStartup = null
        if (captureResources === resources) captureResources = null
        if (captureGeneration === token && !fence.acceptsFrames(token)) fence.invalidate()
      })
      return disposed
    }
  }
  resources.lease = lease; captureResources = resources
  const aborted = () => { lease.stopAccepting(); void lease.dispose() }
  signal.addEventListener('abort', aborted, { once: true })
  if (signal.aborted) aborted()
  try {
    assertCurrent()
    let microphoneAllowed = options.microphone
    if (options.microphone && process.platform === 'darwin') {
      let permissionMessage = 'Microphone permission was denied. Open macOS permission settings.'
      try { microphoneAllowed = await abortableCapture(systemPreferences.askForMediaAccess('microphone'), startup.signal, 30_000, 'Microphone permission is still pending. Check macOS permission settings and try again.') }
      catch (error) { assertCurrent(); if (!options.systemAudio) throw error; microphoneAllowed = false; permissionMessage = safeError(error) }
      assertCurrent()
      if (!microphoneAllowed) {
        if (!options.systemAudio) throw new Error(permissionMessage)
        captureState.microphone = permissionMessage
        emit({ type: 'error', message: `${permissionMessage} System audio can continue.`, code: 'capture-permission' }); emitCapture()
      }
    }
    if (!captureWindow || captureWindow.isDestroyed()) captureWindow = windowFor('capture')
    await waitForSurface(captureWindow.webContents, startup.signal)
    assertCurrent()
    const enabled = (['microphone', 'system'] as AudioChannel[]).filter(channel => channel === 'microphone' ? microphoneAllowed : options.systemAudio)
    await Promise.allSettled(enabled.map(async channel => {
      try {
        const transcriber = await createLiveTranscriber({ apiKey, model: options.transcriptionModel, language: options.inputLanguage, channel, context: transcriptionContext(session, options, channel), signal: startup.signal,
          onPartial: (itemId, text, capturedAt) => {
            if (!current() || revokedChannels.has(channel)) return
            const id = `${sessionId}:${token}:${channel}:${itemId}`, previous = partialTranscripts.get(id)
            partialTranscripts.set(id, { id, sessionId, channel, text, timestamp: previous?.timestamp ?? capturedAt, provisional: true })
            emit({ type: 'transcript-partial', sessionId, channel, itemId, text })
            const turn = partialTranscripts.get(id)!
            if (automaticReplyAllowed({ turn: { ...turn, provisional: false }, generation: token, epoch: session.contextEpoch })) liveReplies.defer({ turn, generation: token, epoch: session.contextEpoch })
          },
          onFinal: (itemId, text, capturedAt) => ingestFinalTranscript(resources, channel, itemId, text, capturedAt),
          onIncomplete: message => {
            // A timeout notice can arrive at the five-second boundary after final-result admission closes.
            if (captureGeneration !== token || resources.closed || !canPublish(sessionId, session.contextEpoch)) return
            try { repo.markTranscriptIncomplete(sessionId); emit({ type: 'error', message: safeError(new Error(message)), code: 'transcript_incomplete' }); emitState() } catch (error) { emit({ type: 'error', message: `Transcript completeness could not be saved: ${safeError(error)}`, code: 'storage_failed' }) }
          },
          onError: message => {
            if (!current() || revokedChannels.has(channel)) return
            captureState[channel] = safeError(new Error(message)); emitCapture()
            emit({ type: 'error', message: `${channel === 'system' ? 'System audio' : 'Microphone'}: ${captureState[channel]}`, code: 'capture_failed' }); releaseChannel(token, channel)
          }
        })
        if (!current() || revokedChannels.has(channel)) { await transcriber.stop(); return }
        resources.pipelines.set(channel, transcriber); live.set(channel, transcriber)
      } catch (error) {
        if (!current()) return
        captureState[channel] = safeError(error); revokedChannels.add(channel); emitCapture()
        emit({ type: 'error', message: `${channel === 'system' ? 'System audio' : 'Microphone'}: ${captureState[channel]}`, code: 'capture_failed' })
      }
    }))
    assertCurrent()
    if (!resources.pipelines.size) throw new Error('No audio source could connect. Check source permissions and transcription settings.')
    return lease
  } catch (error) { await lease.dispose(); throw error }
}
function ingestFinalTranscript(resources: CaptureResources, channel: AudioChannel, itemId: string, text: string, capturedAt: number): void {
  const { sessionId, token, epoch } = resources
  partialTranscripts.delete(`${sessionId}:${token}:${channel}:${itemId}`)
  if (!fence.acceptsResult(token, sessionId, epoch) || !canPublish(sessionId, epoch)) return
  if (!text.trim()) {
    emit({ type: 'transcript-partial', sessionId, channel, itemId, text: '' })
    liveReplies.offer({ turn: { id: `${sessionId}:${token}:${channel}:${itemId}`, sessionId, channel, text: '', timestamp: capturedAt }, generation: token, epoch })
  } else {
    try {
      const turn = repo.transcript(sessionId, channel, text.slice(0, 100_000), `${sessionId}:${token}:${channel}:${itemId}`, capturedAt)
      emit({ type: 'transcript-final', turn })
      const session = repo.get(sessionId)
      if (session.mode === 'interview' && currentSessionId === sessionId && !resources.stopped && capturePolicy.state().phase === 'running' &&
        channel !== settings.liveSuggestionSource && resources.listening.has(channel) && !revokedChannels.has(channel) &&
        [...requests.values()].some(request => request.sessionId === sessionId && request.answer.origin === 'automatic' && !request.published && !request.abort.signal.aborted && !request.answer.context?.transcriptIds.includes(turn.id))) {
        liveReplies.contextChanged({ turn, generation: token, epoch })
      }
      if (session.mode === 'interview' && currentSessionId === sessionId && !resources.stopped && capturePolicy.state().phase === 'running' && channel === settings.liveSuggestionSource && resources.listening.has(channel) && !revokedChannels.has(channel)) {
        for (const request of requests.values()) if (request.answer.origin !== 'automatic' && shouldInterruptInterviewAnswer(request.answer, turn, channel, session.transcript)) interruptRequest(request, { type: 'interview-interruption', reason: 'new-question', transcriptId: turn.id })
      }
      liveReplies.offer({ turn, generation: token, epoch })
    } catch (error) { emit({ type: 'error', message: `Transcript could not be saved: ${safeError(error)}`, code: 'storage_failed' }) }
  }
  if (channel === settings.liveSuggestionSource) for (const turn of partialTranscripts.values()) if (turn.sessionId === sessionId && turn.channel === channel && turn.text.trim()) liveReplies.defer({ turn, generation: token, epoch })
}

/** Explicitly isolated smoke-only text proxy; never opens an OS source or live transcription connection. */
let fixtureCapture: CaptureResources | null = null
function startFixtureCapture(sessionId: string): void {
  requireAccessSetup()
  if (!liveFixture || capturePolicy.state().phase !== 'idle') throw new Error('The isolated live fixture requires stopped capture.')
  const stored = repo.get(sessionId), token = fence.begin(sessionId, stored.contextEpoch), startup = new AbortController()
  const listening = new Set<AudioChannel>((['microphone', 'system'] as AudioChannel[]).filter(channel => channel === 'system' ? settings.systemAudio : settings.microphone))
  if (!listening.size) throw new Error('Enable a fixture source.')
  const resources: CaptureResources = { token, sessionId, epoch: stored.contextEpoch, startup, pipelines: new Map(), draining: new Set(), listening, stopped: false, activated: true, closed: false, sourceTimer: null, ready: Promise.resolve(), readyResolve() {}, readyReject() {}, lease: null! }
  const lease: CaptureLease = {
    generation: token, activate() {},
    stopAccepting() {
      if (resources.stopped) return
      resources.stopped = true; liveReplies.reset(); fence.stop(); partialTranscripts.clear(); captureState.active = false
      emit({ type: 'transcript-clear', sessionId }); emitCapture()
    },
    dispose() { lease.stopAccepting(); resources.closed = true; if (captureResources === resources) captureResources = null; fence.invalidate() }
  }
  repo.shadowIfHistoryOff(sessionId)
  resources.lease = lease; fixtureCapture = resources; captureResources = resources; captureGeneration = token; currentSessionId = sessionId; revokedChannels.clear()
  captureState = { active: true, sessionId, microphone: listening.has('microphone') ? 'Listening (fixture)' : 'Off', system: listening.has('system') ? 'Listening (fixture)' : 'Off' }
  captureLifecycle.adopt(sessionId, lease)
}
async function startCapture(sessionId: string): Promise<void> {
  requireAccessSetup()
  accessTelemetry.captureStarts++
  repo.get(sessionId)
  if (!settings.microphone && !settings.systemAudio) throw new Error('Enable microphone or system audio in Settings.')
  if (quitting) throw new Error('Faangin is closing.')
  const policy = capturePolicy.state()
  if (policy.phase !== 'idle' && policy.sessionId !== sessionId) throw new Error('Stop the current session before capturing another.')
  requireSystemAudioConsent(sessionId)
  repo.shadowIfHistoryOff(sessionId); currentSessionId = sessionId
  await captureLifecycle.start(sessionId)
}
function releaseChannel(token: number, channel: AudioChannel): void {
  const resources = captureResources
  if (!resources || resources.token !== token || !fence.acceptsFrames(token)) return
  revokedChannels.add(channel); resources.listening.delete(channel)
  if (channel === settings.liveSuggestionSource) liveReplies.reset()
  for (const [id, turn] of partialTranscripts) if (turn.channel === channel) partialTranscripts.delete(id)
  emit({ type: 'transcript-clear', sessionId: resources.sessionId, channel })
  sendCapture({ type: 'stop-channel', generation: token, sessionId: resources.sessionId, channel, microphone: false, systemAudio: false, microphoneDeviceId: '' })
  const pipeline = resources.pipelines.get(channel); resources.pipelines.delete(channel); live.delete(channel)
  // A failed source does not admit another turn; already committed finals may still arrive.
  if (pipeline) {
    const draining = pipeline.stop().catch(error => emit({ type: 'error', message: safeError(error), code: 'capture_failed' }))
    resources.draining.add(draining); void draining.then(() => resources.draining.delete(draining))
  }
  captureState.active = resources.listening.size > 0; refreshLiveSuggestions(); emitCapture()
  if (resources.pipelines.size && channel === 'microphone' && captureState[channel] === 'Audio device disconnected.' && capturePolicy.state().phase === 'running') scheduleDeviceReconnect()
  if (!resources.pipelines.size && resources.activated) {
    resources.readyReject(new Error('All audio sources disconnected. Check permissions and start again.'))
    if (capturePolicy.state().phase === 'running') {
      if (captureState[channel] === 'Audio device disconnected.') {
        if (deviceChangeTimer) { clearTimeout(deviceChangeTimer); deviceChangeTimer = null }
        void captureLifecycle.deviceChanged().catch(error => emit({ type: 'error', message: safeError(error), code: 'capture_failed' }))
      } else void stopCapture()
    }
  }
}
function reportCaptureReady(channel: AudioChannel): void {
  const resources = captureResources
  if (!resources || resources.stopped || revokedChannels.has(channel)) return
  resources.listening.add(channel); captureState.active = true; resources.readyResolve()
  refreshLiveSuggestions()
  if (resources.listening.size === resources.pipelines.size && resources.sourceTimer) { clearTimeout(resources.sourceTimer); resources.sourceTimer = null }
}
async function stopCapture(): Promise<void> {
  const sessionId = capturePolicy.state().sessionId ?? captureState.sessionId
  if (sessionId) { manualPreparations.cancel(sessionId); if (captureSolve.preparing()) captureSolve.cancel(sessionId) }
  if (deviceChangeTimer) { clearTimeout(deviceChangeTimer); deviceChangeTimer = null }
  await captureLifecycle.stop()
}
async function pauseCapture(): Promise<void> { await captureLifecycle.pause() }
async function resumeCapture(sessionId: string): Promise<void> {
  requireAccessSetup()
  if (capturePolicy.state().sessionId !== sessionId) throw new Error('This session is not paused. Start capture explicitly to resume its saved context.')
  if (quitting) throw new Error('Faangin is closing.')
  requireSystemAudioConsent(sessionId, true)
  await captureLifecycle.resume()
}
function onCaptureSuspend(): void { void captureLifecycle.suspend().catch(error => emit({ type: 'error', message: safeError(error), code: 'capture_failed' })) }
function onCaptureWake(): void { if (!quitting) void captureLifecycle.wake().catch(error => emit({ type: 'error', message: safeError(error), code: 'capture_failed' })) }
function scheduleDeviceReconnect(): void {
  if (deviceChangeTimer) clearTimeout(deviceChangeTimer)
  deviceChangeTimer = setTimeout(() => { deviceChangeTimer = null; if (!quitting) void captureLifecycle.deviceChanged().catch(error => emit({ type: 'error', message: safeError(error), code: 'capture_failed' })) }, 300)
  deviceChangeTimer.unref()
}
function setupCapturePolicy(): void {
  capturePolicy.configureIdleTimeout(settings.captureIdleMinutes * 60_000)
  powerMonitor.on('suspend', onCaptureSuspend); powerMonitor.on('resume', onCaptureWake)
  capturePolicyTimer = setInterval(() => {
    if (accessSetupState().required && (capturePolicy.state().phase !== 'idle' || overlay?.isVisible() || requests.size > 0 || captureSolve.preparing())) { refreshAccessReadiness(); return }
    const ended = captureLifecycle.poll()
    if (ended) { emit({ type: 'error', message: 'Capture ended after the configured period without speech. Your saved context is still available.', code: 'capture_idle' }); void ended.catch(error => emit({ type: 'error', message: safeError(error), code: 'capture_failed' })) }
  }, 1000)
  capturePolicyTimer.unref()
}
function disposeCapturePolicy(): void {
  if (capturePolicyTimer) { clearInterval(capturePolicyTimer); capturePolicyTimer = null }
  if (deviceChangeTimer) { clearTimeout(deviceChangeTimer); deviceChangeTimer = null }
  powerMonitor.removeListener('suspend', onCaptureSuspend); powerMonitor.removeListener('resume', onCaptureWake)
}
function addAttachment(sessionId: string, name: string, image: Electron.NativeImage, oneShotCapture = false): Attachment {
  repo.get(sessionId)
  const size = image.getSize(), existing = attachments.get(sessionId) ?? []
  const replacedId = oneShotCapture ? captureSolveImages.replacement(sessionId, existing) : undefined
  const current = existing.filter(attachment => attachment.id !== replacedId)
  if (image.isEmpty() || !size.width || !size.height) throw new Error('The selected source did not return an image. Check permission and source availability.')
  if (current.length >= 4) throw new Error('Remove an image before adding more than four attachments.')
  const normalized = size.width > 2560 || size.height > 2560 ? image.resize({ width: Math.round(size.width * Math.min(2560 / size.width, 2560 / size.height)), height: Math.round(size.height * Math.min(2560 / size.width, 2560 / size.height)) }) : image
  const buffer = normalized.toPNG(), dimensions = normalized.getSize()
  if (buffer.byteLength > 8 * 1024 * 1024 || current.reduce((sum, image) => sum + image.dataUrl.length, 0) + buffer.length * 1.34 > 32 * 1024 * 1024) throw new Error('Images exceed this session’s 32 MB memory limit.')
  const attachment: Attachment = { id: randomUUID(), sessionId, name, dataUrl: `data:image/png;base64,${buffer.toString('base64')}`, width: dimensions.width, height: dimensions.height, createdAt: Date.now() }
  // A failed native acquisition, invalid bitmap, or size check never discards
  // an older image. Commit replacement only once the new frame is usable.
  if (replacedId) attachmentSelection.removed(sessionId, replacedId)
  if (oneShotCapture) captureSolveImages.committed(sessionId, attachment.id, replacedId)
  attachments.set(sessionId, [...current, attachment]); attachmentSelection.added(sessionId, attachment.id); emitState(); return attachment
}
const screenshotCapture = new ScreenshotCapture<Electron.NativeImage>({
  windows: () => BrowserWindow.getAllWindows(),
  watchWindows: listener => {
    const created = (_event: Electron.Event, window: BrowserWindow) => listener(window)
    app.on('browser-window-created', created)
    return () => { app.removeListener('browser-window-created', created) }
  },
  displays: () => screen.getAllDisplays().map(display => ({ id: String(display.id), width: display.bounds.width, height: display.bounds.height, scaleFactor: display.scaleFactor })),
  sources: async thumbnailSize => screenshotFixture
    ? [{ id: 'screen:fixture', name: 'Synthetic capture fixture', display_id: String(screen.getPrimaryDisplay().id), thumbnail: nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 255), { width: 64, height: 64 }) }]
    : desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize, fetchWindowIcons: false }),
  mayRestore: window => window !== overlay || overlayInteraction.desiredVisible,
  quitting: () => quitting
})
async function screenshot(sessionId: string, sourceId?: string, assertOperationCurrent?: () => void, oneShotCapture = false): Promise<Attachment> {
  requireAccessSetup()
  accessTelemetry.screenCaptures++
  assertOperationCurrent?.()
  repo.get(sessionId)
  if (oneShotCapture) captureSolveImages.replacement(sessionId, attachments.get(sessionId) ?? [])
  else if ((attachments.get(sessionId) ?? []).length >= 4) throw new Error('Remove an image before adding more than four attachments.')
  if (!screenshotFixture && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') throw new Error('Screen recording permission is denied. Enable Faangin in macOS settings, then restart the app.')
  const epoch = repo.epoch(sessionId), chosenId = sourceId || settings.screenshotSourceId || undefined
  const assertCurrent = () => { assertOperationCurrent?.(); if (!canPublish(sessionId, epoch)) throw new Error('This session changed during capture. The screenshot was not saved.') }
  const captured = await screenshotCapture.capture({ sessionId, sourceId: chosenId, primaryDisplayId: String(screen.getPrimaryDisplay().id), assertCurrent })
  assertCurrent()
  return addAttachment(sessionId, captured.source.name, captured.source.thumbnail, oneShotCapture)
}
const captureSolve = new CaptureSolveCoordinator({
  snapshot: sessionId => {
    const session = repo.get(sessionId)
    if (currentSessionId !== sessionId) throw new Error('Select the session before using Capture & solve.')
    if (!chatConfigured()) throw new Error('Configure a chat connection in Settings before using Capture & solve.')
    if (settings.chatProvider === 'compatible' && !settings.compatibleChatVision) throw new Error('Your chat provider has image inputs turned off. Enable image support in Connection & models, or type the problem to solve it.')
    if (manualQuestionPreparations || [...requests.values()].some(request => request.sessionId === sessionId)) throw new Error('An answer is already running. Wait for it to finish or stop it before capturing another problem.')
    return { sessionId, epoch: session.contextEpoch, sourceId: settings.screenshotSourceId || undefined, smart: settings.smartMode, connectionIdentity: captureSolveConnectionIdentity(settings) }
  },
  assertCurrent: snapshot => {
    if (quitting || currentSessionId !== snapshot.sessionId || !canPublish(snapshot.sessionId, snapshot.epoch)) throw new Error('The session changed during Capture & solve. Capture again in the current session.')
    if ((settings.screenshotSourceId || undefined) !== snapshot.sourceId) throw new Error('The capture source changed. Capture again with the selected source.')
    if (captureSolveConnectionIdentity(settings) !== snapshot.connectionIdentity) throw new Error('The chat connection or image settings changed. Capture again with the current connection.')
  },
  capture: async (snapshot, assertCurrent) => {
    await screenshotCapture.whenIdle()
    assertCurrent()
    return screenshot(snapshot.sessionId, snapshot.sourceId, assertCurrent, true)
  },
  select: (sessionId, imageId) => { attachmentSelection.set(sessionId, [imageId], (attachments.get(sessionId) ?? []).map(image => image.id)); emitState() },
  generate: input => generateManual(validate.generateInput(input)),
  finished: requestId => requests.get(requestId)?.done ?? Promise.resolve(),
  cancelCapture: sessionId => screenshotCapture.invalidate(sessionId),
  changed: () => { if (repo && settings && !quitting) emitState() }
})
async function captureAndSolve(sessionId: string): Promise<{ requestId: string }> {
  requireAccessSetup()
  const presentation = overlayInteraction.checkpoint(), epoch = repo.epoch(sessionId)
  const present = () => { if (currentSessionId === sessionId && canPublish(sessionId, epoch)) showWindow('overlay', presentation) }
  return captureSolve.run(sessionId).then(result => { present(); return result }, error => { present(); throw error })
}
const screenshotRegions = new ScreenshotRegionStore<Electron.NativeImage>()
const regionOwners = new WeakSet<Electron.WebContents>()
async function previewScreenshotRegion(sessionId: string, ownerId: string, sourceId?: string) {
  requireAccessSetup()
  repo.get(sessionId); screenshotRegions.canCreate(ownerId)
  if ((attachments.get(sessionId) ?? []).length >= 4) throw new Error('Remove an image before adding more than four attachments.')
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') throw new Error('Screen recording permission is denied. Enable Faangin in macOS settings, then restart the app.')
  const epoch = repo.epoch(sessionId), assertCurrent = () => { if (!canPublish(sessionId, epoch)) throw new Error('This session changed during capture. The region preview was not saved.') }
  const captured = await screenshotCapture.capture({ sessionId, sourceId: sourceId || settings.screenshotSourceId || undefined, primaryDisplayId: String(screen.getPrimaryDisplay().id), assertCurrent })
  assertCurrent()
  // Canonical PNG decoding gives one image representation at scale 1; the UI and
  // native crop consequently share the exact encoded pixel grid on Retina too.
  let image = nativeImage.createFromBuffer(captured.source.thumbnail.toPNG())
  const original = image.getSize(), ratio = Math.min(1, 2560 / original.width, 2560 / original.height)
  if (ratio < 1) image = image.resize({ width: Math.max(1, Math.round(original.width * ratio)), height: Math.max(1, Math.round(original.height * ratio)) })
  const png = image.toPNG()
  if (image.isEmpty() || png.byteLength > 16 * 1024 * 1024) throw new Error('The region preview exceeds its memory limit. Choose a smaller source.')
  const dimensions = validate.imageSize(png), size = image.getSize()
  if (dimensions.width !== size.width || dimensions.height !== size.height || image.getScaleFactors().some(scale => scale !== 1)) throw new Error('The screenshot pixel scale could not be verified. Capture a different source.')
  const preview = image.toJPEG(90)
  if (preview.byteLength > 8 * 1024 * 1024) throw new Error('The region preview exceeds its memory limit. Choose a smaller source.')
  const lease = screenshotRegions.create(randomUUID(), { sessionId, ownerId, epoch, image, name: captured.source.name, ...dimensions, display: captured.display })
  return { ...lease, sessionId, name: captured.source.name, dataUrl: `data:image/jpeg;base64,${preview.toString('base64')}`, ...dimensions, displayId: captured.display?.id, scaleFactor: captured.display?.scaleFactor }
}
function validateDocxArchive(buffer: Buffer): void {
  // Read central-directory metadata before the parser can expand the archive.
  let entries = 0, expanded = 0
  for (let offset = 0; offset + 46 <= buffer.length; offset++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue
    entries++; expanded += buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32)
    if (entries > 1000 || expanded > 30 * 1024 * 1024 || offset + 46 + nameLength + extra + comment > buffer.length) throw new Error('The document archive exceeds import limits or is malformed.')
    offset += 45 + nameLength + extra + comment
  }
  if (!entries) throw new Error('This is not a valid DOCX archive.')
}
async function parseDocument(bytes: Buffer, format: string): Promise<string> {
  if (documentWindow && !documentWindow.isDestroyed()) throw new Error('Another profile is being imported.')
  const window = windowFor('document'); documentWindow = window
  return new Promise<string>((resolve, reject) => {
    const id = randomUUID()
    const finish = (error?: Error, value?: string) => { clearTimeout(timer); documentJobs.delete(id); if (documentWindow === window) documentWindow = null; if (!window.isDestroyed()) window.destroy(); error ? reject(error) : resolve(value ?? '') }
    const timer = setTimeout(() => finish(new Error('Document import timed out. Try a smaller document or paste plain text.')), 20_000)
    documentJobs.set(id, { window, resolve: value => finish(undefined, value), reject: error => finish(error) })
    window.webContents.once('did-finish-load', () => window.webContents.send('faangin:document-command', { id, format, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }))
    window.webContents.once('did-fail-load', () => finish(new Error('The isolated document reader failed to load.')))
    window.webContents.once('render-process-gone', () => finish(new Error('The document was too complex for the isolated reader. Try plain text.')))
    window.once('closed', () => { if (documentJobs.has(id)) finish(new Error('The document reader closed.')) })
  })
}
function handle(channel: string, count: [number, number], handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(`faangin:${channel}`, async (event, ...args: unknown[]) => {
    validSender(event, 'ui')
    if (args.length < count[0] || args.length > count[1]) throw new Error('Invalid request arguments.')
    try {
      if (['generate', 'sources', 'screenshot', 'capture-solve', 'region-preview', 'region-commit', 'capture-start', 'capture-resume', 'connection', 'chat-connection', 'overlay-resize', 'overlay-reset-layout', 'click-through'].includes(channel)) requireAccessSetup()
      return await handler(event, ...args)
    } catch (error) { recordDiagnosticError(error); throw new Error(safeError(error)) }
  })
}
function microphoneInventory(): Promise<MicrophoneDevice[]> {
  if (microphoneInventoryPromise) return microphoneInventoryPromise
  const pending = (async () => {
    if (!captureWindow || captureWindow.isDestroyed()) captureWindow = windowFor('capture')
    const window = captureWindow, deadline = Date.now() + 5_000
    await waitForSurface(window.webContents, new AbortController().signal, 5_000)
    return new Promise<MicrophoneDevice[]>((resolve, reject) => {
      const id = randomUUID()
      const finish = (error?: Error, devices?: MicrophoneDevice[]) => {
        clearTimeout(timer); window.removeListener('closed', closed); window.webContents.removeListener('render-process-gone', closed)
        if (microphoneInventoryJob?.id === id) microphoneInventoryJob = null
        error ? reject(error) : resolve(devices ?? [])
      }
      const closed = () => finish(new Error('Microphone inventory closed. Refresh devices again.'))
      const timer = setTimeout(() => finish(new Error('Microphone inventory timed out. Refresh devices again.')), Math.max(1, deadline - Date.now()))
      microphoneInventoryJob = { id, window, resolve: devices => finish(undefined, devices), reject: error => finish(error) }
      window.once('closed', closed); window.webContents.once('render-process-gone', closed)
      try { window.webContents.send('faangin:microphone-inventory-command', id) } catch { finish(new Error('Microphone inventory closed. Refresh devices again.')) }
    })
  })().finally(() => { if (microphoneInventoryPromise === pending) microphoneInventoryPromise = null })
  microphoneInventoryPromise = pending
  return pending
}
function setupIPC(): void {
  if (liveFixture) handle('smoke-live', [1, 1], async (_event, command) => {
    const value = validate.record(command), type = validate.oneOf(value.type, ['start', 'final', 'partial', 'image', 'permission-probe', 'native-audio-probe', 'overlay-state', 'overlay-reset-menu', 'access-fixture', 'access-shortcut', 'access-telemetry'])
    if (type === 'access-fixture' || type === 'access-shortcut' || type === 'access-telemetry') {
      if (!accessFixtureEnabled) throw new Error('Access fixtures require an explicit disposable access profile.')
      if (type === 'access-telemetry') { validate.onlyKeys(value, ['type']); return { ...accessTelemetry, providerRequests: accessTelemetry.cloudRequests, access: accessSetupState(), capture: { ...captureState } } }
      if (type === 'access-shortcut') { validate.onlyKeys(value, ['type', 'action']); shortcutAction(validate.oneOf(value.action, SHORTCUT_ACTIONS)); return { dispatched: true, access: accessSetupState() } }
      validate.onlyKeys(value, ['type', 'permissions', 'completed', 'probeResult', 'notify'])
      const previous = accessSetupState()
      let systemAudio = previous.permissions.systemAudio
      if (value.permissions !== undefined) {
        const updates = validate.record(value.permissions); validate.onlyKeys(updates, ['microphone', 'screen', 'systemAudio'])
        for (const kind of ['microphone', 'screen'] as const) if (updates[kind] !== undefined) accessFixturePermissions[kind] = validate.oneOf(updates[kind], ['not-determined', 'granted', 'denied', 'restricted', 'unknown'])
        if (updates.systemAudio !== undefined) systemAudio = validate.oneOf(updates.systemAudio, ['not-requested', 'checking', 'verified', 'denied', 'unavailable'])
      }
      const completed = value.completed === undefined ? previous.completed : validate.bool(value.completed)
      accessSetup = new AccessSetupCoordinator({ version: 1, completed, backgroundCheckConsented: completed, systemAudioVerifiedAt: systemAudio === 'verified' ? Date.now() : null }, next => repo.saveConfiguration('access-setup', next))
      if (systemAudio === 'verified') accessSetup.finishAudioCheck(true)
      if (systemAudio === 'checking') accessSetup.beginAudioCheck()
      else if (systemAudio === 'denied' || systemAudio === 'unavailable') accessSetup.finishAudioCheck(false, 'Synthetic access fixture', systemAudio === 'denied')
      if (value.probeResult !== undefined) accessFixtureProbeResult = validate.oneOf(value.probeResult, ['success', 'denied', 'unavailable', 'timeout'])
      const notify = value.notify === undefined ? true : validate.bool(value.notify)
      return { ...accessTelemetry, access: notify ? refreshAccessReadiness() : accessSetupState() }
    }
    if (type === 'overlay-reset-menu') {
      validate.onlyKeys(value, ['type'])
      const reset = Menu.getApplicationMenu()?.getMenuItemById('overlay-reset-layout')
      if (!reset?.enabled || typeof reset.click !== 'function') throw new Error('The native overlay reset menu item is unavailable.')
      reset.click({}, BrowserWindow.fromWebContents(_event.sender), _event.sender)
      return { invoked: true, version: app.getVersion() }
    }
    if (type === 'overlay-state') {
      validate.onlyKeys(value, ['type'])
      const exists = !!overlay && !overlay.isDestroyed()
      return { exists, passive: overlayInteraction.passive, desiredVisible: overlayInteraction.desiredVisible, visible: exists && overlay!.isVisible(), focused: exists && overlay!.isFocused(), focusable: exists ? overlay!.isFocusable() : null,
        ...(exists ? { bounds: overlay!.getBounds(), contentBounds: overlay!.getContentBounds(), display: { id: screen.getDisplayMatching(overlay!.getBounds()).id, workArea: screen.getDisplayMatching(overlay!.getBounds()).workArea }, resizable: overlay!.isResizable(), maximized: overlay!.isMaximized(), fullscreen: overlay!.isFullScreen(), maximizable: overlay!.isMaximizable(), fullscreenable: overlay!.isFullScreenable(), minimumSize: overlay!.getMinimumSize(), maximumSize: overlay!.getMaximumSize() } : {}) }
    }
    if (type === 'start') { validate.onlyKeys(value, ['type', 'sessionId']); startFixtureCapture(validate.id(value.sessionId)); return }
    if (type === 'permission-probe' || type === 'native-audio-probe') {
      validate.onlyKeys(value, ['type'])
      const nativeAudio = type === 'native-audio-probe'
      if (nativeAudio && process.env.FAANGIN_SMOKE_NATIVE_AUDIO !== '1') throw new Error('Native system audio requires the explicit isolated smoke opt-in.')
      if (capturePermissionProbe || !fixtureCapture || fixtureCapture !== captureResources || fixtureCapture.stopped || !settings.systemAudio || !fence.acceptsFrames(captureGeneration)) throw new Error('Start the isolated system-audio fixture before probing permissions.')
      if (!captureWindow || captureWindow.isDestroyed()) captureWindow = windowFor('capture')
      await waitForSurface(captureWindow.webContents, new AbortController().signal)
      const probe: CapturePermissionProbe = { contents: captureWindow.webContents, reachedDisplayHandler: false, nativeAudio, sourceEnumerationStarted: false, sourcesEnumerated: false, sourceCount: 0, sourceSelected: false, callbackResponded: false, callbackGranted: false, requests: [] }
      capturePermissionProbe = probe
      let hardTimer: ReturnType<typeof setTimeout> | undefined
      try {
        if (nativeAudio) {
          const window = captureWindow
          // Destroying the owned surface also stops a native request that outlives its JS deadline.
          const result = await Promise.race([
            window.webContents.executeJavaScript(`(${probeNativeSystemAudio.toString()})()`, true),
            new Promise<never>((_resolve, reject) => { hardTimer = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); reject(new Error('Native system audio probe exceeded its cleanup deadline.')) }, 14_000) })
          ])
          return { ...result, nativeDisplay: { reachedDisplayHandler: probe.reachedDisplayHandler, sourceEnumerationStarted: probe.sourceEnumerationStarted, sourcesEnumerated: probe.sourcesEnumerated, sourceCount: probe.sourceCount, sourceSelected: probe.sourceSelected, callbackResponded: probe.callbackResponded, callbackGranted: probe.callbackGranted, ...(probe.sourceError ? { sourceError: probe.sourceError } : {}), screenAccess: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'not-applicable' } }
        }
        // Reach Electron's real permission callback, but deny source selection before
        // asking macOS for a screen/audio stream. No OS source or provider is opened.
        const result = await captureWindow.webContents.executeJavaScript(`navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(stream => { stream.getTracks().forEach(track => track.stop()); return { streamGranted: true } }, error => ({ streamGranted: false, error: error.name }))`, true)
        return { ...result, reachedDisplayHandler: probe.reachedDisplayHandler, observedLegacyDisplay: probe.requests.some(request => request.permission === 'media' && Array.isArray(request.mediaTypes) && request.mediaTypes.length === 0) }
      } finally { clearTimeout(hardTimer); if (capturePermissionProbe === probe) capturePermissionProbe = null }
    }
    if (type === 'image') {
      validate.onlyKeys(value, ['type', 'sessionId'])
      const image = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGNgGGzgP5F4iBhAFqCqASQ5fXAaQBYYBgbQHwAAq6FHuddDHPYAAAAASUVORK5CYII=', 'base64'))
      return addAttachment(validate.id(value.sessionId), 'Synthetic problem screenshot.png', image)
    }
    validate.onlyKeys(value, ['type', 'itemId', 'channel', 'text'])
    const resources = fixtureCapture
    if (!resources) throw new Error('Start the isolated live fixture first.')
    const channel = validate.channel(value.channel), itemId = validate.id(value.itemId), text = validate.text(value.text, 30_000, true)
    if (type === 'final') ingestFinalTranscript(resources, channel, itemId, text, Date.now())
    else if (!resources.stopped) {
      const id = `${resources.sessionId}:${resources.token}:${channel}:${itemId}`
      partialTranscripts.set(id, { id, sessionId: resources.sessionId, channel, text, timestamp: Date.now(), provisional: true })
      emit({ type: 'transcript-partial', sessionId: resources.sessionId, channel, itemId, text })
      const turn = partialTranscripts.get(id)!
      if (automaticReplyAllowed({ turn: { ...turn, provisional: false }, generation: resources.token, epoch: resources.epoch })) liveReplies.defer({ turn, generation: resources.token, epoch: resources.epoch })
    }
  })
  handle('state', [0, 0], event => state(BrowserWindow.fromWebContents(event.sender) === overlay ? 'overlay' : 'workspace'))
  handle('settings', [1, 1], (_event, patch) => {
    const changes = validate.settingsPatch(patch)
    const value = { ...settings, ...changes }
    const captureConnectionChanged = captureSolveConnectionIdentity(value) !== captureSolveConnectionIdentity(settings)
    const explicitLiveResume = patch && typeof patch === 'object' && 'liveSuggestions' in patch && patch.liveSuggestions === true && liveReplies.snapshot().phase === 'paused'
    const liveSettingsChanged = (['liveSuggestions', 'liveSuggestionSource', 'chatProvider', 'fastModel', 'smartModel', 'smartMode', 'compatibleChatEndpoint', 'compatibleChatModel', 'compatibleChatSmartModel', 'profile', 'jobDescription', 'instructions', 'outputLanguage', 'programmingLanguage', 'includeHistory', 'historyEnabled'] as const).some(key => value[key] !== settings[key])
    const phase = capturePolicy.state().phase
    if (!['idle', 'paused', 'suspended'].includes(phase) && (value.microphone !== settings.microphone || value.systemAudio !== settings.systemAudio || value.microphoneDeviceId !== settings.microphoneDeviceId || value.transcriptionModel !== settings.transcriptionModel || value.inputLanguage !== settings.inputLanguage)) throw new Error('Stop or pause capture before changing audio sources or transcription settings.')
    const previousBindings = shortcutManager.bindings()
    const collapseChanged = Object.hasOwn(changes, 'overlayCollapsed') && value.overlayCollapsed !== settings.overlayCollapsed
    if (collapseChanged && value.overlayCollapsed && overlay && !overlay.isDestroyed()) value.overlayExpandedHeight = overlayExpandedHeight(overlay.getBounds().height)
    const overlayLayoutChanged = collapseChanged || (Object.hasOwn(changes, 'overlayExpandedHeight') && value.overlayExpandedHeight !== settings.overlayExpandedHeight)
    const bindingsChanged = value.shortcutPreset !== settings.shortcutPreset || JSON.stringify(value.shortcutOverrides) !== JSON.stringify(settings.shortcutOverrides)
    if (bindingsChanged) { const result = shortcutManager.apply(resolveShortcutBindings(value.shortcutPreset, value.shortcutOverrides)); if (!result.ok) throw new Error(result.message) }
    try { settings = repo.saveSettings(value) } catch (error) { if (bindingsChanged) shortcutManager.apply(previousBindings); refreshMenu(); throw error }
    if (captureConnectionChanged && captureSolve.preparing()) captureSolve.cancel()
    if (liveSettingsChanged) { liveReplies.reset(); refreshLiveSuggestions() }
    else if (explicitLiveResume) refreshLiveSuggestions(true)
    if (!settings.historyEnabled) for (const id of new Set([currentSessionId, captureState.sessionId, ...[...requests.values()].map(request => request.sessionId)].filter((id): id is string => !!id))) { try { repo.makeEphemeral(id) } catch { /* Deleted requests cannot publish and need no RAM shadow. */ } }
    capturePolicy.configureIdleTimeout(settings.captureIdleMinutes * 60_000)
    if (overlayLayoutChanged) applyOverlayLayout()
    refreshMenu()
    applyDockPreference()
    nativeTheme.themeSource = settings.theme
    refreshAppearance()
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
    for (const window of uiWindows()) window.setContentProtection(settings.privacyMode)
    emitState(); return settings
  })
  handle('key-set', [1, 1], async (_event, value) => {
    if (capturePolicy.state().phase !== 'idle' || requests.size || connectionTest) throw new Error('Stop capture, running answers, and connection tests before replacing the key.')
    const key = validate.text(value, 1024).trim()
    if (!key.startsWith('sk-') || /\s/.test(key)) throw new Error('Enter a valid OpenAI API key.')
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('OS credential encryption is unavailable. No key was saved.')
    const path = userDataFile('openai.key.enc'), temporary = `${path}.${randomUUID()}.tmp`
    try { await writeFile(temporary, safeStorage.encryptString(key), { mode: 0o600 }); await rename(temporary, path); chmodSync(path, 0o600) } finally { await unlink(temporary).catch(() => {}) }
    emitState(); return { configured: true }
  })
  handle('key-remove', [0, 0], async () => { cancelRequests(); await stopCapture(); await unlink(userDataFile('openai.key.enc')).catch(error => { if (error.code !== 'ENOENT') throw error }); emitState() })
  handle('connection', [0, 0], async () => { try { return await verifyConfiguredModels(requireKey(), { ...settings }) } catch (error) { return { ok: false, message: safeError(error) } } })
  handle('compatible-key-set', [2, 2], async (_event, endpointValue, keyValue) => {
    if (requests.size || connectionTest) throw new Error('Stop running answers and connection tests before replacing the compatible chat key.')
    const endpoint = normalizeCompatibleChatEndpoint(endpointValue), apiKey = validate.text(keyValue, 1024).trim()
    if (endpoint !== settings.compatibleChatEndpoint) throw new Error('Save the compatible endpoint settings before saving its key.')
    if (/\s/.test(apiKey)) throw new Error('The compatible chat key must not contain whitespace.')
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('OS credential encryption is unavailable. No key was saved.')
    const path = userDataFile('compatible-chat.key.enc'), temporary = `${path}.${randomUUID()}.tmp`
    try { await writeFile(temporary, safeStorage.encryptString(JSON.stringify({ endpoint, apiKey })), { mode: 0o600 }); await rename(temporary, path); chmodSync(path, 0o600) } finally { await unlink(temporary).catch(() => {}) }
    emitState(); return { configured: true }
  })
  handle('compatible-key-remove', [0, 0], async () => { cancelRequests(); await unlink(userDataFile('compatible-chat.key.enc')).catch(error => { if (error.code !== 'ENOENT') throw error }); emitState() })
  handle('chat-connection', [0, 0], async () => {
    if (connectionTest) throw new Error('A connection test is already running. Stop it or wait for it to finish.')
    const snapshot = { ...settings }, controller = new AbortController(); connectionTest = controller
    try {
      const compatible = snapshot.chatProvider === 'compatible'
      const endpoint = compatible ? normalizeCompatibleChatEndpoint(snapshot.compatibleChatEndpoint) : null
      const credential = endpoint ? compatibleCredential(endpoint) : undefined
      const apiKey = compatible ? undefined : requireKey()
      const modelIds = [...new Set((compatible ? [snapshot.compatibleChatModel, snapshot.compatibleChatSmartModel] : [snapshot.fastModel, snapshot.smartModel]).filter(Boolean))]
      if (!modelIds.length) throw new Error('Save a Fast or Smart model before testing it.')
      const checks = []
      for (const model of modelIds) {
        if (controller.signal.aborted) break
        try {
          if (compatible) {
            const configuration = validateCompatibleChatConfiguration({ endpoint, model, vision: false })
            await generateCompatibleAnswer({ instructions: 'Reply with OK only.', input: [{ role: 'user', content: 'Connection test. Reply OK.' }], maxOutputTokens: 16, sources: { transcriptIds: [], attachmentIds: [], priorAnswerIds: [], memorySourceIds: [], truncated: false, provisional: false } }, configuration, { signal: controller.signal, credential, onDelta() {} })
          } else {
            const session: Session = { id: 'connection-test', title: 'Connection test', mode: 'meeting', status: 'idle', createdAt: 0, updatedAt: 0, notes: '', transcript: [], answers: [], attachments: [], contextEpoch: 0 }
            await generateAnswer({ action: 'ask', prompt: 'Connection test. Reply OK only.', settings: { ...DEFAULT_SETTINGS, fastModel: model, smartModel: model, instructions: 'Reply with OK only.' }, session, attachments: [] }, { apiKey: apiKey!, signal: controller.signal, maxOutputTokens: 'reasoning' in answerReasoning(model) && answerReasoning(model).reasoning?.effort === 'low' ? 512 : 16, onDelta() {} })
          }
          checks.push({ label: model, model, ok: true, message: 'A small streamed response completed. Vision and audio are not verified.' })
        } catch (error) { checks.push({ label: model, model, ok: false, message: safeError(error) }) }
      }
      return { ok: !controller.signal.aborted && checks.length > 0 && checks.every(check => check.ok), checks, message: controller.signal.aborted ? 'The generation test was cancelled.' : 'Configured chat models tested with one small generation each. This uses the selected service’s quota when applicable.' }
    } finally { if (connectionTest === controller) connectionTest = null }
  })
  handle('session-create', [1, 1], (_event, value) => { const created = repo.create(validate.mode(value)); if (currentSessionId) { manualPreparations.cancel(currentSessionId); captureSolve.cancel(currentSessionId) }; liveReplies.reset(); currentSessionId = created.id; refreshLiveSuggestions(); emitState(); return fullSession(created.id) })
  handle('session-select', [1, 1], (_event, value) => { const id = validate.id(value); if (!settings.historyEnabled) repo.makeEphemeral(id); const selected = fullSession(id); if (currentSessionId !== selected.id) { if (currentSessionId) { manualPreparations.cancel(currentSessionId); captureSolve.cancel(currentSessionId) }; liveReplies.reset() }; currentSessionId = selected.id; refreshLiveSuggestions(); emitState(); return selected })
  handle('session-update', [2, 2], (_event, value, patch) => { const id = validate.id(value), sessionPatch = validate.sessionPatch(patch); repo.shadowIfHistoryOff(id); const result = repo.update(id, sessionPatch); emitState(); return fullSession(result.id) })
  handle('session-list', [2, 3], (_event, query, trash, filter) => repo.list(validate.text(query, 500, true), validate.bool(trash), validate.sessionListFilter(filter)))
  handle('session-delete', [1, 1], async (_event, value) => { const id = validate.id(value); cancelRequests(id); if (captureState.sessionId === id || capturePolicy.state().sessionId === id) await stopCapture(); repo.trash(id); clearSessionAux(id); if (currentSessionId === id) currentSessionId = null; emitState() })
  handle('session-restore', [1, 1], (_event, value) => { repo.restore(validate.id(value)); emitState() })
  handle('session-purge', [1, 1], async (_event, value) => {
    const id = validate.id(value), session = repo.get(id, true)
    if (session.deletedAt === undefined) throw new Error('Move the session to Trash before deleting it permanently.')
    cancelRequests(id); if (captureState.sessionId === id || capturePolicy.state().sessionId === id) await stopCapture()
    const result = repo.deletePermanently(id)
    clearSessionAux(id)
    if (currentSessionId === id) currentSessionId = null
    if (result.cleanup === 'pending') emit({ type: 'error', code: 'deletion-checkpoint-pending', message: 'The session was deleted from the workspace. Database cleanup is pending because another reader is active; close other copies of Faangin. User exports and OS backups are outside app deletion.' })
    emitState()
  })
  handle('preset-manage', [1, 1], (_event, command) => {
    const value = validate.record(command), type = validate.oneOf(value.type, ['create', 'update', 'duplicate', 'delete', 'restore-defaults'])
    if (presetRecoveryRequired) throw new Error('The saved preset catalog needs recovery. Its record was preserved. Repair or restore the workspace before changing presets.')
    const next = new PresetCatalog(presetCatalog.snapshot())
    if (type === 'create') { validate.onlyKeys(value, ['type', 'draft']); next.create(value.draft) }
    else if (type === 'update') { validate.onlyKeys(value, ['type', 'id', 'draft', 'revision']); next.update(validate.id(value.id), value.draft, validate.generation(value.revision)) }
    else if (type === 'duplicate') { validate.onlyKeys(value, ['type', 'id']); next.duplicate(validate.id(value.id)) }
    else if (type === 'delete') { validate.onlyKeys(value, ['type', 'id']); next.delete(validate.id(value.id)) }
    else { validate.onlyKeys(value, ['type']); next.restoreDefaults() }
    savePresetCatalog(next); emitState(); return presetCatalog.snapshot()
  })
  handle('preset-select', [3, 3], (_event, sessionValue, kindValue, presetValue) => {
    if (presetRecoveryRequired) throw new Error('Recover the saved preset catalog before selecting presets.')
    const id = validate.id(sessionValue), session = repo.get(id), next = new PresetCatalog(presetCatalog.snapshot())
    repo.shadowIfHistoryOff(id)
    next.select(id, session.mode, validate.oneOf(kindValue, ['response', 'notes']), presetValue === null ? null : validate.id(presetValue))
    savePresetCatalog(next); emitState()
  })
  handle('memory-candidates', [2, 2], (_event, sessionValue, query) => priorCandidates(validate.id(sessionValue), validate.text(query, 200, true)))
  handle('memory-select', [2, 3], (_event, sessionValue, idsValue, displayedValue) => {
    const id = validate.id(sessionValue); if (!Array.isArray(idsValue) || idsValue.length > 4) throw new Error('Choose at most four excerpts.')
    repo.get(id)
    const ids = idsValue.map(value => validate.text(value, 1100)), prior = selectedMemory.get(id) ?? []
    const candidates = displayedValue === undefined ? priorCandidates(id) : displayedValue
    if (!Array.isArray(candidates) || candidates.length > 50) throw new Error('Refresh the bounded prior-session search.')
    const selected = prepareMemorySelection(id, ids, prior, candidates, source => repo.get(source))
    selectedMemory.set(id, selected); emitState(); return structuredClone(selected)
  })
  handle('memory-edit', [3, 3], (_event, sessionValue, sourceValue, text) => {
    const id = validate.id(sessionValue); repo.get(id)
    const selected = editMemorySnippet(id, selectedMemory.get(id) ?? [], validate.text(sourceValue, 1100), validate.text(text, 2000))
    resolveMemorySnippets(id, selected, source => repo.get(source)); selectedMemory.set(id, selected); emitState(); return structuredClone(selected)
  })
  handle('diagnostics-export', [0, 0], async event => {
    const content = diagnosticJSON({ platform: process.platform, arch: process.arch, versions: { app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, os: release() }, permissions: permissions(), settings, credential: { configured: settings.chatProvider === 'compatible' ? compatibleKeyConfigured() : keyConfigured(), encryptionAvailable: safeStorage.isEncryptionAvailable() }, capture: captureState, storage: repo.diagnostics(), runtime: { pendingRequests: requests.size, selectedImages: currentSessionId ? attachmentSelection.get(currentSessionId).length : 0 }, timings: timingSamples, errorCodes: diagnosticErrors })
    const selection = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, { defaultPath: 'Faangin-diagnostics.json', filters: [{ name: 'Diagnostics metadata', extensions: ['json'] }] })
    if (selection.canceled || !selection.filePath) return null
    await writeFile(selection.filePath, content, { mode: 0o600 }); return { path: selection.filePath }
  })
  handle('session-reset', [1, 1], async (_event, value) => { const id = validate.id(value); cancelRequests(id); repo.shadowIfHistoryOff(id); const result = repo.reset(id); clearSessionAux(id); if (captureState.sessionId === id || capturePolicy.state().sessionId === id) await stopCapture(); emitState(); return result })
  handle('transcript', [2, 2], (_event, value, text) => { const id = validate.id(value), body = validate.text(text, 100_000); repo.shadowIfHistoryOff(id); const turn = repo.transcript(id, 'manual', body); emit({ type: 'transcript-final', turn }); emitState(); return turn })
  handle('generate', [1, 1], (_event, input) => generateManual(validate.generateInput(input)))
  handle('cancel', [1, 1], (_event, value) => {
    const request = requests.get(validate.id(value))
    if (request?.answer.origin === 'automatic') { liveReplies.reset(); refreshLiveSuggestions() }
    request?.abort.abort()
  })
  handle('sources', [0, 0], async () => (await screenshotCapture.listSources()).map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(), displayId: source.display_id, scaleFactor: source.id.startsWith('screen:') ? screen.getAllDisplays().find(display => String(display.id) === source.display_id)?.scaleFactor : undefined })))
  handle('microphone-devices', [0, 0], () => microphoneInventory())
  handle('screenshot', [1, 2], (_event, value, source) => screenshot(validate.id(value), source === undefined ? undefined : validate.text(source, 256, true)))
  handle('capture-solve', [1, 1], (_event, value) => captureAndSolve(validate.id(value)))
  handle('region-preview', [1, 2], async (event, value, source) => {
    const ownerId = String(event.sender.id)
    if (!regionOwners.has(event.sender)) { regionOwners.add(event.sender); event.sender.once('destroyed', () => screenshotRegions.clearOwner(ownerId)) }
    const preview = await previewScreenshotRegion(validate.id(value), ownerId, source === undefined ? undefined : validate.text(source, 256, true))
    if (event.sender.isDestroyed()) { screenshotRegions.clearOwner(ownerId); throw new Error('The region preview window closed before capture finished.') }
    return preview
  })
  handle('region-commit', [3, 3], (event, value, preview, region) => {
    const id = validate.id(value); repo.get(id)
    const displays = screen.getAllDisplays().map(display => ({ id: String(display.id), width: display.bounds.width, height: display.bounds.height, scaleFactor: display.scaleFactor }))
    return screenshotRegions.commit(validate.id(preview), id, String(event.sender.id), repo.epoch(id), displays, region, (frame, rectangle) => {
      const cropped = frame.image.crop(rectangle), size = cropped.getSize()
      if (cropped.isEmpty() || size.width !== rectangle.width || size.height !== rectangle.height) throw new Error('The region pixel bounds could not be verified. Capture a new preview.')
      return addAttachment(id, `${frame.name} · region`, cropped)
    })
  })
  handle('region-discard', [1, 1], (event, preview) => screenshotRegions.discard(validate.id(preview), String(event.sender.id)))
  handle('image-import', [1, 1], async (event, value) => {
    const id = validate.id(value); repo.get(id)
    const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    if (selected.canceled) return null
    const path = selected.filePaths[0], bytes = await readBounded(path, 8 * 1024 * 1024)
    validate.imageSize(bytes)
    const image = nativeImage.createFromBuffer(bytes); return addAttachment(id, basename(path), image)
  })
  handle('attachment-remove', [2, 2], (_event, value, attachment) => { const id = validate.id(value); repo.get(id); const attachmentId = validate.id(attachment); attachments.set(id, (attachments.get(id) ?? []).filter(image => image.id !== attachmentId)); attachmentSelection.removed(id, attachmentId); captureSolveImages.removed(id, attachmentId); emitState() })
  handle('attachment-selection', [2, 2], (_event, value, selected) => {
    const id = validate.id(value); repo.get(id)
    if (!Array.isArray(selected)) throw new Error('Choose a list of screenshot IDs.')
    attachmentSelection.set(id, selected.map(validate.id), (attachments.get(id) ?? []).map(image => image.id)); emitState()
  })
  handle('attachment-order', [2, 2], (_event, value, ordered) => {
    const id = validate.id(value); repo.get(id)
    if (!Array.isArray(ordered)) throw new Error('Choose an ordered list of screenshot IDs.')
    const next = reorderSessionAttachments(id, attachments.get(id) ?? [], ordered.map(validate.id), attachmentSelection.get(id))
    attachmentSelection.set(id, next.selectedIds, next.attachments.map(image => image.id)); attachments.set(id, next.attachments); emitState()
  })
  handle('capture-start', [1, 1], (_event, value) => startCapture(validate.id(value)))
  handle('capture-stop', [0, 0], () => stopCapture())
  handle('capture-pause', [0, 0], () => pauseCapture())
  handle('capture-resume', [1, 1], (_event, value) => resumeCapture(validate.id(value)))
  handle('profile-import', [0, 0], async event => {
    const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { properties: ['openFile'], filters: [{ name: 'Profile documents', extensions: ['txt', 'md', 'pdf', 'docx'] }] })
    if (selected.canceled) return null
    const path = selected.filePaths[0], bytes = await readBounded(path, 10 * 1024 * 1024), extension = extname(path).toLowerCase()
    if (extension === '.txt' || extension === '.md') return validate.text(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 100_000)
    if (extension === '.pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('This file is not a PDF.')
    if (extension === '.docx') validateDocxArchive(bytes)
    return parseDocument(bytes, validate.oneOf(extension.slice(1), ['pdf', 'docx']))
  })
  handle('export', [2, 2], async (event, value, formatValue) => {
    const session = fullSession(validate.id(value), true), format = validate.oneOf(formatValue, ['markdown', 'json'])
    const selected = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, { defaultPath: `${session.title.replace(/[^\w .-]/g, '_')}.${format === 'json' ? 'json' : 'md'}`, filters: [{ name: format, extensions: [format === 'json' ? 'json' : 'md'] }] })
    if (selected.canceled || !selected.filePath) return null
    const content = format === 'json' ? JSON.stringify({ ...session, attachments: session.attachments.map(({ dataUrl: _data, ...metadata }) => metadata) }, null, 2) : sessionMarkdown(session)
    await writeFile(selected.filePath, content, { mode: 0o600 }); return { path: selected.filePath }
  })
  handle('window-open', [1, 2], (_event, kindValue, viewValue) => {
    const kind = validate.windowKind(kindValue), view = viewValue === undefined ? undefined : validate.oneOf(viewValue, ['workspace', 'library', 'settings'] as const)
    if (kind === 'overlay') requireAccessSetup()
    if (kind === 'overlay') makeOverlayInteractive()
    else showWindow(kind)
    const target = kind === 'workspace' ? workspace : overlay
    if (view && target) { const navigate = () => target.webContents.send('faangin:event', { type: 'navigate', view } satisfies AppEvent); if (target.webContents.isLoading()) target.webContents.once('did-finish-load', navigate); else navigate() }
  })
  handle('overlay-hide', [0, 0], () => overlayInteraction.hide())
  handle('overlay-resize', [1, 1], (_event, value) => {
    const size = validate.record(value); validate.onlyKeys(size, ['width', 'height'])
    resizeOverlay({ width: Math.round(validate.finite(size.width, 1, 10_000)), height: Math.round(validate.finite(size.height, 1, 10_000)) })
  })
  handle('overlay-reset-layout', [0, 0], () => resetOverlayLayout())
  handle('click-through', [1, 1], (_event, enabled) => {
    const value = validate.bool(enabled)
    if (!value) { makeOverlayInteractive(); return }
    if (!overlay || overlay.isDestroyed()) throw new Error('Open the overlay before changing interaction.')
    overlayInteraction.setPassive(true); refreshMenu(); emitState()
  })
  handle('permissions', [1, 1], async (_event, value) => {
    const kind = validate.oneOf(value, ['microphone', 'screen', 'system-audio'])
    await openPermissionSettings(kind)
  })
  handle('permission-request', [1, 1], async (_event, value) => {
    const kind = validate.oneOf(value, ['microphone', 'screen', 'system-audio'])
    if (accessRequestPending) throw new Error('Finish the current system permission request before starting another.')
    accessRequestPending = true; accessTelemetry.permissionRequests++
    try {
      if (kind === 'system-audio') { await requestComputerAudioAccess(); return }
      await requestSetupPermission(kind, {
        platform: process.platform,
        status: permission => permissions()[permission],
        requestMicrophone: async () => { if (accessFixtureEnabled) { accessFixturePermissions.microphone = 'granted'; return true }; return systemPreferences.askForMediaAccess('microphone') },
        enumerateScreens: async () => { if (accessFixtureEnabled) { accessFixturePermissions.screen = 'granted'; return [] }; return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }) },
        openSettings: openPermissionSettings
      })
    } finally { accessRequestPending = false; refreshAccessReadiness() }
  })
  handle('access-refresh', [0, 0], () => refreshAccessReadiness())
  handle('system-audio-consent', [0, 0], () => { repo.saveConfiguration('system-audio-consent', systemAudioConsentReceipt()); systemAudioConsent = true; emitState() })
  handle('access-complete', [0, 0], () => {
    if (accessRequestPending || !accessSetupState().ready) throw new Error('Allow screen and microphone access, then verify computer audio before continuing.')
    settings = repo.saveSettings({ ...settings, microphone: true, systemAudio: true, liveSuggestionSource: 'system', liveSuggestions: false })
    accessSetup.complete(permissions())
    refreshMenu(); emitState()
  })
  ipcMain.on('faangin:document-result', (event, idValue, textValue, errorValue) => {
    try { validSender(event, 'document'); const id = validate.id(idValue), job = documentJobs.get(id); if (!job || job.window.webContents !== event.sender) return; if (errorValue !== undefined) job.reject(new Error(validate.text(errorValue, 1000))); else job.resolve(validate.text(textValue, 100_000)) } catch {}
  })
  ipcMain.on('faangin:microphone-inventory-result', (event, idValue, devices, failed) => {
    try { validSender(event, 'capture') } catch { return }
    const job = microphoneInventoryJob
    if (!job || typeof idValue !== 'string' || job.id !== idValue || job.window.webContents !== event.sender) return
    try {
      if (failed === true) job.reject(new Error('Microphones could not be listed. Check system permissions and refresh devices.'))
      else job.resolve(validateMicrophoneInventory(devices))
    } catch { job.reject(new Error('Microphone inventory was unavailable. Refresh devices again.')) }
  })
  function captureMessage(channelName: string, callback: (...args: unknown[]) => void): void {
    ipcMain.on(`faangin:${channelName}`, (event, tokenValue, channelValue, ...args: unknown[]) => {
      try { validSender(event, 'capture'); const token = validate.generation(tokenValue), channel = validate.channel(channelValue); if (!fence.acceptsFrames(token) || token !== captureGeneration || revokedChannels.has(channel)) return; callback(channel, ...args) } catch { /* Reject malformed/untrusted fire-and-forget IPC without crashing main. */ }
    })
  }
  captureMessage('audio', (value, frame) => {
    const channel = value as AudioChannel, bytes = validate.pcm(frame), now = Date.now(), budget = capturesPerSecond.get(channel)
    const next = !budget || now - budget.at >= 1000 ? { at: now, bytes: 0 } : budget
    next.bytes += bytes.length; capturesPerSecond.set(channel, next)
    if (next.bytes > 96_000) { captureState[channel] = 'Audio overflow — source stopped.'; emitCapture(); releaseChannel(captureGeneration, channel); return }
    if (bytes.byteLength) captureLifecycle.activity(captureGeneration, 1)
    live.get(channel)?.write(bytes)
  })
  captureMessage('commit-audio', value => { const channel = value as AudioChannel; commits.set(channel, (commits.get(channel) ?? 0) + 1); live.get(channel)?.commit() })
  captureMessage('capture-report', (value, status, failedValue) => {
    const channel = value as AudioChannel, failed = failedValue === undefined ? false : validate.bool(failedValue)
    captureState[channel] = validate.text(status, 1000)
    if (!failed && captureState[channel] === 'Listening') reportCaptureReady(channel)
    emitCapture()
    if (failed) {
      if (channel === 'system') accessSetup.finishAudioCheck(false, 'Computer audio access needs to be checked again after the audio source stopped.')
      emit({ type: 'error', message: `${channel === 'system' ? 'System audio' : 'Microphone'}: ${captureState[channel]}`, code: 'capture_failed' }); releaseChannel(captureGeneration, channel)
      refreshAccessReadiness()
    }
  })
  captureMessage('audio-level', (value, level) => emit({ type: 'audio-level', channel: value as AudioChannel, level: validate.finite(level, 0, 1) }))
  ipcMain.on('faangin:devices-change', (event, tokenValue) => {
    try { validSender(event, 'capture'); const token = validate.generation(tokenValue); if (token === captureGeneration && fence.acceptsFrames(token)) scheduleDeviceReconnect() } catch {}
  })
}
function shortcutAction(action: string): void {
  if (action === 'show-workspace') { showWindow('workspace'); return }
  if (action === 'stop') { cancelRequests(); void stopCapture(); return }
  if (action === 'hide' && overlayInteraction.desiredVisible) { overlayInteraction.hide(); return }
  if (accessSetupBlocked()) return
  if (action === 'toggle-interaction') {
    if (overlayInteraction.passive) makeOverlayInteractive()
    else { overlayInteraction.setPassive(true); showWindow('overlay'); refreshMenu() }
    return
  }
  if (action === 'hide') {
    if (overlayInteraction.desiredVisible) overlayInteraction.hide()
    else makeOverlayInteractive()
    return
  }
  if (action.startsWith('move-')) {
    showWindow('overlay')
    const bounds = overlay!.getBounds(), delta = 32
    overlay!.setBounds({ ...bounds, x: bounds.x + (action === 'move-left' ? -delta : action === 'move-right' ? delta : 0), y: bounds.y + (action === 'move-up' ? -delta : action === 'move-down' ? delta : 0) })
    windowState?.reflow('overlay'); return
  }
  if (action === 'scroll-up' || action === 'scroll-down') {
    const target = overlay?.isVisible() ? overlay : workspace
    if (target) sendUI(target, { type: 'shortcut', action }); return
  }
  if (!currentSessionId) { emit({ type: 'error', message: 'Create a session in the workspace first.' }); showWindow('overlay'); return }
  if (action === 'toggle-capture') {
    const { phase, sessionId: pausedId } = capturePolicy.state()
    const sessionId = currentSessionId
    void (phase === 'idle' ? startCapture(sessionId) : phase === 'paused' ? (async () => { requireSystemAudioConsent(pausedId ?? sessionId, true); await captureLifecycle.resume() })() : stopCapture()).catch(error => emit({ type: 'error', message: safeError(error) })); return
  }
  if (action === 'reset') { showWindow('workspace'); if (workspace) sendUI(workspace, { type: 'shortcut', action: 'reset' }); return }
  if (action === 'capture-solve') { void captureAndSolve(currentSessionId).catch(error => emit({ type: 'error', message: safeError(error) })); return }
  if (action === 'assist' || action === 'solve' || action === 'reply') { const focused = BrowserWindow.getFocusedWindow(); if (focused && uiWindows().includes(focused)) { focused.webContents.send('faangin:event', { type: 'shortcut', action } satisfies AppEvent); return } }
  if (action === 'screenshot') { void screenshot(currentSessionId).catch(error => emit({ type: 'error', message: safeError(error) })); return }
  const sessionId = currentSessionId, presentation = overlayInteraction.checkpoint()
  void (async () => generateManual(shortcutGenerationInput(repo.get(sessionId), action as Action, attachmentSelection.get(sessionId))))().then(() => showWindow('overlay', presentation), error => { emit({ type: 'error', message: safeError(error) }); showWindow('overlay', presentation) })
}
function refreshMenu(): void {
  const configured = resolveShortcutBindings(settings.shortcutPreset, settings.shortcutOverrides)
  const active = shortcutManager.bindings()
  shortcuts.splice(0, shortcuts.length, ...configured.map(binding => ({ id: binding.action, action: binding.label, accelerator: binding.accelerator, registered: !smoke && active.some(item => item.action === binding.action && item.accelerator === binding.accelerator) })))
  const actions: Array<{ action: string; label: string }> = [
    { action: 'capture-solve', label: 'Capture & solve' }, { action: 'assist', label: 'Assist' }, { action: 'reply', label: 'Suggested reply' }, { action: 'screenshot', label: 'Capture screenshot' }, { action: 'solve', label: 'Solve' }, { action: 'reset', label: 'Reset problem context…' }, { action: 'toggle-capture', label: 'Start / stop capture' }, { action: 'stop', label: 'Stop capture' }, { action: 'hide', label: 'Show / hide overlay' }
  ]
  const recovery: Electron.MenuItemConstructorOptions[] = [
    { label: `Faangin ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Show workspace', accelerator: active.find(binding => binding.action === 'show-workspace')?.accelerator, click: () => showWindow('workspace') },
    { label: 'Show overlay', click: () => makeOverlayInteractive() },
    { id: 'overlay-reset-layout', label: 'Reset overlay size & position', click: () => { try { resetOverlayLayout(); makeOverlayInteractive() } catch (error) { emit({ type: 'error', message: `Overlay layout could not be reset: ${safeError(error)}` }) } } },
    { label: 'Make overlay interactive', click: () => makeOverlayInteractive() },
    { label: 'Click-through overlay', type: 'checkbox', checked: overlayInteraction.passive, accelerator: active.find(binding => binding.action === 'toggle-interaction')?.accelerator, click: () => shortcutAction('toggle-interaction') },
    ...(process.platform === 'darwin' ? [{ label: 'Show in Dock', type: 'checkbox' as const, checked: !settings.hideDockIcon, click: () => {
      try { settings = repo.saveSettings({ ...settings, hideDockIcon: !settings.hideDockIcon }); applyDockPreference(); refreshMenu(); emitState() }
      catch (error) { emit({ type: 'error', message: `Dock preference could not be saved: ${safeError(error)}` }); refreshMenu() }
    } }] : []),
    { type: 'separator' },
    ...actions.map(item => ({ label: item.label, accelerator: active.find(binding => binding.action === item.action)?.accelerator, click: () => shortcutAction(item.action) })),
    { type: 'separator' }, { label: 'Settings', click: () => { showWindow('workspace'); emit({ type: 'navigate', view: 'settings' }) } }, { role: 'quit' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Faangin', submenu: recovery }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  tray?.setContextMenu(Menu.buildFromTemplate(recovery))
}
function setupMenu(): void {
  const result = applyStartupShortcutBindings(shortcutManager, settings.shortcutPreset, settings.shortcutOverrides)
  if (!result.ok) emit({ type: 'error', message: result.message })
  if (!smoke) {
    const image = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGNgGGzgP5F4iBhAFqCqASQ5fXAaQBYYBgbQHwAAq6FHuddDHPYAAAAASUVORK5CYII=')
    image.setTemplateImage(true); tray = new Tray(image); tray.setToolTip(`Faangin ${app.getVersion()}`)
  }
  refreshMenu()
}
if (!smoke && !app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => showWindow('workspace'))
  app.whenReady().then(async () => {
    const data = app.getPath('userData'); mkdirSync(data, { recursive: true, mode: 0o700 }); chmodSync(data, 0o700)
    repo = new Repository(userDataFile('faangin.sqlite')); settings = repo.settings()
    let savedAccessSetup: unknown
    try { savedAccessSetup = repo.configuration('access-setup') } catch { /* Preserve an unreadable receipt and require setup again. */ }
    if (accessFixtureMode === 'ready') savedAccessSetup = { version: 1, completed: true, systemAudioVerifiedAt: Date.now() }
    accessSetup = new AccessSetupCoordinator(savedAccessSetup, value => repo.saveConfiguration('access-setup', value))
    try { systemAudioConsent = systemAudioConsented(repo.configuration('system-audio-consent')) } catch { /* An unreadable acknowledgment shows the notice again. */ }
    if (accessFixtureMode === 'ready') accessSetup.finishAudioCheck(true)
    try { presetCatalog = new PresetCatalog(repo.configuration('preset-catalog')) } catch { presetRecoveryRequired = true }
    savedPresetSnapshot = presetCatalog.snapshot()
    windowState = new WindowStateManager(screen, jsonWindowStateStore(userDataFile('window-state.json')), error => emit({ type: 'error', code: 'save-failed', message: `Window position could not be saved: ${safeError(error)}` }))
    setupAppearance(); setupIPC(); registerBillingIpc(); setupMenu(); applyDockPreference(); setupCapturePolicy()
    currentSessionId = repo.list()[0]?.id ?? null; workspace = windowFor('index', 'workspace')
    workspace.webContents.once('did-finish-load', () => {
      // The completed setup records consent for one no-sample capability recheck on a later launch.
      // Focus/poll refreshes remain read-only and never repeat this request.
      if (accessFixtureMode === 'ready' || !accessSetup.mayRecheckOnStartup(permissions())) return
      accessRequestPending = true
      void requestComputerAudioAccess(true).catch(() => {}).finally(() => { accessRequestPending = false; refreshAccessReadiness() })
    })
    if (smoke && process.env.FAANGIN_SMOKE_READY) {
      workspace.webContents.once('did-finish-load', async () => {
        try {
          const diagnostics = await workspace!.webContents.executeJavaScript('(async () => ({ state: await window.faangin.getState(), security: { sandbox: window.faanginSmoke?.sandbox, contextIsolation: window.faanginSmoke?.contextIsolation }, nodeIntegration: typeof window.require !== "undefined" }))()')
          const workflow = await workspace!.webContents.executeJavaScript(`(async () => {
            const api = window.faangin;
            const session = await api.createSession('interview');
            const brief = { company: 'Fixture company', role: 'Software engineer', round: 'coding', stage: 'verify', problem: 'Return two indices with the target sum.', constraints: 'Distinct indices; integers.', candidateAttempt: 'def two_sum(values, target):\\n    return []' };
            await api.updateSession(session.id, { interview: brief });
            await api.appendTranscript(session.id, 'How would you handle duplicate values?');
            await api.selectAttachments(session.id, []);
            await api.updateSettings({ opacity: 0 });
            const updated = await api.getState();
            const interviewReady = updated.currentSession.interview.problem === brief.problem && updated.currentSession.interview.candidateAttempt === brief.candidateAttempt && updated.currentSession.transcript.length === 1 && updated.currentSession.selectedAttachmentIds.length === 0;
            const transparencyReady = updated.settings.opacity === 0;
            await api.resetContext(session.id);
            const reset = await api.getState();
            const resetReady = reset.currentSession.interview.problem === '' && reset.currentSession.transcript.length === 0;
            await api.deleteSession(session.id);
            await api.restoreSession(session.id);
            const restored = await api.selectSession(session.id);
            return { interviewReady, transparencyReady, resetReady, restoreReady: restored.id === session.id };
          })()`)
          if (!workflow.interviewReady || !workflow.transparencyReady || !workflow.resetReady || !workflow.restoreReady) throw new Error('Isolated interview workflow checks did not pass.')
          let documentImports: { pdf: boolean; docx: boolean } | undefined
          const fixtureDirectory = process.env.FAANGIN_SMOKE_DOCUMENT_FIXTURES_DIR
          if (fixtureDirectory) {
            const pdf = await readBounded(join(resolve(fixtureDirectory), 'profile.pdf'), 10 * 1024 * 1024)
            const docx = await readBounded(join(resolve(fixtureDirectory), 'profile.docx'), 10 * 1024 * 1024)
            validateDocxArchive(docx)
            const pdfText = await parseDocument(pdf, 'pdf'), docxText = await parseDocument(docx, 'docx')
            documentImports = { pdf: pdfText.includes('Faangin document fixture'), docx: docxText.includes('Faangin document fixture') }
            if (!documentImports.pdf || !documentImports.docx) throw new Error('Sandboxed document fixture extraction did not match expected text.')
          }
          await writeFile(process.env.FAANGIN_SMOKE_READY!, JSON.stringify({
            version: app.getVersion(), windowCount: BrowserWindow.getAllWindows().length,
            keyConfigured: diagnostics.state.keyConfigured, sqliteReady: true,
            startupSession: { id: diagnostics.state.currentSession?.id ?? null, historyEnabled: diagnostics.state.settings.historyEnabled, persistent: diagnostics.state.currentSession?.persistent ?? null },
            security: { sandbox: diagnostics.security?.sandbox === true, contextIsolation: diagnostics.security?.contextIsolation === true, nodeIntegration: diagnostics.nodeIntegration },
            rendererReady: true, workflow, ...(documentImports ? { documentImports } : {})
          }), { mode: 0o600 })
        } catch (error) { await writeFile(process.env.FAANGIN_SMOKE_READY!, JSON.stringify({ error: safeError(error) })) }
      })
    }
  }).catch(error => { dialog.showErrorBox('Faangin could not start', safeError(error)); app.exit(1) })
}
app.on('activate', () => {
  // Accessory-policy changes and explicit overlay interaction can activate the
  // app too. They must not open a workspace over the app beneath the overlay.
  if (repo && !quitting && (!smoke || smokeVisible) && !(process.platform === 'darwin' && settings.hideDockIcon) && !overlayInteraction.desiredVisible && !uiWindows().some(window => window.isVisible())) showWindow('workspace')
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smoke) app.quit() })
app.on('web-contents-created', (_event, contents) => { contents.session.on('will-download', event => event.preventDefault()) })
app.on('before-quit', event => {
  if (quitting) return
  for (const window of uiWindows()) window.webContents.session.flushStorageData()
  event.preventDefault(); quitting = true; dockPolicy.dispose(); disposeAppearance(); disposeCapturePolicy(); windowState?.dispose(); cancelRequests(); shortcutManager.dispose(); tray?.destroy()
  void stopCapture().finally(() => { repo?.close(); app.exit(0) })
})
process.on('SIGTERM', () => { for (const window of uiWindows()) window.webContents.session.flushStorageData(); quitting = true; liveReplies.reset(); app.exit(0) })
