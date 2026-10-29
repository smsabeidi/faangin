export interface NativeAudioProbeResult {
  streamGranted: boolean
  audioTrackCount: number
  audioTrackLive: boolean
  videoTracksEnded: boolean
  contextState: string
  contextClosed: boolean
  sampleRate: number
  sampleCount: number
  peakRms: number
  allTracksEnded: boolean
  stage: 'requesting-stream' | 'stream-granted' | 'resuming-context' | 'analysing' | 'complete'
  error?: string
}

/** Serialized into the isolated capture renderer. Keep every dependency inside this function. */
export async function probeNativeSystemAudio(): Promise<NativeAudioProbeResult> {
  const result: NativeAudioProbeResult = { streamGranted: false, audioTrackCount: 0, audioTrackLive: false, videoTracksEnded: false, contextState: 'uncreated', contextClosed: true, sampleRate: 0, sampleCount: 0, peakRms: 0, allTracksEnded: false, stage: 'requesting-stream' }
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined
  let tracks: MediaStreamTrack[] = [], context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined, analyser: AnalyserNode | undefined, gain: GainNode | undefined
  try {
    const acquisition = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(stream => {
      if (expired) { stream.getTracks().forEach(track => track.stop()); throw new Error('Native capture expired.') }
      return stream
    })
    const stream = await Promise.race([acquisition, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Native capture timed out.')) }, 10_000) })])
    clearTimeout(timer)
    tracks = stream.getTracks(); result.streamGranted = true; result.stage = 'stream-granted'
    // Never consume video pixels; the production display request requires video admission.
    stream.getVideoTracks().forEach(track => track.stop())
    result.videoTracksEnded = stream.getVideoTracks().every(track => track.readyState === 'ended')
    const audio = stream.getAudioTracks()
    result.audioTrackCount = audio.length; result.audioTrackLive = audio.some(track => track.readyState === 'live')
    if (!result.audioTrackLive) throw new Error('No live system audio track.')
    context = new AudioContext({ latencyHint: 'interactive' }); result.contextClosed = false
    source = context.createMediaStreamSource(new MediaStream(audio))
    analyser = context.createAnalyser(); analyser.fftSize = 1_024
    gain = context.createGain(); gain.gain.value = 0
    source.connect(analyser); analyser.connect(gain); gain.connect(context.destination)
    result.stage = 'resuming-context'
    await context.resume()
    result.contextState = context.state; result.sampleRate = context.sampleRate
    result.stage = 'analysing'
    const samples = new Float32Array(analyser.fftSize), until = performance.now() + 1_000
    while (performance.now() < until) {
      analyser.getFloatTimeDomainData(samples)
      let power = 0
      for (const sample of samples) power += Number.isFinite(sample) ? sample * sample : 0
      result.peakRms = Math.max(result.peakRms, Math.sqrt(power / samples.length)); result.sampleCount += samples.length
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    result.audioTrackLive = audio.some(track => track.readyState === 'live')
    result.stage = 'complete'
  } catch (error) { result.error = expired ? 'CaptureTimeout' : result.streamGranted && !result.audioTrackCount ? 'NoAudioTrack' : result.streamGranted && !result.audioTrackLive ? 'AudioTrackEnded' : error instanceof Error ? error.name : 'CaptureError' }
  finally {
    expired = true; clearTimeout(timer)
    try { source?.disconnect(); analyser?.disconnect(); gain?.disconnect() } catch {}
    tracks.forEach(track => { try { track.stop() } catch {} })
    result.allTracksEnded = tracks.every(track => track.readyState === 'ended')
    if (context) {
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([context.close(), new Promise(resolve => { closeTimer = setTimeout(resolve, 1_000) })]) } catch {}
      finally { clearTimeout(closeTimer); result.contextClosed = context.state === 'closed' }
    }
  }
  return result
}
