import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { SOURCE_VAD_OPTIONS, VoiceActivity } from '../src/capture/vad'

function worklet(rate: number) {
  type Processor = { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean }
  let Processor!: new () => Processor
  const frames: Array<{ pcm: ArrayBuffer; level: number }> = []
  vm.runInNewContext(readFileSync(new URL('../src/capture/pcm-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: (frame: { pcm: ArrayBuffer; level: number }) => frames.push(frame) } },
    sampleRate: rate, Int16Array, Float32Array, Float64Array, Number, Math,
    registerProcessor: (_name: string, value: typeof Processor) => { Processor = value },
  })
  const processor = new Processor()
  return { processor, frames,
    render(channels: number, sample: (index: number, channel: number) => number, seconds = 1) {
      for (let block = 0; block < Math.ceil(rate * seconds / 128); block++) {
        const input = Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: 128 }, (_, index) => sample(block * 128 + index, channel)))
        const output = new Float32Array(128).fill(1)
        processor.process([input], [[output]])
        assert.ok(output.every(value => value === 0), 'capture output must never produce local feedback')
      }
      return frames
    },
  }
}

test('long speech crosses six-second transport chunks without dropped, duplicated or re-gated PCM frames', () => {
  const written: ArrayBuffer[] = [], commits: number[] = []
  const vad = new VoiceActivity(frame => written.push(frame), () => commits.push(written.length), SOURCE_VAD_OPTIONS.system)
  const input = Array.from({ length: 615 }, (_, index) => { const frame = new ArrayBuffer(960); new Int16Array(frame).fill(index); return frame })
  input.forEach((frame, index) => vad.push(frame, index > 300 && index < 330 ? .004 : .02))
  assert.deepEqual(commits, [300, 600])
  assert.equal(written.length, input.length)
  input.forEach((frame, index) => assert.equal(written[index], frame, `frame ${index} must retain its source and order`))
  vad.stop(true); assert.deepEqual(commits, [300, 600, 615])
})

test('stopping exactly at a chunk boundary does not commit another empty audio buffer', () => {
  let commits = 0
  const vad = new VoiceActivity(() => {}, () => { commits++ }, SOURCE_VAD_OPTIONS.microphone)
  for (let i = 0; i < 300; i++) vad.push(new ArrayBuffer(960), .02)
  assert.equal(commits, 1)
  vad.stop(true); assert.equal(commits, 1)
})

test('resampling preserves real-time frame cadence for low-rate, standard and high-rate input devices', () => {
  for (const rate of [16_000, 44_100, 48_000, 176_400]) {
    const f = worklet(rate)
    const frames = f.render(1, index => Math.sin(2 * Math.PI * 1_000 * index / rate) * .5)
    assert.ok(frames.length >= 49 && frames.length <= 50, `${rate} Hz must not drift or create excess PCM frames`)
    assert.ok(frames.every(frame => frame.pcm.byteLength === 960 && frame.level > .3 && frame.level < .4))
  }
})

test('quiet one-sided and opposite-polarity stereo retain the same speech samples as mono', () => {
  const tone = (index: number) => Math.sin(2 * Math.PI * 1_000 * index / 48_000) * .01
  const mono = worklet(48_000).render(1, tone)
  for (const arrangement of ['left', 'right', 'opposite'] as const) {
    const stereo = worklet(48_000).render(2, (index, channel) => arrangement === 'opposite' ? tone(index) * (channel ? -1 : 1) : (channel === (arrangement === 'left' ? 0 : 1) ? tone(index) : 0))
    assert.equal(stereo.length, mono.length)
    stereo.forEach((frame, index) => {
      assert.ok(frame.level >= .006, 'quiet loopback speech must survive the admission threshold')
      assert.deepEqual(new Int16Array(frame.pcm), new Int16Array(mono[index].pcm))
    })
  }
})

test('clipped and invalid input samples cannot poison frame health or break the audio processor', () => {
  const f = worklet(24_000)
  const frames = f.render(1, index => [NaN, Infinity, -Infinity, 2, -2, .1, -.1][index % 7])
  assert.ok(frames.length >= 49 && frames.length <= 50)
  assert.ok(frames.every(frame => Number.isFinite(frame.level) && frame.level <= 1))
  const pcm = new Int16Array(frames[0].pcm)
  assert.ok(pcm.includes(0)); assert.ok(pcm.includes(32_767)); assert.ok(pcm.includes(-32_768))
})

test('an empty native input block still produces silent connected output', () => {
  const f = worklet(48_000), output = new Float32Array(128).fill(1)
  assert.equal(f.processor.process([[]], [[output]]), true)
  assert.ok(output.every(value => value === 0)); assert.equal(f.frames.length, 0)
})

test('voice activity timing limits cannot exceed the provider audio turn bound', () => {
  for (const options of [{ maxSegmentMs: 15_020 }, { maxSegmentMs: 6_001 }, { silenceMs: 21 }, { silenceMs: NaN }]) {
    assert.throws(() => new VoiceActivity(() => {}, () => {}, options), /timing limits/)
  }
})
