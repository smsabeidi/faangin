import type { AccessSetupState } from '../../shared/types'

export type AccessPermission = 'screen' | 'microphone' | 'system-audio'
export const ACCESS_PERMISSION_ORDER: AccessPermission[] = ['microphone', 'screen', 'system-audio']

export function permissionValue(report: AccessSetupState | undefined, kind: AccessPermission): string {
  return kind === 'system-audio' ? report?.permissions.systemAudio ?? 'not-requested' : report?.permissions[kind] ?? 'unknown'
}

export function permissionReady(report: AccessSetupState | undefined, kind: AccessPermission): boolean {
  const value = permissionValue(report, kind)
  return kind === 'system-audio' ? value === 'verified' : value === 'granted' || value === 'not-required'
}

export function accessSetupReady(report: AccessSetupState | undefined): boolean {
  return report?.ready === true && ACCESS_PERMISSION_ORDER.every(kind => permissionReady(report, kind))
}

export function nextAccessPermission(report: AccessSetupState | undefined): AccessPermission | undefined {
  return ACCESS_PERMISSION_ORDER.find(kind => !permissionReady(report, kind))
}

export function permissionBlocked(report: AccessSetupState | undefined, kind: AccessPermission): boolean {
  return ['denied', 'restricted', 'unavailable'].includes(permissionValue(report, kind))
}

export function permissionNeedsSettings(report: AccessSetupState | undefined, kind: AccessPermission): boolean {
  return ['denied', 'restricted'].includes(permissionValue(report, kind))
}

export function permissionStatusLabel(report: AccessSetupState | undefined, kind: AccessPermission, requesting = false): string {
  const value = permissionValue(report, kind)
  if (requesting || value === 'checking') return 'Checking'
  if (permissionReady(report, kind)) return kind === 'system-audio' ? 'Access checked' : value === 'not-required' ? 'Ready on this device' : 'Granted'
  return permissionBlocked(report, kind) ? 'Blocked' : 'Needs access'
}
