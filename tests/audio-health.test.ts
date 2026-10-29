import test from 'node:test'
import assert from 'node:assert/strict'
import { AudioHealthTracker, AUDIO_HEALTH_MESSAGES } from '../src/capture/audio-health'
import { VoiceActivity } from '../src/capture/vad'

function frames(tracker: AudioHealthTracker, from: number, until: number, level: number): void {
  for (let at = from; at <= until; at += 20) assert.equal(tracker.push(level, at), true)
}

test('quiet active audio gets a conditional low-level diagnostic without admitting it as speech', () => {
  const tracker = new AudioHealthTracker(0), frame = new ArrayBuffer(960)
  let writes = 0, commits = 0
  const vad = new VoiceActivity(() => writes++, () => commits++)
  for (let at = 20; at <= 8_020; at += 20) { tracker.push(.004, at); vad.push(frame, .004) }
  assert.equal(tracker.read(8_020), 'low-level')
  assert.equal(AUDIO_HEALTH_MESSAGES['low-level'], 'Low audio level — raise the source volume if speech is playing.')
  assert.equal(writes, 0); assert.equal(commits, 0)
})

test('silent active frames preserve the silence diagnostic and missing frames take precedence', () => {
  const tracker = new AudioHealthTracker(0)
  frames(tracker, 20, 8_000, 0)
  assert.equal(tracker.read(8_000), 'listening')
  tracker.push(0, 8_020)
  assert.equal(tracker.read(8_020), 'silent')
  assert.equal(AUDIO_HEALTH_MESSAGES.silent, 'Silent — check the source if speech is playing.')
  assert.equal(tracker.read(11_020), 'silent')
  assert.equal(tracker.read(11_021), 'no-frames')
  assert.equal(AUDIO_HEALTH_MESSAGES['no-frames'], 'No audio frames — reconnect this source.')
})

test('quiet warning recovers only after three consecutive adequate frames and is not cleared by isolated noise', () => {
  const tracker = new AudioHealthTracker(0)
  frames(tracker, 20, 8_020, .004)
  tracker.push(.015, 8_040); tracker.push(.015, 8_060)
  assert.equal(tracker.read(8_060), 'low-level')
  tracker.push(.004, 8_080)
  tracker.push(.015, 8_100); tracker.push(.015, 8_120)
  assert.equal(tracker.read(8_120), 'low-level')
  tracker.push(.015, 8_140)
  assert.equal(tracker.read(8_140), 'listening')
  frames(tracker, 8_160, 16_140, .004)
  assert.equal(tracker.read(16_140), 'listening')
  tracker.push(.004, 16_160)
  assert.equal(tracker.read(16_160), 'low-level')
})

test('invalid levels and stale times cannot refresh health or masquerade as adequate audio', () => {
  const tracker = new AudioHealthTracker(100)
  for (const level of [NaN, Infinity, -Infinity, -.1, 1.1]) assert.equal(tracker.push(level, 1_000), false)
  assert.equal(tracker.push(.1, NaN), false)
  assert.equal(tracker.push(.1, 99), false)
  assert.equal(tracker.read(3_101), 'no-frames')
  assert.throws(() => tracker.read(NaN)); assert.throws(() => tracker.read(99))
  assert.throws(() => new AudioHealthTracker(Infinity)); assert.throws(() => new AudioHealthTracker(-1))
})

test('independent sources and a fresh capture generation do not inherit warning or admission state', () => {
  const microphone = new AudioHealthTracker(0), system = new AudioHealthTracker(0)
  frames(microphone, 20, 8_020, .004)
  frames(system, 20, 8_020, .02)
  assert.equal(microphone.read(8_020), 'low-level'); assert.equal(system.read(8_020), 'listening')
  const restarted = new AudioHealthTracker(8_020)
  assert.equal(restarted.read(8_020), 'listening')
  restarted.push(.02, 8_040); restarted.push(.02, 8_060)
  frames(restarted, 8_080, 16_040, .004)
  assert.equal(restarted.read(16_040), 'low-level')
})
