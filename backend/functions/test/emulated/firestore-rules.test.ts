import assert from 'node:assert/strict'
import { test } from 'node:test'
import { db, PROJECT, signInTestUser } from './harness.js'

test('Firestore denies account and unauthenticated clients every server-owned collection', async () => {
  const user = await signInTestUser()
  const paths = [`entitlements/${user.uid}`, `customers/${user.uid}`, 'customersByStripe/cus_rules', 'stripeEvents/evt_rules', 'deviceCodes/ABCDEFGH', `devices/${user.uid}/items/mac-rules-001`, `usage/${user.uid}/periods/2026-10`, 'flags/global', 'stats/pro', `checkoutLocks/${user.uid}`, `gatewaySessions/${user.uid}`]
  for (const path of paths) {
    await db.doc(path).set({ rulesFixture: true }, { merge: true })
    const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`
    for (const headers of [{}, { authorization: `Bearer ${user.idToken}` }]) {
      assert.equal((await fetch(url, { headers })).status, 403, `read denied: ${path}`)
      assert.equal((await fetch(url, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { plan: { stringValue: 'pro' } } }) })).status, 403, `write denied: ${path}`)
    }
  }
})
