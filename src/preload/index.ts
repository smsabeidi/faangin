import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, CaptureCommand, FaanginAPI } from '../shared/types'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(`faangin:${channel}`, ...args)
function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const callback = (_event: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, callback)
  return () => ipcRenderer.removeListener(channel, callback)
}
if (process.argv.includes('--faangin-smoke')) contextBridge.exposeInMainWorld('faanginSmoke', Object.freeze({ sandbox: process.sandboxed, contextIsolation: process.contextIsolated,
  ...(process.argv.includes('--faangin-live-fixture') ? { liveFixture: (command: unknown) => invoke('smoke-live', command) } : {})
}))
const surface = process.argv.find(argument => argument.startsWith('--faangin-surface='))?.split('=')[1]
if (surface === 'capture') {
  contextBridge.exposeInMainWorld('faangin', Object.freeze({
    onCaptureCommand: (listener: (command: CaptureCommand) => void) => listen('faangin:capture-command', listener),
    sendAudio: (generation: number, channel: string, pcm: ArrayBuffer) => ipcRenderer.send('faangin:audio', generation, channel, pcm),
    commitAudio: (generation: number, channel: string, utteranceComplete: boolean) => ipcRenderer.send('faangin:commit-audio', generation, channel, utteranceComplete),
    reportCapture: (generation: number, channel: string, status: string, failed?: boolean) => ipcRenderer.send('faangin:capture-report', generation, channel, status, failed),
    reportAudioLevel: (generation: number, channel: string, level: number) => ipcRenderer.send('faangin:audio-level', generation, channel, level),
    reportDevicesChanged: (generation: number) => ipcRenderer.send('faangin:devices-change', generation),
    onMicrophoneInventory: (listener: (requestId: string) => void) => listen('faangin:microphone-inventory-command', listener),
    reportMicrophoneInventory: (requestId: string, devices: unknown, failed?: boolean) => ipcRenderer.send('faangin:microphone-inventory-result', requestId, devices, failed)
  }))
} else if (surface === 'document') {
  contextBridge.exposeInMainWorld('faanginDocument', Object.freeze({
    onParse: (listener: (command: { id: string; format: string; bytes: ArrayBuffer }) => void) => listen('faangin:document-command', listener),
    result: (id: string, text: string, error?: string) => ipcRenderer.send('faangin:document-result', id, text, error)
  }))
} else {
  const api: Omit<FaanginAPI, 'onCaptureCommand' | 'sendAudio' | 'commitAudio' | 'reportCapture' | 'reportAudioLevel' | 'reportDevicesChanged' | 'onMicrophoneInventory' | 'reportMicrophoneInventory'> = {
    getState: () => invoke('state'), updateSettings: patch => invoke('settings', patch),
    setApiKey: key => invoke('key-set', key), removeApiKey: () => invoke('key-remove'), testConnection: () => invoke('connection'),
    setCompatibleApiKey: (endpoint, key) => invoke('compatible-key-set', endpoint, key), removeCompatibleApiKey: () => invoke('compatible-key-remove'), testChatConnection: () => invoke('chat-connection'),
    createSession: mode => invoke('session-create', mode), selectSession: id => invoke('session-select', id),
    updateSession: (id, patch) => invoke('session-update', id, patch), deleteSession: id => invoke('session-delete', id), restoreSession: id => invoke('session-restore', id),
    permanentlyDeleteSession: id => invoke('session-purge', id),
    listSessions: (query = '', trash = false, filter) => invoke('session-list', query, trash, filter), resetContext: id => invoke('session-reset', id),
    appendTranscript: (id, text) => invoke('transcript', id, text), generate: input => invoke('generate', input), cancelGeneration: id => invoke('cancel', id),
    listCaptureSources: () => invoke('sources'), captureScreen: (id, source) => invoke('screenshot', id, source), importImage: id => invoke('image-import', id),
    captureAndSolve: id => invoke('capture-solve', id),
    previewScreenshotRegion: (id, source) => invoke('region-preview', id, source), commitScreenshotRegion: (id, preview, region) => invoke('region-commit', id, preview, region), discardScreenshotRegion: preview => invoke('region-discard', preview),
    listMicrophoneDevices: () => invoke('microphone-devices'),
    removeAttachment: (id, attachment) => invoke('attachment-remove', id, attachment), startCapture: id => invoke('capture-start', id), stopCapture: () => invoke('capture-stop'),
    selectAttachments: (id, attachments) => invoke('attachment-selection', id, attachments),
    reorderAttachments: (id, attachments) => invoke('attachment-order', id, attachments),
    pauseCapture: () => invoke('capture-pause'), resumeCapture: id => invoke('capture-resume', id),
    managePreset: command => invoke('preset-manage', command), choosePreset: (id, kind, preset) => invoke('preset-select', id, kind, preset),
    memoryCandidates: (id, query = '') => invoke('memory-candidates', id, query), selectMemory: (id, sources, displayed) => invoke('memory-select', id, sources, displayed), editMemory: (id, source, text) => invoke('memory-edit', id, source, text),
    exportDiagnostics: () => invoke('diagnostics-export'),
    exportSession: (id, format) => invoke('export', id, format), importProfile: () => invoke('profile-import'),
    openWindow: (kind, view) => invoke('window-open', kind, view), hideOverlay: () => invoke('overlay-hide'), resizeOverlay: size => invoke('overlay-resize', size), resetOverlayLayout: () => invoke('overlay-reset-layout'), setClickThrough: enabled => invoke('click-through', enabled),
    openPermissionSettings: kind => invoke('permissions', kind), requestPermission: kind => invoke('permission-request', kind), refreshAccessSetup: () => invoke('access-refresh'), completeAccessSetup: () => invoke('access-complete'), acknowledgeSystemAudioConsent: () => invoke('system-audio-consent'),
    getBilling: () => invoke('billing-state'), billingSignIn: () => invoke('billing-sign-in'), billingCancelSignIn: () => invoke('billing-cancel-sign-in'), billingSignOut: () => invoke('billing-sign-out'), billingRefresh: () => invoke('billing-refresh'),
    billingCheckout: plan => invoke('billing-checkout', plan), billingManage: () => invoke('billing-manage'), onBillingChange: listener => listen('faangin:billing-change', listener),
    onEvent: (listener: (event: AppEvent) => void) => listen('faangin:event', listener)
  }
  contextBridge.exposeInMainWorld('faangin', Object.freeze(api))
}
