// Device sign-in (OAuth device-flow shape): the Mac starts a code, the buyer approves it in the browser,
// the Mac polls and receives a custom token. Only the sha256 of the device code is ever stored.
import { createHash, randomBytes } from 'node:crypto'
import { HttpsError, onCall, onRequest, type Request, type Response } from 'firebase-functions/https'
import { auth, db } from '../admin.js'
import { DEVICE_CODE_POLL_INTERVAL_SECONDS, DEVICE_CODE_TTL_SECONDS, hostingOrigin } from '../config.js'

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols, no 0/O/1/I
const USER_CODE = new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`)
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/ // 32 random bytes as base64url

interface DeviceCodeDoc {
  deviceCodeHash: string
  deviceId: string
  deviceName: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved'
  uid?: string
}

const codes = () => db.collection('deviceCodes')
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex')
const showUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`
const normalizeUserCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '')
const validDeviceName = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 64

function newUserCode(): string {
  let code = ''
  for (const byte of randomBytes(8)) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
  return code
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

/** The JSON object body of a POST; otherwise answers the error and returns null. */
function postBody(req: Request, res: Response): Record<string, unknown> | null {
  if (req.method !== 'POST') {
    fail(res, 405, 'method-not-allowed', 'POST only')
    return null
  }
  const body: unknown = req.body
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Buffer.isBuffer(body)) {
    fail(res, 400, 'invalid-argument', 'JSON object body required')
    return null
  }
  return body as Record<string, unknown>
}

export const deviceCodeStart = onRequest({ cors: true }, async (req, res) => {
  const body = postBody(req, res)
  if (!body) return
  const { deviceId, deviceName } = body
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return fail(res, 400, 'invalid-argument', 'deviceId must match [A-Za-z0-9_-]{8,64}')
  if (!validDeviceName(deviceName)) return fail(res, 400, 'invalid-argument', 'deviceName must be 1-64 characters')

  const deviceCode = randomBytes(32).toString('base64url')
  const userCode = newUserCode()
  const now = Date.now()
  const doc: DeviceCodeDoc = {
    deviceCodeHash: sha256Hex(deviceCode),
    deviceId,
    deviceName,
    createdAt: now,
    expiresAt: now + DEVICE_CODE_TTL_SECONDS * 1000,
    status: 'pending'
  }
  // One code per device: a new start replaces whatever this device had before.
  const previous = await codes().where('deviceId', '==', deviceId).get()
  const batch = db.batch()
  for (const old of previous.docs) batch.delete(old.ref)
  batch.set(codes().doc(userCode), doc)
  await batch.commit()

  const shown = showUserCode(userCode)
  res.json({
    deviceCode,
    userCode: shown,
    verificationUrl: `${hostingOrigin()}/activate?code=${shown}`,
    expiresIn: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_CODE_POLL_INTERVAL_SECONDS
  })
})

export const deviceCodeApprove = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first')
  const raw: unknown = request.data?.userCode
  if (typeof raw !== 'string') throw new HttpsError('invalid-argument', 'userCode required')
  const userCode = normalizeUserCode(raw)
  if (!USER_CODE.test(userCode)) throw new HttpsError('invalid-argument', 'userCode must be 8 letters or digits')

  const ref = codes().doc(userCode)
  const deviceName = await db.runTransaction(async (tx) => {
    const code = (await tx.get(ref)).data() as DeviceCodeDoc | undefined
    if (!code || code.expiresAt <= Date.now()) throw new HttpsError('not-found', 'Unknown or expired code')
    if (code.status === 'approved') throw new HttpsError('failed-precondition', 'Code already approved')
    tx.update(ref, { status: 'approved', uid })
    return code.deviceName
  })
  return { ok: true, deviceName }
})

export const deviceCodePoll = onRequest({ cors: true }, async (req, res) => {
  const body = postBody(req, res)
  if (!body) return
  const { deviceCode } = body
  if (typeof deviceCode !== 'string' || !DEVICE_CODE.test(deviceCode)) return fail(res, 400, 'invalid-argument', 'deviceCode invalid')

  // Lookup by hash only: the user code never travels with the poll.
  const found = await codes().where('deviceCodeHash', '==', sha256Hex(deviceCode)).limit(1).get()
  const snap = found.docs[0]
  const code = snap?.data() as DeviceCodeDoc | undefined
  if (!snap || !code || code.expiresAt <= Date.now()) return void res.json({ status: 'expired' })
  if (code.status !== 'approved' || !code.uid) return void res.json({ status: 'pending' })

  const customToken = await auth.createCustomToken(code.uid)
  await snap.ref.delete() // single use
  res.json({ status: 'approved', customToken, uid: code.uid })
})
