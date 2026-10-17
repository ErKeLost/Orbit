import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "../../shared/ui/Popover";
import { loadMessages, report, request } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { useMetrics } from "../../hooks/use-metrics";
import {
  CONTEXT_SOURCE_KEYS,
  contextBarSegments,
  estimateContextSources,
  fitToUsed,
  type ContextSourceKey,
} from "./contextBreakdown";

const SIZE = 14;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function ringClass(ratio: number) {
  if (ratio >= 0.9) return "text-red-400";
  if (ratio >= 0.75) return "text-amber-400";
  return "text-content/45";
}

function MeterRing({ ratio, spinning }: { ratio: number; spinning?: boolean }) {
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className={`${ringClass(ratio)} ${spinning ? "animate-spin" : ""}`} aria-hidden>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE} className="opacity-25" />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
    </svg>
  );
}

/** 四类来源。文案与色块只在这里出现，数字来自 `contextBreakdown`。 */
const SOURCES: Record<ContextSourceKey, { label: string; note: string; swatch: string }> = {
  system: {
    label: "System",
    note: "System prompt, tool definitions and harness control text. The tool schema is re-sent on every request.",
    swatch: "context-swatch-system",
  },
  conversation: {
    label: "Conversation",
    note: "Your messages, the model's replies and its reasoning.",
    swatch: "context-swatch-conversation",
  },
  tools: {
    label: "Tool results",
    note: "Tool arguments and output. One long output stays in the window until the next compaction.",
    swatch: "context-swatch-tools",
  },
  app: {
    label: "Attachments",
    note: "Screenshots, image attachments and images returned by tools. Roughly 1.1K tokens each.",
    swatch: "context-swatch-attachment",
  },
};

const percentLabel = (ratio: number) => `${Math.round(ratio * 1000) / 10}%`;

/**
 * Orbit's context ring; its action is Pi's `compact`.
 *
 * 弹出的卡片把窗口拆成四类来源。总量是 provider 回报的真数，
 * 分类是本地折算后按比例缩放的预估值（推导见 `contextBreakdown.ts`）：卡片上不写
 * 免责声明（用户要求去掉那两行），所以文案不能把分类说成实测值。
 */
export function ContextMeter({ usage, compacting }: { usage?: { used: number; window: number }; compacting: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [expanded, setExpanded] = useState<ContextSourceKey | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // 卡片比原来那颗环大得多：光标从环移到卡片上要跨过几像素空隙，所以“离开”
  // 得留一点余量，否则卡片会在用户伸手去点的那一瞬间消失。
  const closeTimer = useRef<number | null>(null);
  const keepOpen = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setHovered(true);
  };
  const scheduleClose = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setHovered(false);
    }, 160);
  };
  useEffect(() => () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  }, []);
  const running = useWorkspace((state) => state.transcript.running);
  const cwd = useWorkspace((state) => state.cwd);
  const visible = hovered || pinned;
  // 只在卡片打开时订阅 transcript：流式回复每 32ms 都会换掉 messages 的引用，
  // 关着的环不该跟着重渲染，更不该反复扫一遍全部历史来折算 token。
  const messages = useWorkspace((state) => (visible ? state.transcript.messages : null));
  const tools = useWorkspace((state) => (visible ? state.transcript.tools : null));
  const runtime = useMetrics().runtime;

  const systemPrompt = runtime?.systemPrompt;
  const toolSchemaChars = runtime?.breakdown?.toolChars;
  const raw = useMemo(
    () => estimateContextSources({ systemPrompt, toolSchemaChars, messages: messages ?? [], tools: tools ?? {} }),
    [systemPrompt, toolSchemaChars, messages, tools],
  );
  const used = usage?.used ?? 0;
  const buckets = useMemo(() => fitToUsed(raw, used), [raw, used]);
  const segments = useMemo(() => contextBarSegments(buckets, usage?.window ?? 0), [buckets, usage?.window]);

  const ratio = usage ? Math.min(1, Math.max(0, usage.used / usage.window)) : compacting ? 0.25 : null;
  if (ratio === null) return null;
  // The ring, the headline and the bar share one scale: calm is neutral, 75%
  // turns amber, 90% turns red — the same thresholds everywhere.
  const levelClass = ratio >= 0.9 ? "text-red-400" : ratio >= 0.75 ? "text-amber-400" : "text-content";
  const headline = compacting ? "Compacting context" : `${Math.round(ratio * 100)}% context used`;
  const classified = CONTEXT_SOURCE_KEYS.reduce((total, key) => total + buckets[key], 0);
  const rows = CONTEXT_SOURCE_KEYS.filter((key) => buckets[key] > 0);
  const hasBreakdown = usage != null && !compacting && classified > 0;

  return (
    <div ref={root} className="relative shrink-0" onMouseEnter={keepOpen} onMouseLeave={scheduleClose}>
      <button
        type="button"
        title="Context usage"
        aria-label={`${headline}, ${usage ? `${compact.format(usage.used)} / ${compact.format(usage.window)} tokens` : "waiting for Pi usage"}`}
        aria-expanded={pinned}
        onClick={() => {
          // 已固定时再点一次就是关掉：光标还停在环上，只清 pinned 的话卡片会赖着不走。
          if (pinned) {
            setPinned(false);
            setHovered(false);
            setExpanded(null);
            return;
          }
          setPinned(true);
        }}
        className="-m-1 grid rounded-sm p-1 outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <MeterRing ratio={ratio} spinning={compacting} />
      </button>
      {visible ? (
        <Popover
          anchor={root}
          side="top"
          align="end"
          onDismiss={() => {
            setPinned(false);
            setHovered(false);
            setExpanded(null);
          }}
          onMouseEnter={keepOpen}
          onMouseLeave={scheduleClose}
          className="w-[19rem] px-3.5 py-3"
        >
          <div className="space-y-2.5">
            <div className="text-[13px] font-semibold leading-4 text-content">Context</div>

            {/* A stale bar under “Compacting” would be a lie: the old usage died with the compaction. */}
            {usage && !compacting ? (
              <>
                <div className="flex items-end justify-between gap-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className={`font-mono text-[26px] font-semibold leading-none tracking-tight ${levelClass}`}>{compact.format(usage.used)}</span>
                    <span className="text-[10.5px] leading-4 text-content/40">/ {compact.format(usage.window)} tokens</span>
                  </div>
                  <span className={`shrink-0 font-mono text-[13px] tabular-nums ${levelClass}`}>{percentLabel(ratio)}</span>
                </div>

                <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-content/10" aria-hidden>
                  {segments.map((segment) => (
                    <span
                      key={segment.key}
                      className={`absolute inset-y-0 ${SOURCES[segment.key].swatch}`}
                      style={{
                        left: `${segment.left}%`,
                        // 一段一段之间留 2px 缝，靠窗口本身不需要缝：剩余额度是底色。
                        width: segment.width > 0 ? `max(2px, calc(${segment.width}% - 2px))` : 0,
                      }}
                    />
                  ))}
                </div>

                <div>
                  {used > 0 ? (
                    hasBreakdown ? (
                      rows.map((key) => {
                        const source = SOURCES[key];
                        const open = expanded === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setExpanded(open ? null : key)}
                            className="-mx-1 flex w-[calc(100%+0.5rem)] flex-col rounded px-1 text-left hover:bg-content/5"
                            aria-expanded={open}
                          >
                            <span className="flex items-center gap-2 py-[3px]">
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${source.swatch}`} />
                              <span className="text-[12px] leading-4 text-content/75">{source.label}</span>
                              <span className="ml-auto font-mono text-[11.5px] tabular-nums text-content/85">{compact.format(buckets[key])}</span>
                            </span>
                            {open ? <span className="pb-1 pl-3.5 text-[10.5px] leading-4 text-content/40">{source.note}</span> : null}
                          </button>
                        );
                      })
                    ) : (
                      // 知道总量但拆不开（系统提示还没回传）：不编造四段，只把真数放上来。
                      <div className="flex items-center gap-2 py-[3px]">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-content/30" />
                        <span className="text-[12px] leading-4 text-content/75">Used</span>
                        <span className="ml-auto font-mono text-[11.5px] tabular-nums text-content/85">{compact.format(usage.used)}</span>
                      </div>
                    )
                  ) : null}
                </div>
              </>
            ) : (
              <div className="text-[11px] leading-4 text-content/50">{compacting ? "Usage returns after compaction" : "Waiting for Pi to report usage"}</div>
            )}

            {pinned ? (
              <button
                type="button"
                disabled={running || compacting}
                title={running ? "Wait for the current reply to finish" : "Compact this conversation"}
                onClick={() => {
                  setPinned(false);
                  setExpanded(null);
                  void request({ type: "compact" }, 180000).then(() => loadMessages(cwd)).catch(report);
                }}
                className="w-full rounded-md border border-content/10 bg-content/5 px-2 py-1.5 text-[11px] text-content hover:bg-content/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Compact now
              </button>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
