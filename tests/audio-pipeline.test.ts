import test from 'node:test'
import assert from 'node:assert/strict'
import { AudioPipeline } from '../src/capture/pipeline'
import { acquireMicrophone, audioCaptureError, microphoneMissing } from '../src/capture/media'
import type { AudioChannel } from '../src/shared/types'

function fixture(channel: AudioChannel = 'microphone') {
  let at = 0, active = true, tick = () => {}, watching = false, writes = 0, commits = 0, levels = 0, resumes = 0, closes = 0
  const statuses: Array<{ message: string; failed?: boolean }> = []
  const written: ArrayBuffer[] = [], reportedLevels: number[] = []
  const track = { onended: null as (() => void) | null, onmute: null as (() => void) | null, onunmute: null as (() => void) | null, muted: false, stops: 0, stop() { this.stops++ }, getSettings: () => ({ deviceId: 'headset' }) }
  const videoTrack = { onended: null as (() => void) | null, stops: 0, stop() { this.stops++ } }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track, videoTrack] } as unknown as MediaStream
  const source = { disconnected: 0, connect() {}, disconnect() { this.disconnected++ } }
  const gain = { gain: { value: 1 }, disconnected: 0, connect() {}, disconnect() { this.disconnected++ } }
  const node = { port: { onmessage: null as ((event: { data: unknown }) => void) | null }, onprocessorerror: null as (() => void) | null, disconnected: 0, connect() {}, disconnect() { this.disconnected++ } }
  const context = { state: 'suspended', audioWorklet: { async addModule() {} }, destination: {}, createMediaStreamSource: () => source, createGain: () => gain,
    async resume() { resumes++; this.state = 'running' }, async close() { closes++; this.state = 'closed' } }
  const pipeline = new AudioPipeline({ stream, context: context as unknown as AudioContext, channel, current: () => active, now: () => at,
    watch: check => { tick = check; watching = true; return () => { watching = false } },
    frame: pcm => { writes++; written.push(pcm) }, commit: () => { commits++ }, level: value => { levels++; reportedLevels.push(value) }, status: (message, failed) => statuses.push({ message, failed }) })
  return { pipeline, context, track, videoTrack, source, gain, node, stream, statuses, written, reportedLevels,
    start: () => pipeline.start('worklet.js', () => node as unknown as AudioWorkletNode),
    frame(level = .02, sample = 0) { at += 20; const pcm = new ArrayBuffer(960); new Int16Array(pcm).fill(sample); node.port.onmessage?.({ data: { pcm, level } }) },
    setTime(value: number) { at = value }, setCurrent(value: boolean) { active = value }, tick: () => tick(),
    stats: () => ({ watching, writes, commits, levels, resumes, closes }) }
}

test('source is ready only after a valid PCM frame, including when the source is currently silent', async () => {
  const f = fixture(); await f.start()
  assert.deepEqual(f.statuses, [])
  for (const data of [null, { pcm: new ArrayBuffer(0), level: .1 }, { pcm: new ArrayBuffer(960), level: NaN }, { pcm: new ArrayBuffer(960), level: 2 }]) f.node.port.onmessage?.({ data })
  assert.deepEqual(f.statuses, [])
  f.frame(0)
  assert.deepEqual(f.statuses, [{ message: 'Listening', failed: undefined }])
  assert.equal(f.stats().levels, 1)
  assert.equal(f.stats().writes, 0)
  f.pipeline.stop()
})

test('worklet and context-resume failures close every owned resource and leave no watchdog running', async () => {
  for (const failure of ['module', 'resume']) {
    const f = fixture()
    if (failure === 'module') f.context.audioWorklet.addModule = async () => { throw new Error('module failed') }
    else f.context.resume = async () => { throw new Error('resume failed') }
    await assert.rejects(f.start(), new RegExp(`${failure} failed`))
    assert.equal(f.track.stops, 1); assert.equal(f.videoTrack.stops, 1)
    assert.equal(f.stats().closes, 1); assert.equal(f.stats().watching, false)
    assert.equal(f.node.port.onmessage, null)
    f.pipeline.stop(); assert.equal(f.stats().closes, 1)
    if (failure === 'resume') { assert.equal(f.source.disconnected, 1); assert.equal(f.node.disconnected, 1); assert.equal(f.gain.disconnected, 1) }
  }
})

test('late worklet acquisition after stop cannot connect a source or report readiness', async () => {
  const f = fixture(); let finish!: () => void
  f.context.audioWorklet.addModule = () => new Promise<void>(resolve => { finish = resolve })
  const starting = f.start(); f.setCurrent(false); f.pipeline.stop(); finish(); await starting
  assert.equal(f.stats().resumes, 0); assert.equal(f.stats().closes, 1)
  assert.deepEqual(f.statuses, []); assert.equal(f.track.stops, 1)
})

test('startup gets a bounded grace period, then missing frames fail once and release both tracks', async () => {
  const f = fixture(); await f.start()
  f.setTime(8_000); f.tick(); assert.deepEqual(f.statuses, [])
  f.setTime(8_001); f.tick(); f.tick()
  assert.deepEqual(f.statuses, [{ message: 'No audio frames — reconnect this source.', failed: true }])
  assert.equal(f.stats().watching, false); assert.equal(f.track.stops, 1); assert.equal(f.videoTrack.stops, 1)
})

test('an interrupted context resumes in place and missing running frames cannot remain falsely listening', async () => {
  const f = fixture(); await f.start(); f.frame()
  f.context.state = 'suspended'; f.tick(); await Promise.resolve()
  assert.equal(f.stats().resumes, 2); assert.equal(f.context.state, 'running')
  f.frame(); assert.equal(f.statuses.filter(status => status.message === 'Listening').length, 1)
  f.setTime(3_041); f.tick()
  assert.equal(f.statuses.at(-1)?.failed, true); assert.equal(f.stats().watching, false)
})

test('ended sources stop callbacks and discard renderer VAD state without committing again', async () => {
  const f = fixture(); await f.start()
  for (let i = 0; i < 5; i++) f.frame()
  const lateMessage = f.node.port.onmessage!, ended = f.track.onended!
  ended(); const writes = f.stats().writes
  lateMessage({ data: { pcm: new ArrayBuffer(960), level: .1 } }); ended()
  assert.equal(f.stats().writes, writes); assert.equal(f.stats().commits, 0)
  assert.equal(f.statuses.filter(status => status.failed).length, 1)
  assert.equal(f.track.onended, null); assert.equal(f.track.stops, 1)
})

test('a missing saved microphone retries the default input once with a visible fallback', async () => {
  const requests: MediaStreamConstraints[] = []; let notices = 0
  const expected = {} as MediaStream
  const media = { async getUserMedia(constraints: MediaStreamConstraints) { requests.push(constraints); if (requests.length === 1) throw Object.assign(new Error('missing'), { name: 'OverconstrainedError', constraint: 'deviceId' }); return expected } }
  assert.equal(await acquireMicrophone(media, 'old-headset', () => true, () => { notices++ }), expected)
  assert.equal(notices, 1); assert.equal(requests.length, 2)
  assert.deepEqual((requests[0].audio as MediaTrackConstraints).deviceId, { exact: 'old-headset' })
  assert.equal((requests[1].audio as MediaTrackConstraints).deviceId, undefined)
  for (const request of requests) {
    const audio = request.audio as MediaTrackConstraints
    assert.equal(audio.echoCancellation, true); assert.equal(audio.noiseSuppression, true)
    assert.equal(audio.autoGainControl, false); assert.deepEqual(audio.channelCount, { ideal: 1 })
  }
})

test('simultaneous microphone and system sources endpoint independently without mixing their samples', async () => {
  const microphone = fixture('microphone'), system = fixture('system')
  await Promise.all([microphone.start(), system.start()])
  for (let i = 0; i < 10; i++) { microphone.frame(.02, 1_000); system.frame(.02, -2_000) }
  for (let i = 0; i < 29; i++) system.frame(0)
  assert.equal(system.stats().commits, 0, 'ordinary within-question pauses must not finalize the remote question')
  system.frame(0)
  assert.equal(system.stats().commits, 1, 'the remote question endpoints after 600 ms')
  assert.equal(microphone.stats().commits, 0)
  for (let i = 0; i < 29; i++) microphone.frame(0)
  assert.equal(microphone.stats().commits, 0)
  microphone.frame(0); assert.equal(microphone.stats().commits, 1, 'local speech has its own independent 600 ms endpoint')
  assert.ok(microphone.written.every(frame => new Int16Array(frame).every(sample => sample === 0 || sample === 1_000)))
  assert.ok(system.written.every(frame => new Int16Array(frame).every(sample => sample === 0 || sample === -2_000)))
  system.node.onprocessorerror!()
  const before = microphone.stats().writes
  for (let i = 0; i < 4; i++) microphone.frame(.02, 1_000)
  assert.ok(microphone.stats().writes > before, 'one source failure cannot stop the other source')
  assert.equal(microphone.stats().watching, true); assert.equal(system.stats().watching, false)
  microphone.pipeline.stop()
})

test('native mute finalizes admitted speech and recovers in place without confusing silence with disconnection', async () => {
  const f = fixture(); await f.start()
  for (let i = 0; i < 10; i++) f.frame()
  const before = f.stats().writes
  f.track.muted = true; f.track.onmute!()
  assert.equal(f.stats().commits, 1); assert.equal(f.reportedLevels.at(-1), 0)
  f.setTime(20_000); f.tick()
  assert.match(f.statuses.at(-1)!.message, /source is muted/)
  assert.equal(f.statuses.some(status => status.failed), false)
  for (let i = 0; i < 5; i++) f.frame(.02)
  assert.equal(f.stats().writes, before, 'queued frames from a muted source cannot reopen speech admission')
  f.track.muted = false; f.track.onunmute!()
  f.tick(); assert.equal(f.stats().watching, true)
  assert.equal(f.statuses.at(-1)!.message, 'Listening')
  for (let i = 0; i < 4; i++) f.frame()
  assert.ok(f.stats().writes > before)
  assert.equal(f.stats().resumes, 1, 'unmute keeps the existing native source and context')
  f.pipeline.stop()
  assert.equal(f.track.onmute, null); assert.equal(f.track.onunmute, null)
})

test('a worklet processor crash fails once and releases its native source immediately', async () => {
  const f = fixture(); await f.start(); f.frame()
  const crash = f.node.onprocessorerror!
  crash(); crash()
  assert.deepEqual(f.statuses.at(-1), { message: 'Audio processing stopped. Reconnect this source.', failed: true })
  assert.equal(f.statuses.filter(status => status.failed).length, 1)
  assert.equal(f.stats().watching, false); assert.equal(f.stats().closes, 1); assert.equal(f.track.stops, 1)
  assert.equal(f.node.onprocessorerror, null)
})

test('a source that starts muted gets a fresh startup window when native audio becomes available', async () => {
  const f = fixture('system'); f.track.muted = true; await f.start()
  f.setTime(20_000); f.tick()
  assert.equal(f.statuses.some(status => status.failed), false)
  f.track.muted = false; f.track.onunmute!(); f.tick()
  assert.equal(f.stats().watching, true)
  assert.equal(f.statuses.some(status => status.failed), false)
  f.frame(0)
  assert.equal(f.statuses.at(-1)!.message, 'Listening')
  f.pipeline.stop()
})

test('permission denial and revoked capture never retry or switch the selected microphone', async () => {
  for (const scenario of [{ name: 'NotAllowedError', current: true }, { name: 'NotFoundError', current: false }]) {
    let requests = 0, notices = 0
    const error = Object.assign(new Error('denied'), { name: scenario.name })
    const media = { async getUserMedia() { requests++; throw error } }
    await assert.rejects(acquireMicrophone(media, 'headset', () => scenario.current, () => { notices++ }), error)
    assert.equal(requests, 1); assert.equal(notices, 0)
  }
})

test('native acquisition errors explain the affected source and a recovery action', () => {
  for (const source of ['microphone', 'system'] as const) {
    for (const name of ['NotAllowedError', 'PermissionDeniedError']) {
      const message = audioCaptureError(source, { name })
      assert.match(message, /access was blocked/)
      assert.match(message, /Stop listening.*system settings.*already allowed.*fully quit and reopen.*Start listening/)
      assert.doesNotMatch(message, /permission was denied/)
    }
  }
  assert.match(audioCaptureError('microphone', { name: 'NotReadableError' }), /device is connected and available/)
})

test('hardware inventory changes only revoke the missing active microphone', async () => {
  const f = fixture(); await f.start()
  const active = f.pipeline.inputDeviceId()
  assert.equal(active, 'headset')
  assert.equal(microphoneMissing(active, [{ kind: 'audioinput', deviceId: 'headset' }, { kind: 'audiooutput', deviceId: 'new-speakers' }]), false)
  assert.equal(microphoneMissing(active, [{ kind: 'audioinput', deviceId: 'headset' }, { kind: 'audioinput', deviceId: 'new-mic' }]), false)
  assert.equal(microphoneMissing(active, [{ kind: 'audiooutput', deviceId: 'headset' }, { kind: 'audioinput', deviceId: 'new-mic' }]), true)
  assert.equal(microphoneMissing(active, []), true)
  assert.equal(microphoneMissing(undefined, []), false)
  assert.equal(microphoneMissing('default', []), false)
  f.pipeline.stop(); assert.equal(f.pipeline.inputDeviceId(), undefined)
})
