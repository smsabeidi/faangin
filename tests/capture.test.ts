import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { CaptureFence } from '../src/capture/fence'
import { commandPlatform } from '../src/capture/platform'
import { VoiceActivity } from '../src/capture/vad'
import type { CaptureCommand } from '../src/shared/types'

test('capture ownership fences late device acquisition, repeated stop, restart and reset results', () => {
  const fence = new CaptureFence()
  const first = fence.begin('first', 0)
  assert.equal(fence.acceptsFrames(first), true)
  assert.equal(fence.stop(1000), first); assert.equal(fence.stop(1001), null)
  assert.equal(fence.acceptsFrames(first), false)
  assert.equal(fence.acceptsResult(first, 'first', 0, 5999), true)
  assert.equal(fence.acceptsResult(first, 'first', 0, 6001), false)
  assert.equal(fence.acceptsResult(first, 'first', 1, 2000), false)
  const next = fence.begin('second', 0)
  assert.ok(next > first); assert.equal(fence.acceptsFrames(next), true)
  assert.equal(fence.acceptsResult(first, 'first', 0, 2000), false)
  fence.invalidate(); assert.equal(fence.acceptsFrames(next), false); assert.equal(fence.acceptsResult(next, 'second', 0), false)
})
test('VAD keeps pre-roll, commits silence and splits utterances at fifteen seconds', () => {
  let written = 0, committed = 0
  const vad = new VoiceActivity(() => written++, () => committed++)
  const frame = new ArrayBuffer(960)
  for (let i = 0; i < 1000; i++) vad.push(frame, 0)
  assert.equal(written, 0)
  for (let i = 0; i < 10; i++) vad.push(frame, .1)
  assert.equal(written, 17)
  for (let i = 0; i < 30; i++) vad.push(frame, 0)
  assert.equal(committed, 1)
  for (let i = 0; i < 1600; i++) vad.push(frame, .1)
  assert.ok(committed >= 3); vad.stop(true); assert.ok(committed >= 4)
})
test('VAD admits quiet headset speech, preserves soft syllables, and still rejects background below onset', () => {
  let writes = 0, commits = 0
  const vad = new VoiceActivity(() => { writes++ }, () => { commits++ })
  const frame = new ArrayBuffer(960)
  for (let i = 0; i < 100; i++) vad.push(frame, .003)
  assert.equal(writes, 0)
  for (let i = 0; i < 10; i++) vad.push(frame, .006)
  const onsetWrites = writes
  assert.ok(onsetWrites >= 10)
  for (let i = 0; i < 60; i++) vad.push(frame, .004)
  assert.equal(writes, onsetWrites + 60); assert.equal(commits, 0)
  for (let i = 0; i < 30; i++) vad.push(frame, 0)
  assert.equal(commits, 1)
  for (let i = 0; i < 100; i++) vad.push(frame, .004)
  assert.equal(writes, onsetWrites + 90)
})

test('invalid VAD levels cannot open or advance a speech turn', () => {
  let writes = 0, commits = 0
  const vad = new VoiceActivity(() => { writes++ }, () => { commits++ }), frame = new ArrayBuffer(960)
  for (const level of [NaN, Infinity, -.1, 2]) for (let i = 0; i < 100; i++) vad.push(frame, level)
  for (let i = 0; i < 3; i++) vad.push(new ArrayBuffer(0), .1)
  assert.equal(writes, 0); assert.equal(commits, 0)
})
test('AudioWorklet resamples Bluetooth HFP, consumer and high-rate DAC mix formats into mono PCM16 without audible feedback', () => {
  // Windows AudioContexts inherit the render device mix format: 16 kHz from an HFP headset, 96/192 kHz from onboard DACs.
  for (const rate of [16_000, 44_100, 48_000, 96_000, 192_000]) {
    let Processor: new () => { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean }
    const emitted: Array<{ pcm: ArrayBuffer; level: number }> = []
    const sandbox = { AudioWorkletProcessor: class { port = { postMessage: (message: { pcm: ArrayBuffer; level: number }) => emitted.push(message) } }, sampleRate: rate, Int16Array, Math, registerProcessor: (_name: string, constructor: typeof Processor) => { Processor = constructor } }
    vm.runInNewContext(readFileSync(new URL('../src/capture/pcm-worklet.js', import.meta.url), 'utf8'), sandbox)
    const processor = new Processor!()
    let time = 0
    for (let block = 0; block < Math.ceil(rate / 128); block++) {
      const input = Float32Array.from({ length: 128 }, () => Math.sin(2 * Math.PI * 1000 * time++ / rate) * .5)
      const output = new Float32Array(128).fill(1)
      processor.process([[input, input]], [[output]])
      assert.ok(output.every(value => value === 0))
    }
    assert.ok(emitted.length >= 49 && emitted.length <= 50, `${rate} Hz must keep the 20 ms frame cadence`)
    assert.ok(emitted.every(frame => frame.pcm.byteLength === 960 && frame.level > .3 && frame.level < .4), `${rate} Hz must keep 960-byte frames at the tone's RMS`)
    const pcm = new Int16Array(emitted[0].pcm)
    assert.ok(Math.max(...pcm) > 15_000 && Math.max(...pcm) < 17_000)
  }
})

test('the capture command carries the OS main runs on, and a malformed value keeps the macOS behaviour instead of failing capture', () => {
  const command = (platform: unknown): CaptureCommand => ({ type: 'start', generation: 1, sessionId: 's', microphone: true, systemAudio: true, microphoneDeviceId: '', platform } as CaptureCommand)
  assert.equal(commandPlatform(command('darwin')), 'darwin')
  assert.equal(commandPlatform(command('win32')), 'win32')
  assert.equal(commandPlatform(command('linux')), 'linux')
  for (const malformed of ['Windows', 'WIN32', 'freebsd', 7, null, undefined, {}]) assert.equal(commandPlatform(command(malformed)), 'darwin')
})

test('renderer accepts Start/Stop/Start and disposes late media instead of reopening stopped devices', async () => {
  const { MediaGeneration } = await import('../src/capture/generation')
  const guard = new MediaGeneration()
  assert.equal(guard.begin(1), true)
  let acquired!: (stream: { stop(): void }) => void, disposed = false
  const pendingDevice = new Promise<{ stop(): void }>(resolve => { acquired = resolve })
  const finishAcquisition = pendingDevice.then(stream => { if (!guard.accepts(1)) stream.stop() })
  assert.equal(guard.stop(1), true)
  assert.equal(guard.begin(2), true)
  assert.equal(guard.stop(1), false)
  acquired({ stop: () => { disposed = true } }); await finishAcquisition
  assert.equal(disposed, true); assert.equal(guard.accepts(2), true)
  assert.equal(guard.begin(1), false); assert.equal(guard.stop(2), true)
  assert.equal(guard.begin(3), true)
})

test('stop-channel fences late permission completion while the independent source stays active', async () => {
  const { MediaGeneration } = await import('../src/capture/generation')
  const guard = new MediaGeneration(); guard.begin(10)
  let complete!: (stream: { stop(): void }) => void, stopped = false
  const microphone = new Promise<{ stop(): void }>(resolve => { complete = resolve }).then(stream => { if (!guard.accepts(10, 'microphone')) stream.stop() })
  assert.equal(guard.stopChannel(10, 'microphone'), true)
  assert.equal(guard.accepts(10, 'system'), true)
  complete({ stop: () => { stopped = true } }); await microphone
  assert.equal(stopped, true); assert.equal(guard.accepts(10, 'microphone'), false)
  assert.equal(guard.stopChannel(9, 'system'), false)
  guard.begin(11); assert.equal(guard.accepts(11, 'microphone'), true)
})
