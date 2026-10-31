import { rimeSttOpen, rimeSttPush, rimeSttFinish, rimeSttAbort, rimeStt } from "@/lib/rpc-projects"
import { MicCapture, pcmToBase64, type Utterance } from "./micCapture"
import { rimeError, rimeErrorMessage, type RimeApiError } from "@/lib/rime-error"

type InputStream = { id: Promise<string>; pending: Int16Array[]; chain: Promise<unknown>; aborted: boolean; failed: RimeApiError | null; born: number }
type InputSegment = { stream: InputStream; partial: string; text?: string; utterance?: Utterance }
type InputTurn = { id: string; segments: InputSegment[]; ended: boolean }
export type SpeechInputOptions = { endpointMs: number }
export class SpeechInput {
  private mic: MicCapture
  private warm: InputStream | null = null
  private active: { segment: InputSegment; turn: InputTurn } | null = null
  private turn: InputTurn | null = null
  private generation = 0
  private listening = false
  private expiry: ReturnType<typeof setTimeout> | undefined
  private handlers: {
    onStart: (turn: string) => void; onPartial: (text: string) => void
    onDiscard?: (turn: string) => void
    onEndpoint?: (turn: string, utterance: Utterance) => void
    onText: (text: string, turn: string, utterance: Utterance) => void
    onLevel: (level: number) => void; onError: (message: string) => void; onBargeIn: () => void
  }
  private streams = new Set<InputStream>()
  constructor(options: SpeechInputOptions, handlers: SpeechInput["handlers"]) {
    this.handlers = handlers
    this.mic = new MicCapture({
      onSpeechStart: () => this.begin(), onChunk: chunk => this.chunk(chunk), onUtterance: utterance => void this.finish(utterance),
      onDiscard: () => this.discard(),
      onBargeIn: handlers.onBargeIn, onLevel: handlers.onLevel, onError: handlers.onError,
    })
    this.mic.setEndpointMs(options.endpointMs)
    this.mic.setListening(false)
  }
  /** Open the device within the click gesture; routing begins only after activation. */
  async prepareDevice(deviceId?: string) {
    const generation = this.generation
    await this.mic.start(deviceId)
    if (generation !== this.generation) throw new DOMException("Aborted", "AbortError")
  }
  activate() { this.listening = true; this.mic.setListening(true); this.prepare() }
  setEndpointMs(value: number) { this.mic.setEndpointMs(value) }
  async start(deviceId?: string) { await this.prepareDevice(deviceId); this.activate() }
  setSpeaking(value: boolean) { this.mic.setAgentSpeaking(value) }
  async setDevice(deviceId: string) { this.stop(); await this.start(deviceId || undefined) }
  private open(): InputStream {
    const state: InputStream = { id: Promise.resolve(""), pending: [], chain: Promise.resolve(), aborted: false, failed: null, born: performance.now() }
    this.streams.add(state)
    state.id = rimeSttOpen(event => {
      if (state.aborted) return
      if (event.error) state.failed = rimeError({ ...event, message: event.error })
      // Rime hypotheses replace only their own stream's text. Earlier streams
      // still belong to this user turn, even if their final arrives later.
      const segment = this.turn?.segments.find(segment => segment.stream === state)
      if (event.partial !== undefined && segment) { segment.partial = event.partial; this.partial() }
    }).then(result => { if (state.aborted) void rimeSttAbort(result.id).catch(() => undefined); return result.id })
    // Observe rejection immediately even while the microphone is quiet.
    void state.id.catch(error => { state.failed = rimeError(error) })
    return state
  }
  private prepare() {
    if (this.warm) return
    const state = this.open(); this.warm = state
    clearTimeout(this.expiry)
    this.expiry = setTimeout(() => { if (this.warm === state) { this.warm = null; this.abort(state) } }, 10000)
  }
  private begin() {
    if (!this.listening) return
    clearTimeout(this.expiry)
    const turn = this.turn ?? { id: crypto.randomUUID(), segments: [], ended: false }
    this.turn = turn; turn.ended = false
    const stream = this.warm && (!this.warm.failed || !this.warm.failed.retryable) && performance.now() - this.warm.born < 10000 ? this.warm : this.open()
    if (this.warm && this.warm !== stream) this.abort(this.warm)
    this.warm = null
    const segment: InputSegment = { stream, partial: "" }
    turn.segments.push(segment)
    this.active = { segment, turn }
    this.handlers.onStart(turn.id)
    this.partial()
  }
  private partial() {
    if (this.turn) this.handlers.onPartial(this.turn.segments.map(segment => segment.text ?? segment.partial).filter(Boolean).join(" "))
  }
  private discard() {
    const active = this.active; this.active = null
    if (!active) return
    this.abort(active.segment.stream)
    const turn = active.turn
    turn.segments = turn.segments.filter(segment => segment !== active.segment)
    if (!turn.segments.length) { this.turn = null; this.handlers.onDiscard?.(turn.id) }
    else {
      turn.ended = true
      this.handlers.onEndpoint?.(turn.id, turn.segments.at(-1)!.utterance!)
      this.partial(); this.commit(turn)
    }
    if (this.listening) this.prepare()
  }
  private commit(turn: InputTurn) {
    if (this.turn !== turn || this.active || !turn.ended || turn.segments.some(segment => segment.text === undefined)) return
    this.turn = null
    const utterances = turn.segments.map(segment => segment.utterance!)
    const pcm = new Int16Array(utterances.reduce((sum, utterance) => sum + utterance.pcm.length, 0))
    let offset = 0
    for (const utterance of utterances) { pcm.set(utterance.pcm, offset); offset += utterance.pcm.length }
    this.handlers.onText(turn.segments.map(segment => segment.text!.trim()).filter(Boolean).join(" "), turn.id, {
      pcm, durationMs: utterances.reduce((sum, utterance) => sum + utterance.durationMs, 0), lastVoicedAt: utterances.at(-1)?.lastVoicedAt,
    })
  }
  private chunk(chunk: Int16Array) {
    const state = this.active?.segment.stream
    if (!state || state.aborted || state.failed) return
    // Opening is a real state: retain the first frames until the IPC stream id arrives.
    state.pending.push(chunk)
    if (state.pending.length >= 2) this.flush(state)
  }
  private flush(state: InputStream) {
    const chunks = state.pending; state.pending = []
    if (!chunks.length) return
    const merged = new Int16Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
    state.chain = state.chain.then(async () => {
      const id = await state.id
      if (!state.aborted && !state.failed) await rimeSttPush(id, pcmToBase64(merged))
    }).catch(error => { state.failed ??= rimeError(error) })
  }
  private async finish(utterance: Utterance) {
    const active = this.active; this.active = null
    if (!active) return
    const { turn, segment } = active
    segment.utterance = utterance
    turn.ended = utterance.endReason !== "segment"
    if (turn.ended) this.handlers.onEndpoint?.(turn.id, utterance)
    const generation = this.generation
    if (!segment.stream.failed || segment.stream.failed.retryable) this.prepare()
    try {
      let text: string
      {
        const state = segment.stream
        this.flush(state)
        await state.chain
        if (state.aborted || generation !== this.generation) return
        try {
          const id = await state.id
          if (state.aborted || generation !== this.generation) return
          if (state.failed) throw state.failed
          text = (await rimeSttFinish(id)).text
        } catch (error) {
          this.abort(state)
          if (generation !== this.generation) return
          // Only a transient transport/service failure may replay audio to Rime.
          // Authentication, capacity and invalid requests need correction, not another upload.
          const failure = state.failed ?? rimeError(error)
          if (!failure.retryable) throw failure
          text = (await rimeStt(pcmToBase64(utterance.pcm))).text
        }
      }
      if (generation === this.generation && this.turn === turn) { segment.text = text.trim(); this.partial(); this.commit(turn) }
    } catch (error) {
      if (generation === this.generation && this.turn === turn) {
        this.turn = null; this.active = null
        for (const segment of turn.segments) this.abort(segment.stream)
        this.handlers.onError(rimeErrorMessage(error))
      }
    }
    finally { this.streams.delete(segment.stream) }
  }
  private abort(state: InputStream) { state.aborted = true; state.pending = []; this.streams.delete(state); void state.id.then(id => rimeSttAbort(id)).catch(() => undefined) }
  stop() {
    this.generation++; this.listening = false; clearTimeout(this.expiry); this.mic.setListening(false); this.mic.stop()
    for (const state of this.streams) this.abort(state)
    this.warm = null; this.active = null; this.turn = null
  }
}
