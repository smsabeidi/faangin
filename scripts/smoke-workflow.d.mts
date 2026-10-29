import type { FaanginAPI } from '../src/shared/types'
import type { NativeAudioProbeResult } from '../src/main/native-audio-probe'

export interface DesktopSmokeIds { persisted: string; ephemeral: string; purged: string; answer: string; draft: string }
export interface DesktopSmokeReport {
  capture: Record<'missingKeyRejected' | 'intentEnded' | 'repeatedPauseStop' | 'nativeDisplayPermissionReached' | 'permissionProbeOpenedNoStream', boolean>
  inference: Record<'fast' | 'smart' | 'context' | 'cancellation' | 'safeQuota' | 'sourceLinkedDraft', boolean>
  presets: Record<'create' | 'choice' | 'update' | 'staleEditRejected' | 'duplicate' | 'restoreDefaults' | 'delete', boolean>
  context: Record<'reset' | 'trash' | 'restore' | 'purge' | 'purgeGuard', boolean>
  history: Record<'ramShadow' | 'ramSession' | 'noAutomaticPromotion', boolean>
  ids: DesktopSmokeIds
  nativeAudio?: NativeAudioProbeResult
}
export type DesktopWorkflowAPI = Pick<FaanginAPI, 'getState' | 'onEvent' | 'updateSettings' | 'createSession' | 'selectSession' | 'updateSession' | 'appendTranscript' | 'startCapture' | 'pauseCapture' | 'stopCapture' | 'managePreset' | 'choosePreset' | 'selectAttachments' | 'reorderAttachments' | 'resetContext' | 'deleteSession' | 'restoreSession' | 'permanentlyDeleteSession' | 'listSessions' | 'memoryCandidates' | 'selectMemory' | 'generate' | 'cancelGeneration'>
export function runDesktopWorkflow(api: DesktopWorkflowAPI, providerEndpoint: string, options?: { nativeAudio?: boolean }): Promise<DesktopSmokeReport>
export function verifyDesktopPersistence(api: DesktopWorkflowAPI, ids: DesktopSmokeIds): Promise<Record<'savedBaseline' | 'answerDurable' | 'draftDurable' | 'ramSessionDiscarded' | 'ramShadowDiscarded' | 'transientPresetChoiceDiscarded' | 'purgedSessionAbsent', boolean>>
