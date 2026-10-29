import { createHash } from 'node:crypto'
import { SPEECH_END_LEVEL } from '../src/capture/vad'

export const PCM_FRAME_BYTES = 960
export const PCM_FRAME_MS = 20
export const SYNTHETIC_QUIET_RMS = SPEECH_END_LEVEL
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export function frameRms(pcm: Buffer): number {
  if (!pcm.length || pcm.length % 2) throw new Error('PCM16 frames must have a positive even byte length.')
  let sum = 0
  for (let offset = 0; offset < pcm.length; offset += 2) sum += (pcm.readInt16LE(offset) / 32768) ** 2
  return Math.sqrt(sum / (pcm.length / 2))
}

export function pcmWave(bytes: Buffer) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Synthetic WAV has an unexpected container.')
  let format: { encoding: number; channels: number; sampleRate: number; bits: number } | undefined
  let pcm: Buffer | undefined
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > bytes.length) throw new Error('Synthetic WAV contains a truncated chunk.')
    if (type === 'fmt ') {
      if (size < 16) throw new Error('Synthetic WAV format is truncated.')
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) }
    }
    if (type === 'data') pcm = bytes.subarray(start, start + size)
    offset = start + size + size % 2
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 24_000 || format.bits !== 16 || !pcm?.length || pcm.length % 2) throw new Error('Synthetic WAV must contain mono 24 kHz signed PCM16.')
  return { format, pcm }
}

/** Derive a transport fixture by shortening frames below the actual VAD release threshold. */
export function compressQuietGaps(pcm: Buffer, maxQuietGapMs = 100) {
  if (!pcm.length || pcm.length % 2) throw new Error('Synthetic input must contain complete PCM16 samples.')
  if (!Number.isSafeInteger(maxQuietGapMs) || maxQuietGapMs < PCM_FRAME_MS || maxQuietGapMs % PCM_FRAME_MS) throw new Error('Quiet gap limit must use positive whole PCM frames.')
  const keepLimit = maxQuietGapMs / PCM_FRAME_MS
  const frames: Buffer[] = [], retainedFrameIndices: number[] = []
  const gaps: Array<{ startFrame: number; inputFrames: number; retainedFrames: number }> = []
  let quietRun = 0, sourceVoicedFrames = 0
  const voicedBefore = createHash('sha256'), voicedAfter = createHash('sha256')
  for (let offset = 0, index = 0; offset < pcm.length; offset += PCM_FRAME_BYTES, index++) {
    const frame = pcm.subarray(offset, Math.min(offset + PCM_FRAME_BYTES, pcm.length)), rms = frameRms(frame)
    const quiet = rms < SYNTHETIC_QUIET_RMS
    if (!quiet) { voicedBefore.update(frame); sourceVoicedFrames++ }
    if (quiet) {
      if (!quietRun) gaps.push({ startFrame: index, inputFrames: 0, retainedFrames: 0 })
      quietRun++; gaps[gaps.length - 1].inputFrames++
      if (quietRun > keepLimit) continue
      gaps[gaps.length - 1].retainedFrames++
    } else quietRun = 0
    frames.push(frame); retainedFrameIndices.push(index)
    if (!quiet) voicedAfter.update(frame)
  }
  const output = Buffer.concat(frames), before = voicedBefore.digest('hex'), after = voicedAfter.digest('hex')
  return {
    pcm: output, retainedFrameIndices,
    metadata: {
      kind: 'vad_quiet_gap_compression', quietRmsThreshold: SYNTHETIC_QUIET_RMS, maxQuietGapMs,
      definition: `Only runs of synthetic 20 ms frames with RMS < ${SYNTHETIC_QUIET_RMS} are shortened. All frames at or above the VAD release threshold retain exact samples and source order. Quiet frames may still contain low-level speech; this is an artificial transport fixture.`,
      originalPcmBytes: pcm.length, transformedPcmBytes: output.length, removedBytes: pcm.length - output.length,
      originalDurationMs: pcm.length / 48, transformedDurationMs: output.length / 48,
      originalPcmSha256: hash(pcm), transformedPcmSha256: hash(output),
      sourceVadVoicedFrames: sourceVoicedFrames, originalVadVoicedPcmSha256: before, transformedVadVoicedPcmSha256: after,
      allVadVoicedFramesPreserved: before === after, gaps,
    },
  }
}
