/** Gateway usage contracts and local fixture implementation. Production uses SupabaseStore. */
import { decideAnswer, type AnswerDecision, type AnswerInput } from './meter.js'

export type LeaseKind = 'answers' | 'audio'
type Leases = Partial<Record<LeaseKind, Record<string, number>>>
export interface AnswerAdmission extends Omit<AnswerInput, 'usage' | 'inFlight'> {
  leaseId: string
  now: number
  expiresAt: number
}

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
  /** The allowance increment and global answer-slot claim commit together. */
  admitAnswer(uid: string, periodKey: string, input: AnswerAdmission): Promise<AnswerDecision>
  claimLease(uid: string, kind: LeaseKind, id: string, now: number, expiresAt: number, limit: number, renewOnly?: boolean): Promise<boolean>
  releaseLease(uid: string, kind: LeaseKind, id: string): Promise<void>
  claimGrace(uid: string, periodKey: string, now: number): Promise<number>
}

const COUNTERS = ['audioSeconds', 'handsfree', 'fast', 'smart', 'spendUsd'] as const

export function emptyUsage(): Usage {
  return { audioSeconds: 0, handsfree: 0, fast: 0, smart: 0, spendUsd: 0, days: {} }
}

function liveLeases(leases: Leases, kind: LeaseKind, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(leases[kind] ?? {}).filter(([, expiresAt]) => expiresAt > now))
}

export class MemoryStore implements Store {
  readonly docs = new Map<string, Usage>()
  private readonly leases = new Map<string, Leases>()

  async admitAnswer(uid: string, periodKey: string, input: AnswerAdmission): Promise<AnswerDecision> {
    const leases = this.leases.get(uid) ?? {}
    const answers = liveLeases(leases, 'answers', input.now)
    const usage = this.docs.get(`${uid}/${periodKey}`) ?? emptyUsage()
    const decision = decideAnswer({ ...input, usage, inFlight: Object.keys(answers).length })
    if (decision.kind === 'run') {
      answers[input.leaseId] = input.expiresAt
      this.leases.set(uid, { ...leases, answers })
      usage[decision.mode]++
      this.docs.set(`${uid}/${periodKey}`, usage)
    }
    return decision
  }

  async claimLease(uid: string, kind: LeaseKind, id: string, now: number, expiresAt: number, limit: number, renewOnly = false): Promise<boolean> {
    const leases = this.leases.get(uid) ?? {}
    const active = liveLeases(leases, kind, now)
    if (active[id] === undefined && (renewOnly || Object.keys(active).length >= limit)) return false
    active[id] = expiresAt
    this.leases.set(uid, { ...leases, [kind]: active })
    return true
  }

  async releaseLease(uid: string, kind: LeaseKind, id: string): Promise<void> {
    const leases = this.leases.get(uid)
    if (leases?.[kind]) delete leases[kind]![id]
  }

  async claimGrace(uid: string, periodKey: string, now: number): Promise<number> {
    const key = `${uid}/${periodKey}`
    const usage = this.docs.get(key) ?? emptyUsage()
    usage.graceUsedAt ??= now
    this.docs.set(key, usage)
    return usage.graceUsedAt
  }

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
