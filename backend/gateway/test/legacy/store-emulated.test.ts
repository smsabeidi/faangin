import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { deleteApp, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { FirestoreStore } from '../../src/legacy/store-firebase.js'
import { NOW, PERIOD_KEY, TODAY } from '../support.js'

test('Firestore serializes allowances and leases across independent gateway stores', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const app = initializeApp({ projectId: 'demo-faangin' }, `gateway-${randomUUID()}`)
  const db = getFirestore(app), a = new FirestoreStore(db), b = new FirestoreStore(db)
  const uid = `gateway-store-${randomUUID()}`
  const base = { mode: 'fast' as const, day: TODAY, ramped: false, flags: { smartToFast: false, handsfreeOff: false }, now: NOW, expiresAt: NOW + 1000 }
  try {
    await a.increment(uid, PERIOD_KEY, TODAY, { fast: 499 })
    const admissions = await Promise.all([
      a.admitAnswer(uid, PERIOD_KEY, { ...base, leaseId: 'first' }),
      b.admitAnswer(uid, PERIOD_KEY, { ...base, leaseId: 'second' })
    ])
    assert.deepEqual(admissions.map(value => value.kind).sort(), ['exhausted', 'run'])
    assert.equal((await b.read(uid, PERIOD_KEY)).fast, 500)

    // Slots span allowance periods and independent instances; a release frees one immediately.
    const nextPeriod = 'next-period'
    const second = await b.admitAnswer(uid, nextPeriod, { ...base, leaseId: 'third' })
    assert.equal(second.kind, 'run')
    assert.equal((await a.admitAnswer(uid, nextPeriod, { ...base, leaseId: 'fourth' })).kind, 'concurrency')
    await Promise.all(['first', 'second', 'third'].map(id => a.releaseLease(uid, 'answers', id)))
    assert.equal((await b.admitAnswer(uid, nextPeriod, { ...base, leaseId: 'released' })).kind, 'run')

    const audio = await Promise.all([
      a.claimLease(uid, 'audio', 'mic', NOW, NOW + 1000, 2),
      b.claimLease(uid, 'audio', 'system', NOW, NOW + 1000, 2),
      a.claimLease(uid, 'audio', 'extra', NOW, NOW + 1000, 2)
    ])
    assert.equal(audio.filter(Boolean).length, 2)
    assert.equal(await b.claimLease(uid, 'audio', 'after-crash', NOW + 1001, NOW + 2001, 2), true)
    await a.releaseLease(uid, 'audio', 'after-crash')
    assert.equal(await b.claimLease(uid, 'audio', 'after-crash', NOW + 1002, NOW + 2002, 2, true), false)
    const grace = await Promise.all([a.claimGrace(uid, PERIOD_KEY, NOW), b.claimGrace(uid, PERIOD_KEY, NOW + 1)])
    assert.equal(grace[0], grace[1])
    assert.equal((await a.read(uid, PERIOD_KEY)).graceUsedAt, grace[0])
  } finally {
    await Promise.all([db.doc(`usage/${uid}/periods/${PERIOD_KEY}`).delete(), db.doc(`usage/${uid}/periods/next-period`).delete(), db.doc(`gatewaySessions/${uid}`).delete()])
    await deleteApp(app)
  }
})
