/**
 * Phone-side screen channel.
 *
 * Three decisions shape this file, all from `docs/SCREEN.md`:
 *
 * 1. **Frames get their own transport.** A preview frame is hundreds of
 *    kilobytes; sharing the control WebSocket with the Pi event stream would
 *    stall thinking tokens and input acknowledgements behind video. This
 *    module opens a second, independently authenticated connection.
 * 2. **Input goes the other way.** Input is sent on the *control* connection,
 *    so a click is never queued behind a frame that is still uploading. The
 *    host resolves the target display globally, so the two channels do not
 *    need to agree on anything beyond the pairing URI.
 * 3. **H.264 where it exists, JPEG as the floor.** H.264 costs a few hundred
 *    bytes for an idle desktop where JPEG costs tens of kilobytes, but it
 *    needs a decoder. `WebCodecs` provides one on both current mobile WebViews;
 *    the check happens once, before `screen.start`, so the host is asked for a
 *    codec the phone can actually render.
 */
import type { OrbitRemoteClient } from "./remote-client"
import { addRemoteForegroundListener, sendRemoteScreenInput, screenRemoteChannel } from "./remote-runtime"
import type {
  RemoteDisplay,
  RemoteScreenCodec,
  RemoteScreenFrame,
  RemoteScreenInput,
  RemoteScreenSettings,
  RemoteScreenStartResult,
  RemoteScreenStatus,
} from "./remote-protocol"

export type ScreenChannelState = "idle" | "connecting" | "live" | "failed"

export type ScreenChannelSnapshot = {
  state: ScreenChannelState
  error: string | null
  codec: RemoteScreenCodec
  /**
   * Why H.264 was not used, when it was not. `null` means it was.
   *
   * Surfaced rather than hidden: "the phone silently fell back to JPEG" is
   * indistinguishable from "the host ignored the request", and the two need
   * completely different fixes.
   */
  codecNote: string | null
  /** Whether this WebView exposes WebCodecs at all. */
  webCodecs: boolean
  displays: RemoteDisplay[]
  display: RemoteDisplay | null
  /** Object URL of the newest JPEG frame; unused on the H.264 path. */
  frameUrl: string | null
  frame: {
    seq: number
    width: number
    height: number
    bytes: number
    capturedAt: number
    receivedAt: number
    keyframe: boolean
  } | null
  status: RemoteScreenStatus | null
  /** Frames per second measured on the phone, over the last second. */
  receivedFps: number
  /** Capture-to-display estimate, in milliseconds. */
  latencyMs: number | null
  /** Frames the decoder had to drop because its reference chain broke. */
  decodeRecoveries: number
}

const EMPTY: ScreenChannelSnapshot = {
  state: "idle",
  error: null,
  codec: "jpeg",
  codecNote: null,
  webCodecs: false,
  displays: [],
  display: null,
  frameUrl: null,
  frame: null,
  status: null,
  receivedFps: 0,
  latencyMs: null,
  decodeRecoveries: 0,
}

type Listener = (snapshot: ScreenChannelSnapshot) => void

let channel: ScreenChannel | null = null
let support: Promise<boolean> | null = null

/**
 * Whether this WebView can decode H.264 through WebCodecs.
 *
 * Asked once per process and cached: `isConfigSupported` is asynchronous and
 * would otherwise run on every start. A `false` here is not a failure — it is
 * the answer that makes the phone ask the host for JPEG.
 */
export function hasWebCodecs(): boolean {
  return typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function"
}

export function supportsHardwareH264(): Promise<boolean> {
  support ??= (async () => {
    const decoder = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder
    if (!decoder || typeof decoder.isConfigSupported !== "function") return false
    try {
      // Probed with the same shape the host sends — AVCC plus a configuration
      // record — because a browser that only accepts Annex-B would answer
      // `true` here and then fail on every real frame.
      //
      // The profile/level asked about is the *floor*, not the stream: Baseline
      // level 3.1 is the most universally supported H.264 configuration, and
      // anything that can decode H.264 through WebCodecs can decode it. Asking
      // about Main level 4.0 instead — which is what this used to do — reports
      // "unsupported" on hardware that would have decoded the real stream
      // happily (a 720×404 preview is level 3.1 content). That is a silent
      // permanent downgrade to JPEG, which is exactly the expensive path the
      // probe is supposed to avoid.
      //
      // The record is structurally valid: one SPS, one PPS, 4-byte lengths.
      // `isConfigSupported` validates the config, it does not decode.
      const result = await decoder.isConfigSupported({
        codec: "avc1.42E01F",
        description: new Uint8Array([
          0x01, 0x42, 0xe0, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x1f,
          0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
        ]),
        optimizeForLatency: true,
      })
      return result.supported === true
    } catch {
      // Conservative by design: an unanswerable probe means JPEG, which always
      // works, rather than an H.264 stream this device might not render.
      return false
    }
  })()
  return support
}

class ScreenChannel {
  private client: OrbitRemoteClient | null = null
  private snapshot: ScreenChannelSnapshot = EMPTY
  private readonly listeners = new Set<Listener>()
  private frameUrl: string | null = null
  private windowStart = 0
  private windowFrames = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private statsPending = false
  private closed = false
  private settings: RemoteScreenSettings = {}
  private detachForeground: (() => void) | null = null
  /**
   * Host clock minus phone clock, in milliseconds.
   *
   * `capturedAt`/`encodedAt` are the desktop's clock and `Date.now()` is the
   * phone's. Subtracting them directly produced a latency figure of `0 ms`
   * (clamped from a negative number) on a real device, which made the JPEG path
   * look far better than it is. The offset from the handshake is accurate to
   * about half the network round trip, which is the same order as the number
   * being measured and vastly better than assuming the clocks agree.
   */
  private clockOffsetMs = 0
  private hasClockOffset = false
  /** True between a successful start and the next failure. */
  private wasLive = false
  /** Settings currently accepted by the host, to avoid pointless restarts. */
  private applied: RemoteScreenSettings = {}

  // ── H.264 decode path ────────────────────────────────────────────
  private decoder: VideoDecoder | null = null
  private canvas: HTMLCanvasElement | null = null
  /** Which surface owns the canvas, so a teardown cannot clear someone else's. */
  private canvasOwner: object | null = null
  /** Sequence of the last frame actually produced a picture. */
  private decodedSeq = 0
  /** Set when the chain broke; frames are dropped until the next keyframe. */
  private desynced = false
  private description: Uint8Array | null = null
  private configured = false
  /**
   * Set once H.264 has actually failed to decode on this device.
   *
   * The capability probe can only ask a general question; whether *this*
   * stream decodes is only knowable by trying. Once it has failed, JPEG becomes
   * the default for every later start — including the ones triggered by
   * resizing the window — so a failed codec is not retried in a loop. Only an
   * explicit request for H.264 clears it, which is what makes the manual
   * toggle in the enlarged view meaningful.
   */
  private h264Failed = false
  /** A downgrade reason worth keeping across later starts. */
  private codecNoteOverride: string | null = null
  /** Whether the panel is on screen; drawing is skipped when it is not. */
  private rendering = true

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get current(): ScreenChannelSnapshot {
    return this.snapshot
  }

  /**
   * Hand over the canvas H.264 frames are drawn into.
   *
   * The channel owns drawing and closing `VideoFrame`s: they leak GPU memory
   * if they are not closed, and splitting that ownership across a component
   * boundary is exactly how they get forgotten.
   */
  /**
   * Hand over (or release) the canvas H.264 frames are drawn into.
   *
   * Ownership matters because the floating window and the enlarged view can
   * both be mounted at once, each with its own canvas. Releasing without
   * checking the owner would let whichever component unmounts second blank the
   * other one's picture, which looks exactly like the stream dying.
   */
  attachCanvas(canvas: HTMLCanvasElement | null, owner: object): void {
    if (canvas === null) {
      if (this.canvasOwner === owner) {
        this.canvas = null
        this.canvasOwner = null
      }
      return
    }
    this.canvas = canvas
    this.canvasOwner = owner
  }

  /**
   * Whether frames should be drawn.
   *
   * Decoding continues either way: H.264 frames depend on their predecessors,
   * so pausing the decoder would corrupt the stream rather than save work. Only
   * the composite is skipped, which is the part a hidden tab cannot see.
   */
  setRendering(rendering: boolean): void {
    this.rendering = rendering
  }

  private emit(patch: Partial<ScreenChannelSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener(this.snapshot)
  }

  async start(settings: RemoteScreenSettings = {}): Promise<void> {
    this.closed = false
    this.settings = settings
    // A new explicit start is a new decision: allow one more H.264 attempt.
    this.fallbacking = false
    if (settings.codec === "h264") {
      this.h264Failed = false
      this.codecNoteOverride = null
    }
    if (!this.client) this.emit({ state: "connecting", error: null })
    try {
      const client = await this.ensureClient()
      // Only ask for H.264 if it can be decoded here. Doing this before the
      // request means the host never has to guess, and a WebView without
      // WebCodecs never sees a frame it cannot render.
      const decoder = hasWebCodecs()
      // Once H.264 has demonstrably failed here, only an explicit request brings
      // it back; otherwise every resize would re-attempt a known-bad codec.
      const wants = settings.codec ?? (this.h264Failed ? "jpeg" : undefined)
      const supported = wants === "jpeg" ? false : await supportsHardwareH264()
      const codec: RemoteScreenCodec = supported ? "h264" : "jpeg"
      const codecNote = codec === "h264"
        ? null
        : decoder
          ? "此设备无法解码 H.264，已改用 JPEG（带宽明显更高）"
          : "此设备的 WebView 没有 WebCodecs，已改用 JPEG"
      const result = await client.request(
        { type: "screen.start", settings: { ...settings, codec } },
        20_000,
      ) as RemoteScreenStartResult | undefined
      if (this.closed) return
      if (!result?.display) throw new Error("桌面没有返回可捕获的显示器")
      if (result.codec === "h264") this.resetDecoder()
      else this.releaseFrameUrl()
      // The caller's request, not the merged result: comparing against the
      // merged shape would report a difference on every call (the reply adds a
      // concrete `codec`) and restart capture each time.
      this.applied = { ...settings, codec: settings.codec }
      this.wasLive = true
      this.emit({
        state: "live",
        error: null,
        codec: result.codec,
        codecNote: result.codec === "h264" ? null : (this.codecNoteOverride ?? codecNote),
        webCodecs: decoder,
        display: result.display,
        displays: result.displays ?? [],
      })
      this.startStatsPolling()
    } catch (error) {
      if (this.closed) return
      this.wasLive = false
      this.emit({ state: "failed", error: message(error) })
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * Apply settings only when they differ from what the host already accepted.
   *
   * PiP and the expanded view ask for very different pixel budgets, and a
   * `screen.start` with identical settings would still force a keyframe for no
   * reason.
   */
  async configure(settings: RemoteScreenSettings): Promise<void> {
    if (this.closed) return
    const same = (["maxWidth", "maxFps", "quality", "displayId", "codec"] as const)
      .every(key => this.applied[key] === settings[key])
    if (same && this.snapshot.state === "live") return
    await this.start(settings)
  }

  async stop(): Promise<void> {
    this.wasLive = false
    this.applied = {}
    this.stopStatsPolling()
    this.releaseFrameUrl()
    this.releaseDecoder()
    this.emit({ state: "idle", frame: null, latencyMs: null, receivedFps: 0 })
    const client = this.client
    if (!client) return
    try {
      await client.request({ type: "screen.stop" }, 5_000)
    } catch {
      // The subscription dies with the connection anyway.
    }
  }

  close(): void {
    this.closed = true
    this.stopStatsPolling()
    this.releaseFrameUrl()
    this.releaseDecoder()
    this.detachForeground?.()
    this.detachForeground = null
    this.client?.close()
    this.client = null
    this.snapshot = EMPTY
    for (const listener of this.listeners) listener(this.snapshot)
  }

  notifyForeground(reason: "app-resume" | "network-change" | "focus"): void {
    this.client?.notifyForeground(reason)
  }

  private async ensureClient(): Promise<OrbitRemoteClient> {
    if (this.client && this.client.connectionState === "online") return this.client
    // `screenRemoteChannel` reuses the pairing endpoints and the same E2EE
    // key as the control connection; it is a second socket, not a second
    // pairing.
    const client = await screenRemoteChannel({
      onHandshake: serverTime => {
        this.clockOffsetMs = serverTime - Date.now()
        this.hasClockOffset = true
      },
      onEvent: event => {
        if (event.type !== "screen.frame") return
        this.onFrame(event)
      },
      onState: state => {
        if (state === "offline") {
          // Not `failed`: the client reconnects on its own, so the honest state
          // is "reconnecting" and the last frame stays on screen. Reporting a
          // failure here is what made a backgrounded phone look permanently
          // broken when it was about to come back.
          this.stopStatsPolling()
          this.emit({
            state: this.wasLive ? "connecting" : "failed",
            error: this.wasLive ? "已断开，正在重连电脑…" : "与桌面的屏幕连接已断开",
          })
          return
        }
        // Back online on a fresh connection: the subscription died with the
        // old socket, so it has to be re-established.
        if (state === "online" && this.wasLive) void this.resubscribe()
      },
      // Subscription state lives on the connection, so a reconnect produces a
      // connection that is *not* subscribed. Re-issuing `screen.start` here is
      // what makes the preview come back on its own after a network blip.
      onReconnected: () => {
        void this.resubscribe()
      },
      onError: error => {
        this.emit({ error: message(error) })
      },
    })
    this.client = client
    if (!this.detachForeground) {
      this.detachForeground = addRemoteForegroundListener(reason => this.notifyForeground(reason))
    }
    return client
  }

  private async resubscribe(): Promise<void> {
    if (this.closed || !this.client) return
    try {
      await this.start(this.settings)
    } catch {
      // `start` already published the failure state.
    }
  }

  private onFrame(frame: RemoteScreenFrame): void {
    if (this.closed) return
    const receivedAt = Date.now()
    this.windowFrames += 1
    if (!this.windowStart) this.windowStart = receivedAt
    const elapsed = receivedAt - this.windowStart
    let receivedFps = this.snapshot.receivedFps
    if (elapsed >= 1000) {
      receivedFps = (this.windowFrames * 1000) / elapsed
      this.windowStart = receivedAt
      this.windowFrames = 0
    }
    // Compare on the host's clock. The handshake offset is the only thing that
    // makes a cross-device latency figure mean anything.
    const encodedAt = frame.encodedAt > 0 ? frame.encodedAt : receivedAt
    const localNow = this.hasClockOffset ? receivedAt + this.clockOffsetMs : receivedAt
    const common = {
      state: "live" as const,
      frame: {
        seq: frame.seq,
        width: frame.width,
        height: frame.height,
        bytes: frame.bytes,
        capturedAt: frame.capturedAt,
        receivedAt,
        keyframe: frame.keyframe,
      },
      receivedFps,
      latencyMs: Math.max(0, localNow - encodedAt),
    }

    if (frame.codec === "jpeg") {
      let url: string
      try {
        // `atob` + a typed array is the fastest portable base64 path here; the
        // blob is then decoded by the browser's own image pipeline, off the
        // main thread, and `<img>` swaps it without a visible flash.
        url = URL.createObjectURL(new Blob([base64ToBytes(frame.data)], { type: "image/jpeg" }))
      } catch {
        return
      }
      const previous = this.frameUrl
      this.frameUrl = url
      if (previous) URL.revokeObjectURL(previous)
      this.emit({ ...common, codec: "jpeg", frameUrl: url })
      return
    }

    this.emit({ ...common, codec: "h264" })
    this.decodeH264(frame)
  }

  // ── H.264 ────────────────────────────────────────────────────────

  private decodeH264(frame: RemoteScreenFrame): void {
    const decoder = this.decoder
    if (!decoder) {
      this.emit({ error: "H.264 解码器未就绪" })
      return
    }

    if (frame.description) {
      // The host only sends this when it changed, which for a static desktop
      // is once per session.
      this.description = base64ToBytes(frame.description)
      this.configured = false
    }
    if (frame.resync) this.desynced = true
    // A gap against the last chunk *fed to the decoder* means the reference
    // chain is broken. The host detects the same gap and answers with a
    // keyframe; until then, feeding an orphaned P-frame would only paint
    // garbage over a good picture.
    if (this.decodedSeq !== 0 && frame.seq > this.decodedSeq + 1) this.desynced = true

    if (this.desynced && !frame.keyframe) return

    if (this.desynced) {
      // Coming back from a break: `reset` drops whatever was queued for the
      // dead chain, and leaves the decoder needing a fresh configuration.
      try {
        decoder.reset()
      } catch {
        return
      }
      this.configured = false
      this.emit({ decodeRecoveries: this.snapshot.decodeRecoveries + 1 })
    }
    if (!this.configured && !this.configureDecoder(frame.width, frame.height)) return

    let chunk: EncodedVideoChunk
    try {
      chunk = new EncodedVideoChunk({
        type: frame.keyframe ? "key" : "delta",
        // Microseconds and monotonic: WebCodecs requires both.
        timestamp: frame.capturedAt * 1000,
        data: base64ToBytes(frame.data),
      })
    } catch {
      return
    }
    try {
      decoder.decode(chunk)
      this.decodedSeq = frame.seq
      this.desynced = false
    } catch (error) {
      this.emit({ error: message(error) })
    }
  }

  /** Give up on H.264 and ask the host for JPEG instead. Runs at most once. */
  private fallbackToJpeg(reason: string): void {
    if (this.h264Failed || this.fallbacking) return
    this.fallbacking = true
    this.h264Failed = true
    this.codecNoteOverride = `H.264 解码失败，已改用 JPEG：${reason}`
    this.emit({ codecNote: this.codecNoteOverride })
    // `start` publishes the note from the override, so this is not lost.
    void this.start({ ...this.settings, codec: "jpeg" }).catch(() => undefined)
  }

  private fallbacking = false

  private configureDecoder(width: number, height: number): boolean {
    const decoder = this.decoder
    const description = this.description
    if (!decoder || !description) return false
    try {
      decoder.configure({
        // Derived from the configuration record rather than hard-coded: a
        // decoder that disagrees with the actual SPS rejects the stream.
        codec: avcCodecString(description),
        description,
        codedWidth: width,
        codedHeight: height,
        optimizeForLatency: true,
      })
      this.configured = true
      return true
    } catch (error) {
      this.fallbackToJpeg(message(error))
      return false
    }
  }

  private resetDecoder(): void {
    this.releaseDecoder()
    const Decoder = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder
    if (!Decoder) return
    this.decoder = new Decoder({
      output: frame => {
        try {
          const canvas = this.rendering ? this.canvas : null
          if (canvas) {
            // Match the frame's own geometry; CSS decides how big it is shown.
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth
              canvas.height = frame.displayHeight
            }
            const context = canvas.getContext("2d")
            context?.drawImage(frame, 0, 0, canvas.width, canvas.height)
          }
        } finally {
          // Mandatory: an unclosed VideoFrame pins GPU memory until GC, and at
          // ten frames a second the collector does not keep up.
          frame.close()
        }
      },
      error: error => {
        // A decoder that reports an error will keep reporting it; the useful
        // response is to stop asking it to decode.
        this.fallbackToJpeg(message(error))
        this.desynced = true
      },
    })
    this.decodedSeq = 0
    this.desynced = true
    this.configured = false
  }

  private releaseDecoder(): void {
    try {
      this.decoder?.close()
    } catch {
      // Already closed.
    }
    this.decoder = null
    this.configured = false
    this.desynced = true
    this.description = null
  }

  private startStatsPolling(): void {
    if (this.statsTimer) return
    this.statsTimer = setInterval(() => {
      const client = this.client
      if (!client || this.statsPending || this.closed) return
      if (client.connectionState !== "online") return
      this.statsPending = true
      client.request({ type: "screen.stats" }, 8_000)
        .then(result => {
          if (this.closed || !result) return
          const status = result as unknown as RemoteScreenStatus
          this.emit({ status })
          if (status.failure) this.emit({ error: status.failure })
        })
        .catch(() => undefined)
        .finally(() => {
          this.statsPending = false
        })
    }, 2000)
  }

  private stopStatsPolling(): void {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    this.statsPending = false
  }

  private releaseFrameUrl(): void {
    if (this.frameUrl) URL.revokeObjectURL(this.frameUrl)
    this.frameUrl = null
  }
}

/**
 * Build the WebCodecs `codec` string from an `AVCDecoderConfigurationRecord`.
 *
 * Bytes 1..4 of the record are the profile, the compatibility flags, and the
 * level — exactly the three values the `avc1.PPCCLL` form encodes. Reading
 * them beats hard-coding a string: the encoder picks its own level, and a
 * mismatch makes `configure` fail or, worse, decode incorrectly.
 */
function avcCodecString(description: Uint8Array): string {
  if (description.length < 4) return "avc1.42E01E"
  const hex = (value: number) => value.toString(16).padStart(2, "0").toUpperCase()
  return `avc1.${hex(description[1]!)}${hex(description[2]!)}${hex(description[3]!)}`
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  // An explicit `ArrayBuffer` keeps the result a valid `BlobPart` and
  // `BufferSource` rather than the wider `ArrayBufferLike`.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The one screen channel this app owns. */
export function screenChannel(): ScreenChannel {
  if (!channel) channel = new ScreenChannel()
  return channel
}

/** Send an input event on the control connection. Never queued behind video. */
export function sendScreenInput(event: RemoteScreenInput): void {
  sendRemoteScreenInput(event)
}

export type { OrbitRemoteClient }
