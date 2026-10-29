import type { AudioChannel, CaptureCommand } from '../shared/types'
import { MediaGeneration } from './generation'
import { AudioPipeline } from './pipeline'
import { acquireMicrophone, audioCaptureError, microphoneMissing } from './media'
import workletUrl from './pcm-worklet.js?url'

const generations = new MediaGeneration()
const accepts = (token: number, channel: AudioChannel) => generations.accepts(token, channel)
const pipelines = new Map<AudioChannel, AudioPipeline>()
let activeToken: number | null = null
function dispose(channel: AudioChannel): void {
  const pipeline = pipelines.get(channel)
  if (!pipeline) return
  pipelines.delete(channel); pipeline.stop()
}
function disposeAll(): void { for (const channel of pipelines.keys()) dispose(channel) }
async function acquire(command: CaptureCommand, channel: AudioChannel): Promise<void> {
  const token = command.generation
  let stream: MediaStream | null = null, context: AudioContext | null = null, pipeline: AudioPipeline | null = null
  try {
    window.faangin.reportCapture(token, channel, 'Requesting permission…')
    stream = channel === 'microphone'
      ? await acquireMicrophone(navigator.mediaDevices, command.microphoneDeviceId, () => accepts(token, channel), () => window.faangin.reportCapture(token, channel, 'Selected microphone disconnected. Connecting the default microphone…'))
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    if (!accepts(token, channel)) { for (const track of stream.getTracks()) track.stop(); return }
    if (!stream.getAudioTracks().length) throw new Error(channel === 'system' ? 'No system audio track was provided. Allow screen and system audio recording in system settings, then reconnect audio.' : 'No microphone audio track was provided. Connect a microphone, then reconnect audio.')
    context = new AudioContext({ latencyHint: 'interactive' })
    pipeline = new AudioPipeline({ stream, context, channel,
      current: () => accepts(token, channel) && pipelines.get(channel) === pipeline,
      frame: frame => window.faangin.sendAudio(token, channel, frame),
      commit: utteranceComplete => window.faangin.commitAudio(token, channel, utteranceComplete),
      level: level => window.faangin.reportAudioLevel(token, channel, level),
      status: (message, failed) => { if (failed && pipelines.get(channel) === pipeline) pipelines.delete(channel); window.faangin.reportCapture(token, channel, message, failed) }
    })
    pipelines.set(channel, pipeline)
    await pipeline.start(workletUrl)
  } catch (error) {
    if (pipeline) { if (pipelines.get(channel) === pipeline) pipelines.delete(channel); pipeline.stop() }
    else { if (stream) for (const track of stream.getTracks()) track.stop(); if (context) await context.close().catch(() => {}) }
    if (accepts(token, channel)) window.faangin.reportCapture(token, channel, audioCaptureError(channel, error), true)
  }
}
window.faangin.onCaptureCommand(command => {
  if (command.type === 'stop') { if (generations.stop(command.generation)) { activeToken = null; disposeAll() }; return }
  if (command.type === 'stop-channel') { if (command.channel && generations.stopChannel(command.generation, command.channel)) { dispose(command.channel) }; return }
  if (!generations.begin(command.generation)) return
  activeToken = command.generation
  disposeAll()
  if (command.microphone) void acquire(command, 'microphone')
  if (command.systemAudio) void acquire(command, 'system')
})
window.addEventListener('beforeunload', () => { activeToken = null; generations.invalidate(); disposeAll() })
navigator.mediaDevices.addEventListener?.('devicechange', () => {
  const token = activeToken, microphone = pipelines.get('microphone'), deviceId = microphone?.inputDeviceId()
  if (token === null || !microphone || !deviceId) return
  void navigator.mediaDevices.enumerateDevices().then(devices => {
    if (accepts(token, 'microphone') && pipelines.get('microphone') === microphone && microphoneMissing(deviceId, devices)) window.faangin.reportDevicesChanged(token)
  }, () => { /* The live track/watchdog remains authoritative when inventory cannot be read. */ })
})
window.faangin.onMicrophoneInventory?.(requestId => {
  void Promise.resolve().then(() => navigator.mediaDevices.enumerateDevices()).then(devices => {
    const microphones = devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId.length <= 256).slice(0, 64).map(device => ({ deviceId: device.deviceId, label: device.label.slice(0, 160) }))
    window.faangin.reportMicrophoneInventory(requestId, microphones)
  }, () => window.faangin.reportMicrophoneInventory(requestId, [], true))
})
