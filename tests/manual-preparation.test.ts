import assert from 'node:assert/strict'
import test from 'node:test'
import { ManualPreparationFence } from '../src/main/manual-preparation'

function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(finish => { resolve = finish }), resolve: () => resolve() }
}

test('Stop during transport draining or question finalization revokes preparation before dispatch', async () => {
  for (const stopDuring of ['drain', 'transcription']) {
    const fence = new ManualPreparationFence(), preparation = fence.begin('interview')
    const drain = deferred(), transcription = deferred()
    let dispatched = false, finalizing = false
    const preparing = (async () => {
      try {
        fence.assertCurrent(preparation)
        await drain.promise
        fence.assertCurrent(preparation)
        finalizing = true
        await transcription.promise
        fence.assertCurrent(preparation)
        dispatched = true
      } finally { fence.release(preparation) }
    })()
    if (stopDuring === 'transcription') { drain.resolve(); await Promise.resolve(); assert.equal(finalizing, true) }
    fence.cancel()
    drain.resolve(); transcription.resolve()
    await assert.rejects(preparing, /answer request was cancelled/)
    assert.equal(dispatched, false)
  }
})

test('stopping a foreign capture session leaves the current manual preparation owned', () => {
  const fence = new ManualPreparationFence(), preparation = fence.begin('interview')
  fence.cancel('background-meeting')
  assert.equal(fence.current(preparation), true)
  assert.doesNotThrow(() => fence.assertCurrent(preparation))
  fence.cancel('interview')
  assert.equal(fence.current(preparation), false)
})

test('late release from a cancelled preparation cannot clear a newer request', () => {
  const fence = new ManualPreparationFence(), old = fence.begin('first')
  fence.cancel('first')
  const current = fence.begin('second')
  fence.release(old)
  assert.equal(fence.current(current), true)
  assert.throws(() => fence.assertCurrent(old), /cancelled/)
  fence.release(current)
  assert.equal(fence.current(current), false)
})

test('switching away and back cannot reuse a revoked preparation identity', () => {
  const fence = new ManualPreparationFence(), old = fence.begin('interview')
  fence.cancel('interview')
  const current = fence.begin('interview')
  assert.equal(fence.current(old), false); assert.equal(fence.current(current), true)
  assert.notEqual(current.revision, old.revision)
  assert.throws(() => fence.begin('another'), /still being finalized/)
})
