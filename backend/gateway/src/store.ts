/** usage/{uid}/periods/{periodKey}. The gateway only ever adds; Firestore does it with FieldValue.increment. */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'

export interface DayUsage { audioSeconds: number; spendUsd: number }

export interface Usage {
  audioSeconds: number
  handsfree: number
  fast: number
  smart: number
  spendUsd: number
  graceUsedAt?: number
  days: Record<string, DayUsage>
}

/** Numeric fields are added; audioSeconds and spendUsd also land in days[day]; graceUsedAt is set. */
export interface UsageDelta {
  audioSeconds?: number
  handsfree?: number
  fast?: number
  smart?: number
  spendUsd?: number
  graceUsedAt?: number
}

export interface Store {
  read(uid: string, periodKey: string): Promise<Usage>
  increment(uid: string, periodKey: string, day: string, delta: UsageDelta): Promise<void>
}

const COUNTERS = ['audioSeconds', 'handsfree', 'fast', 'smart', 'spendUsd'] as const

export function emptyUsage(): Usage {
  return { audioSeconds: 0, handsfree: 0, fast: 0, smart: 0, spendUsd: 0, days: {} }
}

export class MemoryStore implements Store {
  readonly docs = new Map<string, Usage>()

  async read(uid: string, periodKey: string): Promise<Usage> {
    return structuredClone(this.docs.get(`${uid}/${periodKey}`) ?? emptyUsage())
  }

  async increment(uid: string, periodKey: string, day: string, delta: UsageDelta): Promise<void> {
    const key = `${uid}/${periodKey}`
    const usage = this.docs.get(key) ?? emptyUsage()
    for (const field of COUNTERS) usage[field] += delta[field] ?? 0
    if (delta.audioSeconds || delta.spendUsd) {
      const today = (usage.days[day] ??= { audioSeconds: 0, spendUsd: 0 })
      today.audioSeconds += delta.audioSeconds ?? 0
      today.spendUsd += delta.spendUsd ?? 0
    }
    if (delta.graceUsedAt !== undefined) usage.graceUsedAt = delta.graceUsedAt
    this.docs.set(key, usage)
  }
}

export class FirestoreStore implements Store {
  constructor(private readonly db: Firestore) {}

  private doc(uid: string, periodKey: string) {
    return this.db.doc(`usage/${uid}/periods/${periodKey}`)
  }

  async read(uid: string, periodKey: string): Promise<Usage> {
    const snap = await this.doc(uid, periodKey).get()
    return { ...emptyUsage(), ...(snap.data() ?? {}) } as Usage
  }

  async increment(uid: string, periodKey: string, day: string, delta: UsageDelta): Promise<void> {
    const data: Record<string, unknown> = { updatedAt: Date.now() }
    for (const field of COUNTERS) if (delta[field]) data[field] = FieldValue.increment(delta[field]!)
    if (delta.audioSeconds || delta.spendUsd) {
      const today: Record<string, unknown> = {}
      if (delta.audioSeconds) today.audioSeconds = FieldValue.increment(delta.audioSeconds)
      if (delta.spendUsd) today.spendUsd = FieldValue.increment(delta.spendUsd)
      data.days = { [day]: today }
    }
    if (delta.graceUsedAt !== undefined) data.graceUsedAt = delta.graceUsedAt
    await this.doc(uid, periodKey).set(data, { merge: true })
  }
}
