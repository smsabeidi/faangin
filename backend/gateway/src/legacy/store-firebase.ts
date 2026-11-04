/** Historical Firebase adapter; excluded from the Supabase gateway runtime. */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { decideAnswer, type AnswerDecision } from '../meter.js'
import { emptyUsage, type AnswerAdmission, type LeaseKind, type Store, type Usage, type UsageDelta } from '../store.js'
type Leases = Partial<Record<LeaseKind, Record<string, number>>>
const COUNTERS = ['audioSeconds', 'handsfree', 'fast', 'smart', 'spendUsd'] as const
function liveLeases(leases: Leases, kind: LeaseKind, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(leases[kind] ?? {}).filter(([, expiresAt]) => expiresAt > now))
}

export class FirestoreStore implements Store {
  constructor(private readonly db: Firestore) {}

  private doc(uid: string, periodKey: string) {
    return this.db.doc(`usage/${uid}/periods/${periodKey}`)
  }

  private leases(uid: string) { return this.db.doc(`gatewaySessions/${uid}`) }

  async admitAnswer(uid: string, periodKey: string, input: AnswerAdmission): Promise<AnswerDecision> {
    return this.db.runTransaction(async tx => {
      const leaseRef = this.leases(uid), usageRef = this.doc(uid, periodKey)
      const [leaseSnap, usageSnap] = await Promise.all([tx.get(leaseRef), tx.get(usageRef)])
      const leases = (leaseSnap.data() ?? {}) as Leases
      const answers = liveLeases(leases, 'answers', input.now)
      const usage = { ...emptyUsage(), ...(usageSnap.data() ?? {}) } as Usage
      const decision = decideAnswer({ ...input, usage, inFlight: Object.keys(answers).length })
      if (decision.kind === 'run') {
        answers[input.leaseId] = input.expiresAt
        tx.set(leaseRef, { ...leases, answers })
        tx.set(usageRef, { [decision.mode]: FieldValue.increment(1), updatedAt: input.now }, { merge: true })
      }
      return decision
    })
  }

  async claimLease(uid: string, kind: LeaseKind, id: string, now: number, expiresAt: number, limit: number, renewOnly = false): Promise<boolean> {
    const ref = this.leases(uid)
    return this.db.runTransaction(async tx => {
      const leases = ((await tx.get(ref)).data() ?? {}) as Leases
      const active = liveLeases(leases, kind, now)
      if (active[id] === undefined && (renewOnly || Object.keys(active).length >= limit)) return false
      active[id] = expiresAt
      tx.set(ref, { ...leases, [kind]: active })
      return true
    })
  }

  async releaseLease(uid: string, kind: LeaseKind, id: string): Promise<void> {
    const ref = this.leases(uid)
    await this.db.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (!snap.exists) return
      const leases = snap.data() as Leases
      if (!leases[kind]?.[id]) return
      delete leases[kind]![id]
      tx.set(ref, leases)
    })
  }

  async claimGrace(uid: string, periodKey: string, now: number): Promise<number> {
    const ref = this.doc(uid, periodKey)
    return this.db.runTransaction(async tx => {
      const usage = (await tx.get(ref)).data()
      const graceUsedAt = typeof usage?.graceUsedAt === 'number' ? usage.graceUsedAt : now
      if (usage?.graceUsedAt === undefined) tx.set(ref, { graceUsedAt, updatedAt: now }, { merge: true })
      return graceUsedAt
    })
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
