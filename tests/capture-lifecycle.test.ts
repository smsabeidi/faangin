import test from 'node:test'
import assert from 'node:assert/strict'
import { CaptureFence } from '../src/capture/fence'
import { VoiceActivity } from '../src/capture/vad'
import { CaptureLifecycle, type CaptureLease } from '../src/main/capture-lifecycle'
import { CapturePolicy } from '../src/main/capture-policy'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
class Lease implements CaptureLease {
  activations = 0; fenced = 0; disposals = 0; writes = 0; commits = 0
  readonly fence = new CaptureFence()
  readonly localGeneration = this.fence.begin('session', 0)
  readonly vad = new VoiceActivity(() => { if (this.fence.acceptsFrames(this.localGeneration)) this.writes++ }, () => { if (this.fence.acceptsFrames(this.localGeneration)) this.commits++ })
  activation: Promise<void> = Promise.resolve()
  drain: Promise<void> = Promise.resolve()
  constructor(readonly generation: number) {}
  activate(_signal: AbortSignal) { this.activations++; return this.activation }
  stopAccepting() { this.fenced++; this.fence.stop(); this.vad.stop(false) }
  dispose() { this.disposals++; return this.drain }
  frame() { if (this.fence.acceptsFrames(this.localGeneration)) this.vad.push(new ArrayBuffer(960), .1) }
}
function fixture(idleTimeoutMs = 600_000) {
  const statuses: Array<{ sessionId: string; status: string }> = [], errors: unknown[] = []
  const pending: Array<{ sessionId: string; signal: AbortSignal; ready: ReturnType<typeof deferred<CaptureLease>> }> = []
  const policy = new CapturePolicy({ idleTimeoutMs, now: () => 1000 })
  const lifecycle = new CaptureLifecycle(policy, {
    acquire: (sessionId, signal) => { const ready = deferred<CaptureLease>(); pending.push({ sessionId, signal, ready }); return ready.promise },
    status: (sessionId, status) => statuses.push({ sessionId, status }),
    error: error => errors.push(error)
  })
  const lease = new Lease(1); lifecycle.adopt('session', lease)
  return { lifecycle, policy, lease, statuses, errors, pending }
}

test('Stop during asynchronous resume aborts acquisition and disposes a late lease without activating it', async () => {
  const { lifecycle, policy, statuses, pending } = fixture()
  await lifecycle.pause()
  const resumed = lifecycle.resume(); await tick()
  assert.equal(pending.length, 1)
  await lifecycle.stop(); assert.equal(pending[0].signal.aborted, true)
  const late = new Lease(2); pending[0].ready.resolve(late); await resumed
  assert.equal(late.activations, 0); assert.equal(late.fenced, 1); assert.equal(late.disposals, 1)
  assert.equal(policy.state().phase, 'idle'); assert.equal(statuses.at(-1)!.status, 'ended')
})
test('Stop during asynchronous activation fences frames immediately and prevents a late recording status', async () => {
  const { lifecycle, policy, statuses, pending } = fixture()
  await lifecycle.pause()
  const resumed = lifecycle.resume(); await tick()
  const ready = new Lease(2), activation = deferred<void>(); ready.activation = activation.promise
  pending[0].ready.resolve(ready); await tick()
  assert.equal(ready.activations, 1)
  const stopped = lifecycle.stop()
  assert.equal(ready.fence.acceptsFrames(ready.localGeneration), false)
  activation.resolve(); await Promise.all([stopped, resumed])
  assert.equal(ready.disposals, 1); assert.equal(policy.state().phase, 'idle'); assert.equal(statuses.at(-1)!.status, 'ended')
})
test('manual pause synchronously stops frame admission, retains paused session, and does not add a speech commit', async () => {
  const { lifecycle, policy, lease, statuses } = fixture()
  for (let index = 0; index < 10; index++) lease.frame()
  assert.ok(lease.writes > 0); assert.equal(lease.commits, 0)
  const paused = lifecycle.pause(); const before = lease.writes
  for (let index = 0; index < 50; index++) lease.frame()
  assert.equal(lease.writes, before); assert.equal(lease.commits, 0)
  await paused; assert.equal(lease.disposals, 1)
  assert.equal(policy.state().sessionId, 'session'); assert.equal(policy.state().phase, 'paused'); assert.equal(statuses.at(-1)!.status, 'paused')
})
test('Stop while hardware is already paused ends intent without reacquisition or duplicate disposal', async () => {
  const { lifecycle, policy, lease, statuses, pending } = fixture()
  await lifecycle.pause(); await lifecycle.stop(); await lifecycle.stop(); await lifecycle.resume()
  assert.equal(lease.disposals, 1); assert.equal(pending.length, 0)
  assert.equal(policy.state().sessionId, null); assert.equal(statuses.at(-1)!.status, 'ended')
})
test('sleep retains paused status and wake waits for prior admitted work before reacquiring the same session', async () => {
  const { lifecycle, policy, lease, statuses, pending } = fixture()
  const drain = deferred<void>(); lease.drain = drain.promise
  const sleeping = lifecycle.suspend(); const wake = lifecycle.wake(); await tick()
  assert.equal(lease.fenced, 1); assert.equal(pending.length, 0); assert.equal(statuses.at(-1)!.status, 'paused')
  drain.resolve(); await sleeping; await tick()
  assert.equal(pending.length, 1); assert.equal(pending[0].sessionId, 'session')
  const next = new Lease(2); pending[0].ready.resolve(next); await wake
  assert.equal(next.activations, 1); assert.equal(policy.state().generation, 2); assert.equal(policy.state().phase, 'running')
  assert.equal(statuses.at(-1)!.status, 'recording'); await lifecycle.stop()
})
test('manual pause stays paused across sleep and wake without a new permission request', async () => {
  const { lifecycle, policy, pending, statuses } = fixture()
  await lifecycle.pause(); await lifecycle.suspend(); await lifecycle.wake()
  assert.equal(pending.length, 0); assert.equal(policy.state().reason, 'manual'); assert.equal(statuses.at(-1)!.status, 'paused')
})
test('Stop while asleep revokes wake intent, including a pending drain', async () => {
  const { lifecycle, policy, lease, pending, statuses } = fixture()
  const drain = deferred<void>(); lease.drain = drain.promise
  const sleeping = lifecycle.suspend(), stopped = lifecycle.stop(), waking = lifecycle.wake()
  drain.resolve(); await Promise.all([sleeping, stopped, waking])
  assert.equal(pending.length, 0); assert.equal(policy.state().phase, 'idle'); assert.equal(statuses.at(-1)!.status, 'ended')
})
test('device restart notifications share one acquisition and stale media is never run concurrently', async () => {
  const { lifecycle, lease, pending, policy } = fixture()
  const drain = deferred<void>(); lease.drain = drain.promise
  const first = lifecycle.deviceChanged(), second = lifecycle.deviceChanged(), third = lifecycle.deviceChanged()
  assert.equal(first, second); assert.equal(second, third); assert.equal(lease.disposals, 1)
  await tick(); assert.equal(pending.length, 0)
  drain.resolve(); await tick(); assert.equal(pending.length, 1)
  pending[0].ready.resolve(new Lease(2)); await Promise.all([first, second, third])
  assert.equal(policy.state().generation, 2); await lifecycle.stop()
})
test('idle ending wins a subsequent device-change event and never resumes automatically', async () => {
  const { lifecycle, lease, policy, statuses, pending } = fixture(1000)
  const ending = lifecycle.poll(2000)!
  await lifecycle.deviceChanged(); await ending
  assert.equal(lease.fenced, 1); assert.equal(policy.state().phase, 'idle'); assert.equal(pending.length, 0)
  assert.equal(statuses.at(-1)!.status, 'ended')
})
test('device reconnect cannot trigger idle ending while a new generation is still being acquired', async () => {
  const { lifecycle, pending, policy } = fixture(1000)
  const restarting = lifecycle.deviceChanged(); await tick()
  assert.equal(lifecycle.poll(1_000_000), null)
  pending[0].ready.resolve(new Lease(2)); await restarting
  assert.equal(policy.state().phase, 'running'); assert.equal(policy.state().lastActivityAt, 1000)
  await lifecycle.stop()
})
test('reacquisition errors leave paused intent visible and do not loop or change providers', async () => {
  const { lifecycle, policy, statuses, errors, pending } = fixture()
  await lifecycle.suspend(); const waking = lifecycle.wake(); await tick()
  pending[0].ready.reject(new Error('Device unavailable')); await waking
  assert.equal(policy.state().phase, 'paused'); assert.equal(statuses.at(-1)!.status, 'paused'); assert.equal(errors.length, 1)
  await lifecycle.wake(); assert.equal(pending.length, 1)
})
test('an invalid reacquired generation is disposed before activation and leaves a visible paused failure', async () => {
  const { lifecycle, policy, errors, pending } = fixture()
  await lifecycle.pause(); const resume = lifecycle.resume(); await tick()
  const invalid = new Lease(1); pending[0].ready.resolve(invalid); await resume
  assert.equal(invalid.activations, 0); assert.equal(invalid.disposals, 1); assert.equal(policy.state().phase, 'paused'); assert.equal(errors.length, 1)
})
test('a new explicit generation after Stop survives late completion from the old resumed generation', async () => {
  const { lifecycle, policy, pending, statuses } = fixture()
  await lifecycle.pause(); const oldResume = lifecycle.resume(); await tick(); await lifecycle.stop()
  const current = new Lease(3); lifecycle.adopt('new-session', current)
  const stale = new Lease(2); pending[0].ready.resolve(stale); await oldResume
  assert.equal(stale.activations, 0); assert.equal(stale.disposals, 1); assert.equal(current.disposals, 0)
  assert.equal(policy.state().sessionId, 'new-session'); assert.equal(statuses.at(-1)!.status, 'recording')
  await lifecycle.stop()
})
test('storage notification and disposal failures are surfaced without blocking the synchronous admission fence', async () => {
  const errors: unknown[] = [], policy = new CapturePolicy({ idleTimeoutMs: 0 }), lease = new Lease(1)
  lease.dispose = () => { lease.disposals++; throw new Error('Drain failure') }
  const lifecycle = new CaptureLifecycle(policy, { acquire: async () => new Lease(2), status: () => { throw new Error('Disk full') }, error: error => errors.push(error) })
  lifecycle.adopt('session', lease); await lifecycle.stop()
  assert.equal(lease.fence.acceptsFrames(lease.localGeneration), false); assert.equal(policy.state().phase, 'idle')
  assert.equal(errors.length, 3)
})

function freshFixture() {
  const policy = new CapturePolicy({ idleTimeoutMs: 1000, now: () => 1000 }), statuses: string[] = []
  const pending: Array<{ ready: ReturnType<typeof deferred<CaptureLease>>; lease: Lease; signal: AbortSignal }> = []
  const lifecycle = new CaptureLifecycle(policy, {
    acquire: async (_sessionId, signal) => {
      const lease = new Lease(pending.length + 1), ready = deferred<CaptureLease>()
      // Like the real main port, acquisition installs a generation-owned abort fence before awaiting OS permission.
      let released = false
      const stop = () => { if (!released) { released = true; lease.stopAccepting(); lease.dispose() } }
      const originalStop = lease.stopAccepting.bind(lease), originalDispose = lease.dispose.bind(lease)
      let fenced = false, disposed = false
      lease.stopAccepting = () => { if (!fenced) { fenced = true; originalStop() } }
      lease.dispose = () => { if (!disposed) { disposed = true; return originalDispose() }; return lease.drain }
      signal.addEventListener('abort', stop, { once: true })
      pending.push({ ready, lease, signal })
      if (signal.aborted) stop()
      return ready.promise
    },
    status: (_id, status) => statuses.push(status)
  })
  return { policy, lifecycle, pending, statuses }
}
test('fresh Start creates revocable intent before permission and is idempotent until physical activation', async () => {
  const { lifecycle, policy, pending, statuses } = freshFixture()
  const start = lifecycle.start('session'), repeated = lifecycle.start('session')
  assert.equal(start, repeated); assert.equal(policy.state().phase, 'starting'); assert.equal(policy.state().generation, 0)
  assert.equal(lifecycle.poll(100_000_000), null)
  await tick(); assert.equal(pending.length, 1)
  const physicalReady = deferred<void>(); pending[0].lease.activation = physicalReady.promise
  pending[0].ready.resolve(pending[0].lease); await tick()
  assert.equal(policy.state().phase, 'starting'); assert.equal(statuses.at(-1), 'starting')
  physicalReady.resolve(); await start
  assert.equal(policy.state().phase, 'running'); assert.equal(policy.state().generation, 1); assert.equal(statuses.at(-1), 'recording')
  await lifecycle.stop()
})
test('Stop during fresh OS permission fences the locally owned generation before permission resolves', async () => {
  const { lifecycle, policy, pending, statuses } = freshFixture()
  const start = lifecycle.start('session'); await tick()
  await lifecycle.stop()
  assert.equal(pending[0].lease.fence.acceptsFrames(pending[0].lease.localGeneration), false)
  assert.equal(policy.state().phase, 'idle'); assert.equal(statuses.at(-1), 'ended')
  pending[0].ready.resolve(pending[0].lease); await start
  assert.equal(pending[0].lease.activations, 0); assert.equal(pending[0].lease.disposals, 1)
  assert.equal(statuses.at(-1), 'ended')
})
test('manual pause during fresh permission retains the session and resumes only a new owned generation', async () => {
  const { lifecycle, policy, pending, statuses } = freshFixture()
  const initial = lifecycle.start('session'); await tick(); await lifecycle.pause()
  assert.equal(policy.state().phase, 'paused'); assert.equal(policy.state().sessionId, 'session'); assert.equal(statuses.at(-1), 'paused')
  const resumed = lifecycle.resume(); await tick()
  assert.equal(pending.length, 2)
  pending[0].ready.resolve(pending[0].lease); await initial
  assert.equal(pending[0].lease.activations, 0)
  pending[1].ready.resolve(pending[1].lease); await resumed
  assert.equal(policy.state().generation, 2); assert.equal(statuses.at(-1), 'recording'); await lifecycle.stop()
})
test('sleep during fresh permission retains wake intent and excludes the obsolete permission result', async () => {
  const { lifecycle, policy, pending } = freshFixture()
  const initial = lifecycle.start('session'); await tick(); await lifecycle.suspend()
  assert.equal(policy.state().phase, 'suspended'); assert.equal(pending[0].signal.aborted, true)
  const waking = lifecycle.wake(); await tick()
  pending[0].ready.resolve(pending[0].lease); await initial
  pending[1].ready.resolve(pending[1].lease); await waking
  assert.equal(pending[0].lease.activations, 0); assert.equal(policy.state().generation, 2); await lifecycle.stop()
})
test('a fresh acquisition failure rejects Start and ends intent rather than claiming recording success', async () => {
  const { lifecycle, policy, pending, statuses } = freshFixture()
  const start = lifecycle.start('session'); const failure = assert.rejects(start, /Permission denied/)
  await tick(); pending[0].ready.reject(new Error('Permission denied')); await failure
  assert.equal(policy.state().phase, 'idle'); assert.equal(statuses.at(-1), 'ended'); assert.equal(statuses.includes('recording'), false)
})
test('Stop revokes a new fresh Start waiting for the old generation drain without beginning acquisition', async () => {
  const { lifecycle, lease, pending, policy, statuses } = fixture()
  const drain = deferred<void>(); lease.drain = drain.promise
  const oldStop = lifecycle.stop(), newStart = lifecycle.start('new-session'), newStop = lifecycle.stop()
  assert.equal(policy.state().phase, 'idle'); assert.equal(statuses.at(-1)!.status, 'ended')
  drain.resolve(); await Promise.all([oldStop, newStart, newStop])
  assert.equal(pending.length, 0)
})
