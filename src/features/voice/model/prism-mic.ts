/** Continuous 16 kHz PCM. Prism finds the end of the turn; this does not. */

const FRAME = 320

function rms(frame: Float32Array) {
  let sum = 0
  for (const sample of frame) sum += sample * sample
  return Math.min(1, Math.sqrt(sum / frame.length) * 4)
}

function pcm16(frame: Float32Array) {
  const out = new Int16Array(frame.length)
  for (let i = 0; i < frame.length; i++) {
    const sample = Math.max(-1, Math.min(1, frame[i] ?? 0))
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return out
}

export function pcmToBase64(pcm: Int16Array) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export class PrismMic {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private generation = 0
  private muted = false
  private pending = new Int16Array(0)
  constructor(private readonly handlers: { onAudio: (base64: string) => void; onLevel: (level: number) => void; onError: (message: string) => void }) {}

  async start() {
    const generation = ++this.generation
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
    if (generation !== this.generation) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    this.stream = stream
    const context = new AudioContext({ latencyHint: "interactive" })
    this.context = context
    await context.audioWorklet.addModule(new URL("./capture.worklet.js", import.meta.url).href)
    if (generation !== this.generation) return this.stop()
    const node = new AudioWorkletNode(context, "orbit-capture")
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (generation !== this.generation) return
      const frame = event.data
      this.handlers.onLevel(this.muted ? 0 : rms(frame))
      const samples = this.muted ? new Int16Array(FRAME) : pcm16(frame)
      const joined = new Int16Array(this.pending.length + samples.length)
      joined.set(this.pending)
      joined.set(samples, this.pending.length)
      // 80 ms. Prism still sees the silence; the socket is not one invoke per frame.
      if (joined.length < FRAME * 4) {
        this.pending = joined
        return
      }
      this.pending = new Int16Array(0)
      this.handlers.onAudio(pcmToBase64(joined))
    }
    const source = context.createMediaStreamSource(stream)
    source.connect(node)
    node.connect(context.destination)
    await context.resume()
  }

  setMuted(muted: boolean) {
    this.muted = muted
    if (muted) this.handlers.onLevel(0)
  }

  stop() {
    this.generation++
    this.pending = new Int16Array(0)
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    void this.context?.close()
    this.context = null
  }
}
