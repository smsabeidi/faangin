import type { AccessSetupState, PermissionStatus, SystemAudioAccessStatus } from '../shared/types'

export interface AccessSetupReceipt { version: 1; completed: boolean; systemAudioVerifiedAt: number | null; backgroundCheckConsented: boolean }
export const ACCESS_SETUP_MESSAGE = 'Finish access setup in the workspace before opening the overlay, capturing, or requesting answers.'
// Completing setup is the only way to give consent. 0.4.2 cleared it after a failed audio check,
// so a completed receipt with consent stored as false gets the user's original consent back.
function receipt(value: unknown): AccessSetupReceipt {
  if (value && typeof value === 'object') {
    const entry = value as Partial<AccessSetupReceipt>
    if (entry.version === 1 && typeof entry.completed === 'boolean' && (entry.systemAudioVerifiedAt === null || (typeof entry.systemAudioVerifiedAt === 'number' && Number.isFinite(entry.systemAudioVerifiedAt) && entry.systemAudioVerifiedAt > 0 && entry.systemAudioVerifiedAt <= Date.now()))) return { version: 1, completed: entry.completed, systemAudioVerifiedAt: entry.systemAudioVerifiedAt, backgroundCheckConsented: entry.backgroundCheckConsented === true || (entry.completed && entry.backgroundCheckConsented === false) }
  }
  return { version: 1, completed: false, systemAudioVerifiedAt: null, backgroundCheckConsented: false }
}

/** Computer audio is a separate verified capability, never inferred from screen TCC. */
export class AccessSetupCoordinator {
  private saved: AccessSetupReceipt
  private audioStatus: SystemAudioAccessStatus
  private issue: string | undefined
  constructor(value: unknown, private save: (value: AccessSetupReceipt) => void) {
    this.saved = receipt(value)
    // A historical receipt is never proof that CoreAudio Tap access still works in this process.
    this.audioStatus = 'not-requested'
  }
  snapshot(permissions: PermissionStatus): AccessSetupState {
    const microphone = permissions.platform === 'linux' && permissions.microphone === 'unknown' ? 'not-required' : permissions.microphone
    const screen = permissions.platform !== 'darwin' && permissions.screen === 'unknown' ? 'not-required' : permissions.screen
    const ready = ['granted', 'not-required'].includes(microphone) && ['granted', 'not-required'].includes(screen) && this.audioStatus === 'verified'
    return { required: !this.saved.completed || !ready, completed: this.saved.completed, ready, checking: this.audioStatus === 'checking', permissions: { microphone, screen, systemAudio: this.audioStatus }, systemAudioVerifiedAt: this.saved.systemAudioVerifiedAt, ...(this.issue ? { issue: this.issue } : {}) }
  }
  beginAudioCheck(): void { this.audioStatus = 'checking'; this.issue = undefined }
  mayRecheckOnStartup(permissions: PermissionStatus): boolean {
    const current = this.snapshot(permissions)
    return this.saved.completed && this.saved.backgroundCheckConsented && !!this.saved.systemAudioVerifiedAt && ['granted', 'not-required'].includes(current.permissions.microphone) && ['granted', 'not-required'].includes(current.permissions.screen)
  }
  finishAudioCheck(success: boolean, issue?: string, denied = false): void {
    // Failure clears only the verified timestamp: no unattended recheck runs until a check passes again, and consent stays recorded.
    const next = { ...this.saved, systemAudioVerifiedAt: success ? Date.now() : null }
    try { this.save(next) } catch (error) { this.audioStatus = 'unavailable'; this.issue = 'The access check could not be saved. Check local storage and retry.'; throw error }
    this.saved = next
    this.audioStatus = success ? 'verified' : denied ? 'denied' : 'unavailable'; this.issue = issue
  }
  complete(permissions: PermissionStatus): void {
    if (!this.snapshot(permissions).ready) throw new Error('Allow microphone and screen access, then verify computer audio before continuing.')
    const next = { ...this.saved, completed: true, backgroundCheckConsented: true }
    this.save(next); this.saved = next
  }
  assertReady(permissions: PermissionStatus): void { if (this.snapshot(permissions).required) throw new Error(ACCESS_SETUP_MESSAGE) }
}

/** An explicit, short-lived lease admits only display-audio readiness in its owned isolated frame. */
export function setupAudioPermissionAllowed(trustedSetupMainFrame: boolean, activeLease: boolean, permission: string, mediaTypes: unknown): boolean {
  return trustedSetupMainFrame && activeLease && (permission === 'display-capture' || (permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length === 0))
}
export function setupAudioPermissionCheckAllowed(trustedSetupMainFrame: boolean, activeLease: boolean, permission: string, mediaType: unknown): boolean {
  return trustedSetupMainFrame && activeLease && (permission === 'display-capture' || (permission === 'media' && (mediaType === 'unknown' || mediaType === undefined)))
}

export interface SystemAudioReadinessResult { verified: boolean; allTracksStopped: boolean; error?: string }
/** Serialized into an isolated local renderer; never reads samples, pixels, or creates an AudioContext. */
export async function checkSystemAudioReadiness(): Promise<SystemAudioReadinessResult> {
  let tracks: MediaStreamTrack[] = []
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    tracks = stream.getTracks()
    const verified = stream.getAudioTracks().some(track => track.readyState === 'live')
    tracks.forEach(track => track.stop())
    return { verified, allTracksStopped: tracks.every(track => track.readyState === 'ended'), ...(!verified ? { error: 'NoAudioTrack' } : {}) }
  } catch (error) {
    tracks.forEach(track => { try { track.stop() } catch {} })
    return { verified: false, allTracksStopped: tracks.every(track => track.readyState === 'ended'), error: error instanceof Error ? error.name : 'AccessError' }
  }
}
