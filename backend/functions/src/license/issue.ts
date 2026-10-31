// issueLicense: a signed-in device asks for a signed license it can verify offline for 30 days (+14 grace).
import { HttpsError, onCall } from 'firebase-functions/https'
import { db } from '../admin.js'
import { DEVICE_ACTIVE_WINDOW_DAYS, DEVICE_LIMIT, LICENSE_GRACE_DAYS, LICENSE_SIGNING_KEY, LICENSE_TTL_DAYS } from '../config.js'
import { entitledPlan, readEntitlement } from '../entitlements.js'
import { signLicense, type LicensePayload } from './sign.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/

export const issueLicense = onCall({ cors: true, secrets: [LICENSE_SIGNING_KEY] }, async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first')
  const deviceId: unknown = request.data?.deviceId
  const deviceName: unknown = request.data?.deviceName
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw new HttpsError('invalid-argument', 'deviceId must match [A-Za-z0-9_-]{8,64}')
  if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 64) throw new HttpsError('invalid-argument', 'deviceName must be 1-64 characters')

  const entitlement = await readEntitlement(uid)
  const plan = entitledPlan(entitlement)
  if (plan === 'none') throw new HttpsError('failed-precondition', 'No active plan')

  // Device cap: a device not seen in the window counts as new. Count and upsert in one transaction so parallel
  // calls with new deviceIds cannot all pass the check.
  const now = Date.now()
  const devices = db.collection('devices').doc(uid).collection('items')
  await db.runTransaction(async (tx) => {
    const active = await tx.get(devices.where('lastSeenAt', '>=', now - DEVICE_ACTIVE_WINDOW_DAYS * DAY_MS))
    const seen = active.docs.find((d) => d.id === deviceId)
    if (!seen && active.size >= DEVICE_LIMIT) {
      throw new HttpsError('resource-exhausted', `Up to ${DEVICE_LIMIT} devices in ${DEVICE_ACTIVE_WINDOW_DAYS} days`)
    }
    tx.set(
      devices.doc(deviceId),
      { name: deviceName, firstSeenAt: seen?.get('firstSeenAt') ?? now, lastSeenAt: now, lastLicenseAt: now },
      { merge: true }
    )
  })

  const exp = now + LICENSE_TTL_DAYS * DAY_MS
  const grace = exp + LICENSE_GRACE_DAYS * DAY_MS
  const payload: LicensePayload = { v: 1, uid, plan, status: entitlement.status, iat: now, exp, grace, deviceId }
  if (plan === 'pro' && entitlement.pro) {
    payload.periodEnd = entitlement.pro.currentPeriodEnd
    payload.rampUntil = entitlement.pro.rampUntil
    payload.cancelAtPeriodEnd = entitlement.pro.cancelAtPeriodEnd
  }
  const token = signLicense(payload, LICENSE_SIGNING_KEY.value())
  return { token, plan, status: entitlement.status, expiresAt: exp, graceUntil: grace }
})
