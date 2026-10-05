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
import { addRemoteForegroundListener, sendRemoteScreenAck, sendRemoteScreenInput, screenRemoteChannel } from "./remote-runtime"
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

export type ScreenDiag = {
  received: number
  /** Frames handed to the decoder. */
  decoded: number
  /** Frames the decoder produced and that were drawn onto the canvas. */
  painted: number
  /** Frames the decoder produced but there was no canvas to draw them on. */
  noCanvas: number
  /** Dropped while waiting for a keyframe after a break. */
  waitingForKeyframe: number
  /** Could not configure the decoder (no description yet, or it threw). */
  noDecoderConfig: number
  /** The decoder reported an error. */
  decodeErrors: number
  /** Last thing that went wrong, in words. */
  lastProblem: string | null
}

export const EMPTY_DIAG: ScreenDiag = {
  received: 0,
  decoded: 0,
  painted: 0,
  noCanvas: 0,
  waitingForKeyframe: 0,
  noDecoderConfig: 0,
  decodeErrors: 0,
  lastProblem: null,
}

/** One line of the phone's screen log. */
export type ScreenLogEntry = { at: number; message: string }

/**
 * What the phone actually put on screen, read back from the pixels.
 *
 * The counters only say a frame was handed to `drawImage` or to an `<img>`;
 * only reading the result back says whether that frame was a picture.
 */
export type ScreenReadback = {
  /** Mean brightness 0–255 of a grid of on-screen pixels; -1 when unreadable. */
  brightness: number
  maxBrightness: number
  /** Which surface was read: the H.264 canvas or the JPEG image. */
  surface: "canvas" | "image" | "none"
  width: number
  height: number
  /** Why it could not be read, if it could not. */
  error: string | null
  at: number
}

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
  /**
   * Where frames went, so a black preview can be told apart from "nothing was
   * sent". `received` is every `screen.frame` that reached the phone; the rest
   * say what happened to it. Without these a dead preview and a preview that
   * never got a frame look identical (0.0 fps).
   */
  diag: ScreenDiag
  /** The phone's own recent events, newest last. */
  log: ScreenLogEntry[]
  readback: ScreenReadback | null
  /** Round trip to the host, measured from the stats request. */
  rttMs: number | null
  /** What we last told the host: delay above the round trip. */
  reportedQueueDelayMs: number | null
  /** Decoder backlog. Anything sustained above a couple of frames is latency. */
  decodeQueue: number
  /**
   * Set when the frame rate had to be lowered because this device could not
   * decode what it asked for. Reported rather than hidden: an unexplained
   * "why is it only 45 fps" is worse than the reason.
   */
  fpsNote: string | null
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
  diag: EMPTY_DIAG,
  log: [],
  readback: null,
  rttMs: null,
  reportedQueueDelayMs: null,
  decodeQueue: 0,
  fpsNote: null,
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

/**
 * The configurations the capability probe tries, in order of preference.
 *
 * AVCC with a configuration record is what the host actually sends, so that is
 * what has to be supported; the later entries exist so a rejection can be
 * attributed rather than guessed at.
 */
function probeConfigurations(): { label: string; config: VideoDecoderConfig }[] {
  const baseline = new Uint8Array([
    0x01, 0x42, 0xe0, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x1f,
    0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
  ])
  return [
    { label: "avc1.42E01F+avcC", config: { codec: "avc1.42E01F", description: baseline, optimizeForLatency: true } },
    { label: "avc1.4D401F+avcC", config: { codec: "avc1.4D401F", description: baseline, optimizeForLatency: true } },
    { label: "avc1.42E01E+avcC", config: { codec: "avc1.42E01E", description: baseline, optimizeForLatency: true } },
    { label: "avc1.42E01F", config: { codec: "avc1.42E01F", optimizeForLatency: true } },
  ]
}

/** Which configurations came back unsupported, for the note the user sees. */
let probeReport: string[] | null = null

export function probeDiagnostics(): string | null {
  return probeReport?.length ? probeReport.join(", ") : null
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
      const rejected: string[] = []
      for (const candidate of probeConfigurations()) {
        try {
          const result = await decoder.isConfigSupported(candidate.config)
          if (result.supported === true) {
            probeReport = rejected.length ? rejected : null
            return true
          }
          rejected.push(`${candidate.label}=否`)
        } catch (error) {
          rejected.push(`${candidate.label}=抛错(${message(error)})`)
        }
      }
      probeReport = rejected
      return false
    } catch (error) {
      // Conservative by design: an unanswerable probe means JPEG, which always
      // works, rather than an H.264 stream this device might not render.
      probeReport = [`探测本身抛错(${message(error)})`]
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
    // Counters are bumped on the frame path without publishing (a render per
    // counter would double the work of every frame), so the stored snapshot can
    // be one step behind them. Anyone *reading* gets the live values.
    if (this.snapshot.diag !== this.diag || this.diag.painted !== this.paintedCount) {
      if (this.diag.painted !== this.paintedCount) this.diag = { ...this.diag, painted: this.paintedCount }
      this.snapshot = { ...this.snapshot, diag: this.diag }
    }
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

  /**
   * Bump one diagnostic counter.
   *
   * Counters live outside the snapshot and ride along on the `emit` the frame
   * path already does, so counting costs no extra React render per frame. A
   * counter that carries a *reason* is a problem, and problems are published
   * straight away: that is the whole point of having them.
   */
  private diag: ScreenDiag = { ...EMPTY_DIAG }
  /** Hot-path counters: folded into `diag` on the next emit, not per frame. */
  private paintedCount = 0
  /** Every frame since the channel was created; never reset, so a reply can tell whether frames raced ahead of it. */
  private receivedTotal = 0
  private noCanvasCount = 0

  private logEntries: ScreenLogEntry[] = []

  /** Record one line in the phone's screen log and publish it. */
  private note(message: string): void {
    this.logEntries = [...this.logEntries.slice(-79), { at: Date.now(), message }]
    this.emit({ log: this.logEntries })
  }

  private tally(key: Exclude<keyof ScreenDiag, "lastProblem">, problem?: string): void {
    this.diag = { ...this.diag, [key]: this.diag[key] + 1, ...(problem ? { lastProblem: problem } : {}) }
    if (problem) {
      // A problem that repeats every frame would flood the log; record it when it
      // first appears and then every 30th time.
      const count = this.diag[key]
      if (count === 1 || count % 30 === 0) this.note(`${problem}（第 ${count} 次）`)
      else this.emit({ diag: this.diag })
    }
  }

  private emit(patch: Partial<ScreenChannelSnapshot>): void {
    if (this.diag.painted !== this.paintedCount) this.diag = { ...this.diag, painted: this.paintedCount }
    this.snapshot = { ...this.snapshot, ...patch, diag: this.diag }
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
      this.probeDetail = supported ? null : probeDiagnostics()
      const codec: RemoteScreenCodec = supported ? "h264" : "jpeg"
      // Name the actual cause. "无法解码" was printed for two different
      // situations — the capability probe rejecting every configuration, and a
      // real decoder error after the stream started — so neither a user nor I
      // could tell which one was happening. `probeDetail` carries what the probe
      // tried.
      const codecNote = codec === "h264"
        ? null
        : !decoder
          ? "此设备的 WebView 没有 WebCodecs，已改用 JPEG"
          : wants === "jpeg"
            ? "上一次 H.264 解码失败，已改用 JPEG"
            : `本机不支持 H.264（探测 ${this.probeDetail ?? "无结果"}），已改用 JPEG`
      const receivedBefore = this.receivedTotal
      this.note(`发送 screen.start：codec=${codec} maxWidth=${settings.maxWidth ?? "默认"} maxFps=${settings.maxFps ?? "默认"} quality=${settings.quality ?? "默认"} source=${settings.source ?? "默认"}`)
      const result = await client.request(
        { type: "screen.start", settings: { ...settings, codec } },
        20_000,
      ) as RemoteScreenStartResult | undefined
      if (this.closed) return
      if (!result?.display) throw new Error("桌面没有返回可捕获的显示器")
      const action = decoderActionOnStart({
        codec: result.codec,
        hasDecoder: this.decoder !== null,
        framesSinceRequest: this.receivedTotal - receivedBefore,
      })
      this.note(`screen.start 回复：codec=${result.codec} 画面=${result.display?.name ?? "?"} ${result.width}×${result.height}；回复前已收 ${this.receivedTotal - receivedBefore} 帧 → 解码器 ${({ build: "新建", keep: "保留", release: "释放" } as const)[action]}`)
      if (action !== "keep") {
        // Counters describe the decoder they were measured on; a kept decoder
        // keeps its counters too.
        this.diag = { ...EMPTY_DIAG }
        this.paintedCount = 0
        this.noCanvasCount = 0
      }
      if (action === "build") this.resetDecoder()
      else if (action === "release") this.releaseFrameUrl()
      // The caller's request, not the merged result: comparing against the
      // merged shape would report a difference on every call (the reply adds a
      // concrete `codec`) and restart capture each time.
      this.applied = { ...settings, codec: settings.codec }
      if (settings.maxFps !== undefined && settings.maxFps >= (this.previousFps ?? 0)) {
        // An explicit raise clears the "this device is too slow" note.
        this.fpsNote = null
      }
      this.previousFps = settings.maxFps
      this.wasLive = true
      this.emit({
        state: "live",
        error: null,
        codec: result.codec,
        codecNote: result.codec === "h264" ? null : (this.codecNoteOverride ?? codecNote),
        fpsNote: this.fpsNote,
        webCodecs: decoder,
        display: result.display,
        displays: result.displays ?? [],
      })
      this.startStatsPolling()
    } catch (error) {
      if (this.closed) return
      this.wasLive = false
      this.note(`screen.start 失败：${message(error)}`)
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
    if (sameSettings(this.applied, settings) && this.snapshot.state === "live") return
    await this.start(settings)
  }

  async stop(): Promise<void> {
    this.wasLive = false
    this.applied = {}
    this.stopStatsPolling()
    this.releaseFrameUrl()
    this.releaseDecoder()
    this.diag = { ...EMPTY_DIAG }
    this.paintedCount = 0
    this.noCanvasCount = 0
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
          this.note(this.wasLive ? "屏幕连接断开，等待重连" : "屏幕连接断开")
          this.emit({
            state: this.wasLive ? "connecting" : "failed",
            error: this.wasLive ? "已断开，正在重连电脑…" : "与桌面的屏幕连接已断开",
          })
          return
        }
        // Back online on a fresh connection: the subscription died with the
        // old socket, so it has to be re-established.
        if (state === "online" && this.wasLive) {
          this.note("屏幕连接恢复，重新订阅")
          void this.resubscribe()
        }
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
    this.receivedTotal += 1
    if (this.diag.received === 0) {
      this.note(`收到第一帧：#${frame.seq} ${frame.codec} ${frame.width}×${frame.height} ${frame.keyframe ? "关键帧" : "非关键帧"}${frame.description ? " 带解码配置" : " 无解码配置"} ${frame.bytes} 字节`)
    }
    this.tally("received")
    if (!this.windowStart) this.windowStart = receivedAt
    const elapsed = receivedAt - this.windowStart
    let receivedFps = this.snapshot.receivedFps
    if (elapsed >= 1000) {
      receivedFps = (this.windowFrames * 1000) / elapsed
      this.windowStart = receivedAt
      this.windowFrames = 0
    }
    this.startWatchdog()
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
    // The first frame can beat the `screen.start` reply here, and it is the only
    // one that carries the decoder configuration. Dropping it for want of a
    // decoder — which is only built once the reply lands — loses that
    // configuration for good, so build the decoder on demand instead.
    if (!this.decoder) this.resetDecoder()
    const decoder = this.decoder
    if (!decoder) {
      this.tally("noDecoderConfig", "此设备没有 WebCodecs 视频解码器")
      this.emit({ error: "H.264 解码器未就绪" })
      return
    }

    if (frame.description) {
      // The host only sends this when it changed, which for a static desktop
      // is once per session.
      this.description = base64ToBytes(frame.description)
      this.note(`收到解码配置（#${frame.seq}，${this.description.length} 字节，${avcCodecString(this.description)}）`)
      this.configured = false
    }
    if (frame.resync && !this.desynced) this.note(`主机标记重同步（#${frame.seq}）`)
    if (frame.resync) this.desynced = true
    // A gap against the last chunk *fed to the decoder* means the reference
    // chain is broken. The host detects the same gap and answers with a
    // keyframe; until then, feeding an orphaned P-frame would only paint
    // garbage over a good picture.
    if (this.decodedSeq !== 0 && frame.seq > this.decodedSeq + 1) {
      if (!this.desynced) this.note(`帧号跳跃：上次解码 #${this.decodedSeq}，现在 #${frame.seq}，等关键帧`)
      this.desynced = true
    }

    if (this.desynced && !frame.keyframe) {
      // Waiting. The watchdog below asks the host for a keyframe if one does not
      // arrive on its own.
      this.waitingForKeyframeSince ??= Date.now()
      this.tally("waitingForKeyframe", "解码链中断，正在等关键帧")
      return
    }

    if (this.desynced) {
      // Coming back from a break: `reset` drops whatever was queued for the
      // dead chain, and leaves the decoder needing a fresh configuration.
      try {
        decoder.reset()
        this.note(`用关键帧 #${frame.seq} 恢复解码`)
      } catch {
        return
      }
      this.configured = false
      this.emit({ decodeRecoveries: this.snapshot.decodeRecoveries + 1 })
    }
    if (!this.configured && !this.configureDecoder(frame.width, frame.height)) {
      // Not silent any more: without a configuration record the decoder cannot
      // start, and this used to leave the picture blank with no explanation.
      this.tally("noDecoderConfig", this.description ? "解码器配置失败" : "还没收到解码器配置（description）")
      return
    }

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
      this.tally("decoded")
      this.decodedSeq = frame.seq
      this.desynced = false
      this.waitingForKeyframeSince = null
    } catch (error) {
      this.tally("decodeErrors", message(error))
      this.emit({ error: message(error) })
    }
  }

  /** Give up on H.264 and ask the host for JPEG instead. Runs at most once. */
  private fallbackToJpeg(reason: string): void {
    if (this.h264Failed || this.fallbacking) return
    this.fallbacking = true
    this.note(`H.264 解码失败，改用 JPEG：${reason}`)
    this.h264Failed = true
    this.codecNoteOverride = `H.264 解码失败，已改用 JPEG：${reason}`
    this.emit({ codecNote: this.codecNoteOverride })
    // `start` publishes the note from the override, so this is not lost.
    void this.start({ ...this.settings, codec: "jpeg" }).catch(() => undefined)
  }

  private fallbacking = false
  /**
   * How many consecutive stats ticks the decoder has been behind.
   *
   * A decoder that cannot keep up does not drop frames for you — with no
   * B-frames there is nothing it is allowed to drop — so the backlog becomes
   * latency, and latency is the one thing this whole design exists to avoid.
   * When that happens the honest response is to ask for fewer frames.
   */
  private backlogTicks = 0
  private fpsCooldownUntil = 0
  /**
   * When the decoder started waiting for a keyframe, if it is waiting.
   *
   * A decoder that lost its reference chain needs a keyframe before it can draw
   * anything, and the host has no way to know: on a single connection the frames
   * it sends are contiguous, so its own gap detection never fires. Nothing else
   * asks for one either — which meant a desync waited forever and the only
   * recovery was closing the window. This is the request that was missing.
   */
  private waitingForKeyframeSince: number | null = null
  private keyframeRequestedAt = 0

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
          if (!canvas) {
            // The decoder is working but there is nowhere to put the picture.
            // This used to be silent, which is exactly what a black preview with
            // a healthy frame rate looks like.
            this.noCanvasCount += 1
            if (this.noCanvasCount === 1 || this.noCanvasCount % 30 === 0) {
              this.tally("noCanvas", this.rendering ? "解码正常，但没有可绘制的画布" : "解码正常，但预览被暂停渲染")
            }
          }
          if (canvas) {
            // Match the frame's own geometry; CSS decides how big it is shown.
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth
              canvas.height = frame.displayHeight
            }
            const context = canvas.getContext("2d")
            context?.drawImage(frame, 0, 0, canvas.width, canvas.height)
            this.paintedCount += 1
          }
        } finally {
          // Mandatory: an unclosed VideoFrame pins GPU memory until GC, and at
          // ten frames a second the collector does not keep up.
          frame.close()
        }
      },
      error: error => {
        this.tally("decodeErrors", message(error))
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

  /**
   * A watchdog on the picture, on a half-second cadence.
   *
   * Two jobs, both about a picture that has stopped moving:
   *
   * * **Decay the frame-rate reading.** The last measured value otherwise stays
   *   on screen for as long as the stream is quiet, which reads as "it is still
   *   running". A static desktop legitimately produces almost no frames, so
   *   without this the two cases look identical — which is exactly what made
   *   one of these bugs hard to read.
   * * **Rescue a stalled decoder.** A decoder that lost its reference chain
   *   will not recover on its own and nothing else asks the host for a keyframe.
   */
  private startWatchdog(): void {
    this.watchdog ??= setInterval(() => {
      const frame = this.snapshot.frame
      if (frame && this.snapshot.receivedFps > 0 && Date.now() - frame.receivedAt >= 1200) {
        this.emit({ receivedFps: 0 })
      }
      const waitingSince = this.waitingForKeyframeSince
      if (waitingSince === null) return
      if (Date.now() - waitingSince < 800) return
      // One request per few seconds: the host forces a keyframe immediately, so
      // a repeat would only mean the request itself is not getting through.
      if (Date.now() - this.keyframeRequestedAt < 4000) return
      this.keyframeRequestedAt = Date.now()
      this.waitingForKeyframeSince = null
      // `start` with unchanged settings does not restart capture — the host sees
      // the same shape and answers by forcing a keyframe for this subscriber.
      this.note(`等关键帧超过 0.8 秒，向主机请求关键帧`)
      void this.start(this.settings).catch(() => undefined)
    }, 500)
  }

  private watchdog: ReturnType<typeof setInterval> | null = null
  /**
   * Round trip to the host, timed from the stats request that already happens.
   *
   * The value exists to be subtracted: a link that is merely far away shows a
   * large delay and is not congested, and telling those apart is the whole
   * reason the host wants a number from here at all.
   */
  private rttMs: number | null = null
  /** What the H.264 capability probe actually tried, for the note above. */
  private probeDetail: string | null = null

  private startStatsPolling(): void {
    if (this.statsTimer) return
    this.statsTimer = setInterval(() => {
      const client = this.client
      if (!client || this.statsPending || this.closed) return
      if (client.connectionState !== "online") return
      this.statsPending = true
      const started = performance.now()
      client.request({ type: "screen.stats" }, 8_000)
        .then(result => {
          this.rttMs = performance.now() - started
          this.reportQueueDelay()
          if (this.closed || !result) return
          const status = result as unknown as RemoteScreenStatus
          this.emit({ status })
          void this.readBack()
          if (status.failure) this.emit({ error: status.failure })
          this.watchDecodeBacklog()
        })
        .catch(() => undefined)
        .finally(() => {
          this.statsPending = false
        })
    }, 2000)
  }

  /**
   * Tell the host how long the picture is queuing, above the round trip.
   *
   * `latencyMs` is measured on the host's clock, so the transit time is already
   * included in it; subtracting the round trip leaves the part that grows when a
   * link starts buffering. Reported at the stats cadence rather than per frame:
   * it is a trend, and a per-frame report would spend the socket it exists to
   * keep clear.
   */
  private reportQueueDelay(): void {
    const frame = this.snapshot.frame
    const latency = this.snapshot.latencyMs
    if (!frame || latency === null || this.rttMs === null) return
    const queueDelay = Math.max(0, latency - this.rttMs)
    // Below a millisecond of difference there is nothing to report, and sending
    // it would only add noise to the host's signal.
    if (queueDelay < 5) {
      this.emit({ rttMs: this.rttMs, reportedQueueDelayMs: 0 })
      sendRemoteScreenAck(frame.seq, 0)
      return
    }
    this.emit({ rttMs: this.rttMs, reportedQueueDelayMs: queueDelay })
    sendRemoteScreenAck(frame.seq, queueDelay)
  }

  /** Lower the frame rate when this device cannot decode what it asked for. */
  private watchDecodeBacklog(): void {
    const queue = this.decoder?.decodeQueueSize ?? 0
    this.emit({ decodeQueue: queue })
    if (queue <= 3) {
      this.backlogTicks = 0
      return
    }
    this.backlogTicks += 1
    if (this.backlogTicks < 2) return
    this.backlogTicks = 0
    const now = Date.now()
    if (now < this.fpsCooldownUntil) return
    const current = this.settings.maxFps ?? 60
    // 30 is the floor: below that the preview stops being a preview, and a link
    // that cannot carry 30 fps of H.264 has a different problem.
    if (current <= 30) return
    const next = Math.max(30, Math.round(current * 0.75))
    this.fpsCooldownUntil = now + 15_000
    this.fpsNote = `本机解码跟不上 ${current} fps，已降到 ${next} fps`
    this.emit({ fpsNote: this.fpsNote })
    void this.start({ ...this.settings, maxFps: next }).catch(() => undefined)
  }

  private fpsNote: string | null = null
  private previousFps: number | undefined

  /**
   * Read back what is actually on screen.
   *
   * H.264 is drawn into a canvas, so the canvas is read. JPEG is shown as an
   * `<img>`, so the same blob is decoded into a small offscreen canvas and
   * read. Either way this measures the picture the user is looking at, which is
   * the only number that can tell "the computer sent black" from "the phone
   * drew black".
   */
  private async readBack(): Promise<void> {
    const at = Date.now()
    const failed = (surface: ScreenReadback["surface"], error: string): void => {
      this.emit({ readback: { brightness: -1, maxBrightness: -1, surface, width: 0, height: 0, error, at } })
    }
    try {
      if (this.snapshot.codec === "h264") {
        const canvas = this.canvas
        if (!canvas) return failed("none", "没有挂载画布（小窗未显示）")
        if (canvas.width === 0 || canvas.height === 0) return failed("canvas", `画布尺寸为 ${canvas.width}×${canvas.height}`)
        const reading = readPixels(canvas, canvas.width, canvas.height)
        this.emit({ readback: { ...reading, surface: "canvas", width: canvas.width, height: canvas.height, error: null, at } })
        return
      }
      const url = this.frameUrl
      if (!url) return failed("none", "还没有收到 JPEG 画面")
      const image = new Image()
      image.decoding = "async"
      image.src = url
      await image.decode()
      const scratch = document.createElement("canvas")
      scratch.width = Math.min(320, image.naturalWidth || 1)
      scratch.height = Math.max(1, Math.round(scratch.width * (image.naturalHeight || 1) / (image.naturalWidth || 1)))
      const context = scratch.getContext("2d", { willReadFrequently: true })
      if (!context) return failed("image", "无法创建读取画布")
      context.drawImage(image, 0, 0, scratch.width, scratch.height)
      const reading = readPixels(scratch, scratch.width, scratch.height)
      this.emit({ readback: { ...reading, surface: "image", width: image.naturalWidth, height: image.naturalHeight, error: null, at } })
    } catch (error) {
      failed(this.snapshot.codec === "h264" ? "canvas" : "image", message(error))
    }
  }

  private stopStatsPolling(): void {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    this.statsPending = false
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
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

/**
 * Whether two requests describe the same stream.
 *
 * Every key is compared, taken from the objects themselves rather than from a
 * hand-written list: the list used to name five fields and silently omit
 * `source`, so changing the preview from one application to the whole screen
 * produced a request the client then decided was identical to the last one and
 * never sent. A key that is added to the protocol cannot be forgotten here if
 * there is no list to forget it from.
 */
function sameSettings(left: RemoteScreenSettings, right: RemoteScreenSettings): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof RemoteScreenSettings>
  for (const key of keys) {
    if (left[key] !== right[key]) return false
  }
  return true
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

/**
 * What to do with the decoder when a `screen.start` reply arrives.
 *
 * The host activates the subscription *before* it answers, so the first frame —
 * the only one carrying the decoder configuration — can reach the phone ahead of
 * the reply. Tearing the decoder down then throws that configuration away, and
 * the host does not send it again until someone asks for a keyframe. The
 * watchdog's request is another `screen.start`, whose reply tears the decoder
 * down again: a loop in which frames arrive at full rate (so the frame counter
 * looks healthy) and none is ever decodable. That is a black preview at 28 fps.
 *
 * A decoder that already took frames since this request was sent is left alone.
 */
export function decoderActionOnStart(input: {
  codec: RemoteScreenCodec
  hasDecoder: boolean
  framesSinceRequest: number
}): "build" | "keep" | "release" {
  if (input.codec !== "h264") return "release"
  if (!input.hasDecoder) return "build"
  return input.framesSinceRequest > 0 ? "keep" : "build"
}

/** Mean and max brightness of a sparse grid of pixels on a canvas. */
function readPixels(canvas: HTMLCanvasElement, width: number, height: number): { brightness: number; maxBrightness: number } {
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new Error("画布没有 2D 上下文")
  const columns = 24
  const rows = 14
  let sum = 0
  let max = 0
  let samples = 0
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = Math.min(width - 1, Math.floor(((column + 0.5) / columns) * width))
      const y = Math.min(height - 1, Math.floor(((row + 0.5) / rows) * height))
      const data = context.getImageData(x, y, 1, 1).data
      const value = ((data[0] ?? 0) + (data[1] ?? 0) + (data[2] ?? 0)) / 3
      sum += value
      max = Math.max(max, value)
      samples += 1
    }
  }
  return { brightness: samples ? sum / samples : -1, maxBrightness: max }
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
