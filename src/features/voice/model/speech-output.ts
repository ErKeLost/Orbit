import { rimeTtsStream, rimeTtsSend, rimeTtsFinish, rimeTtsCancel } from "@/lib/rpc-projects"
import { rimeErrorMessage } from "@/lib/rime-error"

export class SpeechOutput {
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private playhead = 0
  private generation = 0
  private opened: Promise<string> | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private carry = ""
  private done = true
  private timer: ReturnType<typeof setInterval> | undefined
  private received = false
  private pendingText = ""
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private completed = true
  private sampleRate = 24000
  private handlers: { onActivity: (active: boolean) => void; onLevel: (level: number) => void; onFirstAudio: (at: number) => void; onAudioReceived?: () => void; onComplete?: () => void; onRequest?: (requestId: string) => void; onError: (message: string) => void }
  constructor(handlers: SpeechOutput["handlers"]) { this.handlers = handlers }
  async prepare() {
    this.context ??= new AudioContext({ latencyHint: "interactive" })
    if (!this.analyser) { this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 256; this.analyser.connect(this.context.destination) }
    await this.context.resume()
  }
  begin() {
    this.cancel()
    const generation = this.generation
    this.done = false; this.received = false; this.completed = false
    this.opened = rimeTtsStream((audio, sampleRate) => {
      if (generation !== this.generation || this.done) return
      try { this.audio(audio, sampleRate) } catch (error) { this.cancel(); this.handlers.onError(rimeErrorMessage(error)) }
    }, event => {
      if (generation !== this.generation) return
      if (event.requestId) this.handlers.onRequest?.(event.requestId)
      if (event.error) { this.cancel(); this.handlers.onError(rimeErrorMessage({ ...event, message: event.error })); return }
      if (event.done) { this.done = true; this.check() }
    }).then(stream => {
      if (generation !== this.generation) void rimeTtsCancel(stream.id).catch(() => undefined)
      else this.sampleRate = stream.sampleRate
      return stream.id
    })
    this.chain = this.opened.catch(error => { if (generation === this.generation) { this.cancel(); this.handlers.onError(rimeErrorMessage(error)) } })
    this.startMeter()
  }
  append(text: string) {
    if (!text || this.done) return
    this.pendingText += text
    // Coalesce token bursts into one IPC write while preserving every space.
    // Final text is flushed synchronously by finish(); no whole-answer buffering.
    this.flushTimer ??= setTimeout(() => this.flush(), 16)
  }
  private flush() {
    clearTimeout(this.flushTimer); this.flushTimer = undefined
    const text = this.pendingText; this.pendingText = ""
    if (!text) return
    const generation = this.generation, opened = this.opened
    this.chain = this.chain.then(async () => {
      const id = await opened
      if (id && generation === this.generation) await rimeTtsSend(id, text)
    }).catch(error => { if (generation === this.generation) { this.cancel(); this.handlers.onError(rimeErrorMessage(error)) } })
  }
  finish() {
    this.flush()
    const generation = this.generation, opened = this.opened
    this.chain = this.chain.then(async () => { const id = await opened; if (id && generation === this.generation) await rimeTtsFinish(id) }).catch(error => { if (generation === this.generation) { this.cancel(); this.handlers.onError(rimeErrorMessage(error)) } })
  }
  private audio(base64: string, sampleRate = this.sampleRate) {
    const context = this.context, analyser = this.analyser
    if (!context || !analyser || context.state !== "running") return
    let binary = this.carry + atob(base64); this.carry = binary.length % 2 ? binary.slice(-1) : ""; binary = binary.slice(0, binary.length & ~1)
    if (!binary.length) return
    if (this.playhead - context.currentTime > 30) { this.cancel(); this.handlers.onError("语音回复过长，已停止播放"); return }
    const buffer = context.createBuffer(1, binary.length / 2, sampleRate), channel = buffer.getChannelData(0)
    for (let i = 0; i < channel.length; i++) channel[i] = (((binary.charCodeAt(i * 2 + 1) << 8) | binary.charCodeAt(i * 2)) << 16 >> 16) / 32768
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(analyser)
    const start = Math.max(context.currentTime + 0.015, this.playhead)
    source.start(start); this.playhead = start + buffer.duration; this.sources.add(source)
    const generation = this.generation
    source.onended = () => { this.sources.delete(source); source.disconnect(); if (generation === this.generation) this.check() }
    if (!this.received) { this.received = true; this.handlers.onAudioReceived?.(); this.handlers.onFirstAudio(performance.now() + Math.max(0, start - context.currentTime) * 1000) }
    this.handlers.onActivity(true)
  }
  private startMeter() {
    if (this.timer) return
    const samples = new Float32Array(256)
    this.timer = setInterval(() => {
      this.analyser?.getFloatTimeDomainData(samples)
      let sum = 0; for (const sample of samples) sum += sample * sample
      this.handlers.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3)); this.check()
    }, 60)
  }
  private check() {
    if (this.done && !this.sources.size && !this.completed) {
      this.completed = true
      clearInterval(this.timer); this.timer = undefined; this.handlers.onLevel(0); this.handlers.onActivity(false)
      this.handlers.onComplete?.()
    }
  }
  get busy() { return !this.done || this.sources.size > 0 }
  cancel() {
    this.generation++
    clearTimeout(this.flushTimer); this.flushTimer = undefined; this.pendingText = ""; this.completed = true
    const opened = this.opened; this.opened = null
    if (opened) void opened.then(id => rimeTtsCancel(id)).catch(() => undefined)
    for (const source of this.sources) { try { source.stop() } catch { /* already stopped */ } source.disconnect() }
    this.sources.clear(); this.playhead = 0; this.carry = ""; this.done = true; this.chain = Promise.resolve()
    clearInterval(this.timer); this.timer = undefined; this.handlers.onLevel(0); this.handlers.onActivity(false)
  }
  dispose() { this.cancel(); void this.context?.close(); this.context = null; this.analyser = null }
}
