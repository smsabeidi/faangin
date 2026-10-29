export interface CapturePermissionScope {
  /** The owned capture WebContents, its local capture URL, and its requesting main frame. */
  trustedCaptureMainFrame: boolean
  /** A current capture generation/session owns system audio, enabled and not revoked. */
  activeSystemAudio: boolean
}

/**
 * Electron 44 reports getDisplayMedia as `media` with an explicit empty mediaTypes
 * array; DEVICE_AUDIO_CAPTURE alone produces ['audio']. See the pinned runtime:
 * https://github.com/electron/electron/blob/v44.7.0/shell/browser/web_contents_permission_helper.cc
 * Newer Electron versions distinguish `display-capture`. Neither path grants camera access.
 */
export function capturePermissionRequestAllowed(scope: CapturePermissionScope, permission: string, mediaTypes?: unknown): boolean {
  if (!scope.trustedCaptureMainFrame) return false
  if (permission === 'display-capture') return scope.activeSystemAudio
  if (permission !== 'media' || !Array.isArray(mediaTypes)) return false
  if (!mediaTypes.length) return scope.activeSystemAudio
  return mediaTypes.length === 1 && mediaTypes[0] === 'audio'
}

/**
 * Desktop media checks in Electron 44 can carry mediaType='unknown'. Admit that
 * ambiguous check only inside the same owned-system fence as the legacy request.
 * Recompute scope after asynchronous source enumeration using the original generation.
 */
export function capturePermissionCheckAllowed(scope: CapturePermissionScope, permission: string, mediaType?: unknown): boolean {
  if (!scope.trustedCaptureMainFrame) return false
  if (permission === 'display-capture') return scope.activeSystemAudio
  if (permission !== 'media') return false
  if (mediaType === 'audio') return true
  return (mediaType === 'unknown' || mediaType === undefined) && scope.activeSystemAudio
}
