/* Audio thread: continuous resampling, 20ms transferable frames. */
class OrbitCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.phase = 0
    this.sum = 0
    this.count = 0
    this.frame = new Float32Array(320)
    this.offset = 0
  }
  process(inputs) {
    const samples = inputs[0]?.[0]
    if (!samples) return true
    const step = 16000 / sampleRate
    for (let i = 0; i < samples.length; i++) {
      this.sum += samples[i]
      this.count++
      this.phase += step
      if (this.phase >= 1) {
        this.phase -= 1
        this.frame[this.offset++] = this.sum / this.count
        this.sum = 0
        this.count = 0
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame, [this.frame.buffer])
          this.frame = new Float32Array(320)
          this.offset = 0
        }
      }
    }
    return true
  }
}
registerProcessor("orbit-capture", OrbitCapture)
