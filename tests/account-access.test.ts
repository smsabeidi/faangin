import assert from 'node:assert/strict'
import test from 'node:test'
import { accountAllowsInference, accountHasPro, requireAccountInference } from '../src/shared/account-access'
import type { LicenseState } from '../src/shared/billing-types'

test('configured accounts deny inference until a verified plan is available', () => {
  for (const kind of ['signed-out', 'no-plan', 'locked'] as const) {
    const state: LicenseState = { kind }
    assert.equal(accountAllowsInference(state), false)
    assert.equal(accountHasPro(state), false)
    assert.throws(() => requireAccountInference(state), /Plan & account/)
  }
})

test('offline valid plans and grace permit inference; only Pro uses managed transport', () => {
  for (const plan of ['byok', 'pro'] as const) {
    for (const state of [
      { kind: 'active', plan, pastDue: true, periodEnd: 100, cancelAtPeriodEnd: true },
      { kind: 'grace', plan, graceUntil: 100 }
    ] as LicenseState[]) {
      assert.equal(accountAllowsInference(state), true)
      assert.equal(accountHasPro(state), plan === 'pro')
      assert.doesNotThrow(() => requireAccountInference(state))
    }
  }
  assert.equal(accountAllowsInference({ kind: 'unavailable' }), true)
  assert.equal(accountHasPro({ kind: 'unavailable' }), false)
})
