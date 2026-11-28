/**
 * 语音页面：**一颗球 + 一条对话**。
 *
 * 没开始的时候整页就是那颗球，点它开始；开始之后球缩到顶部继续当控制键，下面那块
 * 位置展示最近一轮对话。用户消息独立保留，AI 回复限制高度并在内部滚动。
 *
 * 声音在 Rime Prism：断句、打断、闲聊、出声。Jev 只判要不要把这句交给 Pi。
 * 页面还是一颗球。
 */
import { memo, useEffect } from "react";
import { Orb, type AgentState } from "@/components/ui/orb";
import { PrimaryButton } from "@/shared/ui/controls";
import { CallEnd, Pause } from "@/shared/ui/icons";
import { useOrbColors } from "../hooks/useOrbColors";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { OrbBoundary } from "./OrbBoundary";
import { VoiceExchange } from "./VoiceExchange";
import { useVoiceCall } from "../hooks/useVoiceCall";
import { voiceCall, type CallState } from "../model/call";
import { Mic, MicOff } from "lucide-react";

/** 状态 → Orb 的四种。null 就是闲置。 */
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

export const VoicePage = memo(function VoicePage({ visible = true }: { visible?: boolean } = {}) {
  const state = useVoiceCall("state");
  const muted = useVoiceCall("muted");
  const error = useVoiceCall("error");
  const orbColors = useOrbColors();
  const active = state !== "off";
  const starting = state === "connecting";
  useEffect(() => {
    if (!visible) void voiceCall.stop();
  }, [visible]);

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
    if (state === "speaking") voiceCall.pause();
    else void voiceCall.stop();
  };

  const orbSize = active ? 112 : 244;
  const orb = (
    <button
      type="button"
      onClick={activate}
      aria-label={starting ? "取消接通" : state === "off" ? "开始语音对话" : state === "speaking" ? "暂停" : "结束语音对话"}
      title={starting ? "取消接通" : STATE_LABEL[state]}
      className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <div className="relative overflow-hidden rounded-full" style={{ width: orbSize, height: orbSize }}>
        <div className="pointer-events-none absolute left-1/2 top-1/2 size-[244px] overflow-hidden rounded-full" style={{ transform: `translate(-50%, -50%) scale(${orbSize / 244})` }}>
          <VoiceOrb visible={visible} state={state} colors={orbColors} />
        </div>
      </div>
    </button>
  );

  return (
    /* 这一层不画底色：底色是窗口那一层画的（`workspace-background`），窗口底下
       铺了图片时它会让开，图片就该从这里一直透到球后面。这里再涂一层不透明的
       canvas 色，只会把照片挡成一块黑。 */
    <div className="voice-log relative flex min-h-0 flex-1 flex-col justify-center">
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
          {orb}
        </div>
        <div className={active ? "relative w-40" : "relative w-64"}>
          <VoiceMeter visible={visible} state={state} color={orbColors[1]} />
        </div>
        {active && <p role="status" className="h-4 text-center text-xs text-ink-3">{muted ? "麦克风已静音" : STATE_LABEL[state]}</p>}
        {error ? (
          <p role="alert" className="max-w-md px-4 text-center text-xs text-negative">
            {error}
          </p>
        ) : null}
      </div>

      {active ? (
        /* 开始之后：这块就是消息列表，不再切页面。 */
        <div className="relative flex min-w-0 shrink-0 flex-col">
          <VoiceTranscript error={error} />
          <div className="flex shrink-0 items-center justify-center gap-3 pb-5 pt-1">
            <CallControl label="暂停" onClick={() => voiceCall.pause()}>
              <Pause className="size-4" />
            </CallControl>
            <CallControl label="结束对话" danger onClick={() => void voiceCall.stop()}>
              <CallEnd className="size-4" />
            </CallControl>
            <CallControl label={muted ? "取消静音" : "静音"} onClick={() => voiceCall.setMuted(!muted)}>
              {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
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
});

const VoiceOrb = memo(function VoiceOrb({ visible, state, colors }: { visible: boolean; state: CallState; colors: [string, string] }) {
  const input = useVoiceCall("level");
  const output = useVoiceCall("outputLevel");
  return <OrbBoundary colors={colors}>
    <Orb resizeDebounce={0} paused={!visible} colors={colors} agentState={AGENT_STATE[state]}
      volumeMode="manual" manualInput={input} manualOutput={output} seed={7} />
  </OrbBoundary>;
});

const VoiceMeter = memo(function VoiceMeter({ visible, state, color }: { visible: boolean; state: CallState; color: string }) {
  const level = useVoiceCall(state === "speaking" ? "outputLevel" : "level");
  const active = state !== "off";
  return <LiveWaveform active={visible && active && state !== "thinking"} level={level} processing={visible && state === "connecting"}
    mode="static" height={active ? 22 : 40} barWidth={active ? 2 : 3} barGap={2} sensitivity={1.4} barColor={color} />;
});

const VoiceTranscript = memo(function VoiceTranscript({ error }: { error: string | null }) {
  const turns = useVoiceCall("turns");
  return <VoiceExchange log={turns.map(turn => ({ id: turn.id, kind: turn.role, text: turn.text }))} error={error} />;
});
