import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DEVICE_CODE_POLL_INTERVAL_SECONDS, DEVICE_CODE_TTL_SECONDS, LICENSE_GRACE_DAYS, LICENSE_TTL_DAYS } from './config.ts'
import { ServiceError } from './errors.ts'
import { signLicense, type LicensePayload } from './license.ts'
import { entitledPlan } from './entitlements.ts'
import type { AccountStore } from './store.ts'

export interface AccountUser { id: string; email?: string; emailVerified?: boolean }
export interface AccountAuth {
  getUserById(uid: string): Promise<AccountUser>
  /** Admin generateLink only. It must return the generated link's user identity as well as its hash. */
  generateMagicLink(email: string): Promise<{ tokenHash: string; uid: string }>
}
export interface AccountDeps { store: AccountStore; auth: AccountAuth; signingKey: string; activationUrl: string; owner?: () => string }
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/
const USER_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/
const DAY = 86_400_000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export function deviceInfo(input: unknown): { deviceId: string; deviceName: string } {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  if (typeof data.deviceId !== 'string' || !DEVICE_ID.test(data.deviceId)) throw new ServiceError('invalid-argument', 'deviceId must match [A-Za-z0-9_-]{8,64}')
  if (typeof data.deviceName !== 'string' || !data.deviceName.trim() || data.deviceName.length > 64) throw new ServiceError('invalid-argument', 'deviceName must be 1-64 characters')
  return { deviceId: data.deviceId, deviceName: data.deviceName }
}
export function createAccountService(deps: AccountDeps) {
  const owner = deps.owner ?? randomUUID
  return {
    async start(input: unknown) {
      const { deviceId, deviceName } = deviceInfo(input)
      const deviceCode = randomBytes(32).toString('base64url')
      const userCode = [...randomBytes(8)].map(byte => ALPHABET[byte % ALPHABET.length]).join('')
      await deps.store.startDevice(userCode, hash(deviceCode), deviceId, deviceName)
      const shown = userCode.slice(0, 4) + '-' + userCode.slice(4)
      const url = new URL(deps.activationUrl); url.searchParams.set('code', shown)
      return { deviceCode, userCode: shown, verificationUrl: url.href, expiresIn: DEVICE_CODE_TTL_SECONDS, interval: DEVICE_CODE_POLL_INTERVAL_SECONDS }
    },
    async approve(uid: string, input: unknown) {
      if (!uid) throw new ServiceError('unauthenticated', 'Sign in first')
      const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).userCode : undefined
      const userCode = typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : ''
      if (!USER_CODE.test(userCode)) throw new ServiceError('invalid-argument', 'userCode must be 8 letters or digits')
      const deviceName = await deps.store.approveDevice(userCode, uid)
      return { ok: true, deviceName }
    },
    async poll(input: unknown): Promise<{ status: 'pending' | 'expired' } | { status: 'approved'; tokenHash: string; uid: string }> {
      const deviceCode = input && typeof input === 'object' ? (input as Record<string, unknown>).deviceCode : undefined
      if (typeof deviceCode !== 'string' || !DEVICE_CODE.test(deviceCode)) throw new ServiceError('invalid-argument', 'deviceCode invalid')
      const proof = hash(deviceCode), lease = owner()
      const claimed = await deps.store.claimDevice(proof, lease)
      if (claimed.status !== 'claimed') return { status: claimed.status }
      let completed = false
      try {
        const user = await deps.auth.getUserById(claimed.uid)
        if (user.id !== claimed.uid || !user.email || user.emailVerified !== true) throw new ServiceError('failed-precondition', 'Confirm your account email before connecting a device')
        const generated = await deps.auth.generateMagicLink(user.email)
        if (generated.uid !== claimed.uid || !generated.tokenHash) throw new ServiceError('unavailable', 'The approved account changed during sign-in. Start sign-in again.')
        completed = await deps.store.completeDevice(proof, lease)
        if (!completed) return { status: 'expired' }
        return { status: 'approved', tokenHash: generated.tokenHash, uid: claimed.uid }
      } finally {
        if (!completed) await deps.store.releaseDevice(proof, lease).catch(() => {})
      }
    },
    async issueLicense(uid: string, input: unknown) {
      if (!uid) throw new ServiceError('unauthenticated', 'Sign in first')
      const { deviceId, deviceName } = deviceInfo(input)
      const state = await deps.store.touchDevice(uid, deviceId, deviceName)
      const plan = entitledPlan(state.document)
      if (plan === 'none') throw new ServiceError('failed-precondition', 'No active plan')
      const now = state.now, exp = now + LICENSE_TTL_DAYS * DAY, grace = exp + LICENSE_GRACE_DAYS * DAY
      const payload: LicensePayload = { v: 1, uid, plan, status: state.document.status, iat: now, exp, grace, deviceId }
      if (plan === 'pro' && state.document.pro) {
        payload.periodEnd = state.document.pro.currentPeriodEnd; payload.rampUntil = state.document.pro.rampUntil; payload.cancelAtPeriodEnd = state.document.pro.cancelAtPeriodEnd
      }
      return { token: signLicense(payload, deps.signingKey), plan, status: state.document.status, expiresAt: exp, graceUntil: grace }
    }
  }
}
