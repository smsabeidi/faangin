import test from 'node:test'
import assert from 'node:assert/strict'
import { CapturePolicy } from '../src/main/capture-policy'

const create = (idleTimeoutMs = 600_000) => new CapturePolicy({ idleTimeoutMs, now: () => 1000 })
test('manual pause retains session context and requires an explicit resumed generation', () => {
  const policy = create(); policy.begin('session', 1)
  const pause = policy.pause()!
  assert.equal(pause.type, 'pause'); assert.equal(pause.reason, 'manual'); assert.equal(policy.pause(), null)
  assert.equal(policy.state().sessionId, 'session'); assert.equal(policy.activity(1, .8, 2000), false)
  const resume = policy.resume()!
  assert.equal(policy.state().phase, 'resuming'); assert.equal(policy.resumed(resume, 2, 3000), true)
  assert.equal(policy.state().phase, 'running'); assert.equal(policy.state().generation, 2)
  assert.equal(policy.activity(1, .8, 3100), false); assert.equal(policy.activity(2, .8, 3100), true)
})
test('Stop during resume invalidates late acquisition and never resumes a ended session', () => {
  const policy = create(); policy.begin('session', 1); policy.pause()
  const resume = policy.resume()!; policy.stop()
  assert.equal(policy.isCurrent(resume), false); assert.equal(policy.resumed(resume, 2), false)
  assert.equal(policy.state().sessionId, null); assert.equal(policy.resume(), null)
})
test('sleep pauses the active generation and wake only requests reacquisition for the same active session', () => {
  const policy = create(); policy.begin('session', 10)
  assert.equal(policy.suspend()!.reason, 'sleep'); assert.equal(policy.state().phase, 'suspended')
  assert.equal(policy.suspend(), null); assert.equal(policy.activity(10, 1), false)
  const wake = policy.wake()!
  assert.equal(wake.sessionId, 'session'); assert.equal(wake.type, 'resume'); assert.equal(policy.wake(), null)
  assert.equal(policy.resumed(wake, 11, 700_000), true)
  assert.equal(policy.poll(700_001), null)
})
test('manual pause survives sleep and never silently reacquires sources', () => {
  const policy = create(); policy.begin('session', 1); policy.pause()
  assert.equal(policy.suspend(), null); assert.equal(policy.wake(), null)
  assert.equal(policy.state().phase, 'paused'); assert.equal(policy.state().reason, 'manual')
  assert.equal(policy.resume()!.reason, 'manual')
})
test('Stop while asleep prevents automatic wake capture and keeps a later new session independent', () => {
  const policy = create(); policy.begin('old', 1); policy.suspend(); policy.stop()
  assert.throws(() => policy.begin('new', 2), /asleep/)
  assert.equal(policy.wake(), null); policy.begin('new', 2)
  assert.equal(policy.state().sessionId, 'new')
})
test('no auto-ending occurs while idle policy is disabled or the session is manually paused', () => {
  const disabled = create(0); disabled.begin('session', 1); assert.equal(disabled.poll(100_000_000), null)
  const paused = create(10); paused.begin('session', 1); paused.pause(); assert.equal(paused.poll(100_000_000), null)
})
test('idle ending counts only current-generation meaningful audio across either source', () => {
  const policy = create(10_000); policy.begin('session', 1, 1000)
  assert.equal(policy.activity(0, 1, 5000), false)
  assert.equal(policy.activity(1, 0, 6000), false)
  assert.equal(policy.activity(1, NaN, 6000), false)
  assert.equal(policy.activity(1, 1.1, 6000), false)
  assert.equal(policy.activity(1, .03, 9000), true)
  assert.equal(policy.poll(18_999), null)
  const ending = policy.poll(19_000)!
  assert.equal(ending.type, 'end'); assert.equal(ending.reason, 'idle'); assert.equal(policy.isCurrent(ending), true)
  assert.equal(policy.state().phase, 'ending'); assert.equal(policy.resume(), null); assert.equal(policy.pause(), null); assert.equal(policy.deviceChanged(), null)
  assert.equal(policy.poll(30_000), null)
})
test('device changes restart only desired active capture and fence superseded restart decisions', () => {
  const policy = create(); assert.equal(policy.deviceChanged(), null)
  policy.begin('session', 10)
  const old = policy.deviceChanged()!, newest = policy.deviceChanged()!
  assert.equal(newest.type, 'restart'); assert.equal(policy.resumed(old, 11), false)
  assert.equal(policy.resumed(newest, 12), true); assert.equal(policy.state().generation, 12)
  policy.pause(); assert.equal(policy.deviceChanged(), null)
})
test('pause or sleep during device restart invalidates reacquisition', () => {
  for (const event of ['pause', 'suspend'] as const) {
    const policy = create(); policy.begin('session', 1)
    const restart = policy.deviceChanged()!; policy[event]()
    assert.equal(policy.resumed(restart, 2), false)
  }
})
test('failed wake stays visibly paused without an implicit retry loop', () => {
  const policy = create(); policy.begin('session', 1); policy.suspend()
  const wake = policy.wake()!
  assert.equal(policy.resumeFailed(wake), true); assert.equal(policy.state().phase, 'paused')
  assert.equal(policy.state().reason, 'sleep'); assert.equal(policy.wake(), null)
  assert.equal(policy.poll(10_000_000), null); assert.equal(policy.resume()!.type, 'resume')
})
test('new resumed generations must advance and inactive late audio cannot extend idle time', () => {
  const policy = create(); policy.begin('session', 8); policy.pause()
  const resume = policy.resume()!
  assert.throws(() => policy.resumed(resume, 8), /new generation/)
  assert.equal(policy.activity(8, 1, 5000), false)
  policy.resumed(resume, 9, 6000)
  const snapshot = policy.state(); snapshot.sessionId = 'tampered'
  assert.equal(policy.state().sessionId, 'session')
})
test('clock regression cannot leave an active session permanently immune to idle timeout', () => {
  const policy = create(1000); policy.begin('session', 1, 5000)
  assert.equal(policy.poll(100), null); assert.equal(policy.poll(1099), null)
  assert.equal(policy.poll(1100)!.type, 'end')
})
test('policy rejects invalid bounds before mutating lifecycle state', () => {
  assert.throws(() => create(-1)); assert.throws(() => create(Infinity)); assert.throws(() => new CapturePolicy({ idleTimeoutMs: 100, activityThreshold: -1 }))
  const policy = create()
  assert.throws(() => policy.begin('session', 0)); assert.equal(policy.state().phase, 'idle')
  policy.begin('session', 1); assert.throws(() => policy.begin('other', 2)); assert.equal(policy.state().sessionId, 'session')
  assert.throws(() => policy.configureIdleTimeout(-1)); assert.throws(() => policy.poll(NaN))
})
