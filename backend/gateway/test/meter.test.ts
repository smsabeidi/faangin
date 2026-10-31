import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  audioSecondsFromBase64, cap, capEstimateUsd, dayKey, decideAnswer, estimateCostUsd, isRamped, monthlyAnniversary, nextAudioState, overAudioLimit, periodKey
} from '../src/meter.js'
import { emptyUsage, type Usage } from '../src/store.js'
import { NOW, PERIOD_KEY, proEntitlement, TODAY } from './support.js'

const usageWith = (patch: Partial<Usage>): Usage => ({ ...emptyUsage(), ...patch })
const flags = { smartToFast: false, handsfreeOff: false }
const decide = (mode: 'fast' | 'smart' | 'handsfree', usage: Usage, extra: Partial<Parameters<typeof decideAnswer>[0]> = {}) =>
  decideAnswer({ mode, usage, day: TODAY, ramped: false, inFlight: 0, flags, ...extra })

describe('keys and caps', () => {
  it('pro periods follow the Stripe period, others the UTC month', () => {
    assert.equal(periodKey(proEntitlement(), NOW), PERIOD_KEY)
    assert.equal(periodKey({ plan: 'none', status: 'active', updatedAt: 0 }, NOW), '2026-10')
    assert.equal(dayKey(NOW), TODAY)
  })
  it('a yearly Pro subscription renews its allowances every month, counted from the yearly period start', () => {
    const DAY = 86_400_000
    const start = Date.UTC(2026, 9, 28, 15, 30)
    const yearly = (now: number) => periodKey(proEntitlement({ priceLookupKey: 'faangin_pro_annual', currentPeriodStart: start, currentPeriodEnd: Date.UTC(2027, 9, 28, 15, 30) }), now)
    assert.equal(yearly(start), String(start), 'the first month keeps the key a monthly buyer would get')
    assert.equal(yearly(Date.UTC(2026, 10, 28, 15, 29, 59, 999)), String(start), 'one millisecond before the anniversary')
    assert.equal(yearly(Date.UTC(2026, 10, 28, 15, 30)), String(Date.UTC(2026, 10, 28, 15, 30)), 'exactly on the anniversary')
    assert.equal(yearly(Date.UTC(2027, 2, 3)), String(Date.UTC(2027, 1, 28, 15, 30)), 'mid-month stays on the last anniversary')
    const keys = new Set<string>()
    for (let d = 0; d < 365; d++) keys.add(yearly(start + d * DAY))
    assert.equal(keys.size, 12, 'twelve distinct allowance windows in the year')
    // a monthly Stripe period (28-31 days) is untouched
    assert.equal(periodKey(proEntitlement({ currentPeriodStart: start, currentPeriodEnd: start + 31 * DAY }), start + 20 * DAY), String(start))
  })
  it('a yearly period starting on the 31st gives twelve non-decreasing windows, each under 32 days long', () => {
    const DAY = 86_400_000
    const start = Date.UTC(2027, 0, 31, 8)
    const entitlement = proEntitlement({ priceLookupKey: 'faangin_pro_annual', currentPeriodStart: start, currentPeriodEnd: Date.UTC(2028, 0, 31, 8) })
    const keys: number[] = []
    for (let d = 0; d < 365; d++) {
      const now = start + d * DAY
      const key = Number(periodKey(entitlement, now))
      assert.ok(key <= now && now - key < 32 * DAY, `day ${d}: window starts ${new Date(key).toISOString()}`)
      if (keys.at(-1) !== key) keys.push(key)
    }
    assert.equal(keys.length, 12)
    assert.deepEqual(keys, [...keys].sort((x, y) => x - y))
  })
  it('one millisecond before an anniversary is still the previous window, including after a clamped month', () => {
    const jan31 = Date.UTC(2027, 0, 31, 8)
    assert.equal(monthlyAnniversary(jan31, Date.UTC(2027, 1, 28, 7, 59, 59, 999)), jan31)
    assert.equal(monthlyAnniversary(jan31, Date.UTC(2027, 2, 31, 7, 59, 59, 999)), Date.UTC(2027, 1, 28, 8))
    assert.equal(monthlyAnniversary(jan31, Date.UTC(2027, 3, 30, 7, 59, 59, 999)), Date.UTC(2027, 2, 31, 8))
  })
  it('the yearly renewal does not reset or skip a window: the old period at its end and the renewed period at its start share a key', () => {
    const S = Date.UTC(2026, 9, 28, 15, 30)
    const E = Date.UTC(2027, 9, 28, 15, 30)
    const old = proEntitlement({ priceLookupKey: 'faangin_pro_annual', currentPeriodStart: S, currentPeriodEnd: E })
    const renewed = proEntitlement({ priceLookupKey: 'faangin_pro_annual', currentPeriodStart: E, currentPeriodEnd: Date.UTC(2028, 9, 28, 15, 30) })
    assert.equal(periodKey(old, E), periodKey(renewed, E))
    assert.equal(periodKey(old, E + 1000), periodKey(renewed, E + 1000))
  })
  it('monthly anniversaries clamp the day of month without drifting', () => {
    const jan31 = Date.UTC(2027, 0, 31, 8)
    assert.equal(monthlyAnniversary(jan31, Date.UTC(2027, 2, 15)), Date.UTC(2027, 1, 28, 8), 'Feb has 28 days in 2027')
    assert.equal(monthlyAnniversary(jan31, Date.UTC(2027, 2, 31, 8)), Date.UTC(2027, 2, 31, 8), 'back to the 31st in March')
    assert.equal(monthlyAnniversary(jan31, Date.UTC(2027, 3, 30, 8)), Date.UTC(2027, 3, 30, 8), 'April has 30 days')
    assert.equal(monthlyAnniversary(Date.UTC(2028, 0, 31), Date.UTC(2028, 1, 29)), Date.UTC(2028, 1, 29), 'leap year')
    assert.equal(monthlyAnniversary(jan31, jan31 - 1), jan31, 'never before the start')
    assert.equal(monthlyAnniversary(Date.UTC(2026, 10, 30), Date.UTC(2027, 11, 5)), Date.UTC(2027, 10, 30), 'across a year boundary')
  })
  it('ramp is 30 % of the printed cap, floored', () => {
    assert.equal(cap(500, false), 500)
    assert.equal(cap(500, true), 150)
    assert.equal(cap(25, true), 7)
    assert.equal(isRamped(proEntitlement({ rampUntil: NOW + 1 }), NOW), true)
    assert.equal(isRamped(proEntitlement({ rampUntil: NOW }), NOW), false)
  })
})

describe('decideAnswer', () => {
  it('runs the requested mode when under every cap', () => {
    assert.deepEqual(decide('fast', emptyUsage()), { kind: 'run', mode: 'fast', downgraded: false })
    assert.deepEqual(decide('smart', usageWith({ smart: 24 })), { kind: 'run', mode: 'smart', downgraded: false })
  })
  it('rejects the third concurrent answer', () => {
    assert.deepEqual(decide('fast', emptyUsage(), { inFlight: 2 }), { kind: 'concurrency' })
    assert.equal(decide('fast', emptyUsage(), { inFlight: 1 }).kind, 'run')
  })
  it('downgrades smart to fast at the smart cap or on the flag', () => {
    assert.deepEqual(decide('smart', usageWith({ smart: 25 })), { kind: 'run', mode: 'fast', downgraded: true })
    assert.deepEqual(decide('smart', emptyUsage(), { flags: { smartToFast: true, handsfreeOff: false } }), { kind: 'run', mode: 'fast', downgraded: true })
  })
  it('exhausts fast at its cap, also for a downgraded smart', () => {
    assert.deepEqual(decide('fast', usageWith({ fast: 500 })), { kind: 'exhausted', allowance: 'fast' })
    assert.deepEqual(decide('smart', usageWith({ smart: 25, fast: 500 })), { kind: 'exhausted', allowance: 'fast' })
  })
  it('skips handsfree at its cap or when switched off', () => {
    assert.deepEqual(decide('handsfree', usageWith({ handsfree: 1500 })), { kind: 'skip' })
    assert.deepEqual(decide('handsfree', emptyUsage(), { flags: { smartToFast: false, handsfreeOff: true } }), { kind: 'skip' })
  })
  it('applies the ramp to counts', () => {
    assert.equal(decide('fast', usageWith({ fast: 150 }), { ramped: true }).kind, 'exhausted')
    assert.equal(decide('fast', usageWith({ fast: 150 })).kind, 'run')
    assert.equal(decide('handsfree', usageWith({ handsfree: 450 }), { ramped: true }).kind, 'skip')
  })
  it('backstops on month or day spend', () => {
    assert.deepEqual(decide('fast', usageWith({ spendUsd: 16 })), { kind: 'backstop' })
    assert.deepEqual(decide('fast', usageWith({ days: { [TODAY]: { audioSeconds: 0, spendUsd: 11 } } })), { kind: 'backstop' })
    assert.equal(decide('fast', usageWith({ days: { '2026-10-27': { audioSeconds: 0, spendUsd: 11 } } })).kind, 'run')
  })
})

describe('cost', () => {
  it('prices tokens with cached input at the cached rate', () => {
    const cost = estimateCostUsd('fast', { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 500 })
    assert.ok(Math.abs(cost - 0.00114) < 1e-12)
    assert.ok(Math.abs(estimateCostUsd('smart', { input_tokens: 1000, output_tokens: 500 }) - 0.006) < 1e-12)
    assert.equal(estimateCostUsd('handsfree', { input_tokens: 1000 }), estimateCostUsd('fast', { input_tokens: 1000 }))
  })
  it('estimates a usage-less stream at the mode caps', () => {
    assert.ok(Math.abs(capEstimateUsd('fast') - 0.0129536) < 1e-12)
  })
  it('counts audio from base64 length', () => {
    assert.equal(audioSecondsFromBase64(128_000), 2)
  })
})

describe('audio state', () => {
  it('flags the period, day and backstop limits', () => {
    assert.equal(overAudioLimit(emptyUsage(), TODAY, false), false)
    assert.equal(overAudioLimit(usageWith({ audioSeconds: 20 * 3600 }), TODAY, false), true)
    assert.equal(overAudioLimit(usageWith({ audioSeconds: 6 * 3600 }), TODAY, true), true)
    assert.equal(overAudioLimit(usageWith({ days: { [TODAY]: { audioSeconds: 5 * 3600, spendUsd: 0 } } }), TODAY, false), true)
    assert.equal(overAudioLimit(usageWith({ spendUsd: 16 }), TODAY, false), true)
  })
  it('gives one 30-minute grace window from graceUsedAt, then mutes', () => {
    const open = { kind: 'open' } as const
    const GRACE_MS = 30 * 60_000
    assert.deepEqual(nextAudioState(open, false, undefined, NOW), open)
    const grace = nextAudioState(open, true, undefined, NOW)
    assert.deepEqual(grace, { kind: 'grace', until: NOW + GRACE_MS })
    assert.deepEqual(nextAudioState(grace, true, NOW, NOW + GRACE_MS - 1), grace)
    assert.deepEqual(nextAudioState(grace, true, NOW, NOW + GRACE_MS), { kind: 'muted' })
    // a socket that hits the limit inside a window another socket started shares that window
    assert.deepEqual(nextAudioState(open, true, NOW, NOW + 1000), { kind: 'grace', until: NOW + GRACE_MS })
    assert.deepEqual(nextAudioState(open, true, NOW, NOW + GRACE_MS), { kind: 'muted' })
    assert.deepEqual(nextAudioState({ kind: 'muted' }, false, undefined, NOW), { kind: 'muted' })
  })
})
