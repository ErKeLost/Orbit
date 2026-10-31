/**
 * 麦克风 → 16 kHz 单声道 PCM16 的一句话。
 *
 * 这一层只做三件事，且刻意不碰 React：**降采样**、**断句**、**打断**。上层（`useVoiceAgent`）
 * 只收到「一句话说完了」和「用户在 agent 说话时开口了」两个事件，它不需要知道 RMS 是多少。
 *
 * 断句用能量门限而不是模型 VAD：语音对话里最贵的延迟是「用户说完了但系统还在等」，
 * 一个 900ms 的静音计时器就足够，且没有推理成本。代价是环境噪声大的时候会误触发，
 * 所以给了 `setThreshold`。
 *
 * 打断的门限比断句高一档（`BARGE_IN_RATIO`）。这不是保守，是必要：麦克风会听到
 * 扬声器里的 agent 自己的声音——`echoCancellation` 在 WKWebView 上只是"尽力而为"，
 * 门限不提上去，agent 会被自己打断。
 */

/** 一次断句产出的音频：16 kHz 单声道，signed PCM16。 */
export type Utterance = { pcm: Int16Array; durationMs: number; lastVoicedAt?: number; endReason?: "silence" | "segment" }

export type MicCaptureHandlers = {
  /** 一句话说完了（或到达单句上限）。 */
  onUtterance: (utterance: Utterance) => void
  /** 检测到起音：可以在这里先把 STT 的 WebSocket 建起来。 */
  onSpeechStart?: () => void
  onDiscard?: () => void
  /** 正在采集的一句话的增量音频（16k 单声道 PCM16）。 */
  onChunk?: (chunk: Int16Array) => void
  /** agent 正在说话时用户开口了：立刻停播放，并从这里开始录新的一句。 */
  onBargeIn: () => void
  /** 实时音量，0–1，UI 用。 */
  onLevel: (level: number) => void
  /** 采集彻底失败（没有麦克风权限等）。 */
  onError: (message: string) => void
}

const TARGET_RATE = 16_000
const FRAME = 320
/**
 * 静音多久算一句话说完。
 *
 * 这个数字直接就是用户感受里的「延迟」：说完最后一个字，还要等它才能动。650ms 时
 * 每句话都明显顿一下；450ms 跟手得多，代价是环境吵、或者句中间停顿长（中文里很正常）
 * 时会把一句话拆成两段。设置只决定用户轮次的静音边界，传输时长限制不代表用户说完。
 */
const END_SILENCE_MS = 450
/** 单条识别流的音频上限；拆流后由 SpeechInput 合并成同一用户轮次。 */
const MAX_UTTERANCE_MS = 20_000
/** 起音前保留的音频，避免第一个字被切掉。 */
const PRE_ROLL_FRAMES = 8
/** 至少要说这么久才算一句话（排除咳嗽、键盘声）。 */
const MIN_VOICED_FRAMES = 4
/** agent 说话时，打断需要连续多少帧超门限。 */
const BARGE_IN_FRAMES = 3
/** agent 说话时门限抬高多少倍。 */
const BARGE_IN_RATIO = 2.4

const DEFAULT_THRESHOLD = 0.02

function rms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!
  return Math.sqrt(sum / frame.length)
}

/** 按比例抽平均降采样到 16 kHz，顺便转成 int16。 */
function downsample(frame: Float32Array, inputRate: number): Int16Array {
  const step = inputRate / TARGET_RATE
  const length = Math.floor(frame.length / step)
  const out = new Int16Array(length)
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * step)
    const end = Math.min(frame.length, Math.floor((i + 1) * step))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += frame[j]!
    const sample = end > start ? sum / (end - start) : 0
    const clamped = Math.max(-1, Math.min(1, sample))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out
}

function concat(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** PCM16 → base64。分块拼接，避免 `String.fromCharCode(...)` 在大数组上炸栈。 */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export class MicCapture {
  private handlers: MicCaptureHandlers
  private threshold = DEFAULT_THRESHOLD
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | AudioWorkletNode | null = null
  private sink: GainNode | null = null

  private agentSpeaking = false
  private collecting = false
  private chunks: Int16Array[] = []
  private preRoll: Int16Array[] = []
  private voiced = 0
  private silent = 0
  private frames = 0
  private bargeInFrames = 0
  private generation = 0
  private opening: Promise<void> | null = null
  private pendingContext: AudioContext | null = null
  private pendingStream: MediaStream | null = null
  private listening = true
  private endpointMs = END_SILENCE_MS
  private lastVoicedAt = 0

  setEndpointMs(value: number): void { this.endpointMs = Math.max(200, Math.min(1200, value)) }
  setListening(value: boolean): void { this.listening = value; this.reset() }

  constructor(handlers: MicCaptureHandlers) {
    this.handlers = handlers
  }

  get active(): boolean {
    return this.context !== null
  }

  setThreshold(value: number): void {
    if (Number.isFinite(value) && value > 0) this.threshold = value
  }

  getThreshold(): number {
    return this.threshold
  }

  /** agent 开口/闭嘴：只影响打断门限，不影响采集本身（打断要靠一直听）。 */
  setAgentSpeaking(value: boolean): void {
    this.agentSpeaking = value
    this.bargeInFrames = 0
  }

  start(deviceId?: string): Promise<void> {
    if (this.context) return Promise.resolve();
    if (this.opening) return this.opening;
    const opening = this.openDevice(++this.generation, deviceId);
    this.opening = opening;
    void opening.finally(() => { if (this.opening === opening) this.opening = null; }).catch(() => undefined);
    return opening;
  }

  private async openDevice(generation: number, deviceId?: string): Promise<void> {
    const context = new AudioContext({ latencyHint: "interactive" });
    this.pendingContext = context;
    let streamPromise: Promise<MediaStream> | undefined;
    let stream: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let processor: AudioWorkletNode | ScriptProcessorNode | undefined;
    let sink: GainNode | undefined;
    try {
      streamPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      // Permission may resolve after cancellation while resume() is still stuck.
      // Release that stream independently of the other pending device operation.
      void streamPromise.then(value => {
        if (generation !== this.generation) value.getTracks().forEach(track => track.stop());
        else this.pendingStream = value;
      }).catch(() => undefined);
      [stream] = await Promise.all([streamPromise, context.resume()]);
      if (generation !== this.generation) throw new DOMException("Aborted", "AbortError");
      source = context.createMediaStreamSource(stream);
      try {
        await context.audioWorklet.addModule(new URL("./capture.worklet.js", import.meta.url).href);
        if (generation !== this.generation) throw new DOMException("Aborted", "AbortError");
        processor = new AudioWorkletNode(context, "orbit-capture");
        processor.port.onmessage = (event: MessageEvent<Float32Array>) => { if (generation === this.generation) this.onFrame(event.data, TARGET_RATE); };
      } catch (error) {
        if (generation !== this.generation) throw error;
        // Older WebViews keep the same VAD frames through ScriptProcessor.
        processor = context.createScriptProcessor(2048, 1, 1);
        let buffered: number[] = [];
        processor.onaudioprocess = (event) => {
          if (generation !== this.generation) return;
          const pcm = downsample(event.inputBuffer.getChannelData(0), context.sampleRate);
          for (const sample of pcm) buffered.push(sample / 0x8000);
          while (buffered.length >= FRAME) { this.onFrame(Float32Array.from(buffered.slice(0, FRAME)), TARGET_RATE); buffered = buffered.slice(FRAME); }
        };
      }
      if (generation !== this.generation) throw new DOMException("Aborted", "AbortError");
      // Keep capture in the audio graph without playing the microphone back.
      sink = context.createGain(); sink.gain.value = 0;
      source.connect(processor); processor.connect(sink); sink.connect(context.destination);
      this.stream = stream; this.context = context; this.source = source; this.processor = processor; this.sink = sink;
      this.reset();
    } catch (error) {
      processor?.disconnect(); source?.disconnect(); sink?.disconnect();
      if (stream) stream.getTracks().forEach(track => track.stop());
      else void streamPromise?.then(value => value.getTracks().forEach(track => track.stop())).catch(() => undefined);
      if (context.state !== "closed") void context.close().catch(() => undefined);
      throw error;
    } finally {
      if (this.pendingContext === context) { this.pendingContext = null; this.pendingStream = null; }
    }
  }

  stop(): void {
    this.generation += 1
    this.opening = null
    if (this.pendingContext && this.pendingContext.state !== "closed") void this.pendingContext.close().catch(() => undefined)
    this.pendingContext = null
    this.pendingStream?.getTracks().forEach(track => track.stop()); this.pendingStream = null
    this.processor?.disconnect()
    this.source?.disconnect()
    this.sink?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close().catch(() => undefined)
    this.processor = null
    this.source = null
    this.sink = null
    this.stream = null
    this.context = null
    this.reset()
  }

  private reset(): void {
    this.collecting = false
    this.chunks = []
    this.preRoll = []
    this.voiced = 0
    this.silent = 0
    this.frames = 0
    this.bargeInFrames = 0
  }

  private frameMs(rate: number): number {
    return (FRAME / rate) * 1000
  }

  private onFrame(frame: Float32Array, rate: number): void {
    const level = rms(frame)
    this.handlers.onLevel(Math.min(1, level * 8))
    if (!this.listening) return
    const pcm = downsample(frame, rate)
    if (level > this.threshold) this.lastVoicedAt = performance.now()

    if (this.agentSpeaking && !this.collecting) {
      this.preRoll.push(pcm)
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
      // agent 在说话：只在门限明显被越过时才算打断，否则就是它自己的回声。
      const gate = this.threshold * BARGE_IN_RATIO
      if (level > gate) {
        this.bargeInFrames += 1
        if (this.bargeInFrames >= BARGE_IN_FRAMES) {
          this.bargeInFrames = 0
          this.handlers.onBargeIn();
          this.beginCollect()
          this.chunks = this.preRoll.slice()
          this.preRoll = []
          this.voiced = BARGE_IN_FRAMES
          this.handlers.onSpeechStart?.()
          for (const chunk of this.chunks) this.handlers.onChunk?.(chunk)
        }
      } else {
        this.bargeInFrames = 0
      }
      return
    }

    const voiced = level > this.threshold

    if (!this.collecting) {
      // 还没开口：维护一段 pre-roll，这样第一个音不会丢。
      this.preRoll.push(pcm)
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
      if (voiced) {
        this.beginCollect()
        this.chunks = this.preRoll.slice()
        this.preRoll = []
        this.voiced = 1
        this.silent = 0
        this.handlers.onSpeechStart?.()
        for (const chunk of this.chunks) this.handlers.onChunk?.(chunk)
      }
      return
    }

    this.chunks.push(pcm)
    this.handlers.onChunk?.(pcm)
    this.frames += 1
    if (voiced) {
      this.voiced += 1
      this.silent = 0
    } else {
      this.silent += 1
    }

    const silenceMs = this.silent * this.frameMs(rate)
    const totalMs = this.frames * this.frameMs(rate)
    if (silenceMs >= this.endpointMs || totalMs >= MAX_UTTERANCE_MS) {
      this.finish(silenceMs >= this.endpointMs ? "silence" : "segment")
    }
  }

  private beginCollect(): void {
    this.collecting = true
    this.chunks = []
    this.voiced = 0
    this.silent = 0
    this.frames = 0
  }

  /** 交出去一句话，并回到待机。 */
  private finish(endReason: "silence" | "segment" = "silence"): void {
    const chunks = this.chunks
    const voiced = this.voiced
    this.reset()
    if (voiced < MIN_VOICED_FRAMES) { this.handlers.onDiscard?.(); return }
    const pcm = concat(chunks)
    if (pcm.length === 0) return
    this.handlers.onUtterance({
      pcm,
      durationMs: Math.round(pcm.length / TARGET_RATE * 1000),
      lastVoicedAt: this.lastVoicedAt,
      endReason,
    })
    // A transport rollover is still the same speech. Start the next stream
    // immediately and retain every following sample, including quiet ones.
    if (endReason === "segment") { this.beginCollect(); this.handlers.onSpeechStart?.() }
  }

  /** 外部（比如按钮）强制结束当前这句。 */
  flush(): void {
    if (this.collecting) this.finish()
  }
}
