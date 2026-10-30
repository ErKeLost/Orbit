/**
 * 语音页面：**一颗球**。
 *
 * 没有标题栏、没有底栏、没有说明文字——页面本身就是那颗云球。点它开始，再点就是打断；
 * 有对话之后它缩到右下角继续当控制键，消息往上滚。
 *
 * 状态球用 orb-ui 的受控模式（`state` + `signal`），视觉和交互刻意分开：
 * cloud 主题在 `idle` 下会缩成一个纯色点（"挂断"语义），所以页面未开始时也按
 * `listening` 画（那时音量恒为 0，云是静止的），而点击行为由外层按钮自己决定。
 */
import { useEffect, useRef, useState } from "react";
import { Orb, type AgentState } from "@/components/ui/orb";
import { PrimaryButton, SecondaryButton } from "@/shared/ui/controls";
import { useVoiceAgent, type VoiceState, type VoiceLogItem } from "../hooks/useVoiceAgent";
import { useOrbColors } from "../hooks/useOrbColors";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { MicSelector } from "@/components/ui/mic-selector";
import { OrbBoundary } from "./OrbBoundary";

/** hook 的状态 → ElevenLabs Orb 的状态。它只认这四种（null 就是闲置）。 */
const AGENT_STATE: Record<VoiceState, AgentState> = {
  off: null,
  ready: "listening",
  listening: "listening",
  thinking: "thinking",
  speaking: "talking",
};

const STATE_LABEL: Record<VoiceState, string> = {
  off: "点击开始",
  ready: "在听",
  listening: "在听",
  thinking: "在想",
  speaking: "在说",
};

function Bubble({ item }: { item: VoiceLogItem }) {
  if (item.kind === "system") {
    return <p className="self-center text-center text-[11px] leading-relaxed text-content/35">{item.text}</p>;
  }
  if (item.kind === "user") {
    return (
      <div className="max-w-[min(100%,34rem)] self-end">
        <div className="w-fit rounded-xl bg-content/10 px-3 py-1.5 text-[13px] leading-5 text-content">{item.text}</div>
      </div>
    );
  }
  return <p className="max-w-[min(100%,40rem)] self-start text-[13px] leading-6 text-content/90">{item.text}</p>;
}

export function VoicePage() {
  const voice = useVoiceAgent();
  const orbColors = useOrbColors();
  const { state } = voice;
  const active = state !== "off";
  const scroller = useRef<HTMLDivElement>(null);
  // 首帧之后才点亮球：Three 的 canvas 是同步挂载的，直接显示会有一帧突兀的跳变。
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const empty = voice.log.length === 0;
  const agentState = AGENT_STATE[state];

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [voice.log]);

  /** 一颗球一个动作：没开始 → 开始；在说 → 打断；其余 → 结束。 */
  const activate = () => {
    if (state === "off") {
      void voice.start();
      return;
    }
    if (state === "speaking") voice.interrupt();
    else voice.stop();
  };

  const orb = (size: number) => (
    <button
      type="button"
      onClick={activate}
      aria-label={state === "off" ? "开始语音对话" : state === "speaking" ? "打断" : "结束语音对话"}
      title={STATE_LABEL[state]}
      className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <div
        className={`overflow-hidden rounded-full transition-opacity duration-300 ${revealed ? "opacity-100" : "opacity-0"}`}
        style={{ width: size, height: size }}
      >
        <OrbBoundary>
          <Orb
            // 默认 100ms 的 resize 防抖会让首帧画在默认 300×150 的缓冲上，看起来是
            // 一次"抖一下"。这个容器尺寸是固定的，不需要防抖。
            resizeDebounce={0}
            colors={orbColors}
            agentState={agentState}
            volumeMode="manual"
            manualInput={voice.level}
            manualOutput={voice.outputLevel}
            seed={7}
          />
        </OrbBoundary>
      </div>
    </button>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background-base">
      {empty ? (
        <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-8">
          {/* 环境光：把 accent 铺在球后面，光球才不像贴纸上的一颗球 */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 size-[420px] -translate-x-1/2 -translate-y-[62%] rounded-full opacity-40 blur-3xl"
            style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--color-accent) 38%, transparent), transparent 68%)" }}
          />
          <div className="relative">{orb(244)}</div>
          <div className="relative w-64">
            <LiveWaveform
              active={active && state !== "thinking"}
              mode="static"
              height={40}
              barWidth={3}
              barGap={2}
              sensitivity={1.4}
              barColor="var(--color-accent)"
            />
          </div>
          <div className="relative flex items-center gap-2">
          {voice.starting ? (
            <PrimaryButton className="rounded-full px-4" disabled>
              正在启动…
            </PrimaryButton>
          ) : !voice.online ? (
            <div className="flex flex-col items-center gap-2">
              <PrimaryButton className="rounded-full px-4" disabled>
                开始对话
              </PrimaryButton>
              <p className="text-[12px] text-content/40">先在左上角选一个项目</p>
            </div>
          ) : state === "off" ? (
            <PrimaryButton className="rounded-full px-4" onClick={() => void voice.start()}>
              开始对话
            </PrimaryButton>
          ) : state === "speaking" ? (
            <SecondaryButton className="relative rounded-full px-4" onClick={voice.interrupt}>
              打断
            </SecondaryButton>
          ) : (
            <SecondaryButton className="rounded-full px-4" danger onClick={voice.stop}>
              结束对话
            </SecondaryButton>
          )}
            <MicSelector disabled={voice.starting} onValueChange={voice.setDeviceId} />
          </div>
        </div>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-none">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 pb-28 pt-8">
            {voice.log.map((item) => <Bubble key={item.id} item={item} />)}
          </div>
        </div>
      )}

      {/* 有对话之后球浮在右下角，仍然是唯一的控制键。 */}
      {empty ? null : (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-2 px-6 pb-6">
          {state === "speaking" ? (
            <SecondaryButton className="pointer-events-auto" onClick={voice.interrupt}>
              打断
            </SecondaryButton>
          ) : null}
          <SecondaryButton className="pointer-events-auto" danger onClick={voice.stop}>
            结束
          </SecondaryButton>
          <div className="pointer-events-auto drop-shadow-[0_10px_28px_rgba(0,0,0,0.55)]">{orb(56)}</div>
        </div>
      )}
    </div>
  );
}
