import assert from 'node:assert/strict'
import test from 'node:test'
import { compressQuietGaps, frameRms, pcmWave, PCM_FRAME_BYTES } from '../scripts/conversation-audio-fixture'
import { VoiceActivity, SOURCE_VAD_OPTIONS } from '../src/capture/vad'

const frame = (sample: number, bytes = PCM_FRAME_BYTES): Buffer => { const result = Buffer.alloc(bytes); for (let offset = 0; offset < bytes; offset += 2) result.writeInt16LE(sample, offset); return result }

test('continuous transport fixture shortens VAD-quiet runs and preserves exact voiced samples/order', () => {
  const original = Buffer.concat([...Array.from({ length: 400 }, (_, index) => frame(500 + index)), ...Array.from({ length: 30 }, () => frame(1)), ...Array.from({ length: 100 }, (_, index) => frame(1500 + index))])
  const result = compressQuietGaps(original)
  assert.equal(result.metadata.removedBytes, 25 * PCM_FRAME_BYTES)
  assert.equal(result.metadata.allVadVoicedFramesPreserved, true)
  assert.equal(result.metadata.sourceVadVoicedFrames, 500)
  assert.deepEqual(result.retainedFrameIndices, [...Array.from({ length: 405 }, (_, index) => index), ...Array.from({ length: 100 }, (_, index) => index + 430)])
  assert.deepEqual(result.pcm.subarray(0, 400 * PCM_FRAME_BYTES), original.subarray(0, 400 * PCM_FRAME_BYTES))
  assert.deepEqual(result.pcm.subarray(405 * PCM_FRAME_BYTES), original.subarray(430 * PCM_FRAME_BYTES))
  assert.equal(result.metadata.maxQuietGapMs, 100)
  assert.equal(result.metadata.originalVadVoicedPcmSha256, result.metadata.transformedVadVoicedPcmSha256)
})

test('quiet compression retains short gaps, soft nonquiet speech and partial final frames', () => {
  const original = Buffer.concat([frame(164), frame(0), frame(0), frame(164, 240)])
  const result = compressQuietGaps(original)
  assert.deepEqual(result.pcm, original)
  assert.equal(result.metadata.removedBytes, 0)
  assert.equal(frameRms(frame(0)), 0)
  assert.ok(frameRms(frame(164)) > .004)
  assert.throws(() => compressQuietGaps(original, 99), /whole PCM frames/)
  assert.throws(() => compressQuietGaps(Buffer.alloc(3)), /complete PCM16/)
})

test('compressed synthetic pauses exercise a real six-second transport boundary without creating a VAD endpoint', () => {
  const original = Buffer.concat([...Array.from({ length: 400 }, () => frame(700)), ...Array.from({ length: 30 }, () => frame(1)), ...Array.from({ length: 100 }, () => frame(900))])
  const transformed = compressQuietGaps(original), commits: Array<{ complete: boolean; frames: number }> = []
  let written = 0
  const vad = new VoiceActivity(() => { written++ }, complete => commits.push({ complete, frames: written }), SOURCE_VAD_OPTIONS.system)
  for (let offset = 0; offset < transformed.pcm.length; offset += PCM_FRAME_BYTES) {
    const source = transformed.pcm.subarray(offset, offset + PCM_FRAME_BYTES), input = new ArrayBuffer(source.length)
    new Uint8Array(input).set(source); vad.push(input, frameRms(source))
  }
  assert.deepEqual(commits, [{ complete: false, frames: 300 }])
  for (let index = 0; index < 30; index++) vad.push(new ArrayBuffer(PCM_FRAME_BYTES), 0)
  assert.deepEqual(commits, [{ complete: false, frames: 300 }, { complete: true, frames: 535 }])
  assert.equal(transformed.metadata.allVadVoicedFramesPreserved, true)
})

test('synthetic WAV parser rejects wrong source format and incomplete chunks', () => {
  const wav = Buffer.alloc(44 + PCM_FRAME_BYTES)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(PCM_FRAME_BYTES, 40)
  assert.equal(pcmWave(wav).pcm.length, PCM_FRAME_BYTES)
  const stereo = Buffer.from(wav); stereo.writeUInt16LE(2, 22)
  assert.throws(() => pcmWave(stereo), /mono 24 kHz/)
  assert.throws(() => pcmWave(wav.subarray(0, 100)), /truncated chunk/)
})
