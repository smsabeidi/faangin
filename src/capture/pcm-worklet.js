/* Streaming linear resampler: independent mono PCM16 at 24 kHz, 20 ms frames. */
class FaanginPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = []; this.position = 0; this.ratio = sampleRate / 24000
    this.output = new Int16Array(480); this.offset = 0; this.power = 0; this.count = 0
    this.mixed = new Float32Array(128); this.channelPowers = new Float64Array(0)
  }
  process(inputs, outputs) {
    // Connected output is always silent, even while the source has no input.
    for (const output of outputs) for (const channel of output) channel.fill(0)
    const channels = inputs[0]
    if (!channels || !channels.length || !channels[0].length) return true
    const length = channels[0].length
    if (channels.length === 1) {
      for (let i = 0; i < length; i++) {
        const input = channels[0][i]
        this.samples.push(Number.isFinite(input) ? input > 1 ? 1 : input < -1 ? -1 : input : 0)
      }
    } else {
      // Normalize the mono mix to the strongest input's energy. This preserves a
      // quiet one-sided call without attenuating it by 6dB. Opposite-polarity stereo
      // can cancel completely; retain the strongest channel in that case.
      if (this.channelPowers.length !== channels.length) this.channelPowers = new Float64Array(channels.length)
      else this.channelPowers.fill(0)
      if (this.mixed.length < length) this.mixed = new Float32Array(length)
      const powers = this.channelPowers, mixed = this.mixed
      let mixedPower = 0
      for (let i = 0; i < length; i++) {
        let value = 0
        for (let c = 0; c < channels.length; c++) {
          const input = channels[c][i]
          const sample = Number.isFinite(input) ? input > 1 ? 1 : input < -1 ? -1 : input : 0
          powers[c] += sample * sample; value += sample
        }
        mixed[i] = value / channels.length; mixedPower += mixed[i] * mixed[i]
      }
      let strongest = 0
      for (let c = 1; c < channels.length; c++) if (powers[c] > powers[strongest]) strongest = c
      const cancelled = mixedPower < powers[strongest] * .25
      const gain = mixedPower > 0 ? Math.min(2, Math.sqrt(powers[strongest] / mixedPower)) : 1
      for (let i = 0; i < length; i++) {
        const input = cancelled ? channels[strongest][i] : mixed[i] * gain
        this.samples.push(Number.isFinite(input) ? input > 1 ? 1 : input < -1 ? -1 : input : 0)
      }
    }
    while (this.position + 1 < this.samples.length) {
      const base = Math.floor(this.position), fraction = this.position - base
      const value = this.samples[base] * (1 - fraction) + this.samples[base + 1] * fraction
      this.output[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767))
      this.power += value * value; this.count++
      this.position += this.ratio
      if (this.offset === 480) {
        const pcm = this.output.buffer, level = Math.sqrt(this.power / this.count)
        this.port.postMessage({ pcm, level }, [pcm])
        this.output = new Int16Array(480); this.offset = 0; this.power = 0; this.count = 0
      }
    }
    const consumed = Math.min(this.samples.length, Math.floor(this.position))
    if (consumed) { this.samples.copyWithin(0, consumed); this.samples.length -= consumed; this.position -= consumed }
    return true
  }
}
registerProcessor('faangin-pcm', FaanginPcmProcessor)
