/**
 * 语音页面：**一颗球 + 一条对话**。
 *
 * 没开始的时候整页就是那颗球，点它开始；开始之后球缩到顶部继续当控制键，下面那块
 * 位置直接变成消息列表——不再切到另一个页面去。列表用 ElevenLabs UI 的
 * `conversation` / `message` / `response`（见 `components/ui/` 里那三个文件的注释），
 * 只有这一页用。
 *
 * 状态球用 orb-ui 的受控模式（`state` + `signal`），视觉和交互刻意分开：
 * cloud 主题在 `idle` 下会缩成一个纯色点（"挂断"语义），所以页面未开始时也按
 * `listening` 画（那时音量恒为 0，云是静止的），而点击行为由外层按钮自己决定。
 */
import { useEffect, useState } from "react";
import { Orb, type AgentState } from "@/components/ui/orb";
import { PrimaryButton } from "@/shared/ui/controls";
import { CallEnd, Pause } from "@/shared/ui/icons";
import { useVoiceAgent, type VoiceState, type VoiceLogItem } from "../hooks/useVoiceAgent";
import { useOrbColors } from "../hooks/useOrbColors";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { MicSelector } from "@/components/ui/mic-selector";
import { OrbBoundary } from "./OrbBoundary";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ui/conversation";
import { Message, MessageContent } from "@/components/ui/message";
import { Response } from "@/components/ui/response";

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

/**
 * 通话控制：一个圆形图标键。
 *
 * 「结束对话」写成一排字会抢走球和对话的注意力——挂断在语音里是个一眼能认的动作，
 * 用图标就够了，文字放进 title / aria-label。
 */
function CallControl({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid size-9 place-items-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        danger
          ? "border-red-400/25 bg-red-400/10 text-red-400 hover:bg-red-400/20"
          : "border-stroke bg-content/5 text-content/60 hover:bg-content/10 hover:text-content"
      }`}
    >
      {children}
    </button>
  );
}

/** 一条消息。
 *
 * 它说的话**不带头像**：这一页只有它一个说话人，左边那颗小球在每条消息旁边重复四遍
 * 只会把视线从字上拉走。头像只有一种情况有意义——对话里有别人（现在没有）。
 */
function LogItem({ item }: { item: VoiceLogItem }) {
  if (item.kind === "system") {
    return (
      <div className="flex w-full justify-center py-1">
        <p className="max-w-[min(100%,34rem)] text-center text-[11px] leading-relaxed text-content/35">{item.text}</p>
      </div>
    );
  }
  return (
    <Message from={item.kind === "user" ? "user" : "assistant"}>
      <MessageContent>
        <Response>{item.text}</Response>
      </MessageContent>
    </Message>
  );
}

/**
 * 只留**最后一段**对话：我说的最后一句 + 它之后的所有回复。
 *
 * 语音页不是聊天记录页：屏幕上永远是“这一轮在说什么”，上面那些轮次已经说完、也听过
 * 了。留着它们的唯一效果，是把当前这一轮顶出视口、在顶上切掉半行字。
 */
function lastExchange(log: VoiceLogItem[]): VoiceLogItem[] {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    if (log[index]!.kind === "user") return log.slice(index);
  }
  return log;
}

export function VoicePage() {
  const voice = useVoiceAgent();
  const orbColors = useOrbColors();
  const { state } = voice;
  const active = state !== "off";
  // 首帧之后才点亮球：Three 的 canvas 是同步挂载的，直接显示会有一帧突兀的跳变。
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const agentState = AGENT_STATE[state];

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
    <div className="voice-log relative flex min-h-0 flex-1 flex-col justify-center bg-background-base">
      {/*
        通话中球要缩到顶部：它还在，只是不再占满一屏——下面那块地要让给对话。
        缩尺寸而不是换组件，是因为重建 WebGL 上下文就是"进去闪一下"的来源。

        整块（球 + 对话 + 控制行）在页面里垂直居中：它是一体的，顶部对齐会显得
        下半屏空着。
      */}
      <div
        className={
          active
            ? "relative flex shrink-0 flex-col items-center gap-2 pb-1"
            : "relative flex shrink-0 flex-col items-center gap-8"
        }
      >
        {active ? null : (
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-[42%] size-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-3xl"
            style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--color-accent) 38%, transparent), transparent 68%)" }}
          />
        )}
        <div className="relative">{orb(active ? 112 : 244)}</div>
        <div className={active ? "relative w-40" : "relative w-64"}>
          <LiveWaveform
            active={active && state !== "thinking"}
            mode="static"
            height={active ? 22 : 40}
            barWidth={active ? 2 : 3}
            barGap={2}
            sensitivity={1.4}
            barColor="var(--color-accent)"
          />
        </div>
        {active ? <p className="text-[11px] text-content/35">{STATE_LABEL[state]}</p> : null}
      </div>

      {active ? (
        /* 开始之后：这块就是消息列表，不再切页面。 */
        <div className="relative flex flex-col">
          {/*
            高度只由内容决定，最多 188px（四行）。

            列表里只渲染最后一段对话，所以正常情况下根本不会滚；回复长到超过 188px 时
            在框内滚动，滚动条由 `.voice-log` 在 `styles/orbit.css` 里藏掉。
          */}
          <Conversation className="voice-log max-h-[188px] min-h-0 w-full flex-none">
            <ConversationContent className="mx-auto flex w-full max-w-3xl flex-col px-4 pb-2">
              {voice.log.length === 0 ? (
                <ConversationEmptyState
                  title="在听你说"
                  description="说一句，它就接过去；它干活的时候会告诉你进度，卡住了会喊你。"
                />
              ) : (
                lastExchange(voice.log).map((item) => <LogItem key={item.id} item={item} />)
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
          <div className="flex shrink-0 items-center justify-center gap-3 pb-5 pt-1">
            {state === "speaking" ? (
              <CallControl label="打断" onClick={voice.interrupt}>
                <Pause className="size-4" />
              </CallControl>
            ) : (
              <CallControl label="结束对话" danger onClick={voice.stop}>
                <CallEnd className="size-4" />
              </CallControl>
            )}
            <MicSelector disabled={voice.starting} onValueChange={voice.setDeviceId} />
          </div>
        </div>
      ) : (
        <div className="relative flex items-center justify-center gap-2 pb-12">
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
          ) : (
            <PrimaryButton className="rounded-full px-4" onClick={() => void voice.start()}>
              开始对话
            </PrimaryButton>
          )}
          <MicSelector disabled={voice.starting} onValueChange={voice.setDeviceId} />
        </div>
      )}
    </div>
  );
}
