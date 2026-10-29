/** Computer audio includes other people's voices, so listening to it waits for one acknowledged notice. */
export const SYSTEM_AUDIO_NOTICE_VERSION = 1
export const SYSTEM_AUDIO_CONSENT_MESSAGE = 'Review the computer audio notice in the Faangin workspace before listening to computer audio.'

export interface SystemAudioConsentReceipt { version: number; acknowledgedAt: number }

/** A receipt counts only for the current notice text; a revised notice asks again. */
export function systemAudioConsented(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const { version, acknowledgedAt } = value as Partial<SystemAudioConsentReceipt>
  return version === SYSTEM_AUDIO_NOTICE_VERSION && typeof acknowledgedAt === 'number' && Number.isFinite(acknowledgedAt) && acknowledgedAt > 0
}

export function systemAudioConsentReceipt(now = Date.now()): SystemAudioConsentReceipt {
  return { version: SYSTEM_AUDIO_NOTICE_VERSION, acknowledgedAt: now }
}

export function assertSystemAudioConsent(systemAudio: boolean, consented: boolean): void {
  if (systemAudio && !consented) throw new Error(SYSTEM_AUDIO_CONSENT_MESSAGE)
}
