/** 24 kHz PCM16 from Prism. One decoder for the whole reply; chunks are not files. */

export class PcmPlayer {
  private context: AudioContext | null = null
  private playhead = 0
  private sources = new Set<AudioBufferSourceNode>()
  private carry = ""
  private heardOrigin = 0
  private itemId = ""
  private readonly onLevel: (level: number) => void
  constructor(onLevel: (level: number) => void) {
    this.onLevel = onLevel
  }

  async prepare() {
    this.context ??= new AudioContext({ latencyHint: "interactive", sampleRate: 24000 })
    await this.context.resume()
  }

  push(base64: string, itemId: string) {
    const context = this.context
    if (!context || context.state !== "running" || !base64) return
    if (itemId && itemId !== this.itemId) {
      this.itemId = itemId
      this.heardOrigin = context.currentTime
    }
    let binary = this.carry + atob(base64)
    this.carry = binary.length % 2 ? binary.slice(-1) : ""
    binary = binary.slice(0, binary.length & ~1)
    if (!binary) return
    const buffer = context.createBuffer(1, binary.length / 2, 24000)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < channel.length; i++) channel[i] = (((binary.charCodeAt(i * 2 + 1) << 8) | binary.charCodeAt(i * 2)) << 16 >> 16) / 32768
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const start = Math.max(context.currentTime, this.playhead)
    source.start(start)
    this.playhead = start + buffer.duration
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      if (this.sources.size) return
      const now = this.context
      if (!now || now.currentTime >= this.playhead - 0.05) this.itemId = ""
      this.onLevel(0)
    }
    this.onLevel(0.4)
  }

  /**
   * Stop local playback. A report is only for audio that was actually playing.
   * A finished reply is an earlier stretch; reporting it makes Prism say the
   * reply played before the session was last quiet.
   */
  stop(): { itemId: string; heardMs: number } {
    const context = this.context
    const playing = this.sources.size > 0
    const heardMs = playing && context && this.itemId ? Math.max(0, Math.round((context.currentTime - this.heardOrigin) * 1000)) : 0
    const itemId = playing ? this.itemId : ""
    for (const source of this.sources) {
      try { source.stop() } catch { /* already stopped */ }
    }
    this.sources.clear()
    this.playhead = 0
    this.carry = ""
    this.itemId = ""
    this.onLevel(0)
    return { itemId, heardMs }
  }

  get playing() {
    return this.sources.size > 0
  }

  async close() {
    this.stop()
    await this.context?.close()
    this.context = null
  }
}
