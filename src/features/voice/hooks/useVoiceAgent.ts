/**
 * 语音 Agent 的一轮：**听一句 → 交给 Pi → 边生成边念出来**，随时可以被打断。
 *
 * 整条链路是流式的，没有一处等整段：
 *
 * | 段 | 做法 | 省掉的等待 |
 * | --- | --- | --- |
 * | 转写 | 起音就开 WS，边说边推 PCM，静音时只发 `end` | 握手 + 整段上传 |
 * | 模型 | Pi 的流式 delta（`steer` 插话） | — |
 * | 合成 | Rime 的 `/ws`（`segment=immediate`），文字边送、音频边回 | 等整句写完 + 一次完整往返 |
 * | 播放 | 音频片直接排进 Web Audio 时间轴 | 等整段下载完、等 `ended` |
 *
 * 打断是这套设计的前提：队列可以随时清空，正在排的声音可以立刻掐掉，
 * 因为"用户插话"在语音里比"把话说完"重要。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/lib/store";
import { toast } from "@/shared/ui/toast";
import { sendPrompt } from "@/lib/rpc";
import { answerDialog, changeSession } from "@/lib/rpc-session";
import {
  rimeSttAbort,
  rimeSttFinish,
  rimeSttOpen,
  rimeSttPush,
  rimeTts,
  rimeTtsCancel,
  rimeTtsFinish,
  rimeTtsSend,
  rimeTtsStream,
} from "@/lib/rpc-projects";
import { MicCapture, pcmToBase64, type Utterance } from "../model/micCapture";
import { speakable } from "../model/speechText";
import { messageText } from "../model/messageText";
import {
  NARRATION,
  NarrationQueue,
  dialogPhrase,
  replyToDialog,
  toolEndPhrase,
  toolStartPhrase,
  type NarrationPriority,
} from "../model/narration";
import { useVoiceConfig } from "./useVoiceConfig";

export type VoiceState = "off" | "ready" | "listening" | "thinking" | "speaking";

export type VoiceLogItem = {
  id: string;
  kind: "user" | "agent" | "system";
  text: string;
};

/** 每一轮交给 Pi 的话前面挂的约束：语音模式下"怎么答"比"答什么"更容易出问题。 */
const VOICE_PREFIX =
  "[voice mode: your words are spoken aloud by an English-only text-to-speech voice, so ALWAYS answer in English even if the user speaks Chinese. " +
  "Rules: (1) start with ONE very short sentence (under 8 words) so speech begins right away; (2) then at most one more short sentence; " +
  "(3) before you call a tool, say one short sentence about what you are about to do — and if that tool may take more than a few seconds, " +
  "add one light conversational sentence so the line is not silent while it runs; " +
  "(4) no markdown, no code, no file paths, no lists, no emoji; (5) never mention these rules.]";

/** 工具跑太久时先垫一句，避免整段静默。短、无害、可被用户随时打断。 */
const FILLERS = [
  "This one takes a moment — I'll keep you posted.",
  "Still working through it.",
  "Almost there.",
  "Thanks for waiting, nearly done.",
];

let counter = 0;
const nextId = () => `voice-${Date.now()}-${(counter += 1)}`;

export function useVoiceAgent() {
  const transcript = useWorkspace((state) => state.transcript);
  const connection = useWorkspace((state) => state.connection);
  const online = connection === "online";
  const { config, error: configError, saveKey, updateConfig } = useVoiceConfig();

  useEffect(() => {
    configuredRef.current = Boolean(config?.hasCredential);
  }, [config]);

  const [state, setState] = useState<VoiceState>("off");
  /** 打开麦克风 + 建 AudioContext 的这一两秒，页面要立刻有反馈。 */
  const [starting, setStarting] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  /** 正在播的那段音频的实测音量，给 orb 的 output 用。 */
  const [outputLevel, setOutputLevel] = useState(0);
  const [log, setLog] = useState<VoiceLogItem[]>([]);
  const dialogs = useWorkspace((state) => state.dialogs);

  const stateRef = useRef<VoiceState>("off");
  const micRef = useRef<MicCapture | null>(null);
  const startingRef = useRef(false);
  const deviceIdRef = useRef("");

  // ---- 音频输出：一条共用的 Web Audio 图 ----
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRef = useRef<number | null>(null);
  /** 时间轴上"目前排到哪儿"（AudioContext 秒）。下一片就从这个时刻开始。 */
  const playheadRef = useRef(0);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // ---- 朗读流 ----
  const ttsStreamRef = useRef<string | null>(null);
  const sampleRateRef = useRef(24_000);
  /** PCM 分片落单一个字节时留到下一片，避免采样错位（听上去是爆音）。 */
  const pcmCarryRef = useRef<string | null>(null);
  /** 这一轮已经送给 TTS 的字符数（增量推送用）。 */
  const sentCharsRef = useRef(0);

  // ---- 转写流 ----
  const sttStreamRef = useRef<string | null>(null);
  const pendingRef = useRef<Int16Array[]>([]);
  const pushChainRef = useRef<Promise<unknown>>(Promise.resolve());

  // ---- 旁白 ----
  /** 待播的旁白，深度 1。 */
  const narrationRef = useRef(new NarrationQueue());
  const narrationTimerRef = useRef<number | null>(null);
  /** 这张表只为一件事存在：工具从 running 落到 not running 的那一瞬能被看见。 */
  const toolSeenRef = useRef(new Map<string, boolean>());
  /** 已经念过的弹窗 id：同一个确认框只喊你一次。 */
  const announcedDialogsRef = useRef<string[]>([]);
  /** 没配 Rime 密钥时不念旁白（`rime_tts_stream` 会直接报错）。 */
  const configuredRef = useRef(false);

  // ---- 预热 ----
  /**
   * 「开始对话」时那次会话切换的承诺。
   *
   * 麦克风比它先开（点完到能收音之间不能再夹着一次会话切换），所以用户有可能在
   * 切换还没完成时就说完第一句。发 prompt 之前等它一下，比报错或者发进旧会话都强。
   */
  const sessionReadyRef = useRef<Promise<void>>(Promise.resolve());

  // ---- 轮次 ----
  const armedRef = useRef(false);
  /** 发出去那一刻"最后一条 assistant 消息"的 id：新消息到之前不念旧内容。 */
  const skipIdRef = useRef<string | null>(null);
  const agentLogIdRef = useRef<string | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const fillerCountRef = useRef(0);
  const fillerTimerRef = useRef<number | null>(null);
  const scheduleFillerRef = useRef<() => void>(() => {});

  const push = useCallback((kind: VoiceLogItem["kind"], text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setLog((current) => [...current.slice(-40), { id: nextId(), kind, text: trimmed }]);
  }, []);

  /** 失败用 toast 报，不往对话里塞红框——那看起来像页面坏了。 */
  const fail = useCallback((message: string) => {
    setRuntimeError(message);
    toast.error("语音", { description: message, showTimestamp: false });
  }, []);

  const syncState = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setState(next);
    micRef.current?.setAgentSpeaking(next === "speaking");
  }, []);

  const live = useCallback(() => stateRef.current !== "off", []);

  /** 本轮 agent 的文字：同一个 id 原地更新，读起来就是"一段回复在长"。 */
  const setAgentText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = agentLogIdRef.current ?? nextId();
    agentLogIdRef.current = id;
    setLog((current) =>
      current.some((item) => item.id === id)
        ? current.map((item) => (item.id === id ? { ...item, text: trimmed } : item))
        : [...current.slice(-40), { id, kind: "agent", text: trimmed }],
    );
  }, []);

  // ---------------------------------------------------------------- 音频图

  const analyserGraph = useCallback(() => {
    if (!audioCtxRef.current) {
      try {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.65;
        analyser.connect(context.destination);
        audioCtxRef.current = context;
        analyserRef.current = analyser;
      } catch {
        return null;
      }
    }
    const analyser = analyserRef.current;
    const context = audioCtxRef.current;
    return analyser && context ? { context, analyser } : null;
  }, []);

  const stopMeter = useCallback(() => {
    if (meterRef.current !== null) cancelAnimationFrame(meterRef.current);
    meterRef.current = null;
    setOutputLevel(0);
  }, []);

  const startMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const value = (samples[i]! - 128) / 128;
        sum += value * value;
      }
      frame += 1;
      // 每 3 帧才写一次 state：60fps 的 setState 会把这一页拖住。
      if (frame % 3 === 0) {
        const rms = Math.sqrt(sum / samples.length);
        setOutputLevel((previous) => {
          const next = Math.min(1, rms * 3);
          return Math.abs(previous - next) > 0.03 ? next : previous;
        });
      }
      meterRef.current = requestAnimationFrame(tick);
    };
    if (meterRef.current !== null) cancelAnimationFrame(meterRef.current);
    meterRef.current = requestAnimationFrame(tick);
  }, []);

  const remainingMs = useCallback(() => {
    const context = audioCtxRef.current;
    if (!context) return 0;
    return Math.max(0, Math.round((playheadRef.current - context.currentTime) * 1000));
  }, []);

  /** 一片 PCM16 排到时间轴上。来了多少排多少，浏览器保证连续。 */
  const schedulePcm = useCallback(
    (base64: string, sampleRate: number) => {
      const context = audioCtxRef.current;
      const analyser = analyserRef.current;
      if (!context || !analyser || context.state !== "running") return false;
      const binary = atob(base64);
      const byteLength = binary.length & ~1;
      if (byteLength === 0) return false;
      const samples = new Int16Array(byteLength / 2);
      for (let i = 0; i < samples.length; i += 1) {
        const low = binary.charCodeAt(i * 2);
        const high = binary.charCodeAt(i * 2 + 1);
        samples[i] = ((high << 8) | low) << 16 >> 16;
      }
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i]! / 0x8000;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      const startAt = Math.max(context.currentTime + 0.02, playheadRef.current);
      source.start(startAt);
      playheadRef.current = startAt + buffer.duration;
      sourcesRef.current.push(source);
      source.onended = () => {
        sourcesRef.current = sourcesRef.current.filter((item) => item !== source);
      };
      if (analyserRef.current) startMeter();
      return true;
    },
    [startMeter],
  );

  const stopPlayback = useCallback(() => {
    sourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // 已经停了。
      }
    });
    sourcesRef.current = [];
    playheadRef.current = 0;
    stopMeter();
  }, [stopMeter]);

  // ---------------------------------------------------------------- 朗读

  const speakChunk = useCallback(
    (base64: string) => {
      let binary = atob(base64);
      const carry = pcmCarryRef.current;
      if (carry) {
        binary = carry + binary;
        pcmCarryRef.current = null;
      }
      if (binary.length % 2 !== 0) {
        pcmCarryRef.current = binary.slice(-1);
        binary = binary.slice(0, -1);
      }
      if (!binary) return;
      if (stateRef.current !== "speaking") syncState("speaking");
      schedulePcm(btoa(binary), sampleRateRef.current);
    },
    [schedulePcm, syncState],
  );

  const startSpeech = useCallback(async () => {
    if (ttsStreamRef.current) return;
    try {
      const stream = await rimeTtsStream(speakChunk);
      ttsStreamRef.current = stream.id;
      sampleRateRef.current = stream.sampleRate || 24_000;
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause));
    }
  }, [fail, speakChunk]);

  const feedSpeech = useCallback((text: string) => {
    const id = ttsStreamRef.current;
    if (!id || !text) return;
    void rimeTtsSend(id, text).catch(() => undefined);
  }, []);

  const finishSpeech = useCallback(() => {
    const id = ttsStreamRef.current;
    if (!id) return;
    ttsStreamRef.current = null;
    void rimeTtsFinish(id).catch(() => undefined);
  }, []);

  const cancelSpeech = useCallback(() => {
    const id = ttsStreamRef.current;
    ttsStreamRef.current = null;
    pcmCarryRef.current = null;
    if (id) void rimeTtsCancel(id).catch(() => undefined);
  }, []);

  /** 一句话的一次性朗读（垫话用；正常回复走上面的流）。 */
  const speakOnce = useCallback(
    (text: string) => {
      void rimeTts(text, undefined, "pcm")
        .then((sound) => {
          if (!live()) return;
          if (stateRef.current !== "speaking") syncState("speaking");
          schedulePcm(sound.audio, sound.sampleRate ?? 24_000);
        })
        .catch((cause: unknown) => fail(cause instanceof Error ? cause.message : String(cause)));
    },
    [fail, live, schedulePcm, syncState],
  );

  // ---------------------------------------------------------------- 旁白

  /**
   * 旁白和模型的话共用同一条 TTS 流。
   *
   * 这是延迟的关键：流在发 prompt 的那一刻就已经建好了（握手 ~1 秒藏在模型生成首字
   * 的时间里），所以工具开跑时这里只多一次 IPC —— 不再走 `rimeTts` 那种「一句一个
   * 完整 HTTP 往返」的路。
   */
  const speakNarration = useCallback(
    (text: string) => {
      const clean = speakable(text);
      if (!clean) return;
      void startSpeech().then(() => feedSpeech(clean));
      push("system", clean);
    },
    [feedSpeech, push, startSpeech],
  );

  const flushNarrationRef = useRef<() => void>(() => {});
  /**
   * 队列深度是 1（见 `NarrationQueue`）：这里只负责「到点就把那一句送出去」。
   * 时间用 `performance.now()`，和音频时间轴同一个钟。
   */
  const flushNarration = useCallback(() => {
    if (narrationTimerRef.current !== null) {
      window.clearTimeout(narrationTimerRef.current);
      narrationTimerRef.current = null;
    }
    if (!live()) {
      narrationRef.current.clear();
      return;
    }
    const item = narrationRef.current.take(performance.now());
    if (item) speakNarration(item.text);
    const wait = narrationRef.current.waitMs(performance.now());
    if (wait !== null) narrationTimerRef.current = window.setTimeout(() => flushNarrationRef.current(), Math.max(16, wait));
  }, [live, speakNarration]);

  useEffect(() => {
    flushNarrationRef.current = flushNarration;
  }, [flushNarration]);

  /** 一条旁白进来：过时的直接顶掉，然后按间隔播。 */
  const narrate = useCallback(
    (item: { text: string | null; priority: NarrationPriority } | null) => {
      if (!item?.text) return;
      if (!live()) return;
      // 没配密钥时一个字也不该念：否则每条工具事件都在弹同一个错。
      if (!configuredRef.current) return;
      // 模型正在说这一轮的话，就别抢：只有「它卡住了」这一档能插进去。
      if (item.priority > NARRATION.high && sentCharsRef.current > 0 && useWorkspace.getState().transcript.running) return;
      narrationRef.current.push({ text: item.text, priority: item.priority });
      flushNarrationRef.current();
    },
    [live],
  );

  // ---------------------------------------------------------------- 垫话

  const clearFillerTimer = useCallback(() => {
    if (fillerTimerRef.current !== null) window.clearTimeout(fillerTimerRef.current);
    fillerTimerRef.current = null;
  }, []);

  const scheduleFiller = useCallback(() => {
    if (fillerTimerRef.current !== null) return;
    if (fillerCountRef.current >= 2) return;
    const delay = fillerCountRef.current === 0 ? 1500 : 7000;
    fillerTimerRef.current = window.setTimeout(() => {
      fillerTimerRef.current = null;
      if (!armedRef.current) return;
      // 模型已经开口了，就别抢话。
      if (sentCharsRef.current > 0) return;
      if (fillerCountRef.current >= 2) return;
      speakOnce(FILLERS[fillerCountRef.current % FILLERS.length]!);
      fillerCountRef.current += 1;
      scheduleFillerRef.current();
    }, delay);
  }, [speakOnce]);

  useEffect(() => {
    scheduleFillerRef.current = scheduleFiller;
  }, [scheduleFiller]);

  // ---------------------------------------------------------------- 转写

  const openStt = useCallback(() => {
    if (sttStreamRef.current) return;
    pendingRef.current = [];
    pushChainRef.current = rimeSttOpen()
      .then((stream) => {
        sttStreamRef.current = stream.id;
      })
      .catch(() => undefined);
  }, []);

  const flushChunks = useCallback((force = false) => {
    const id = sttStreamRef.current;
    if (!id) return;
    if (!force && pendingRef.current.length < 4) return;
    const queued = pendingRef.current;
    if (queued.length === 0) return;
    pendingRef.current = [];
    const total = queued.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Int16Array(total);
    let offset = 0;
    for (const chunk of queued) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const payload = pcmToBase64(merged);
    pushChainRef.current = pushChainRef.current.then(() => rimeSttPush(id, payload)).catch(() => undefined);
  }, []);

  const abortStt = useCallback(() => {
    const id = sttStreamRef.current;
    sttStreamRef.current = null;
    pendingRef.current = [];
    if (id) void rimeSttAbort(id).catch(() => undefined);
  }, []);

  const runningTurn = () => {
    const current = useWorkspace.getState().transcript;
    return current.running || current.submitted;
  };

  /**
   * 「这一轮从现在开始归我们念」。
   *
   * 提 prompt 和回弹窗两条路都要做同一件事：把上一轮的 assistant 消息 id 记下来
   * （不念旧内容）、清空已送字数、重置垫话计数。写成一份，两边不会走斜。
   */
  const armTurn = useCallback(() => {
    const previous = [...useWorkspace.getState().transcript.messages]
      .reverse()
      .find((item) => item.message.role === "assistant");
    skipIdRef.current = previous?.id ?? null;
    armedRef.current = true;
    sentCharsRef.current = 0;
    agentLogIdRef.current = null;
    clearFillerTimer();
    fillerCountRef.current = 0;
  }, [clearFillerTimer]);

  const handleUtterance = useCallback(
    async (utterance: Utterance) => {
      if (stateRef.current === "off") return;
      syncState("thinking");
      try {
        const streamId = sttStreamRef.current;
        let text = "";
        if (streamId) {
          // 先把 ref 清掉：finish 抛错时这句话已经废了，不能留给下一句。
          sttStreamRef.current = null;
          flushChunks(true);
          try {
            await pushChainRef.current;
            const result = await rimeSttFinish(streamId);
            text = result.text.trim();
          } catch {
            // 预热的那条连接可能在用户开口前就被服务端关掉了；音频还在手里，退回
            // 一次性接口，不要把这句话丢了。
            text = await rimeSttFinishFallback(utterance);
          }
        } else {
          const result = await rimeSttFinishFallback(utterance);
          text = result;
        }
        // 下一句的 WebSocket 现在就建：握手藏在「它在想」和「它在说」的时间里，
        // 而不是等用户开口后再去握手（那就是第一句要等好久的原因）。
        openStt();
        // 只有标点的转写（咳嗽、椅子响）当成没听清：不然会发出一个 "!" 给模型。
        if (!/[\p{L}\p{N}]/u.test(text)) {
          push("system", "没听清，再说一次。");
          syncState("ready");
          return;
        }
        // 会话切换（新会话）还在跑时先等它：麦克风比它先开，第一句可能已经说完了。
        await sessionReadyRef.current.catch(() => undefined);
        push("user", text);

        /**
         * 有弹窗挡着 pi 的主循环：这句话是**对它拍板**，不是新任务。
         *
         * 走确定性映射直接回 `extension_ui_response`（一次 IPC），不经过模型：
         * 弹窗正在阻塞这一轮，再发 prompt 只会排在它后面。匹配不上就追问一句，
         * 不猜——猜错一次的代价是它跑了个你并不想跑的命令。
         */
        const waiting = useWorkspace.getState().dialogs[0];
        if (waiting) {
          const answer = replyToDialog(text, waiting);
          if (!answer) {
            narrate({ text: "Sorry, I did not catch that. Yes or no?", priority: NARRATION.high });
            syncState("ready");
            return;
          }
          armTurn();
          // 回完弹窗，它接着往下跑的那段话要念；对话里的“上一条 assistant”不参与这段判定。
          skipIdRef.current = null;
          await answerDialog(waiting, answer);
          // 这一轮的出字仍然要念，所以朗读流在这里就打开。
          void startSpeech();
          return;
        }

        armTurn();

        /**
         * 上一轮还在跑的时候必须带 `streamingBehavior`，否则 Pi 直接回
         * "Agent is already processing. Specify streamingBehavior..."。
         * 语音里的插话语义就是 **steer**：改变它正在做的事，而不是排在后面。
         */
        const live_turn = runningTurn();
        await sendPrompt(
          { type: "prompt", message: `${VOICE_PREFIX}\n\n${text}`, ...(live_turn ? { streamingBehavior: "steer" as const } : {}) },
          undefined,
          live_turn,
        );
        // 朗读流在**这里**就打开，不等第一个字。实测 WS 握手要 ~1 秒（TLS + 升级），
        // 把它藏在模型生成首字的时间里，首段音频才来得及在 200–400ms 内回来。
        void startSpeech();
        // 15 秒还没有新的 assistant 消息，就把"沉默"说清楚。
        if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
        const baseline = skipIdRef.current;
        watchdogRef.current = window.setTimeout(() => {
          watchdogRef.current = null;
          if (!armedRef.current) return;
          const current = useWorkspace.getState();
          const reply = [...current.transcript.messages].reverse().find((item) => item.message.role === "assistant");
          if (reply && reply.id !== baseline) return;
          fail(`15 秒没有回复：连接 ${current.connection}，会话 ${current.state?.sessionFile?.split("/").pop() ?? "未知"}。`);
        }, 15_000);
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : String(cause));
        syncState("ready");
      }
    },
    [armTurn, fail, flushChunks, narrate, openStt, push, startSpeech, syncState],
  );

  /** 没有任何 STT 流时的兜底：把整段录音丢给一次性接口。 */
  const rimeSttFinishFallback = async (utterance: Utterance): Promise<string> => {
    const { rimeStt } = await import("@/lib/rpc-projects");
    const result = await rimeStt(pcmToBase64(utterance.pcm));
    return result.text.trim();
  };

  const handleSpeechStart = useCallback(() => openStt(), [openStt]);

  const handleChunk = useCallback(
    (chunk: Int16Array) => {
      if (!sttStreamRef.current) return;
      pendingRef.current.push(chunk);
      flushChunks();
    },
    [flushChunks],
  );

  const handleBargeIn = useCallback(() => {
    cancelSpeech();
    abortStt();
    armedRef.current = false;
    agentLogIdRef.current = null;
    stopPlayback();
    syncState("listening");
    // 插话之后下一句马上要转写：现在就把新连接建好。
    openStt();
    push("system", "你插话了，它停下听你说。");
  }, [abortStt, cancelSpeech, openStt, push, stopPlayback, syncState]);

  // ---------------------------------------------------------------- 生命周期

  /**
   * 每次开麦 = 一段新对话。
   *
   * 不新开的话，上一通电话的工具调用、上下文、甚至挂着的弹窗会原封不动跟进来：
   * 第一句「你好」会被当成对刚才那件活插话（steer），而不是开一场新对话。
   *
   * 代价要说清楚：新会话看不到你在聊天页上正在跑的那一轮。真要盯着它干活（oncall），
   * 应该切回那条会话再开麦。
   */
  const beginNewSession = useCallback(async () => {
    const before = useWorkspace.getState().panel;
    await changeSession({ type: "new_session" });
    // `changeSession` 默认把人送回会话页（打字场景的口径）；语音页要留在原地。
    if (useWorkspace.getState().panel !== before) useWorkspace.getState().set({ panel: before });
    setLog([]);
    toolSeenRef.current.clear();
    announcedDialogsRef.current = [];
    narrationRef.current.clear();
    armedRef.current = false;
    agentLogIdRef.current = null;
    skipIdRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    if (!online) {
      startingRef.current = false;
      setStarting(false);
      fail("先打开一个项目：语音 Agent 借用当前会话的 Pi 连接和工具。");
      return;
    }
    setRuntimeError(null);
    if (!micRef.current) {
      micRef.current = new MicCapture({
        onUtterance: (utterance) => void handleUtterance(utterance),
        onSpeechStart: handleSpeechStart,
        onChunk: handleChunk,
        onBargeIn: handleBargeIn,
        onLevel: (value) => setLevel((previous) => (Math.abs(previous - value) > 0.02 ? value : previous)),
        onError: fail,
      });
    }
    try {
      await micRef.current.start(deviceIdRef.current || undefined);
      // AudioContext 必须在用户手势里建并 resume，否则 WebView 会把它挂起，声音是 0 帧。
      const graph = analyserGraph();
      if (graph) await graph.context.resume().catch(() => undefined);
      syncState("ready");
    } catch (cause) {
      startingRef.current = false;
      setStarting(false);
      fail(`无法打开麦克风：${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }

    /*
     * 顺序很关键：麦克风先开，再换新会话。
     *
     * 反过来（先切会话再开麦）的话，点完「开始对话」到能收音之间要白等一次会话
     * 切换；而 STT 那条 WebSocket 要 ~1 秒握手——两件事都压在用户开口之前，就是
     * 「第一句要等好久」的来源。现在它们都在后台跑，用户一开口就能直接推音频。
     */
    openStt();
    sessionReadyRef.current = beginNewSession();
    try {
      await sessionReadyRef.current;
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause));
      micRef.current?.stop();
      micRef.current = null;
      syncState("off");
      startingRef.current = false;
      setStarting(false);
      return;
    }
    // 切换期间那条连接可能已经断了，就绪后再确认一次。
    openStt();
    startingRef.current = false;
    setStarting(false);
  }, [
    analyserGraph,
    beginNewSession,
    fail,
    handleBargeIn,
    handleChunk,
    handleSpeechStart,
    handleUtterance,
    online,
    openStt,
    syncState,
  ]);

  const stop = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    clearFillerTimer();
    if (narrationTimerRef.current !== null) {
      window.clearTimeout(narrationTimerRef.current);
      narrationTimerRef.current = null;
    }
    narrationRef.current.clear();
    cancelSpeech();
    abortStt();
    micRef.current?.stop();
    micRef.current = null;
    stopPlayback();
    armedRef.current = false;
    syncState("off");
    setLevel(0);
  }, [abortStt, cancelSpeech, clearFillerTimer, stopPlayback, syncState]);

  const interrupt = useCallback(() => {
    if (stateRef.current !== "speaking") return;
    cancelSpeech();
    stopPlayback();
    armedRef.current = false;
    syncState("ready");
  }, [cancelSpeech, stopPlayback, syncState]);

  const setDeviceId = useCallback(
    (deviceId: string) => {
      if (deviceIdRef.current === deviceId) return;
      deviceIdRef.current = deviceId;
      const mic = micRef.current;
      if (!mic?.active) return;
      mic.stop();
      void mic.start(deviceId || undefined).catch((cause: unknown) => {
        fail(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [fail],
  );

  // ---------------------------------------------------------------- 效果

  /**
   * 模型吐字 → 直接进 TTS 流。
   *
   * 这里**不再按句切**：`segment=immediate` 让服务端自己决定切分点，我们只负责把
   * 新出现的字符推过去。少一次"等句子完整"的等待，第一段音频通常 100–300ms 就回来。
   */
  useEffect(() => {
    if (!armedRef.current) return;
    const last = [...transcript.messages].reverse().find((item) => item.message.role === "assistant");
    if (!last) return;
    if (last.id === skipIdRef.current) return;
    const text = messageText(last.message);
    if (!text) return;
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    setAgentText(text);
    const spoken = speakable(text);
    if (spoken.length > sentCharsRef.current) {
      const delta = spoken.slice(sentCharsRef.current);
      sentCharsRef.current = spoken.length;
      void startSpeech().then(() => feedSpeech(delta));
    }
  }, [transcript, feedSpeech, setAgentText, startSpeech]);

  // 一轮结束：把 `<EOS>` 发过去（让服务端念完缓冲并关连接）。
  useEffect(() => {
    if (!armedRef.current) return;
    if (transcript.running || transcript.submitted) return;
    finishSpeech();
  }, [transcript, finishSpeech]);

  /**
   * 工具 → 旁白。
   *
   * 只看 `running` 的**跳变**，不看状态本身：连接时就已存在的历史工具不该冒一句
   * 「Reading App.tsx」。表只存 `id → 上一帧是否在跑`，一场长会话里也只占几十字节。
   *
   * 这条 effect 每帧都会被 store 的合批提交触发，所以内部只有一个 Object.entries 循环，
   * 没有任何数组排序或字符串处理——不做，它就会成为首字延迟的一部分。
   */
  useEffect(() => {
    if (stateRef.current === "off") return;
    const seen = toolSeenRef.current;
    for (const id in transcript.tools) {
      const tool = transcript.tools[id]!;
      const wasRunning = seen.get(id);
      if (wasRunning === undefined) {
        seen.set(id, tool.running);
        if (!tool.running) continue;
        narrate({ text: toolStartPhrase(tool.name, tool.args), priority: NARRATION.low });
        continue;
      }
      if (wasRunning && !tool.running) {
        seen.set(id, false);
        narrate(toolEndPhrase(tool.name, tool.args, { durationMs: tool.durationMs, isError: tool.isError }));
      }
    }
    if (seen.size > 200) for (const key of [...seen.keys()].slice(0, seen.size - 200)) seen.delete(key);
  }, [transcript.tools, narrate]);

  /**
   * 弹窗 → 旁白（最高优先级）。
   *
   * oncall 最怕的不是报错，是 `confirm` 弹窗把 pi 卡在那里，而电话里一片安静——
   * 用户会以为它还在跑，实际上它在等一句「行」。
   */
  useEffect(() => {
    const dialog = dialogs[0];
    if (!dialog) return;
    if (announcedDialogsRef.current.includes(dialog.id)) return;
    announcedDialogsRef.current = [...announcedDialogsRef.current.slice(-15), dialog.id];
    narrate({ text: dialogPhrase(dialog), priority: NARRATION.critical });
  }, [dialogs, narrate]);

  // 音轨空了就把话筒交还。
  useEffect(() => {
    if (state !== "speaking") return;
    const timer = window.setInterval(() => {
      if (remainingMs() <= 0) {
        clearInterval(timer);
        if (stateRef.current === "speaking") syncState("ready");
      }
    }, 120);
    return () => window.clearInterval(timer);
  }, [state, remainingMs, syncState]);

  // 工具在跑、模型还没开口：安排一句垫话。
  useEffect(() => {
    if (!armedRef.current) return;
    const running = Object.values(transcript.tools).some((tool) => tool.running);
    const busy = transcript.running || transcript.submitted;
    if (!running || !busy) {
      clearFillerTimer();
      return;
    }
    if (sentCharsRef.current > 0) return;
    scheduleFiller();
  }, [transcript, clearFillerTimer, scheduleFiller]);

  useEffect(() => {
    return () => {
      micRef.current?.stop();
      micRef.current = null;
      if (meterRef.current !== null) cancelAnimationFrame(meterRef.current);
      void audioCtxRef.current?.close().catch(() => undefined);
      sourcesRef.current.forEach((source) => {
        try {
          source.stop();
        } catch {
          // 已经停了。
        }
      });
    };
  }, []);

  const runningTools = useMemo(
    () => Object.values(transcript.tools).filter((tool) => tool.running).map((tool) => tool.name),
    [transcript.tools],
  );

  return {
    state,
    starting,
    level,
    outputLevel,
    log,
    error: runtimeError ?? configError,
    config,
    online,
    runningTools,
    start,
    stop,
    interrupt,
    setDeviceId,
    saveKey,
    updateConfig,
    clearError: () => setRuntimeError(null),
  };
}
