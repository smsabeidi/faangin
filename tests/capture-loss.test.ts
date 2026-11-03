import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { AUDIO_DEVICE_DISCONNECTED, sourceLossEffects } from '../src/main/capture-loss'
import { darwinPlatform, linuxPlatform, win32Platform } from '../src/main/platform'

test('on macOS a lost computer-audio source is a revoked consent: it clears the receipt and only the microphone restarts survivors', () => {
  assert.deepEqual(sourceLossEffects(darwinPlatform, 'system', AUDIO_DEVICE_DISCONNECTED), { clearVerification: true, reconnectSurvivors: false })
  assert.deepEqual(sourceLossEffects(darwinPlatform, 'system', 'No audio frames — reconnect this source.'), { clearVerification: true, reconnectSurvivors: false })
  assert.deepEqual(sourceLossEffects(darwinPlatform, 'microphone', AUDIO_DEVICE_DISCONNECTED), { clearVerification: false, reconnectSurvivors: true })
  assert.deepEqual(sourceLossEffects(darwinPlatform, 'microphone', 'No audio frames — reconnect this source.'), { clearVerification: false, reconnectSurvivors: false })
})

test('on Windows a loopback that ended keeps the receipt and restarts on the new endpoint, so unplugging a headset never forces setup again', () => {
  assert.deepEqual(sourceLossEffects(win32Platform, 'system', AUDIO_DEVICE_DISCONNECTED), { clearVerification: false, reconnectSurvivors: true })
  assert.deepEqual(sourceLossEffects(win32Platform, 'microphone', AUDIO_DEVICE_DISCONNECTED), { clearVerification: false, reconnectSurvivors: true })
  // A silent stall is reported to the user while the microphone continues; it is not an endpoint change.
  assert.deepEqual(sourceLossEffects(win32Platform, 'system', 'No audio frames — reconnect this source.'), { clearVerification: false, reconnectSurvivors: false })
  assert.deepEqual(sourceLossEffects(win32Platform, 'system', 'Audio overflow — source stopped.'), { clearVerification: false, reconnectSurvivors: false })
})

test('platforms without screen-consent gating treat computer audio like Windows', () => {
  assert.equal(linuxPlatform.screenAccessGatesSystemAudio, false)
  assert.deepEqual(sourceLossEffects(linuxPlatform, 'system', AUDIO_DEVICE_DISCONNECTED), sourceLossEffects(win32Platform, 'system', AUDIO_DEVICE_DISCONNECTED))
})

test('the status constant is the exact text the renderer pipeline reports for an ended track or closed context', () => {
  const source = readFileSync(new URL('../src/capture/pipeline.ts', import.meta.url), 'utf8')
  assert.equal(source.split(`this.fail('${AUDIO_DEVICE_DISCONNECTED}')`).length - 1, 2)
})
