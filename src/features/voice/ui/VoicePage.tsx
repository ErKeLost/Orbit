/**
 * 语音页：一颗球 + 一条对话。
 *
 * 声音链路完全在 ElevenLabs 那边——麦克风、断句、打断、识别、合成。这个文件只剩
 * 展示和三个动作：开始、打断、结束。以前那套自己管音频的代码（PCM 排程、重采样、
 * 合并分片）已经整块删掉了，因为那些正是"不该我们管"的部分。
 */
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { Orb, type AgentState } from "@/components/ui/orb";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { CallEnd, Pause } from "@/shared/ui/icons";
import { useVoiceCall } from "../hooks/useVoiceCall";
import { useOrbColors } from "../hooks/useOrbColors";
import { voiceCall, type CallState } from "../model/call";
import { OrbBoundary } from "./OrbBoundary";

const AGENT_STATE: Record<CallState, AgentState> = {
  off: null,
  connecting: "thinking",
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

function CallControl({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid size-9 place-items-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        danger ? "border-negative/25 bg-negative/10 text-negative hover:bg-negative/20" : "border-stroke bg-fill text-ink-2 hover:bg-fill-strong hover:text-ink-1"
      }`}
    >
      {children}
    </button>
  );
}

export function VoicePage({ visible = true }: { visible?: boolean } = {}) {
  const call = useVoiceCall();
  const orbColors = useOrbColors();
  const [revealed, setRevealed] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const active = call.state !== "off";
  const busy = call.state === "connecting";

  useEffect(() => {
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [call.turns]);

  const activate = () => {
    if (busy) return void voiceCall.stop();
    if (call.state === "off") return void voiceCall.start();
    if (call.state === "speaking") return voiceCall.interrupt();
    void voiceCall.stop();
  };

  const orb = (size: number) => (
    <button
      type="button"
      onClick={activate}
      aria-label={busy ? "取消接通" : call.state === "off" ? "开始语音对话" : "结束语音对话"}
      title={STATE_LABEL[call.state]}
      className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <div className={`overflow-hidden rounded-full transition-opacity duration-300 ${revealed ? "opacity-100" : "opacity-0"}`} style={{ width: size, height: size }}>
        <OrbBoundary colors={orbColors}>
          <Orb
            resizeDebounce={0}
            paused={!visible}
            colors={orbColors}
            agentState={AGENT_STATE[call.state]}
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
      <div className={active ? "relative flex shrink-0 flex-col items-center gap-2 pb-1" : "relative flex shrink-0 flex-col items-center gap-8"}>
        <div className="relative grid place-items-center">
          {active ? null : (
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-1/2 rounded-full"
              style={{ background: `radial-gradient(circle closest-side, ${orbColors[0]}1f 0%, ${orbColors[1]}12 42%, ${orbColors[1]}00 100%)` }}
            />
          )}
          {orb(active ? 112 : 244)}
        </div>
        <div className={active ? "relative w-40" : "relative w-64"}>
          <LiveWaveform
            active={visible && active}
            level={call.state === "speaking" ? 0.45 : call.level}
            processing={busy}
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
        <div className="relative flex min-w-0 shrink-0 flex-col">
          <div ref={scroller} className="mx-auto flex max-h-[38vh] w-full max-w-xl flex-col gap-2 overflow-y-auto px-4 py-2">
            {call.turns.map(turn => (
              <div key={turn.id} className={turn.role === "user" ? "self-end max-w-[85%]" : "self-start max-w-[85%]"}>
                <div
                  className={
                    turn.role === "user"
                      ? "rounded-2xl rounded-br-md bg-fill-strong px-3 py-2 text-sm text-ink-1"
                      : "rounded-2xl rounded-bl-md border border-stroke bg-fill px-3 py-2 text-sm text-ink-2"
                  }
                >
                  {turn.text}
                </div>
              </div>
            ))}
          </div>
          <div className="flex shrink-0 items-center justify-center gap-3 pb-5 pt-1">
            {call.state === "speaking" ? (
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
      ) : null}
    </div>
  );
}
