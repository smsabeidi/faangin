export type WorkspaceMode = 'meeting' | 'interview'
export type SessionStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'ended'
export type AudioChannel = 'microphone' | 'system'
export type Action = 'ask' | 'assist' | 'reply' | 'followup' | 'draft' | 'recap' | 'hint' | 'solve' | 'review' | 'debug' | 'design' | 'behavioral' | 'notes'
export type WindowKind = 'workspace' | 'overlay'

export const OVERLAY_OPACITY = { min: 0, max: 1, step: 0.01 } as const

export interface InterviewContext {
  company: string
  role: string
  round: 'coding' | 'system-design' | 'behavioral'
  stage: 'clarify' | 'approach' | 'implement' | 'verify' | 'optimize'
  problem: string
  constraints: string
  candidateAttempt: string
}
export const DEFAULT_INTERVIEW_CONTEXT: InterviewContext = { company: '', role: '', round: 'coding', stage: 'clarify', problem: '', constraints: '', candidateAttempt: '' }

export interface Settings {
  fastModel: string
  smartModel: string
  transcriptionModel: string
  inputLanguage: string
  outputLanguage: string
  programmingLanguage: string
  profile: string
  jobDescription: string
  instructions: string
  noteTemplate: string
  theme: 'dark' | 'light' | 'system'
  opacity: number
  overlayCollapsed: boolean
  overlayExpandedHeight: number
  fontSize: number
  microphone: boolean
  systemAudio: boolean
  liveSuggestions: boolean
  liveSuggestionSource: AudioChannel
  microphoneDeviceId: string
  screenshotSourceId: string
  privacyMode: boolean
  includeHistory: boolean
  launchAtLogin: boolean
  hideDockIcon: boolean
  smartMode: boolean
  historyEnabled: boolean
  shortcutPreset: ShortcutPreset
  shortcutOverrides: ShortcutOverrides
  captureIdleMinutes: number
  chatProvider: 'openai' | 'compatible'
  compatibleChatEndpoint: string
  compatibleChatModel: string
  compatibleChatSmartModel: string
  compatibleChatVision: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fastModel: 'gpt-4.1-mini', smartModel: 'gpt-4.1', transcriptionModel: 'gpt-live-transcribe',
  inputLanguage: 'en', outputLanguage: 'English', programmingLanguage: 'Python',
  profile: '', jobDescription: '', instructions: '',
  noteTemplate: 'Summary, key points, decisions, action items with owners and due dates only if explicitly stated, and open questions.',
  theme: 'system', opacity: 0.94, overlayCollapsed: false, overlayExpandedHeight: 560, fontSize: 14, microphone: true, systemAudio: false,
  liveSuggestions: false, liveSuggestionSource: 'system',
  microphoneDeviceId: '', screenshotSourceId: '', privacyMode: false, includeHistory: false,
  launchAtLogin: false, hideDockIcon: true, smartMode: false, historyEnabled: true,
  shortcutPreset: 'faangin', shortcutOverrides: {}, captureIdleMinutes: 10,
  chatProvider: 'openai', compatibleChatEndpoint: '', compatibleChatModel: '', compatibleChatSmartModel: '', compatibleChatVision: false
}

export interface TranscriptTurn {
  id: string
  sessionId: string
  channel: AudioChannel | 'manual'
  text: string
  timestamp: number
  provisional?: boolean
}

export interface Attachment {
  id: string
  sessionId: string
  name: string
  dataUrl: string
  width: number
  height: number
  createdAt: number
}

export interface Answer {
  id: string
  requestId: string
  sessionId: string
  action: Action
  origin?: 'automatic' | 'manual'
  prompt: string
  text: string
  model: string
  status: 'streaming' | 'complete' | 'cancelled' | 'failed'
  createdAt: number
  error?: string
  inputTokens?: number
  outputTokens?: number
  firstTokenMs?: number
  totalMs?: number
  usedPartialContext?: boolean
  interruption?: { reason: 'new-speech' | 'new-question' | 'manual-takeover'; transcriptId?: string; at: number }
  transcriptReferences?: TranscriptReference[]
  context?: { transcriptIds: string[]; attachmentIds: string[]; priorAnswerIds: string[]; memorySourceIds: string[]; truncated: boolean; replyTargetId?: string; interviewContextKey?: string; interviewSnapshot?: Pick<InterviewContext, 'round' | 'problem' | 'constraints'>; interruptedAnswerIds?: string[] }
}

export interface TranscriptReference {
  label: string
  turnId: string
  channel: TranscriptTurn['channel']
  timestamp: number
  text: string
}

export interface Session {
  id: string
  title: string
  mode: WorkspaceMode
  status: SessionStatus
  createdAt: number
  updatedAt: number
  endedAt?: number
  deletedAt?: number
  notes: string
  transcript: TranscriptTurn[]
  answers: Answer[]
  attachments: Attachment[]
  contextEpoch: number
  interview?: InterviewContext
  selectedAttachmentIds?: string[]
  persistent?: boolean
  memory?: MemorySnippet[]
  transcriptIncomplete?: boolean
}

export interface SessionSummary {
  id: string
  title: string
  mode: WorkspaceMode
  createdAt: number
  updatedAt: number
  status: SessionStatus
  deletedAt?: number
  transcriptCount: number
  answerCount: number
  preview: string
  persistent?: boolean
}

export interface PermissionStatus {
  microphone: string
  screen: string
  platform: string
}
export type AccessPermissionKind = 'microphone' | 'screen' | 'system-audio'
export type SystemAudioAccessStatus = 'not-requested' | 'checking' | 'verified' | 'denied' | 'unavailable'
export interface AccessSetupState {
  required: boolean
  completed: boolean
  ready: boolean
  checking: boolean
  permissions: { microphone: string; screen: string; systemAudio: SystemAudioAccessStatus }
  systemAudioVerifiedAt: number | null
  issue?: string
}

export interface CaptureSource { id: string; name: string; thumbnail: string; displayId: string; scaleFactor?: number }
export interface ScreenshotRegionPreview { id: string; sessionId: string; name: string; dataUrl: string; width: number; height: number; expiresAt: number; displayId?: string; scaleFactor?: number }
export interface MicrophoneDevice { deviceId: string; label: string }
export interface SessionListFilter { updatedFrom?: number; updatedBefore?: number; mode?: WorkspaceMode }
export interface ConnectionReport {
  ok: boolean
  message: string
  checks?: Array<{ label: string; model: string; ok: boolean; message: string }>
}
export interface AppState {
  accessSetup?: AccessSetupState
  systemAudioConsented?: boolean
  settings: Settings
  accessibility: { reduceTransparency: boolean; reduceMotion: boolean; increaseContrast: boolean }
  keyConfigured: boolean
  permissions: PermissionStatus
  sessions: SessionSummary[]
  currentSession: Session | null
  version: string
  windowKind: WindowKind
  capture: { active: boolean; sessionId: string | null; microphone: string; system: string }
  shortcuts: Array<{ id?: ShortcutAction; action: string; accelerator: string; registered: boolean }>
  presets?: PresetCatalogSnapshot
  storageWarnings?: string[]
  chatConfigured: boolean
  compatibleKeyConfigured: boolean
  overlayClickThrough?: boolean
  captureSolve?: { sessionId: string; phase: 'capturing' | 'solving'; requestId?: string } | null
  liveSuggestions?: { phase: 'off' | 'ready' | 'listening' | 'waiting' | 'understanding' | 'generating' | 'paused'; reason?: string; source: AudioChannel; sessionId: string | null }
}

export type AppEvent =
  | { type: 'state'; state: AppState }
  | { type: 'answer-delta'; requestId: string; sessionId: string; delta: string; firstTokenMs?: number }
  | { type: 'answer-complete'; answer: Answer }
  | { type: 'transcript-partial'; sessionId: string; channel: AudioChannel; itemId: string; text: string }
  | { type: 'transcript-clear'; sessionId: string; channel?: AudioChannel }
  | { type: 'transcript-final'; turn: TranscriptTurn }
  | { type: 'answer-started'; answer: Answer }
  | { type: 'audio-level'; channel: AudioChannel; level: number }
  | { type: 'capture-status'; active: boolean; sessionId: string | null; microphone: string; system: string }
  | { type: 'live-suggestions'; state: NonNullable<AppState['liveSuggestions']> }
  | { type: 'error'; message: string; code?: string }
  | { type: 'navigate'; view: 'workspace' | 'library' | 'settings' }
  | { type: 'system-audio-consent'; sessionId: string; resume: boolean }
  | { type: 'shortcut'; action: 'assist' | 'solve' | 'reply' | 'reset' | 'scroll-up' | 'scroll-down' }

export interface GenerateInput {
  sessionId: string
  action: Action
  prompt?: string
  attachmentIds?: string[]
  smart?: boolean
  replaceActive?: boolean
}

export interface CaptureCommand {
  type: 'start' | 'stop' | 'stop-channel'
  channel?: AudioChannel
  generation: number
  sessionId: string
  microphone: boolean
  systemAudio: boolean
  microphoneDeviceId: string
}

export interface FaanginAPI {
  getState(): Promise<AppState>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  setApiKey(key: string): Promise<{ configured: boolean }>
  removeApiKey(): Promise<void>
  testConnection(): Promise<ConnectionReport>
  setCompatibleApiKey(endpoint: string, key: string): Promise<{ configured: boolean }>
  removeCompatibleApiKey(): Promise<void>
  testChatConnection(): Promise<ConnectionReport>
  createSession(mode: WorkspaceMode): Promise<Session>
  selectSession(id: string): Promise<Session>
  updateSession(id: string, patch: { title?: string; notes?: string; interview?: InterviewContext }): Promise<Session>
  deleteSession(id: string): Promise<void>
  restoreSession(id: string): Promise<void>
  permanentlyDeleteSession(id: string): Promise<void>
  listSessions(query?: string, trash?: boolean, filter?: SessionListFilter): Promise<SessionSummary[]>
  resetContext(id: string): Promise<Session>
  appendTranscript(id: string, text: string): Promise<TranscriptTurn>
  generate(input: GenerateInput): Promise<{ requestId: string }>
  cancelGeneration(requestId: string): Promise<void>
  listCaptureSources(): Promise<CaptureSource[]>
  listMicrophoneDevices(): Promise<MicrophoneDevice[]>
  captureScreen(sessionId: string, sourceId?: string): Promise<Attachment>
  captureAndSolve(sessionId: string): Promise<{ requestId: string }>
  previewScreenshotRegion(sessionId: string, sourceId?: string): Promise<ScreenshotRegionPreview>
  commitScreenshotRegion(sessionId: string, previewId: string, region: ScreenshotRegion): Promise<Attachment>
  discardScreenshotRegion(previewId: string): Promise<void>
  importImage(sessionId: string): Promise<Attachment | null>
  removeAttachment(sessionId: string, attachmentId: string): Promise<void>
  reorderAttachments(sessionId: string, attachmentIds: string[]): Promise<void>
  selectAttachments(sessionId: string, attachmentIds: string[]): Promise<void>
  startCapture(sessionId: string): Promise<void>
  stopCapture(): Promise<void>
  pauseCapture(): Promise<void>
  resumeCapture(sessionId: string): Promise<void>
  managePreset(command: PresetMutation): Promise<PresetCatalogSnapshot>
  choosePreset(sessionId: string, kind: PresetKind, id: string | null): Promise<void>
  memoryCandidates(sessionId: string, query?: string): Promise<MemoryCandidate[]>
  selectMemory(sessionId: string, ids: string[], displayed?: MemoryCandidate[]): Promise<MemorySnippet[]>
  editMemory(sessionId: string, id: string, text: string): Promise<MemorySnippet[]>
  exportDiagnostics(): Promise<{ path: string } | null>
  exportSession(id: string, format: 'markdown' | 'json'): Promise<{ path: string } | null>
  importProfile(): Promise<string | null>
  openWindow(kind: WindowKind, view?: 'workspace' | 'library' | 'settings'): Promise<void>
  hideOverlay(): Promise<void>
  resizeOverlay(size: { width: number; height: number }): Promise<void>
  resetOverlayLayout(): Promise<void>
  setClickThrough(enabled: boolean): Promise<void>
  openPermissionSettings(kind: AccessPermissionKind): Promise<void>
  requestPermission(kind: AccessPermissionKind): Promise<void>
  refreshAccessSetup(): Promise<AccessSetupState>
  completeAccessSetup(): Promise<void>
  acknowledgeSystemAudioConsent(): Promise<void>
  onEvent(listener: (event: AppEvent) => void): () => void
  // Only the trusted capture surface may invoke these operations.
  onCaptureCommand(listener: (command: CaptureCommand) => void): () => void
  sendAudio(generation: number, channel: AudioChannel, pcm: ArrayBuffer): void
  commitAudio(generation: number, channel: AudioChannel): void
  reportCapture(generation: number, channel: AudioChannel, status: string, failed?: boolean): void
  reportAudioLevel(generation: number, channel: AudioChannel, level: number): void
  reportDevicesChanged(generation: number): void
  onMicrophoneInventory(listener: (requestId: string) => void): () => void
  reportMicrophoneInventory(requestId: string, devices: MicrophoneDevice[], failed?: boolean): void
}

export type PresetMutation =
  | { type: 'create'; draft: PresetDraft }
  | { type: 'update'; id: string; draft: PresetDraft; revision: number }
  | { type: 'duplicate'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'restore-defaults' }

declare global { interface Window { faangin: FaanginAPI } }
import type { PresetCatalogSnapshot, PresetDraft, PresetKind } from '../main/presets'
import type { MemoryCandidate, MemorySnippet } from '../main/context-memory'
import type { ShortcutAction, ShortcutOverrides, ShortcutPreset } from '../main/shortcut-manager'
import type { ScreenshotRegion } from '../main/screenshot-region'
export type { ScreenshotRegion } from '../main/screenshot-region'
