/**
 * 语音页面：**一颗球 + 一条对话**。
 *
 * 没开始的时候整页就是那颗球，点它开始；开始之后球缩到顶部继续当控制键，下面那块
 * 位置展示最近一轮对话。用户消息独立保留，AI 回复限制高度并在内部滚动。
 *
 * 声音链路在 ElevenLabs 那边（麦克风、断句、打断、识别、合成），这里只有展示与
 * 三个动作：开始、打断、结束。页面本身保持改动前的样子——它看起来是对的，就不该
 * 因为底层换了实现而跟着换一副长相。
 */
import { useEffect, useState } from "react";
import { Orb, type AgentState } from "@/components/ui/orb";
import { PrimaryButton } from "@/shared/ui/controls";
import { CallEnd, Pause } from "@/shared/ui/icons";
import { useOrbColors } from "../hooks/useOrbColors";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { OrbBoundary } from "./OrbBoundary";
import { VoiceExchange } from "./VoiceExchange";
import { useVoiceCall } from "../hooks/useVoiceCall";
import { voiceCall, type CallState, type VoiceLogItem } from "../model/call";
import { Mic, MicOff } from "lucide-react";

/** 状态 → ElevenLabs Orb 的状态。它只认这四种（null 就是闲置）。 */
const AGENT_STATE: Record<CallState, AgentState> = {
  off: null,
  connecting: "listening",
  listening: "listening",
  thinking: "thinking",
  speaking: "talking",
};

const STATE_LABEL: Record<CallState, string> = {
  off: "点击开始",
  connecting: "正在接通…",
  listening: "在听",
  thinking: "在想",
  speaking: "在说",
};

/**
 * 通话控制：一个圆形图标键。
 *
 * 「结束对话」写成一排字会抢走球和对话的注意力——挂断在语音里是个一眼能认的动作，
 * 用图标就够了，文字放进 title / aria-label。
 */
function CallControl({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid size-9 place-items-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        danger
          ? "border-negative/25 bg-negative/10 text-negative hover:bg-negative/20"
          : "border-stroke bg-content/5 text-content/60 hover:bg-content/10 hover:text-content"
      }`}
    >
      {children}
    </button>
  );
}

export function VoicePage({ visible = true }: { visible?: boolean } = {}) {
  const call = useVoiceCall();
  const orbColors = useOrbColors();
  const { state } = call;
  const active = state !== "off";
  const starting = state === "connecting";
  // 首帧之后才点亮球：Three 的 canvas 是同步挂载的，直接显示会有一帧突兀的跳变。
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const agentState = AGENT_STATE[state];

  /** 一颗球一个动作：没开始 → 开始；在说 → 打断；其余 → 结束。 */
  const activate = () => {
    if (starting) {
      void voiceCall.stop();
      return;
    }
    if (state === "off") {
      void voiceCall.start();
      return;
    }
    if (state === "speaking") voiceCall.interrupt();
    else void voiceCall.stop();
  };

  const orb = (size: number) => (
    <button
      type="button"
      onClick={activate}
      aria-label={starting ? "取消接通" : state === "off" ? "开始语音对话" : state === "speaking" ? "打断" : "结束语音对话"}
      title={starting ? "取消接通" : STATE_LABEL[state]}
      className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <div className={`overflow-hidden rounded-full transition-opacity duration-300 ${revealed ? "opacity-100" : "opacity-0"}`} style={{ width: size, height: size }}>
        <OrbBoundary colors={orbColors}>
          <Orb
            // 默认 100ms 的 resize 防抖会让首帧画在默认 300×150 的缓冲上，看起来是
            // 一次"抖一下"。这个容器尺寸是固定的，不需要防抖。
            resizeDebounce={0}
            paused={!visible}
            colors={orbColors}
            agentState={agentState}
            volumeMode="manual"
            manualInput={call.level}
            manualOutput={call.outputLevel}
            seed={7}
          />
        </OrbBoundary>
      </div>
    </button>
  );

  return (
    <div className="voice-log relative flex min-h-0 flex-1 flex-col justify-center bg-background-base">
      {/*
        通话中球要缩到顶部：它还在，只是不再占满一屏——下面那块地要让给对话。
        缩尺寸而不是换组件，是因为重建 WebGL 上下文就是"进去闪一下"的来源。

        整块（球 + 对话 + 控制行）在页面里垂直居中：它是一体的，顶部对齐会显得
        下半屏空着。
      */}
      <div className={active ? "relative flex shrink-0 flex-col items-center gap-2 pb-1" : "relative flex shrink-0 flex-col items-center gap-8"}>
        <div className="relative grid place-items-center">
          {active ? null : (
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-1/2 rounded-full"
              // Fade to zero inside the circle; a filtered layer can expose its
              // rectangular backing tiles in WKWebView beside the WebGL canvas.
              style={{ background: `radial-gradient(circle closest-side, ${orbColors[0]}1f 0%, ${orbColors[1]}12 42%, ${orbColors[1]}00 100%)` }}
            />
          )}
          {orb(active ? 112 : 244)}
        </div>
        <div className={active ? "relative w-40" : "relative w-64"}>
          <LiveWaveform
            active={visible && active && state !== "thinking"}
            level={state === "speaking" ? call.outputLevel : call.level}
            processing={starting}
            mode="static"
            height={active ? 22 : 40}
            barWidth={active ? 2 : 3}
            barGap={2}
            sensitivity={1.4}
            barColor={orbColors[1]}
          />
        </div>
        {call.error ? (
          <p role="alert" className="max-w-md px-4 text-center text-xs text-negative">
            {call.error}
          </p>
        ) : null}
      </div>

      {active ? (
        /* 开始之后：这块就是消息列表，不再切页面。 */
        <div className="relative flex min-w-0 shrink-0 flex-col">
          <VoiceExchange log={logOf(call.turns)} error={call.error} />
          <div className="flex shrink-0 items-center justify-center gap-3 pb-5 pt-1">
            {state === "speaking" ? (
              <CallControl label="打断" onClick={() => voiceCall.interrupt()}>
                <Pause className="size-4" />
              </CallControl>
            ) : (
              <CallControl label="结束对话" danger onClick={() => void voiceCall.stop()}>
                <CallEnd className="size-4" />
              </CallControl>
            )}
            <CallControl label={call.muted ? "取消静音" : "静音"} onClick={() => voiceCall.setMuted(!call.muted)}>
              {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </CallControl>
          </div>
        </div>
      ) : (
        <div className="relative flex items-center justify-center gap-2 pb-12">
          <PrimaryButton className="rounded-full px-4" onClick={() => void voiceCall.start()}>
            开始对话
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}

/** 通话记录 → 页面要的形状。原样的 `turns` 是平的，这里只换名字。 */
function logOf(turns: { id: string; role: "user" | "agent"; text: string }[]): VoiceLogItem[] {
  return turns.map(turn => ({ id: turn.id, kind: turn.role, text: turn.text }));
}
