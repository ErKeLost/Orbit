/** Continuous 16 kHz PCM. Prism finds the end of the turn. */
import { microphoneError } from "./microphone-error"

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
  private readonly pending = new Int16Array(FRAME * 4)
  private pendingLength = 0
  private readonly handlers: { onAudio: (base64: string) => void; onLevel: (level: number) => void; onError: (message: string) => void }
  constructor(handlers: { onAudio: (base64: string) => void; onLevel: (level: number) => void; onError: (message: string) => void }) {
    this.handlers = handlers
  }

  async start() {
    const generation = ++this.generation
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("此设备的网页视图无法打开麦克风")
    const context = new AudioContext({ latencyHint: "interactive" })
    this.context = context
    const started = context.resume()
    void started.catch(() => undefined)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
    if (generation !== this.generation) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    this.stream = stream
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (generation === this.generation) this.handlers.onError("麦克风已断开，请重新接通。")
      }, { once: true })
    }
    if (!context.audioWorklet) throw new Error("此 WebView 不支持实时麦克风处理，请更新系统 WebView。")
    try {
      await context.audioWorklet.addModule(new URL("./capture.worklet.js", import.meta.url).href)
    } catch (error) {
      throw new Error(`麦克风处理器无法启动：${microphoneError(error)}`)
    }
    if (generation !== this.generation) return
    const node = new AudioWorkletNode(context, "orbit-capture")
    node.onprocessorerror = () => {
      if (generation === this.generation) this.handlers.onError("麦克风处理已中断，请重新接通。")
    }
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (generation !== this.generation) return
      const frame = event.data
      this.handlers.onLevel(this.muted ? 0 : rms(frame))
      if (this.muted) this.pending.fill(0, this.pendingLength, this.pendingLength + FRAME)
      else this.pending.set(pcm16(frame), this.pendingLength)
      this.pendingLength += FRAME
      if (this.pendingLength < this.pending.length) return
      this.pendingLength = 0
      this.handlers.onAudio(pcmToBase64(this.pending))
    }
    context.createMediaStreamSource(stream).connect(node)
    node.connect(context.destination)
    await started
  }

  setMuted(muted: boolean) {
    this.muted = muted
    if (muted) {
      this.pending.fill(0, 0, this.pendingLength)
      this.handlers.onLevel(0)
    }
  }

  stop() {
    this.generation++
    this.pendingLength = 0
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    const context = this.context
    this.context = null
    if (context && context.state !== "closed") void context.close().catch(() => undefined)
  }
}
