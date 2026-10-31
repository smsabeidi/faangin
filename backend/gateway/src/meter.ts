/** Every allowance decision, as pure functions. No I/O here. */
import type { Entitlement, Flags } from './auth.js'
import {
  ALLOWANCES, BACKSTOP_USD, CAPS, GRACE_SECONDS, MAX_CONCURRENT_ANSWERS, PCM_BYTES_PER_SECOND, PRICES, RAMP_FRACTION, type Mode
} from './config.js'
import type { Usage } from './store.js'

const DAY_MS = 86_400_000
/** A Pro billing period longer than this is a yearly subscription: Stripe's period is then a year, the allowances still renew monthly. */
const MONTHLY_PERIOD_MAX_MS = 35 * DAY_MS

/**
 * The latest monthly anniversary of `startMs` at or before `nowMs` (UTC, same time of day, day of month clamped to the
 * month's length: a Jan 31 start gives Feb 28/29, Mar 31, Apr 30). Always counted from the original start, so clamping never drifts.
 */
export function monthlyAnniversary(startMs: number, nowMs: number): number {
  if (nowMs <= startMs) return startMs
  const s = new Date(startMs)
  const n = new Date(nowMs)
  const at = (months: number): number => {
    const year = s.getUTCFullYear()
    const month = s.getUTCMonth() + months
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return Date.UTC(year, month, Math.min(s.getUTCDate(), lastDay), s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds(), s.getUTCMilliseconds())
  }
  let months = (n.getUTCFullYear() - s.getUTCFullYear()) * 12 + (n.getUTCMonth() - s.getUTCMonth())
  while (months > 0 && at(months) > nowMs) months--
  return at(months)
}

/**
 * The usage document a request is counted in. Monthly Pro: the Stripe billing period (its start). Yearly Pro: the monthly
 * anniversary of the yearly period's start, so a $144/year buyer gets the printed allowances (and the $16 spend backstop)
 * every month, not once a year; the first month keeps the same key a monthly buyer gets. Anything else: the UTC month.
 */
export function periodKey(entitlement: Entitlement, now: number): string {
  if (entitlement.plan === 'pro' && entitlement.pro) {
    const { currentPeriodStart: start, currentPeriodEnd: end } = entitlement.pro
    return String(end - start > MONTHLY_PERIOD_MAX_MS ? monthlyAnniversary(start, now) : start)
  }
  return new Date(now).toISOString().slice(0, 7)
}

/** UTC day, YYYY-MM-DD. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function isRamped(entitlement: Entitlement, now: number): boolean {
  return entitlement.pro !== undefined && now < entitlement.pro.rampUntil
}

/** While ramped every count cap is 30% of the printed one. */
export function cap(printed: number, ramped: boolean): number {
  return ramped ? Math.floor(printed * RAMP_FRACTION) : printed
}

export function overBackstop(usage: Usage, day: string): boolean {
  return usage.spendUsd >= BACKSTOP_USD.month || (usage.days[day]?.spendUsd ?? 0) >= BACKSTOP_USD.day
}

export type AnswerDecision =
  | { kind: 'run'; mode: Mode; downgraded: boolean }
  | { kind: 'concurrency' }
  | { kind: 'exhausted'; allowance: 'fast' }
  | { kind: 'skip' }
  | { kind: 'backstop' }

export interface AnswerInput {
  mode: Mode
  usage: Usage
  day: string
  ramped: boolean
  /** Answers already running for this uid, not counting this one. */
  inFlight: number
  flags: Pick<Flags, 'smartToFast' | 'handsfreeOff'>
}

/** POST /v1/responses, in contract order: concurrency, smart->fast, fast cap, handsfree skip, backstop. */
export function decideAnswer({ mode, usage, day, ramped, inFlight, flags }: AnswerInput): AnswerDecision {
  if (inFlight >= MAX_CONCURRENT_ANSWERS) return { kind: 'concurrency' }
  let downgraded = false
  if (mode === 'smart' && (usage.smart >= cap(ALLOWANCES.smart, ramped) || flags.smartToFast)) {
    mode = 'fast'
    downgraded = true
  }
  if (mode === 'fast' && usage.fast >= cap(ALLOWANCES.fast, ramped)) return { kind: 'exhausted', allowance: 'fast' }
  if (mode === 'handsfree' && (usage.handsfree >= cap(ALLOWANCES.handsfree, ramped) || flags.handsfreeOff)) return { kind: 'skip' }
  if (overBackstop(usage, day)) return { kind: 'backstop' }
  return { kind: 'run', mode, downgraded }
}

/** The usage object inside OpenAI's response.completed. */
export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
}

/** Estimated provider cost in USD; only for the backstop, never billing. Handsfree runs the fast model. */
export function estimateCostUsd(mode: Mode, usage: TokenUsage): number {
  const price = PRICES[mode === 'smart' ? 'smart' : 'fast']
  const input = usage.input_tokens ?? 0
  const cached = Math.min(input, usage.input_tokens_details?.cached_tokens ?? 0)
  const output = usage.output_tokens ?? 0
  return ((input - cached) * price.input + cached * price.cachedInput + output * price.output) / 1_000_000
}

/** What a stream that never reported usage is assumed to have cost: the per-mode caps at list price. */
export function capEstimateUsd(mode: Mode): number {
  return estimateCostUsd(mode, { input_tokens: CAPS[mode].input, output_tokens: CAPS[mode].output })
}

/** pcm16 mono 24 kHz sent as base64: length * 3/4 bytes, 48 000 bytes a second. */
export function audioSecondsFromBase64(length: number): number {
  return (length * 3) / 4 / PCM_BYTES_PER_SECOND
}

export function audioCostUsd(seconds: number): number {
  return (seconds / 3600) * PRICES.transcribeAudioPerHour
}

export function overAudioLimit(usage: Usage, day: string, ramped: boolean): boolean {
  return (
    usage.audioSeconds >= cap(ALLOWANCES.audioSeconds, ramped) ||
    (usage.days[day]?.audioSeconds ?? 0) >= cap(ALLOWANCES.audioSecondsPerDay, ramped) ||
    overBackstop(usage, day)
  )
}

/** A socket is open, inside the uid's once-per-period grace window (until this time), or muted. */
export type AudioState = { kind: 'open' } | { kind: 'grace'; until: number } | { kind: 'muted' }

const GRACE_MS = GRACE_SECONDS * 1000

/** The window starts when the first socket hits a limit (graceUsedAt) and is shared by every socket of the uid. */
export function nextAudioState(state: AudioState, overLimit: boolean, graceUsedAt: number | undefined, now: number): AudioState {
  if (state.kind === 'muted') return state
  if (state.kind === 'grace') return now >= state.until ? { kind: 'muted' } : state
  if (!overLimit) return state
  const until = (graceUsedAt ?? now) + GRACE_MS
  return now >= until ? { kind: 'muted' } : { kind: 'grace', until }
}
